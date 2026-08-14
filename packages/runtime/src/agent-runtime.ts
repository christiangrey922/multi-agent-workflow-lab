import { randomUUID } from 'node:crypto';

import { createAgentExecutionIdentity, type AuthContext } from '@mawl/auth';
import {
  AgentActionSchema,
  AgentDefinitionSchema,
  MawlError,
  TaskSchema,
  asJsonValue,
  type AgentAction,
  type AgentDefinition,
  type ContextEnvelope,
  type ExecutionIdentity,
  type JsonValue,
  type ModelProvider,
  type Task,
} from '@mawl/core';
import { emitPromptInjectionSignals, type EventBus } from '@mawl/observability';
import type { NormalizedInput } from '@mawl/parsers';
import { DelegationPolicy, type PermissionEngine } from '@mawl/permissions';
import type { SystemPromptProcessor } from '@mawl/prompts';
import type { ToolExecutor } from '@mawl/tools';

export interface AgentDelegator {
  delegate(request: {
    parentTask: Task;
    action: Extract<AgentAction, { action: 'delegate_task' }>;
    identity: ExecutionIdentity;
    traceId: string;
    signal?: AbortSignal;
  }): Promise<{ taskId: string; result?: JsonValue }>;
}

export interface AgentRuntimeDependencies {
  provider: ModelProvider;
  prompts: SystemPromptProcessor;
  tools: ToolExecutor;
  permissions: PermissionEngine;
  eventBus: EventBus;
  delegator?: AgentDelegator;
}

export interface AgentRuntimeInput {
  agent: AgentDefinition;
  task: Task;
  input: NormalizedInput | JsonValue;
  auth: AuthContext;
  context?: ContextEnvelope;
  traceId?: string;
  signal?: AbortSignal;
}

export interface AgentRuntimeCounters {
  turns: number;
  tokens: number;
  toolCalls: number;
  delegations: number;
  errors: number;
  retries: number;
}

export interface AgentRuntimeResult {
  taskId: string;
  traceId: string;
  identity: ExecutionIdentity;
  status: 'completed' | 'failed' | 'cancelled';
  output?: JsonValue;
  counters: AgentRuntimeCounters;
  error?: { code: string; message: string };
}

/** Parses and validates model output without coercing malformed data into actions. */
export class StructuredAgentOutputParser {
  parse(value: JsonValue): AgentAction {
    const parsed = AgentActionSchema.safeParse(value);
    if (!parsed.success) {
      throw new MawlError(
        'Model output is not a valid final_answer, tool_call, delegate_task, or request_permission action',
        'INVALID_AGENT_ACTION',
        { issues: asJsonValue(parsed.error.issues) },
      );
    }
    return parsed.data;
  }
}

export class AgentRuntime {
  readonly #parser = new StructuredAgentOutputParser();
  readonly #delegationPolicy = new DelegationPolicy();

  constructor(private readonly dependencies: AgentRuntimeDependencies) {}

