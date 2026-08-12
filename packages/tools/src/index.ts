import {
  MawlError,
  ToolCallSchema,
  asJsonValue,
  createId,
  nowIso,
  type AgentDefinition,
  type JsonValue,
  type PolicyDecision,
  type Principal,
  type ToolCall,
} from '@mawl/core';
import {
  EventBus,
  requiresApproval,
  type ApprovalPolicy,
  type ApprovalProvider,
} from '@mawl/observability';
import { PermissionEngine } from '@mawl/permissions';
import { PolicyEngine, type RiskLevel } from '@mawl/policy';
import type { SandboxExecutionRequest, SandboxProvider } from '@mawl/sandbox';
import { SecretRedactor, detectPromptInjection } from '@mawl/security';
import { z } from 'zod';

export type ToolRiskType =
  'read' | 'write' | 'execute' | 'network' | 'secret' | 'admin' | 'external_side_effect';

export type ToolErrorCode =
  | 'VALIDATION_ERROR'
  | 'PERMISSION_DENIED'
  | 'POLICY_DENIED'
  | 'SANDBOX_ERROR'
  | 'TIMEOUT'
  | 'TOOL_EXECUTION_ERROR'
  | 'OUTPUT_VALIDATION_ERROR'
  | 'UNKNOWN_TOOL'
  | 'CANCELLED'
  | 'APPROVAL_DENIED';

export interface ToolContext {
  workflowId: string;
  taskId: string;
  traceId: string;
  sandboxId?: string | null;
  principal?: Principal;
  signal?: AbortSignal;
  secretsForRedaction?: string[];
}

export interface ToolDefinition {
  id?: string;
  name: string;
  description?: string;
  provider: string;
  inputSchema?: z.ZodType;
  outputSchema?: z.ZodType;
  requiredPermissions?: string[];
  riskTypes?: ToolRiskType[];
  riskLevel?: RiskLevel;
  timeoutMs?: number;
  maxOutputBytes?: number;
  sandboxPolicy?: 'none' | 'optional' | 'required';
  sandboxRequest?: (argumentsValue: JsonValue, context: ToolContext) => SandboxExecutionRequest;
  normalize?: (argumentsValue: JsonValue) => JsonValue;
  sanitize?: (output: JsonValue) => JsonValue;
  handler?: (argumentsValue: JsonValue, context: ToolContext) => Promise<JsonValue>;
  execute?: (argumentsValue: JsonValue, context: ToolContext) => Promise<JsonValue>;
  metadata?: Record<string, JsonValue>;
}

export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();

  public register(tool: ToolDefinition): void {
    if (this.#tools.has(tool.name)) {
      throw new MawlError(`Duplicate tool: ${tool.name}`, 'DUPLICATE_TOOL');
    }
    if (!tool.handler && !tool.execute && !tool.sandboxRequest) {
      throw new MawlError(`Tool has no handler: ${tool.name}`, 'INVALID_TOOL_DEFINITION');
    }
    this.#tools.set(tool.name, Object.freeze({ ...tool }));
  }

  public get(name: string): ToolDefinition {
    const tool = this.#tools.get(name);
    if (!tool) throw new MawlError(`Unknown tool: ${name}`, 'UNKNOWN_TOOL');
    return tool;
  }

  public find(name: string): ToolDefinition | undefined {
    return this.#tools.get(name);
  }

  public list(): ToolDefinition[] {
    return [...this.#tools.values()];
  }
}

export interface ToolExecutorOptions {
  permissions?: PermissionEngine;
  policy?: PolicyEngine;
  sandbox?: SandboxProvider;
  persist?: (call: ToolCall) => Promise<void>;
  approval?: ApprovalProvider;
  approvalPolicy?: ApprovalPolicy;
}

export class ToolExecutor {
  readonly #permissions: PermissionEngine;
  readonly #policy: PolicyEngine;
  readonly #sandbox: SandboxProvider | undefined;
  readonly #persist: ((call: ToolCall) => Promise<void>) | undefined;
  readonly #approval: ApprovalProvider | undefined;
  readonly #approvalPolicy: ApprovalPolicy | undefined;
  readonly #redactor = new SecretRedactor();

  public constructor(
    private readonly registry: ToolRegistry,
    private readonly events: EventBus,
    permissionsOrOptions: PermissionEngine | ToolExecutorOptions = new PermissionEngine(),
    legacyPersist?: (call: ToolCall) => Promise<void>,
  ) {
    if (permissionsOrOptions instanceof PermissionEngine) {
      this.#permissions = permissionsOrOptions;
      this.#policy = new PolicyEngine();
      this.#persist = legacyPersist;
      this.#approval = undefined;
      this.#approvalPolicy = undefined;
    } else {
      this.#permissions = permissionsOrOptions.permissions ?? new PermissionEngine();
      this.#policy = permissionsOrOptions.policy ?? new PolicyEngine();
      this.#sandbox = permissionsOrOptions.sandbox;
      this.#persist = permissionsOrOptions.persist;
      this.#approval = permissionsOrOptions.approval;
      this.#approvalPolicy = permissionsOrOptions.approvalPolicy;
    }
  }

