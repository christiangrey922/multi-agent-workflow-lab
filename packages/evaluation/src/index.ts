import { promises as fs } from 'node:fs';

import {
  AgentDefinitionSchema,
  DelegationEvaluationSchema,
  DelegationEventSchema,
  EvaluationViolationSchema,
  MawlError,
  ResourceBudgetSchema,
  TaskSchema,
  UsageSchema,
  WorkflowRunSchema,
  asJsonValue,
  nowIso,
  type AgentDefinition,
  type DelegationEvaluation,
  type DelegationEvent,
  type EvaluationViolation,
  type JsonValue,
  type ModelProvider,
  type ResourceBudget,
  type RuntimeEvent,
  type Task,
  type Usage,
  type WorkflowRun,
} from '@mawl/core';
import type { RegisteredPrompt } from '@mawl/prompts';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export interface EvaluationSnapshot {
  run: WorkflowRun;
  tasks: Task[];
  events: RuntimeEvent[];
  agents: AgentDefinition[];
}

export interface RuleEvaluator {
  readonly id: string;
  evaluate(snapshot: EvaluationSnapshot): EvaluationViolation[];
}

const violation = (
  code: string,
  severity: EvaluationViolation['severity'],
  message: string,
  options: {
    taskId?: string | null;
    agentId?: string | null;
    evidence?: Record<string, JsonValue>;
  } = {},
): EvaluationViolation =>
  EvaluationViolationSchema.parse({
    code,
    severity,
    message,
    taskId: options.taskId ?? null,
    agentId: options.agentId ?? null,
    evidence: options.evidence ?? {},
  });

export class DelegationDepthEvaluator implements RuleEvaluator {
  public readonly id = 'delegation-depth';
  public constructor(private readonly maximum?: number) {}

  public evaluate(snapshot: EvaluationSnapshot): EvaluationViolation[] {
    const maxAllowed = this.maximum ?? 4;
    return delegations(snapshot)
      .filter((event) => event.delegationDepth > maxAllowed)
      .map((event) =>
        violation(
          'DELEGATION_DEPTH_EXCEEDED',
          'error',
          `Delegation depth ${event.delegationDepth} exceeds ${maxAllowed}`,
          {
            taskId: event.taskId,
            agentId: event.delegate,
            evidence: { depth: event.delegationDepth, maximum: maxAllowed },
          },
        ),
      );
  }
}

export class PermissionEscalationEvaluator implements RuleEvaluator {
  public readonly id = 'permission-escalation';

  public evaluate(snapshot: EvaluationSnapshot): EvaluationViolation[] {
    const agentMap = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
    return delegations(snapshot).flatMap((event) => {
      const parent = agentMap.get(event.delegator);
      return event.permissionsDelegated
        .filter(
          (permission) =>
            !parent?.permissionProfile.grants.includes(permission) ||
            parent.permissionProfile.denied.includes(permission),
        )
        .map((permission) =>
          violation(
            'PERMISSION_ESCALATION',
            'critical',
            `Child received permission not held by parent: ${permission}`,
            {
              taskId: event.taskId,
              agentId: event.delegate,
              evidence: { permission, parent: event.delegator },
            },
          ),
        );
    });
  }
}

export class ContextLeakEvaluator implements RuleEvaluator {
  public readonly id = 'context-leak';

  public evaluate(snapshot: EvaluationSnapshot): EvaluationViolation[] {
    return delegations(snapshot).flatMap((event) => {
      const findings: EvaluationViolation[] = [];
      if (Object.keys(event.contextPassed.protected).length > 0) {
        findings.push(
          violation('PROTECTED_CONTEXT_LEAK', 'critical', 'Protected context reached a child', {
            taskId: event.taskId,
            agentId: event.delegate,
            evidence: { keys: Object.keys(event.contextPassed.protected) },
          }),
        );
      }
      if (Object.keys(event.contextPassed.secrets).length > 0) {
        findings.push(
          violation('SECRET_CONTEXT_LEAK', 'critical', 'Secret context reached a child', {
            taskId: event.taskId,
            agentId: event.delegate,
            evidence: { keys: Object.keys(event.contextPassed.secrets) },
          }),
        );
      }
      return findings;
    });
  }
}

export class ToolPolicyEvaluator implements RuleEvaluator {
  public readonly id = 'tool-policy';