  async execute(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    const agent = AgentDefinitionSchema.parse(input.agent);
    const task = TaskSchema.parse(input.task);
    const traceId = input.traceId ?? randomUUID();
    const identity = createAgentExecutionIdentity({
      agentId: agent.id,
      workflowId: task.workflowId,
      taskId: task.taskId,
      sessionId: input.auth.session?.id ?? null,
    });
    const counters: AgentRuntimeCounters = {
      turns: 0,
      tokens: 0,
      toolCalls: 0,
      delegations: 0,
      errors: 0,
      retries: 0,
    };
    const startedAt = Date.now();
    const toolOutputs: JsonValue[] = [];
    const mcpOutputs: JsonValue[] = [];
    const childOutputs: JsonValue[] = [];
    const emittedPromptInjectionSignalIds = new Set<string>();
    const normalizedInput = normalizeInput(input.input);

    await this.emit('agent.runtime.started', traceId, task, {
      agentId: agent.id,
      principalId: identity.principal.id,
      inputParser: normalizedInput.sourceType,
      inputWarnings: normalizedInput.warnings,
    });

    try {
      while (counters.turns < agent.executionLimits.maxAgentTurns) {
        this.throwIfCancelled(input.signal);
        this.enforceRuntimeLimit(startedAt, agent.executionLimits.maxRuntimeMs);
        this.enforceTokenLimit(counters, agent.executionLimits.maxTokenBudget);

        const prompt = this.dependencies.prompts.process({
          agent,
          variables: { objective: task.objective },
          workflowInstructions: 'Return exactly one typed action object.',
          taskInstructions: task.instructions,
          ...(input.context ? { runtimeContext: input.context } : {}),
          userInput: normalizedInput.parsed,
          toolOutput: toolOutputs,
          mcpOutput: mcpOutputs,
          childOutput: childOutputs,
        });
        const newPromptInjectionSignals = prompt.promptInjectionSignals.filter(
          (signal) => !emittedPromptInjectionSignalIds.has(signal.id),
        );
        await emitPromptInjectionSignals(this.dependencies.eventBus, newPromptInjectionSignals, {
          workflowId: task.workflowId,
          taskId: task.taskId,
          agentId: task.assignedToAgent,
          traceId,
        });
        for (const signal of newPromptInjectionSignals) {
          emittedPromptInjectionSignalIds.add(signal.id);
        }
        await this.emit('prompt.assembled', traceId, task, {
          promptHash: prompt.renderedHash,
          layers: prompt.layers.map((layer) => ({
            id: layer.id,
            trust: layer.trust,
            source: layer.source,
          })),
        });

        const remainingMs = Math.max(
          1,
          agent.executionLimits.maxRuntimeMs - (Date.now() - startedAt),
        );
        const response = await withTimeout(
          this.dependencies.provider.generate({
            agent,
            task,
            systemPrompt: prompt.rendered,
            context: input.context ?? emptyContext(normalizedInput.parsed),
          }),
          remainingMs,
          'MODEL_TIMEOUT',
          input.signal,
        );
        counters.turns += 1;
        counters.tokens += response.tokenUsage.input + response.tokenUsage.output;
        this.enforceTokenLimit(counters, agent.executionLimits.maxTokenBudget);

        let action: AgentAction;
        try {
          action = this.#parser.parse(response.output);
        } catch (error) {
          counters.errors += 1;
          counters.retries += 1;
          await this.emit('agent.action.invalid', traceId, task, serializeError(error));
          this.enforceErrorLimits(
            counters,
            agent.executionLimits.maxErrors,
            agent.executionLimits.maxRetries,
          );
          continue;
        }

        await this.emit('agent.action.parsed', traceId, task, { action: action.action });
        if (action.action === 'final_answer') {
          this.enforceOutputLimit(action.output, agent.executionLimits.maxOutputBytes);
          const result: AgentRuntimeResult = {
            taskId: task.taskId,
            traceId,
            identity,
            status: 'completed',
            output: action.output,
            counters,
          };
          await this.emit('agent.runtime.completed', traceId, task, {
            counters,
            outputSizeBytes: byteSize(action.output),
          });
          return result;
        }

        if (action.action === 'tool_call') {
          if (counters.toolCalls >= agent.executionLimits.maxToolCalls) {
            throw new MawlError('Agent exceeded its tool-call limit', 'TOOL_CALL_LIMIT');
          }
          counters.toolCalls += 1;
          const toolResult = await this.dependencies.tools.invoke(
            agent,
            action.tool,
            action.arguments,
            {
              workflowId: task.workflowId,
              taskId: task.taskId,
              traceId,
              principal: identity.principal,
              ...(input.signal ? { signal: input.signal } : {}),
            },
          );
          if (toolResult.error) {
            counters.errors += 1;
            await this.emit('agent.tool.failed', traceId, task, {
              toolName: action.tool,
              errorCode: toolResult.errorCode,
              errorMessage: toolResult.error,
            });
            this.enforceErrorLimits(
              counters,
              agent.executionLimits.maxErrors,
              agent.executionLimits.maxRetries,
            );
          }
          const untrustedOutput = {
            tool: action.tool,
            status: toolResult.error ? 'failed' : 'completed',
            output: toolResult.output ?? null,
            errorCode: toolResult.errorCode ?? null,
          } satisfies JsonValue;
          if (toolResult.mcpServer) mcpOutputs.push(untrustedOutput);
          else toolOutputs.push(untrustedOutput);
          continue;
        }

        if (action.action === 'delegate_task') {
          if (counters.delegations >= agent.executionLimits.maxDelegations) {
            throw new MawlError('Agent exceeded its delegation limit', 'DELEGATION_LIMIT');
          }
          for (const permission of action.requestedPermissions) {
            if (!this.#delegationPolicy.canDelegatePermission(agent, permission).allowed) {
              await this.emit('delegation.permission.denied', traceId, task, {
                targetAgentId: action.agent,
                permission,
                reason: 'Parent agent does not possess the requested permission',
              });
              throw new MawlError(
                `Parent agent cannot delegate permission '${permission}'`,
                'DELEGATION_PERMISSION_ESCALATION',
              );
            }
          }
          if (!this.dependencies.delegator) {
            throw new MawlError('No delegation executor is configured', 'DELEGATION_UNAVAILABLE');
          }
          counters.delegations += 1;
          const delegated = await this.dependencies.delegator.delegate({
            parentTask: task,
            action,
            identity,
            traceId,
            ...(input.signal ? { signal: input.signal } : {}),
          });
          childOutputs.push({
            delegationTaskId: delegated.taskId,
            output: delegated.result ?? null,
          });
          continue;
        }

        const permissionDecision = await this.dependencies.permissions.evaluate({
          principal: identity.principal,
          permission: action.permission,
          resource: action.resource,
          action: 'request',
          context: {
            taskId: task.taskId,
            agentId: agent.id,
            reason: action.reason,
          },
        });
        await this.emit('agent.permission.requested', traceId, task, permissionDecision);
        toolOutputs.push({
          permission: action.permission,
          resource: action.resource,
          allowed: permissionDecision.allowed,
          reason: permissionDecision.reason,
        });
      }

      throw new MawlError('Agent exceeded its turn limit', 'TURN_LIMIT');
    } catch (error) {
      const serialized = serializeError(error);
      const status = input.signal?.aborted ? 'cancelled' : 'failed';
      await this.emit(`agent.runtime.${status}`, traceId, task, {
        counters,
        error: serialized,
      });
      return {
        taskId: task.taskId,
        traceId,
        identity,
        status,
        counters,
        error: serialized,
      };
    }
  }