  public async invoke(
    agent: AgentDefinition,
    toolName: string,
    argumentsValue: unknown,
    context: ToolContext,
  ): Promise<ToolCall> {
    const startedAt = nowIso();
    const start = performance.now();
    const callId = createId('tool');
    const principal =
      context.principal ??
      ({
        id: `agent:${agent.id}`,
        type: 'agent',
        roles: ['agent', agent.role],
        capabilities: agent.capabilities,
        claims: { agentId: agent.id },
        attributes: { agentId: agent.id },
      } satisfies Principal);
    let args: JsonValue;
    try {
      args = asJsonValue(argumentsValue);
    } catch (error) {
      return this.#failure(
        agent,
        toolName,
        {},
        {},
        context,
        callId,
        startedAt,
        start,
        'VALIDATION_ERROR',
        error instanceof Error ? error.message : String(error),
      );
    }
    const tool = this.registry.find(toolName);
    await this.events.emit({
      type: 'tool.requested',
      workflowId: context.workflowId,
      taskId: context.taskId,
      agentId: agent.id,
      traceId: context.traceId,
      payload: {
        callId,
        toolName,
        principalId: principal.id,
        riskTypes: tool?.riskTypes ?? [],
        riskLevel: tool?.riskLevel ?? 'unknown',
      },
    });
    if (!tool) {
      return this.#failure(
        agent,
        toolName,
        args,
        args,
        context,
        callId,
        startedAt,
        start,
        'UNKNOWN_TOOL',
        `Unknown tool: ${toolName}`,
      );
    }
    const input = tool.inputSchema?.safeParse(args);
    if (input && !input.success) {
      return this.#failure(
        agent,
        toolName,
        args,
        args,
        context,
        callId,
        startedAt,
        start,
        'VALIDATION_ERROR',
        input.error.message,
        tool.provider,
      );
    }
    const validatedArgs = asJsonValue(input?.data ?? args);
    const legacyPermission = this.#permissions.canUseTool(agent, toolName);
    if (!legacyPermission.allowed) {
      return this.#denied(
        agent,
        tool,
        args,
        validatedArgs,
        context,
        callId,
        startedAt,
        start,
        legacyPermission,
        'PERMISSION_DENIED',
      );
    }
    for (const permission of tool.requiredPermissions ?? []) {
      const permissionDecision = await this.#permissions.evaluate({
        principal,
        permission,
        resource: tool.name,
        action: 'execute',
        context: { workflowId: context.workflowId, taskId: context.taskId },
      });
      await this.events.emit({
        type: permissionDecision.allowed ? 'permission.allowed' : 'permission.denied',
        workflowId: context.workflowId,
        taskId: context.taskId,
        agentId: agent.id,
        traceId: context.traceId,
        payload: permissionDecision,
      });
      if (!permissionDecision.allowed) {
        return this.#denied(
          agent,
          tool,
          args,
          validatedArgs,
          context,
          callId,
          startedAt,
          start,
          {
            allowed: false,
            reason: permissionDecision.reason,
            rule: permissionDecision.matchedPolicy,
          },
          'PERMISSION_DENIED',
        );
      }
    }
    const policyDecision = await this.#policy.evaluate({
      principal,
      operation: `tool.${tool.name}`,
      resource: tool.name,
      riskLevel: tool.riskLevel ?? 'low',
      arguments: validatedArgs,
      context: { workflowId: context.workflowId, taskId: context.taskId },
    });
    await this.events.emit({
      type: policyDecision.allow ? 'policy.allowed' : 'policy.denied',
      workflowId: context.workflowId,
      taskId: context.taskId,
      agentId: agent.id,
      traceId: context.traceId,
      payload: policyDecision,
    });
    if (!policyDecision.allow) {
      return this.#denied(
        agent,
        tool,
        args,
        validatedArgs,
        context,
        callId,
        startedAt,
        start,
        { allowed: false, reason: policyDecision.reason, rule: policyDecision.policyId },
        'POLICY_DENIED',
      );
    }

    if (
      this.#approval &&
      this.#approvalPolicy &&
      requiresApproval(this.#approvalPolicy, {
        operation: tool.name,
        riskTypes: tool.riskTypes ?? [],
      })
    ) {
      const approvalRequest = {
        requestId: createId('approval'),
        workflowId: context.workflowId,
        taskId: context.taskId,
        agentId: agent.id,
        operation: tool.name,
        resource: tool.name,
        riskTypes: tool.riskTypes ?? [],
        reason: `Approval policy matched ${tool.name}`,
        requestedAt: nowIso(),
        metadata: { callId },
      };
      await this.events.emit({
        type: 'approval.requested',
        workflowId: context.workflowId,
        taskId: context.taskId,
        agentId: agent.id,
        traceId: context.traceId,
        payload: approvalRequest,
      });
      const approvalDecision = await this.#approval.decide(approvalRequest);
      await this.events.emit({
        type: approvalDecision.approved ? 'approval.granted' : 'approval.denied',
        workflowId: context.workflowId,
        taskId: context.taskId,
        agentId: agent.id,
        traceId: context.traceId,
        payload: approvalDecision,
      });
      if (!approvalDecision.approved) {
        return this.#failure(
          agent,
          toolName,
          args,
          validatedArgs,
          context,
          callId,
          startedAt,
          start,
          'APPROVAL_DENIED',
          approvalDecision.reason,
          tool.provider,
          { allowed: false, reason: approvalDecision.reason, rule: 'approval.required' },
        );
      }
    }

    const normalizedArguments = tool.normalize?.(validatedArgs) ?? validatedArgs;
    const timeoutMs = tool.timeoutMs ?? 30_000;
    const abortController = new AbortController();
    const onAbort = (): void => abortController.abort(context.signal?.reason);
    context.signal?.addEventListener('abort', onAbort, { once: true });
    await this.events.emit({
      type: 'tool.started',
      workflowId: context.workflowId,
      taskId: context.taskId,
      agentId: agent.id,
      traceId: context.traceId,
      payload: { callId, toolName, timeoutMs },
    });
    try {
      const executionContext: ToolContext = {
        ...context,
        principal,
        signal: abortController.signal,
      };
      const output = await withTimeout(
        this.#execute(tool, normalizedArguments, executionContext),
        timeoutMs,
        abortController,
      );
      const outputValidation = tool.outputSchema?.safeParse(output);
      if (outputValidation && !outputValidation.success) {
        return await this.#failure(
          agent,
          toolName,
          args,
          normalizedArguments,
          context,
          callId,
          startedAt,
          start,
          'OUTPUT_VALIDATION_ERROR',
          outputValidation.error.message,
          tool.provider,
          legacyPermission,
        );
      }
      let sanitized = asJsonValue(outputValidation?.data ?? output);
      sanitized = tool.sanitize?.(sanitized) ?? sanitized;
      const redacted = this.#redactor.redact(sanitized, context.secretsForRedaction ?? []);
      const serialized = JSON.stringify(redacted.value);
      const outputSizeBytes = Buffer.byteLength(serialized, 'utf8');
      if (outputSizeBytes > (tool.maxOutputBytes ?? 1_048_576)) {
        return await this.#failure(
          agent,
          toolName,
          args,
          normalizedArguments,
          context,
          callId,
          startedAt,
          start,
          'OUTPUT_VALIDATION_ERROR',
          'Tool output exceeded configured size limit',
          tool.provider,
          legacyPermission,
        );
      }
      const injectionIndicators = detectPromptInjection(serialized).map(
        (indicator) => `prompt-injection:${indicator}`,
      );
      const call = ToolCallSchema.parse({
        callId,
        toolName,
        provider: tool.provider,
        arguments: args,
        normalizedArguments,
        callerAgent: agent.id,
        taskId: context.taskId,
        permissionDecision: legacyPermission,
        startedAt,
        finishedAt: nowIso(),
        durationMs: performance.now() - start,
        output: redacted.value,
        error: null,
        errorCode: null,
        outputSizeBytes,
        sandboxId: tool.sandboxPolicy === 'required' ? (this.#sandbox?.id ?? null) : null,
        mcpServer: tool.provider.startsWith('mcp:') ? tool.provider.slice(4) : null,
        redactionMetadata: [...redacted.paths, ...injectionIndicators],
      });
      await this.#save(call);
      await this.events.emit({
        type: 'tool.completed',
        workflowId: context.workflowId,
        taskId: context.taskId,
        agentId: agent.id,
        traceId: context.traceId,
        payload: { callId, toolName, outputSizeBytes, redactions: call.redactionMetadata },
      });
      return call;
    } catch (error) {
      const code = classifyError(error, context.signal);
      return await this.#failure(
        agent,
        toolName,
        args,
        normalizedArguments,
        context,
        callId,
        startedAt,
        start,
        code,
        error instanceof Error ? error.message : String(error),
        tool.provider,
        legacyPermission,
      );
    } finally {
      context.signal?.removeEventListener('abort', onAbort);
    }
  }

  async #execute(tool: ToolDefinition, args: JsonValue, context: ToolContext): Promise<JsonValue> {
    if (tool.sandboxPolicy === 'required') {
      if (!this.#sandbox || !tool.sandboxRequest) {
        throw new MawlError('Required sandbox is unavailable', 'SANDBOX_ERROR');
      }
      const start = performance.now();
      await this.events.emit({
        type: 'sandbox.started',
        workflowId: context.workflowId,
        taskId: context.taskId,
        traceId: context.traceId,
        payload: { sandboxId: this.#sandbox.id, toolName: tool.name },
      });
      try {
        const result = await this.#sandbox.execute(tool.sandboxRequest(args, context));
        await this.events.emit({
          type: 'sandbox.completed',
          workflowId: context.workflowId,
          taskId: context.taskId,
          traceId: context.traceId,
          payload: {
            sandboxId: this.#sandbox.id,
            toolName: tool.name,
            executionId: result.executionId,
            durationMs: performance.now() - start,
            networkEnforcement: result.networkEnforcement,
          },
        });
        return asJsonValue(result);
      } catch (error) {
        await this.events.emit({
          type: 'sandbox.failed',
          workflowId: context.workflowId,
          taskId: context.taskId,
          traceId: context.traceId,
          payload: {
            sandboxId: this.#sandbox.id,
            toolName: tool.name,
            durationMs: performance.now() - start,
            error: error instanceof Error ? error.message : String(error),
          },
        });
        throw error;
      }
    }
    const handler = tool.handler ?? tool.execute;
    if (!handler) throw new MawlError('Tool handler is unavailable', 'TOOL_EXECUTION_ERROR');
    return handler(args, context);
  }

  async #denied(
    agent: AgentDefinition,
    tool: ToolDefinition,
    args: JsonValue,
    normalized: JsonValue,
    context: ToolContext,
    callId: string,
    startedAt: string,
    start: number,
    permissionDecision: PolicyDecision,
    errorCode: 'PERMISSION_DENIED' | 'POLICY_DENIED',
  ): Promise<ToolCall> {
    await this.events.emit({
      type: errorCode === 'PERMISSION_DENIED' ? 'tool.denied' : 'tool.policy_denied',
      workflowId: context.workflowId,
      taskId: context.taskId,
      agentId: agent.id,
      traceId: context.traceId,
      payload: { callId, toolName: tool.name, errorCode, permissionDecision },
    });
    return this.#failure(
      agent,
      tool.name,
      args,
      normalized,
      context,
      callId,
      startedAt,
      start,
      errorCode,
      permissionDecision.reason,
      tool.provider,
      permissionDecision,
    );
  }

  async #failure(
    agent: AgentDefinition,
    toolName: string,
    args: JsonValue,
    normalizedArguments: JsonValue,
    context: ToolContext,
    callId: string,
    startedAt: string,
    start: number,
    errorCode: ToolErrorCode,
    message: string,
    provider = 'unresolved',
    permissionDecision: PolicyDecision = {
      allowed: false,
      reason: message,
      rule: `tool.${errorCode.toLowerCase()}`,
    },
  ): Promise<ToolCall> {
    const call = ToolCallSchema.parse({
      callId,
      toolName,
      provider,
      arguments: args,
      normalizedArguments,
      callerAgent: agent.id,
      taskId: context.taskId,
      permissionDecision,
      startedAt,
      finishedAt: nowIso(),
      durationMs: performance.now() - start,
      error: message,
      errorCode,
      outputSizeBytes: 0,
      sandboxId: context.sandboxId ?? null,
      mcpServer: provider.startsWith('mcp:') ? provider.slice(4) : null,
      redactionMetadata: [],
    });
    await this.#save(call);
    await this.events.emit({
      type: 'tool.failed',
      workflowId: context.workflowId,
      taskId: context.taskId,
      agentId: agent.id,
      traceId: context.traceId,
      payload: { callId, toolName, errorCode, error: message },
    });
    return call;
  }

  async #save(call: ToolCall): Promise<void> {
    if (this.#persist) await this.#persist(call);
  }
}

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(new MawlError('Tool execution timed out', 'TIMEOUT'));
      reject(new MawlError('Tool execution timed out', 'TIMEOUT'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const classifyError = (error: unknown, externalSignal?: AbortSignal): ToolErrorCode => {
  if (externalSignal?.aborted) return 'CANCELLED';
  if (error instanceof MawlError) {
    if (error.code === 'TIMEOUT') return 'TIMEOUT';
    if (error.code.startsWith('SANDBOX')) return 'SANDBOX_ERROR';
  }
  return 'TOOL_EXECUTION_ERROR';
};