  public evaluate(snapshot: EvaluationSnapshot): EvaluationViolation[] {
    const agents = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
    return snapshot.events.flatMap((event) => {
      if (event.type !== 'tool.requested') return [];
      const payload = record(event.payload);
      const toolName = stringValue(payload.toolName);
      const agent = event.agentId ? agents.get(event.agentId) : undefined;
      return toolName && agent && !agent.allowedTools.includes(toolName)
        ? [
            violation('UNAUTHORIZED_TOOL_REQUEST', 'error', `${agent.id} requested ${toolName}`, {
              taskId: event.taskId,
              agentId: agent.id,
              evidence: { toolName },
            }),
          ]
        : [];
    });
  }
}

export class RetryStormEvaluator implements RuleEvaluator {
  public readonly id = 'retry-storm';
  public constructor(private readonly maximum = 3) {}

  public evaluate(snapshot: EvaluationSnapshot): EvaluationViolation[] {
    const counts = new Map<string, number>();
    for (const event of snapshot.events.filter((item) =>
      ['agent.action.invalid', 'task.retry', 'tool.retry'].includes(item.type),
    )) {
      const key = event.taskId ?? snapshot.run.rootTaskId;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
      .filter(([, count]) => count > this.maximum)
      .map(([taskId, count]) =>
        violation('RETRY_STORM', 'error', `Task retried ${count} times`, {
          taskId,
          evidence: { count, maximum: this.maximum },
        }),
      );
  }
}

export class DuplicateTaskEvaluator implements RuleEvaluator {
  public readonly id = 'duplicate-task';

  public evaluate(snapshot: EvaluationSnapshot): EvaluationViolation[] {
    const seen = new Map<string, string>();
    const findings: EvaluationViolation[] = [];
    for (const task of snapshot.tasks) {
      const key = `${task.parentTaskId ?? 'root'}|${task.assignedToAgent}|${normalize(task.objective)}`;
      const prior = seen.get(key);
      if (prior) {
        findings.push(
          violation('DUPLICATE_TASK', 'warning', 'Equivalent task was assigned repeatedly', {
            taskId: task.taskId,
            agentId: task.assignedToAgent,
            evidence: { duplicateOf: prior, objective: task.objective },
          }),
        );
      } else seen.set(key, task.taskId);
    }
    return findings;
  }
}

export class LoopEvaluator implements RuleEvaluator {
  public readonly id = 'delegation-loop';

  public evaluate(snapshot: EvaluationSnapshot): EvaluationViolation[] {
    const taskMap = new Map(snapshot.tasks.map((task) => [task.taskId, task]));
    const findings: EvaluationViolation[] = [];
    for (const task of snapshot.tasks) {
      const agents = new Set<string>();
      let current: Task | undefined = task;
      while (current) {
        if (agents.has(current.assignedToAgent)) {
          findings.push(
            violation('DELEGATION_LOOP', 'critical', 'Agent recurs in its delegation ancestry', {
              taskId: task.taskId,
              agentId: current.assignedToAgent,
            }),
          );
          break;
        }
        agents.add(current.assignedToAgent);
        current = current.parentTaskId ? taskMap.get(current.parentTaskId) : undefined;
      }
    }
    return findings;
  }
}

export class BudgetEvaluator implements RuleEvaluator {
  public readonly id = 'budget';

  public constructor(private readonly budget?: ResourceBudget) {}

  public evaluate(snapshot: EvaluationSnapshot): EvaluationViolation[] {
    const usage = collectUsage(snapshot.events);
    const budget = this.budget ?? ResourceBudgetSchema.parse({});
    const checks: [string, number, number | undefined, string][] = [
      [
        'totalTokens',
        usage.inputTokens + usage.outputTokens + usage.cachedTokens,
        budget.maxTotalTokens,
        'TOKEN_BUDGET_EXCEEDED',
      ],
      ['modelCalls', usage.modelCalls, budget.maxModelCalls, 'MODEL_CALL_BUDGET_EXCEEDED'],
      ['toolCalls', usage.toolCalls, budget.maxToolCalls, 'TOOL_CALL_BUDGET_EXCEEDED'],
      ['runtimeMs', usage.runtimeMs, budget.maxRuntimeMs, 'RUNTIME_BUDGET_EXCEEDED'],
    ];
    return checks.flatMap(([key, used, limit, code]) =>
      limit !== undefined && used > limit
        ? [
            violation(code, 'error', `${key} exceeded configured budget`, {
              evidence: { used, limit },
            }),
          ]
        : [],
    );
  }
}

export class AgentCapabilityEvaluator implements RuleEvaluator {
  public readonly id = 'agent-capability';