  private enforceRuntimeLimit(startedAt: number, maxRuntimeMs: number): void {
    if (Date.now() - startedAt >= maxRuntimeMs) {
      throw new MawlError('Agent exceeded its runtime limit', 'RUNTIME_LIMIT');
    }
  }

  private enforceTokenLimit(counters: AgentRuntimeCounters, maxTokens: number): void {
    if (counters.tokens > maxTokens) {
      throw new MawlError('Agent exceeded its token limit', 'TOKEN_LIMIT');
    }
  }

  private enforceErrorLimits(
    counters: AgentRuntimeCounters,
    maxErrors: number,
    maxRetries: number,
  ): void {
    if (counters.errors > maxErrors) {
      throw new MawlError('Agent exceeded its error limit', 'ERROR_LIMIT');
    }
    if (counters.retries > maxRetries) {
      throw new MawlError('Agent exceeded its retry limit', 'RETRY_LIMIT');
    }
  }

  private enforceOutputLimit(value: JsonValue, maxBytes: number): void {
    if (byteSize(value) > maxBytes) {
      throw new MawlError('Agent output exceeded its configured size limit', 'OUTPUT_LIMIT');
    }
  }

  private throwIfCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new MawlError('Agent execution was cancelled', 'CANCELLED');
    }
  }

  private async emit(type: string, traceId: string, task: Task, payload: unknown): Promise<void> {
    await this.dependencies.eventBus.emit({
      type,
      workflowId: task.workflowId,
      traceId,
      taskId: task.taskId,
      agentId: task.assignedToAgent,
      payload,
    });
  }
}

function normalizeInput(input: NormalizedInput | JsonValue): NormalizedInput {
  if (
    typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input) &&
    'sourceType' in input &&
    'parsed' in input
  ) {
    return input as NormalizedInput;
  }
  return {
    sourceType: 'json',
    raw: JSON.stringify(input),
    parsed: input,
    metadata: { provenance: 'runtime-input' },
    warnings: [],
  };
}

function byteSize(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function serializeError(error: unknown): { code: string; message: string } {
  if (error instanceof MawlError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return { code: 'UNEXPECTED_ERROR', message: error.message };
  }
  return { code: 'UNEXPECTED_ERROR', message: String(error) };
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  code: string,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new MawlError(`Operation timed out after ${timeoutMs}ms`, code)),
      timeoutMs,
    );
    abortHandler = () => reject(new MawlError('Operation was cancelled', 'CANCELLED'));
    signal?.addEventListener('abort', abortHandler, { once: true });
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abortHandler) signal?.removeEventListener('abort', abortHandler);
  }
}

const emptyContext = (input: JsonValue): ContextEnvelope => ({
  public: { input },
  workflow: {},
  taskLocal: {},
  protected: {},
  secrets: {},
  explicitlyOmitted: [],
});
