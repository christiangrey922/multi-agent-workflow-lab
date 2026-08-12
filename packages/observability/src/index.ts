import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import {
  ApprovalDecisionSchema,
  MonitorAlertSchema,
  ResourceBudgetSchema,
  RuntimeEventSchema,
  UsageSchema,
  asJsonValue,
  createId,
  nowIso,
  type ApprovalDecision,
  type ApprovalRequest,
  type JsonValue,
  type MonitorAlert,
  type ResourceBudget,
  type RuntimeEvent,
  type Usage,
} from '@mawl/core';

export interface EventSink {
  appendEvent(event: RuntimeEvent): Promise<void>;
}

export interface EmitEventInput {
  type: string;
  workflowId: string;
  taskId?: string | null;
  agentId?: string | null;
  traceId: string;
  spanId?: string;
  payload?: unknown;
}

export class EventBus {
  readonly #events: RuntimeEvent[] = [];
  readonly #subscribers = new Set<(event: RuntimeEvent) => void | Promise<void>>();

  public constructor(private readonly sink?: EventSink) {}

  public async emit(input: EmitEventInput): Promise<RuntimeEvent> {
    const event = RuntimeEventSchema.parse({
      eventId: createId('event'),
      type: input.type,
      timestamp: nowIso(),
      workflowId: input.workflowId,
      taskId: input.taskId ?? null,
      agentId: input.agentId ?? null,
      traceId: input.traceId,
      spanId: input.spanId ?? createId('span'),
      payload: asJsonValue(input.payload ?? {}),
    });
    this.#events.push(event);
    if (this.sink) await this.sink.appendEvent(event);
    await Promise.all([...this.#subscribers].map(async (subscriber) => subscriber(event)));
    return event;
  }

  public subscribe(subscriber: (event: RuntimeEvent) => void | Promise<void>): () => void {
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  }

  public events(): readonly RuntimeEvent[] {
    return [...this.#events];
  }
}

export interface StructuredLogger {
  info(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export class JsonLogger implements StructuredLogger {
  public constructor(private readonly write: (line: string) => void = console.log) {}

  public info(message: string, data: Record<string, unknown> = {}): void {
    this.#log('info', message, data);
  }

  public error(message: string, data: Record<string, unknown> = {}): void {
    this.#log('error', message, data);
  }

  #log(level: string, message: string, data: Record<string, unknown>): void {
    this.write(
      JSON.stringify({
        timestamp: nowIso(),
        level,
        message,
        data: asJsonValue(data),
      }),
    );
  }
}

/** Deterministic, human-readable task tree with security decisions in-line. */
export class HumanTraceRenderer {
  public render(events: readonly RuntimeEvent[]): string {
    const depths = new Map<string, number>();
    const lines: string[] = [];
    for (const event of events) {
      const payload = asRecord(event.payload);
      const taskId = event.taskId ?? undefined;
      if (event.type === 'task.created' && taskId) {
        const taskPayload = asRecord(event.payload);
        const metadata = asRecord(taskPayload.metadata);
        depths.set(taskId, numberValue(metadata.delegationDepth));
      }
      const depth = taskId ? (depths.get(taskId) ?? 0) : 0;
      const prefix = '  '.repeat(depth);
      const subject = taskId ? `${taskId} ` : '';
      lines.push(
        `${prefix}${formatTime(event.timestamp)} ${subject}${describe(event.type, payload)}`,
      );
    }
    return lines.join('\n');
  }
}

const describe = (type: string, payload: Record<string, unknown>): string => {
  if (type === 'delegation.requested') {
    return `delegation requested -> ${textValue(payload.targetAgentId)} (${textValue(payload.objective)})`;
  }
  if (type === 'delegation.allowed' || type === 'delegation.created') {
    return `${type}: ${textValue(payload.delegate ?? payload.delegationId)}`;
  }
  if (type === 'delegation.denied' || type === 'delegation.permission.denied') {
    return `DENY delegation: ${textValue(payload.reason)} [${textValue(payload.rule ?? payload.permission)}]`;
  }
  if (type === 'permission.allowed' || type === 'permission.denied') {
    return `${type === 'permission.allowed' ? 'ALLOW' : 'DENY'} permission ${textValue(payload.permission)} on ${textValue(payload.resource)}: ${textValue(payload.reason)}`;
  }
  if (type === 'policy.allowed' || type === 'policy.denied') {
    return `${type === 'policy.allowed' ? 'ALLOW' : 'DENY'} policy ${textValue(payload.policyId)}: ${textValue(payload.reason)}`;
  }
  if (type.startsWith('tool.')) {
    return `${type} ${textValue(payload.toolName)}${payload.errorCode ? ` [${textValue(payload.errorCode)}]` : ''}${payload.error ? `: ${textValue(payload.error)}` : ''}`;
  }
  if (type === 'agent.action.parsed') return `agent action: ${textValue(payload.action)}`;
  if (type === 'agent.action.invalid') {
    return `REJECT invalid agent action [${textValue(payload.code)}]: ${textValue(payload.message)}`;
  }
  if (type === 'prompt.assembled') return `prompt assembled ${textValue(payload.promptHash)}`;
  return type;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const textValue = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : '-';

const numberValue = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

const formatTime = (timestamp: string): string => timestamp.slice(11, 23);

export interface PricingEntry {
  provider: string;
  model: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cachedPerMillion?: number;
  currency?: string;
}

export class UsageTracker {
  readonly #usage = UsageSchema.parse({});

  public add(delta: Partial<Usage>): Usage {
    for (const key of [
      'inputTokens',
      'outputTokens',
      'cachedTokens',
      'modelCalls',
      'toolCalls',
      'runtimeMs',
      'sandboxMs',
    ] as const) {
      this.#usage[key] += delta[key] ?? 0;
    }
    return this.snapshot();
  }

  public estimate(provider: string, model: string, table: readonly PricingEntry[]): Usage {
    const price = table.find((entry) => entry.provider === provider && entry.model === model);
    if (!price) return this.snapshot();
    this.#usage.estimatedCost =
      (this.#usage.inputTokens / 1_000_000) * price.inputPerMillion +
      (this.#usage.outputTokens / 1_000_000) * price.outputPerMillion +
      (this.#usage.cachedTokens / 1_000_000) * (price.cachedPerMillion ?? 0);
    this.#usage.currency = price.currency ?? 'USD';
    return this.snapshot();
  }

  public snapshot(): Usage {
    return UsageSchema.parse(structuredClone(this.#usage));
  }
}

export interface BudgetDecision {
  allowed: boolean;
  exhausted: string[];
  action: ResourceBudget['onExhausted'];
}

export class BudgetEnforcer {
  readonly #budget: ResourceBudget;

  public constructor(
    budget: ResourceBudget,
    private readonly onExhausted?: (decision: BudgetDecision) => void | Promise<void>,
  ) {
    this.#budget = ResourceBudgetSchema.parse(budget);
  }

  public async evaluate(usage: Usage): Promise<BudgetDecision> {
    const exhausted: string[] = [];
    const totalTokens = usage.inputTokens + usage.outputTokens + usage.cachedTokens;
    if (this.#budget.maxTotalTokens !== undefined && totalTokens >= this.#budget.maxTotalTokens) {
      exhausted.push('maxTotalTokens');
    }
    if (
      this.#budget.maxModelCalls !== undefined &&
      usage.modelCalls >= this.#budget.maxModelCalls
    ) {
      exhausted.push('maxModelCalls');
    }
    if (this.#budget.maxToolCalls !== undefined && usage.toolCalls >= this.#budget.maxToolCalls) {
      exhausted.push('maxToolCalls');
    }
    if (this.#budget.maxRuntimeMs !== undefined && usage.runtimeMs >= this.#budget.maxRuntimeMs) {
      exhausted.push('maxRuntimeMs');
    }
    const decision = {
      allowed: exhausted.length === 0,
      exhausted,
      action: this.#budget.onExhausted,
    } satisfies BudgetDecision;
    if (!decision.allowed && this.onExhausted) await this.onExhausted(decision);
    return decision;
  }
}

export interface ApprovalProvider {
  decide(request: ApprovalRequest): Promise<ApprovalDecision>;
}

export class AutoApproveProvider implements ApprovalProvider {
  public constructor(
    private readonly approved = true,
    private readonly identity = 'service:auto-approver',
  ) {}

  public async decide(request: ApprovalRequest): Promise<ApprovalDecision> {
    return ApprovalDecisionSchema.parse({
      requestId: request.requestId,
      approved: this.approved,
      decidedBy: this.identity,
      reason: this.approved
        ? 'Automatically approved for deterministic test'
        : 'Automatically denied',
      decidedAt: nowIso(),
    });
  }
}

export class CliApprovalProvider implements ApprovalProvider {
  public async decide(request: ApprovalRequest): Promise<ApprovalDecision> {
    const terminal = createInterface({ input: stdin, output: stdout });
    try {
      const answer = await terminal.question(
        `Approve ${request.operation} on ${request.resource}? [y/N] `,
      );
      const approved = /^y(es)?$/iu.test(answer.trim());
      return ApprovalDecisionSchema.parse({
        requestId: request.requestId,
        approved,
        decidedBy: 'user:cli',
        reason: approved ? 'Approved interactively' : 'Denied interactively',
        decidedAt: nowIso(),
      });
    } finally {
      terminal.close();
    }
  }
}

export interface ApprovalPolicy {
  operations: string[];
  riskTypes: string[];
  delegationDepthAbove?: number;
}

export const requiresApproval = (
  policy: ApprovalPolicy,
  input: { operation: string; riskTypes: readonly string[]; delegationDepth?: number },
): boolean =>
  policy.operations.includes(input.operation) ||
  input.riskTypes.some((risk) => policy.riskTypes.includes(risk)) ||
  (policy.delegationDepthAbove !== undefined &&
    (input.delegationDepth ?? 0) > policy.delegationDepthAbove);

export interface RuntimeMonitor {
  readonly id: string;
  inspect(event: RuntimeEvent, history: readonly RuntimeEvent[]): MonitorAlert[];
}

abstract class ThresholdMonitor implements RuntimeMonitor {
  public abstract readonly id: string;
  public constructor(
    protected readonly eventTypes: readonly string[],
    protected readonly threshold: number,
    protected readonly severity: MonitorAlert['severity'] = 'warning',
    protected readonly terminate = false,
  ) {}

  public inspect(event: RuntimeEvent, history: readonly RuntimeEvent[]): MonitorAlert[] {
    if (!this.eventTypes.includes(event.type)) return [];
    const count = history.filter((item) => this.eventTypes.includes(item.type)).length;
    return count >= this.threshold
      ? [
          MonitorAlertSchema.parse({
            alertId: createId('alert'),
            monitor: this.id,
            severity: this.severity,
            workflowId: event.workflowId,
            taskId: event.taskId,
            message: `${this.id} observed ${count} matching events`,
            terminate: this.terminate,
            timestamp: nowIso(),
            evidence: { count, threshold: this.threshold },
          }),
        ]
      : [];
  }
}

export class ExcessiveDelegationMonitor extends ThresholdMonitor {
  public readonly id = 'excessive-delegation';
  public constructor(threshold = 10) {
    super(['delegation.requested'], threshold, 'warning');
  }
}

export class PrivilegeEscalationMonitor extends ThresholdMonitor {
  public readonly id = 'privilege-escalation';
  public constructor() {
    super(['delegation.permission.denied', 'permission.denied'], 1, 'critical', true);
  }
}

export class SecretExposureMonitor extends ThresholdMonitor {
  public readonly id = 'secret-exposure';
  public constructor() {
    super(['secret.exposure.detected'], 1, 'critical', true);
  }
}

export class HighCostMonitor implements RuntimeMonitor {
  public readonly id = 'high-cost';
  public constructor(private readonly maximumTokens = 100_000) {}

  public inspect(event: RuntimeEvent, history: readonly RuntimeEvent[]): MonitorAlert[] {
    const tokens = history.reduce((total, item) => {
      if (item.type !== 'agent.output') return total;
      const usage = asRecord(asRecord(item.payload).tokenUsage);
      return total + numberValue(usage.input) + numberValue(usage.output);
    }, 0);
    return tokens >= this.maximumTokens
      ? [alert(this.id, 'error', event, `Token usage reached ${tokens}`, false, { tokens })]
      : [];
  }
}

export class InfiniteLoopMonitor extends ThresholdMonitor {
  public readonly id = 'infinite-loop';
  public constructor(threshold = 12) {
    super(['agent.action.parsed'], threshold, 'critical', true);
  }
}

export class ToolAbuseMonitor extends ThresholdMonitor {
  public readonly id = 'tool-abuse';
  public constructor(threshold = 20) {
    super(['tool.requested'], threshold, 'error', true);
  }
}

export class ContextGrowthMonitor implements RuntimeMonitor {
  public readonly id = 'context-growth';
  public constructor(private readonly maximumBytes = 262_144) {}

  public inspect(event: RuntimeEvent): MonitorAlert[] {
    if (event.type !== 'prompt.assembled') return [];
    const bytes = Buffer.byteLength(JSON.stringify(event.payload), 'utf8');
    return bytes > this.maximumBytes
      ? [alert(this.id, 'error', event, `Prompt metadata grew to ${bytes} bytes`, false, { bytes })]
      : [];
  }
}

export class ExcessiveRetryMonitor extends ThresholdMonitor {
  public readonly id = 'excessive-retry';
  public constructor(threshold = 4) {
    super(['agent.action.invalid', 'task.retry', 'tool.retry'], threshold, 'error', true);
  }
}

export const defaultMonitors = (): RuntimeMonitor[] => [
  new ExcessiveDelegationMonitor(),
  new PrivilegeEscalationMonitor(),
  new SecretExposureMonitor(),
  new HighCostMonitor(),
  new InfiniteLoopMonitor(),
  new ToolAbuseMonitor(),
  new ContextGrowthMonitor(),
  new ExcessiveRetryMonitor(),
];

export interface ObservabilityMetrics {
  workflow_duration: number;
  agent_execution_duration: number;
  delegation_count: number;
  delegation_depth: number;
  tool_call_count: number;
  tool_failure_count: number;
  permission_denial_count: number;
  sandbox_failure_count: number;
  token_usage: number;
  task_count: number;
  retry_count: number;
}

export class ObservabilityManager {
  readonly #history: RuntimeEvent[] = [];
  readonly #alerts: MonitorAlert[] = [];
  readonly #logs: string[] = [];
  #unsubscribe: (() => void) | undefined;

  public constructor(private readonly monitors: readonly RuntimeMonitor[] = defaultMonitors()) {}

  public attach(bus: EventBus): void {
    this.#unsubscribe?.();
    this.#unsubscribe = bus.subscribe((event) => this.record(event));
  }

  public record(event: RuntimeEvent): void {
    this.#history.push(event);
    for (const monitor of this.monitors) {
      this.#alerts.push(...monitor.inspect(event, this.#history));
    }
    this.#logs.push(
      JSON.stringify({
        timestamp: event.timestamp,
        level: this.#alerts.at(-1)?.severity ?? 'info',
        eventType: event.type,
        workflowId: event.workflowId,
        taskId: event.taskId,
        agentId: event.agentId,
      }),
    );
  }

  public metrics(): ObservabilityMetrics {
    const duration = durationBetween(
      this.#history.at(0)?.timestamp,
      this.#history.at(-1)?.timestamp,
    );
    const agentDuration = this.#history.reduce((total, event) => {
      if (event.type !== 'agent.output') return total;
      return total + numberValue(asRecord(event.payload).durationMs);
    }, 0);
    const tokenUsage = this.#history.reduce((total, event) => {
      if (event.type !== 'agent.output') return total;
      const usage = asRecord(asRecord(event.payload).tokenUsage);
      return total + numberValue(usage.input) + numberValue(usage.output);
    }, 0);
    const depths = this.#history
      .filter((event) => event.type === 'delegation.created')
      .map((event) => numberValue(asRecord(event.payload).delegationDepth));
    return {
      workflow_duration: duration,
      agent_execution_duration: agentDuration,
      delegation_count: countEvents(this.#history, 'delegation.created'),
      delegation_depth: Math.max(0, ...depths),
      tool_call_count: countEvents(this.#history, 'tool.requested'),
      tool_failure_count: countEvents(this.#history, 'tool.failed'),
      permission_denial_count: countEvents(this.#history, 'permission.denied'),
      sandbox_failure_count: countEvents(this.#history, 'sandbox.failed'),
      token_usage: tokenUsage,
      task_count: countEvents(this.#history, 'task.created'),
      retry_count: this.#history.filter((event) => event.type.includes('retry')).length,
    };
  }

  public alerts(): readonly MonitorAlert[] {
    return [...this.#alerts];
  }

  public logs(): readonly string[] {
    return [...this.#logs];
  }

  public shouldTerminate(): boolean {
    return this.#alerts.some((item) => item.terminate);
  }

  public detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }
}

export class TraceTreeRenderer {
  public render(events: readonly RuntimeEvent[]): string {
    const first = events[0];
    if (!first) return 'Workflow <empty>';
    const tasks = new Map<
      string,
      { agent: string; parent: string | null; events: RuntimeEvent[] }
    >();
    for (const event of events) {
      if (!event.taskId) continue;
      const current = tasks.get(event.taskId) ?? {
        agent: event.agentId ?? 'unknown',
        parent: null,
        events: [],
      };
      if (event.type === 'task.created') {
        const task = asRecord(event.payload);
        current.parent = stringOrNull(task.parentTaskId);
        current.agent = stringValue(task.assignedToAgent) || current.agent;
      }
      current.events.push(event);
      tasks.set(event.taskId, current);
    }
    const roots = [...tasks.entries()].filter(
      ([, task]) => !task.parent || !tasks.has(task.parent),
    );
    const lines = [`Workflow ${first.workflowId}`];
    const renderTask = (taskId: string, prefix: string, isLast: boolean): void => {
      const task = tasks.get(taskId);
      if (!task) return;
      lines.push(`${prefix}${isLast ? '└──' : '├──'} ${task.agent} (${taskId})`);
      const childPrefix = `${prefix}${isLast ? '    ' : '│   '}`;
      const notable = task.events.filter((event) =>
        [
          'agent.started',
          'agent.action.parsed',
          'tool.requested',
          'tool.completed',
          'tool.failed',
          'delegation.requested',
          'delegation.result.accepted',
          'task.completed',
          'task.failed',
        ].includes(event.type),
      );
      const children = [...tasks.entries()].filter(([, candidate]) => candidate.parent === taskId);
      notable.forEach((event, index) => {
        const duration = numberValue(asRecord(event.payload).durationMs);
        const suffix = duration > 0 ? ` ${Math.round(duration)}ms` : '';
        const hasFollowing = index < notable.length - 1 || children.length > 0;
        lines.push(`${childPrefix}${hasFollowing ? '├──' : '└──'} ${traceLabel(event)}${suffix}`);
      });
      children.forEach(([childId], index) =>
        renderTask(childId, childPrefix, index === children.length - 1),
      );
    };
    roots.forEach(([taskId], index) => renderTask(taskId, '', index === roots.length - 1));
    return lines.join('\n');
  }
}

export class MermaidDelegationGraph {
  public render(events: readonly RuntimeEvent[]): string {
    const nodes = new Map<string, string>();
    const edges = new Set<string>();
    for (const event of events) {
      if (event.taskId && event.agentId) nodes.set(event.agentId, event.agentId);
      if (event.type === 'delegation.created') {
        const payload = asRecord(event.payload);
        const parent = stringValue(payload.delegator);
        const child = stringValue(payload.delegate);
        if (parent && child) edges.add(`${safeMermaid(parent)} --> ${safeMermaid(child)}`);
      }
      if (event.type === 'tool.requested' && event.agentId) {
        const tool = stringValue(asRecord(event.payload).toolName);
        if (tool) edges.add(`${safeMermaid(event.agentId)} --> ${safeMermaid(tool)}`);
      }
    }
    return [
      'graph TD',
      ...[...nodes].map(([id, label]) => `  ${safeMermaid(id)}["${label}"]`),
      ...[...edges].map((edge) => `  ${edge}`),
    ].join('\n');
  }
}

const alert = (
  monitor: string,
  severity: MonitorAlert['severity'],
  event: RuntimeEvent,
  message: string,
  terminate: boolean,
  evidence: Record<string, JsonValue>,
): MonitorAlert =>
  MonitorAlertSchema.parse({
    alertId: createId('alert'),
    monitor,
    severity,
    workflowId: event.workflowId,
    taskId: event.taskId,
    message,
    terminate,
    timestamp: nowIso(),
    evidence,
  });

const durationBetween = (start?: string, end?: string): number =>
  start && end ? Math.max(0, Date.parse(end) - Date.parse(start)) : 0;
const countEvents = (events: readonly RuntimeEvent[], type: string): number =>
  events.filter((event) => event.type === type).length;
const stringValue = (value: unknown): string => (typeof value === 'string' ? value : '');
const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const traceLabel = (event: RuntimeEvent): string => {
  const payload = asRecord(event.payload);
  if (event.type === 'agent.action.parsed') return `model action ${stringValue(payload.action)}`;
  if (event.type === 'tool.requested') return `tool ${stringValue(payload.toolName)}`;
  if (event.type === 'delegation.requested')
    return `delegate to ${stringValue(payload.targetAgentId)}`;
  return event.type;
};
const safeMermaid = (value: string): string => `n_${Buffer.from(value).toString('hex')}`;