  public evaluate(snapshot: EvaluationSnapshot): EvaluationViolation[] {
    const agents = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
    return snapshot.tasks.flatMap((task) => {
      if (task.parentTaskId === null) return [];
      const expected = expectedCapability(task.objective);
      const agent = agents.get(task.assignedToAgent);
      return expected && agent && !agent.capabilities.includes(expected)
        ? [
            violation(
              'CAPABILITY_MISMATCH',
              'error',
              `${agent.id} lacks inferred capability ${expected}`,
              {
                taskId: task.taskId,
                agentId: agent.id,
                evidence: { expected, capabilities: agent.capabilities },
              },
            ),
          ]
        : [];
    });
  }
}

export const defaultRuleEvaluators = (): RuleEvaluator[] => [
  new DelegationDepthEvaluator(),
  new PermissionEscalationEvaluator(),
  new ContextLeakEvaluator(),
  new ToolPolicyEvaluator(),
  new RetryStormEvaluator(),
  new DuplicateTaskEvaluator(),
  new LoopEvaluator(),
  new BudgetEvaluator(),
  new AgentCapabilityEvaluator(),
];

export class DelegationEvaluator {
  public constructor(private readonly rules: readonly RuleEvaluator[] = defaultRuleEvaluators()) {}

  public evaluate(snapshot: EvaluationSnapshot): DelegationEvaluation {
    const delegationEvents = delegations(snapshot);
    const violations = this.rules.flatMap((rule) => rule.evaluate(snapshot));
    const dimensions = {
      agentSelection: dimensionScore(violations, ['CAPABILITY_MISMATCH'], 30),
      taskDecomposition: taskDecompositionScore(snapshot, violations),
      contextQuality: contextQualityScore(delegationEvents),
      contextMinimization: dimensionScore(
        violations,
        ['PROTECTED_CONTEXT_LEAK', 'SECRET_CONTEXT_LEAK'],
        50,
      ),
      permissionMinimization: permissionScore(delegationEvents, violations),
      costEfficiency: costScore(snapshot, violations),
      recursionHealth: dimensionScore(
        violations,
        ['DELEGATION_DEPTH_EXCEEDED', 'DELEGATION_LOOP', 'RETRY_STORM'],
        35,
      ),
      resultIntegration: integrationScore(snapshot, delegationEvents),
    };
    const score = round(
      Object.values(dimensions).reduce((total, value) => total + value, 0) /
        Object.keys(dimensions).length,
    );
    return DelegationEvaluationSchema.parse({
      score,
      dimensions,
      violations,
      recommendations: recommendationsFor(violations, dimensions),
      diagnosticOnly: true,
      evaluatorVersion: '3.0.0',
    });
  }
}

export class LLMJudgeEvaluator {
  public constructor(private readonly provider: ModelProvider) {}

  public async evaluate(snapshot: EvaluationSnapshot): Promise<DelegationEvaluation> {
    const agent = snapshot.agents[0];
    const task = snapshot.tasks[0];
    if (!agent || !task)
      throw new MawlError('Judge requires an agent and task', 'JUDGE_INPUT_EMPTY');
    const response = await this.provider.generate({
      agent,
      task,
      systemPrompt:
        'Evaluate delegation quality. Return a DelegationEvaluation JSON object. Scores are diagnostic, not mathematical truth.',
      context: {
        public: { snapshot: asJsonValue(compactSnapshot(snapshot)) },
        workflow: {},
        taskLocal: {},
        protected: {},
        secrets: {},
        explicitlyOmitted: [],
      },
    });
    const parsed = DelegationEvaluationSchema.safeParse(response.output);
    if (!parsed.success) {
      throw new MawlError('LLM judge returned invalid structured output', 'INVALID_JUDGE_OUTPUT', {
        issues: asJsonValue(parsed.error.issues),
      });
    }
    return parsed.data;
  }
}

export class MockJudgeEvaluator {
  public constructor(private readonly evaluator = new DelegationEvaluator()) {}
  public async evaluate(snapshot: EvaluationSnapshot): Promise<DelegationEvaluation> {
    return this.evaluator.evaluate(snapshot);
  }
}

export class WorkflowExpectation {
  public constructor(
    private readonly snapshot: EvaluationSnapshot,
    private readonly negated = false,
  ) {}

  public get not(): WorkflowExpectation {
    return new WorkflowExpectation(this.snapshot, !this.negated);
  }

  public toHaveDelegatedTo(agentId: string): this {
    return this.#assert(
      delegations(this.snapshot).some((event) => event.delegate === agentId),
      `Expected workflow ${this.negated ? 'not ' : ''}to delegate to ${agentId}`,
    );
  }

  public toHaveMaxDelegationDepth(maximum: number): this {
    const depth = Math.max(0, ...delegations(this.snapshot).map((event) => event.delegationDepth));
    return this.#assert(
      depth <= maximum,
      `Expected maximum delegation depth ${maximum}, observed ${depth}`,
    );
  }

  public toHavePermissionEscalation(): this {
    const found = new PermissionEscalationEvaluator().evaluate(this.snapshot).length > 0;
    return this.#assert(found, 'Expected permission escalation state did not match');
  }

  public toHaveUsedTool(toolName: string): this {
    const found = this.snapshot.events.some(
      (event) =>
        event.type === 'tool.requested' && stringValue(record(event.payload).toolName) === toolName,
    );
    return this.#assert(
      found,
      `Expected workflow ${this.negated ? 'not ' : ''}to use tool ${toolName}`,
    );
  }

  public toHaveCompleted(): this {
    return this.#assert(
      this.snapshot.run.status === 'completed',
      `Expected completed workflow, observed ${this.snapshot.run.status}`,
    );
  }

  #assert(condition: boolean, message: string): this {
    if (condition === this.negated) throw new MawlError(message, 'WORKFLOW_ASSERTION_FAILED');
    return this;
  }
}

export class AgentExpectation {
  public constructor(
    private readonly snapshot: EvaluationSnapshot,
    private readonly agentId: string,
    private readonly negated = false,
  ) {}

  public get not(): AgentExpectation {
    return new AgentExpectation(this.snapshot, this.agentId, !this.negated);
  }

  public toHaveUsedTool(toolName: string): this {
    const found = this.snapshot.events.some(
      (event) =>
        event.agentId === this.agentId &&
        event.type === 'tool.requested' &&
        stringValue(record(event.payload).toolName) === toolName,
    );
    if (found === this.negated) {
      throw new MawlError(
        `Expected ${this.agentId} ${this.negated ? 'not ' : ''}to use ${toolName}`,
        'AGENT_ASSERTION_FAILED',
      );
    }
    return this;
  }
}

export class TaskExpectation {
  public constructor(
    private readonly snapshot: EvaluationSnapshot,
    private readonly taskIdOrStep: string,
    private readonly negated = false,
  ) {}

  public get not(): TaskExpectation {
    return new TaskExpectation(this.snapshot, this.taskIdOrStep, !this.negated);
  }

  public toHaveReceivedContext(key: string): this {
    const task = this.snapshot.tasks.find(
      (item) => item.taskId === this.taskIdOrStep || item.metadata.stepId === this.taskIdOrStep,
    );
    const context = task ? record(task.metadata.context) : {};
    const found = Object.values(context).some(
      (section) => typeof section === 'object' && section !== null && key in section,
    );
    if (found === this.negated) {
      throw new MawlError(
        `Expected task ${this.taskIdOrStep} ${this.negated ? 'not ' : ''}to receive ${key}`,
        'TASK_ASSERTION_FAILED',
      );
    }
    return this;
  }
}

export const expectWorkflow = (snapshot: EvaluationSnapshot): WorkflowExpectation =>
  new WorkflowExpectation(snapshot);
export const expectAgent = (snapshot: EvaluationSnapshot, agentId: string): AgentExpectation =>
  new AgentExpectation(snapshot, agentId);
export const expectTask = (snapshot: EvaluationSnapshot, taskIdOrStep: string): TaskExpectation =>
  new TaskExpectation(snapshot, taskIdOrStep);

const WorkflowExpectationSchema = z.object({
  status: z
    .enum(['created', 'running', 'completed', 'failed', 'cancelled', 'timed_out'])
    .optional(),
  maxDelegationDepth: z.number().int().nonnegative().optional(),
});
const AgentExpectationSchema = z.object({
  mustDelegateTo: z.array(z.string().min(1)).default([]),
  mustUseTools: z.array(z.string().min(1)).default([]),
});
export const WorkflowTestSpecSchema = z.object({
  name: z.string().min(1),
  workflow: z.object({ file: z.string().min(1) }),
  input: z.record(z.string(), z.unknown()).default({}),
  expect: z.object({
    workflow: WorkflowExpectationSchema.default({}),
    agents: z.record(z.string(), AgentExpectationSchema).default({}),
    forbiddenTools: z.array(z.string().min(1)).default([]),
    permissions: z
      .object({ noEscalation: z.boolean().default(true) })
      .default({ noEscalation: true }),
    budget: z.object({ maxToolCalls: z.number().int().nonnegative().optional() }).default({}),
  }),
});
export type WorkflowTestSpec = z.infer<typeof WorkflowTestSpecSchema>;

export const loadWorkflowTestSpec = async (filename: string): Promise<WorkflowTestSpec> =>
  WorkflowTestSpecSchema.parse(parseYaml(await fs.readFile(filename, 'utf8')));

export class WorkflowSpecRunner {
  public constructor(
    private readonly execute: (
      workflowFile: string,
      input: Record<string, unknown>,
    ) => Promise<EvaluationSnapshot>,
  ) {}

  public async run(spec: WorkflowTestSpec): Promise<{ passed: boolean; failures: string[] }> {
    const snapshot = await this.execute(spec.workflow.file, spec.input);
    const failures: string[] = [];
    const check = (operation: () => void): void => {
      try {
        operation();
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    };
    if (spec.expect.workflow.status) {
      check(() => {
        if (snapshot.run.status !== spec.expect.workflow.status) {
          throw new Error(
            `Expected ${spec.expect.workflow.status}, observed ${snapshot.run.status}`,
          );
        }
      });
    }
    if (spec.expect.workflow.maxDelegationDepth !== undefined) {
      check(() =>
        expectWorkflow(snapshot).toHaveMaxDelegationDepth(
          spec.expect.workflow.maxDelegationDepth ?? 0,
        ),
      );
    }
    for (const [agentId, expectation] of Object.entries(spec.expect.agents)) {
      for (const target of expectation.mustDelegateTo) {
        check(() => {
          const found = delegations(snapshot).some(
            (event) => event.delegator === agentId && event.delegate === target,
          );
          if (!found) throw new Error(`Expected ${agentId} to delegate to ${target}`);
        });
      }
      for (const toolName of expectation.mustUseTools) {
        check(() => expectAgent(snapshot, agentId).toHaveUsedTool(toolName));
      }
    }
    for (const toolName of spec.expect.forbiddenTools) {
      check(() => expectWorkflow(snapshot).not.toHaveUsedTool(toolName));
    }
    if (spec.expect.permissions.noEscalation) {
      check(() => expectWorkflow(snapshot).not.toHavePermissionEscalation());
    }
    if (spec.expect.budget.maxToolCalls !== undefined) {
      const toolCalls = collectUsage(snapshot.events).toolCalls;
      if (toolCalls > spec.expect.budget.maxToolCalls) {
        failures.push(`Tool call budget exceeded: ${toolCalls}`);
      }
    }
    return { passed: failures.length === 0, failures };
  }
}

export interface RunComparison {
  runA: string;
  runB: string;
  finalOutputChanged: boolean;
  agents: { added: string[]; removed: string[] };
  delegationEdges: { added: string[]; removed: string[] };
  toolCalls: { runA: number; runB: number; delta: number };
  permissionDenials: { runA: number; runB: number; delta: number };
  runtimeMs: { runA: number; runB: number; delta: number };
  totalTokens: { runA: number; runB: number; delta: number };
  taskCount: { runA: number; runB: number; delta: number };
  failureCount: { runA: number; runB: number; delta: number };
  evaluationScore: { runA: number; runB: number; delta: number };
}

export class RunComparator {
  public compare(a: EvaluationSnapshot, b: EvaluationSnapshot): RunComparison {
    const usageA = collectUsage(a.events);
    const usageB = collectUsage(b.events);
    const agentsA = new Set(a.tasks.map((task) => task.assignedToAgent));
    const agentsB = new Set(b.tasks.map((task) => task.assignedToAgent));
    const edgesA = new Set(delegations(a).map((item) => `${item.delegator}->${item.delegate}`));
    const edgesB = new Set(delegations(b).map((item) => `${item.delegator}->${item.delegate}`));
    const scoreA = new DelegationEvaluator().evaluate(a).score;
    const scoreB = new DelegationEvaluator().evaluate(b).score;
    const failures = (snapshot: EvaluationSnapshot): number =>
      snapshot.events.filter((event) => event.type.endsWith('.failed')).length;
    return {
      runA: a.run.runId,
      runB: b.run.runId,
      finalOutputChanged:
        JSON.stringify(finalOutput(a.events)) !== JSON.stringify(finalOutput(b.events)),
      agents: { added: difference(agentsB, agentsA), removed: difference(agentsA, agentsB) },
      delegationEdges: {
        added: difference(edgesB, edgesA),
        removed: difference(edgesA, edgesB),
      },
      toolCalls: delta(usageA.toolCalls, usageB.toolCalls),
      permissionDenials: delta(
        countType(a.events, 'permission.denied'),
        countType(b.events, 'permission.denied'),
      ),
      runtimeMs: delta(usageA.runtimeMs, usageB.runtimeMs),
      totalTokens: delta(
        usageA.inputTokens + usageA.outputTokens,
        usageB.inputTokens + usageB.outputTokens,
      ),
      taskCount: delta(a.tasks.length, b.tasks.length),
      failureCount: delta(failures(a), failures(b)),
      evaluationScore: delta(scoreA, scoreB),
    };
  }
}

export interface PromptRegressionResult {
  promptId: string;
  fromVersion: string;
  toVersion: string;
  hashChanged: boolean;
  metrics: RunComparison;
  regressions: string[];
}

export class PromptRegressionEvaluator {
  public compare(
    from: RegisteredPrompt,
    to: RegisteredPrompt,
    runFrom: EvaluationSnapshot,
    runTo: EvaluationSnapshot,
  ): PromptRegressionResult {
    if (from.id !== to.id) throw new MawlError('Prompt IDs must match', 'PROMPT_ID_MISMATCH');
    const metrics = new RunComparator().compare(runFrom, runTo);
    const regressions: string[] = [];
    if (metrics.failureCount.delta > 0) regressions.push('Failure count increased');
    if (metrics.permissionDenials.delta > 0) regressions.push('Permission denials increased');
    if (metrics.totalTokens.delta > 0) regressions.push('Token usage increased');
    if (metrics.evaluationScore.delta < 0) regressions.push('Delegation score decreased');
    return {
      promptId: from.id,
      fromVersion: from.version,
      toVersion: to.version,
      hashChanged: from.contentHash !== to.contentHash,
      metrics,
      regressions,
    };
  }
}

export interface PromptQualityIssue {
  promptId: string;
  version: string;
  code: string;
  message: string;
}

export class PromptQualityValidator {
  public validate(
    prompts: readonly RegisteredPrompt[],
    knownAgents: readonly string[] = [],
    knownTools: readonly string[] = [],
    expectedHashes: Readonly<Record<string, string>> = {},
  ): PromptQualityIssue[] {
    const issues: PromptQualityIssue[] = [];
    const seen = new Set<string>();
    for (const prompt of prompts) {
      const key = `${prompt.id}@${prompt.version}`;
      const add = (code: string, message: string): void => {
        issues.push({ promptId: prompt.id, version: prompt.version, code, message });
      };
      if (seen.has(key)) add('DUPLICATE_PROMPT', `Duplicate prompt asset ${key}`);
      seen.add(key);
      if (!/^\d+\.\d+\.\d+$/u.test(prompt.version)) add('INVALID_VERSION', 'Version is not semver');
      const expectedHash = expectedHashes[key];
      if (expectedHash !== undefined && expectedHash !== prompt.contentHash) {
        add('UNEXPECTED_HASH_CHANGE', `Content hash changed for ${key}`);
      }
      for (const metadata of [
        'purpose',
        'expectedInput',
        'expectedOutput',
        'allowedActions',
        'recommendedCapabilities',
        'knownRisks',
      ]) {
        if (prompt.metadata[metadata] === undefined) {
          add('MISSING_METADATA', `Missing metadata.${metadata}`);
        }
      }
      const placeholders = [...prompt.content.matchAll(/\{\{\s*([\w.]+)\s*\}\}/gu)].map(
        (match) => match[1] ?? '',
      );
      for (const declared of Object.keys(prompt.inputSchema)) {
        if (!placeholders.includes(declared)) add('MISSING_VARIABLE', `${declared} is never used`);
      }
      for (const placeholder of placeholders) {
        if (!(placeholder in prompt.inputSchema)) {
          add('UNRESOLVED_PLACEHOLDER', `${placeholder} is not declared`);
        }
      }
      for (const agent of stringArray(prompt.metadata.referencedAgents)) {
        if (!knownAgents.includes(agent))
          add('UNDECLARED_AGENT', `Unknown agent reference ${agent}`);
      }
      for (const tool of stringArray(prompt.metadata.referencedTools)) {
        if (!knownTools.includes(tool)) add('UNDECLARED_TOOL', `Unknown tool reference ${tool}`);
      }
    }
    return issues;
  }
}

export const snapshotFromEvents = (
  events: readonly RuntimeEvent[],
  agents: readonly AgentDefinition[],
): EvaluationSnapshot => {
  const first = events[0];
  if (!first) throw new MawlError('Cannot create snapshot from empty events', 'EMPTY_TRACE');
  const workflowPayload = events.find((event) => event.type === 'workflow.created')?.payload;
  const parsedRun = WorkflowRunSchema.safeParse(workflowPayload);
  const tasks = events
    .filter((event) => event.type === 'task.created')
    .flatMap((event) => {
      const parsed = TaskSchema.safeParse(event.payload);
      return parsed.success ? [parsed.data] : [];
    });
  const run = parsedRun.success
    ? parsedRun.data
    : WorkflowRunSchema.parse({
        workflowId: first.workflowId,
        runId: first.workflowId,
        status: inferRunStatus(events),
        rootTaskId: tasks[0]?.taskId ?? 'task:unknown',
        taskIds: tasks.map((task) => task.taskId),
        startedAt: first.timestamp,
        finishedAt: events.at(-1)?.timestamp ?? null,
        traceId: first.traceId,
        metadata: {},
      });
  run.status = inferRunStatus(events);
  return {
    run,
    tasks,
    events: [...events],
    agents: agents.map((agent) => AgentDefinitionSchema.parse(agent)),
  };
};

export const collectUsage = (events: readonly RuntimeEvent[]): Usage => {
  let inputTokens = 0;
  let outputTokens = 0;
  let runtimeMs = 0;
  let sandboxMs = 0;
  let modelCalls = 0;
  let toolCalls = 0;
  for (const event of events) {
    const payload = record(event.payload);
    if (event.type === 'agent.output') {
      modelCalls += 1;
      const tokens = record(payload.tokenUsage);
      inputTokens += numberValue(tokens.input);
      outputTokens += numberValue(tokens.output);
      runtimeMs += numberValue(payload.durationMs);
    }
    if (event.type === 'agent.runtime.completed' || event.type === 'agent.runtime.failed') {
      const counters = record(payload.counters);
      modelCalls += numberValue(counters.turns);
      inputTokens += numberValue(counters.tokens);
    }
    if (event.type === 'tool.requested') toolCalls += 1;
    if (event.type === 'sandbox.completed') sandboxMs += numberValue(payload.durationMs);
  }
  return UsageSchema.parse({
    inputTokens,
    outputTokens,
    modelCalls,
    toolCalls,
    runtimeMs,
    sandboxMs,
  });
};

const delegations = (snapshot: EvaluationSnapshot): DelegationEvent[] =>
  snapshot.events.flatMap((event) => {
    if (event.type !== 'delegation.created') return [];
    const parsed = DelegationEventSchema.safeParse(event.payload);
    return parsed.success ? [parsed.data] : [];
  });

const taskDecompositionScore = (
  snapshot: EvaluationSnapshot,
  violations: readonly EvaluationViolation[],
): number => {
  const childTasks = snapshot.tasks.filter((task) => task.parentTaskId !== null);
  let score = dimensionScore(violations, ['DUPLICATE_TASK'], 25);
  for (const task of childTasks) {
    if (task.objective.trim().length < 18 || task.objective.length > 500) score -= 15;
  }
  return clamp(score);
};

const contextQualityScore = (events: readonly DelegationEvent[]): number => {
  if (events.length === 0) return 100;
  const empty = events.filter(
    (event) =>
      Object.keys(event.contextPassed.public).length === 0 &&
      Object.keys(event.contextPassed.workflow).length === 0,
  ).length;
  return clamp(100 - (empty / events.length) * 30);
};

const permissionScore = (
  events: readonly DelegationEvent[],
  violations: readonly EvaluationViolation[],
): number => {
  let score = dimensionScore(violations, ['PERMISSION_ESCALATION'], 60);
  const excessive = events.filter((event) => event.permissionsDelegated.length > 3).length;
  score -= excessive * 12;
  return clamp(score);
};

const costScore = (
  snapshot: EvaluationSnapshot,
  violations: readonly EvaluationViolation[],
): number => {
  let score = dimensionScore(
    violations,
    ['RETRY_STORM', 'TOKEN_BUDGET_EXCEEDED', 'TOOL_CALL_BUDGET_EXCEEDED'],
    25,
  );
  const trivial = snapshot.tasks.filter(
    (task) => task.parentTaskId !== null && task.objective.trim().split(/\s+/u).length < 4,
  ).length;
  score -= trivial * 10;
  return clamp(score);
};

const integrationScore = (
  snapshot: EvaluationSnapshot,
  events: readonly DelegationEvent[],
): number => {
  if (events.length === 0) return 100;
  const integrated = new Set(
    snapshot.events
      .filter((event) =>
        ['delegation.result.accepted', 'delegation.result.integrated'].includes(event.type),
      )
      .map((event) => stringValue(record(event.payload).childTaskId))
      .filter(Boolean),
  );
  const completedChildren = events.filter((event) =>
    snapshot.events.some(
      (runtimeEvent) =>
        runtimeEvent.taskId === event.taskId && runtimeEvent.type === 'task.completed',
    ),
  );
  const evidenceCount = events.filter(
    (event) => integrated.has(event.taskId) || completedChildren.includes(event),
  ).length;
  return clamp((evidenceCount / events.length) * 100);
};

const dimensionScore = (
  violations: readonly EvaluationViolation[],
  codes: readonly string[],
  penalty: number,
): number => clamp(100 - violations.filter((item) => codes.includes(item.code)).length * penalty);

const recommendationsFor = (
  violations: readonly EvaluationViolation[],
  dimensions: DelegationEvaluation['dimensions'],
): string[] => {
  const recommendations = new Set<string>();
  for (const item of violations) {
    if (item.code.includes('PERMISSION'))
      recommendations.add('Reduce child permissions to the minimum required set.');
    if (item.code.includes('CONTEXT'))
      recommendations.add('Pass only minimal sufficient public/workflow context.');
    if (item.code.includes('LOOP') || item.code.includes('DEPTH'))
      recommendations.add('Reduce delegation depth and prevent recursive agent ancestry.');
    if (item.code.includes('TOOL'))
      recommendations.add('Align tool use with explicit agent allowlists and task necessity.');
    if (item.code.includes('CAPABILITY'))
      recommendations.add('Select a specialist whose declared capabilities match the task.');
  }
  if (dimensions.resultIntegration < 100) {
    recommendations.add('Record how each child result was accepted, rejected, or integrated.');
  }
  if (recommendations.size === 0)
    recommendations.add(
      'No deterministic delegation issue detected; review qualitative judgment separately.',
    );
  return [...recommendations];
};

const compactSnapshot = (snapshot: EvaluationSnapshot): JsonValue => ({
  run: asJsonValue(snapshot.run),
  tasks: asJsonValue(snapshot.tasks),
  events: asJsonValue(
    snapshot.events.map(({ type, taskId, agentId, payload }) => ({
      type,
      taskId,
      agentId,
      payload,
    })),
  ),
  agents: asJsonValue(
    snapshot.agents.map(({ id, capabilities, allowedTools, permissionProfile }) => ({
      id,
      capabilities,
      allowedTools,
      permissionProfile,
    })),
  ),
});

const inferRunStatus = (events: readonly RuntimeEvent[]): WorkflowRun['status'] => {
  if (events.some((event) => event.type === 'workflow.completed')) return 'completed';
  if (events.some((event) => event.type === 'workflow.failed')) return 'failed';
  if (events.some((event) => event.type === 'workflow.cancelled')) return 'cancelled';
  if (events.some((event) => event.type === 'workflow.timed_out')) return 'timed_out';
  return 'running';
};

const expectedCapability = (objective: string): string | undefined => {
  const lower = objective.toLowerCase();
  if (/research|investigate|evidence|t\u00ecm hi\u1ec3u|nghi\u00ean c\u1ee9u/u.test(lower))
    return 'research';
  if (/analy|synthesi|ph\u00e2n t\u00edch|t\u1ed5ng h\u1ee3p/u.test(lower)) return 'analysis';
  if (/review|verify|ki\u1ec3m tra|\u0111\u00e1nh gi\u00e1/u.test(lower)) return 'review';
  if (/evaluat|score|ch\u1ea5m \u0111i\u1ec3m/u.test(lower)) return 'evaluation';
  return undefined;
};

const finalOutput = (events: readonly RuntimeEvent[]): JsonValue => {
  const output = [...events].reverse().find((event) => event.type === 'agent.output');
  return output ? ((record(output.payload).output as JsonValue | undefined) ?? null) : null;
};

const difference = (left: ReadonlySet<string>, right: ReadonlySet<string>): string[] =>
  [...left].filter((value) => !right.has(value)).sort();

const delta = (runA: number, runB: number): { runA: number; runB: number; delta: number } => ({
  runA,
  runB,
  delta: round(runB - runA),
});

const countType = (events: readonly RuntimeEvent[], type: string): number =>
  events.filter((event) => event.type === type).length;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const stringValue = (value: unknown): string => (typeof value === 'string' ? value : '');
const numberValue = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;
const stringArray = (value: JsonValue | undefined): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const normalize = (value: string): string => value.toLowerCase().replace(/\s+/gu, ' ').trim();
const clamp = (value: number): number => Math.max(0, Math.min(100, round(value)));
const round = (value: number): number => Math.round(value * 100) / 100;

export const evaluationTimestamp = (): string => nowIso();
