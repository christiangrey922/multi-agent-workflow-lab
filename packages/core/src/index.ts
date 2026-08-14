import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

export const IdSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
export const IsoDateSchema = z.iso.datetime();
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const ExecutionBudgetSchema = z.object({
  maxTokens: z.number().int().nonnegative().default(10_000),
  maxToolCalls: z.number().int().nonnegative().default(20),
  maxRuntimeMs: z.number().int().positive().default(60_000),
});
export type ExecutionBudget = z.infer<typeof ExecutionBudgetSchema>;

export const ExecutionLimitsSchema = z.object({
  maxAgentTurns: z.number().int().positive().default(10),
  maxToolCalls: z.number().int().nonnegative().default(20),
  maxDelegations: z.number().int().nonnegative().default(8),
  maxErrors: z.number().int().nonnegative().default(3),
  maxRetries: z.number().int().nonnegative().default(2),
  maxRuntimeMs: z.number().int().positive().default(60_000),
  maxTokenBudget: z.number().int().nonnegative().default(10_000),
  maxOutputBytes: z.number().int().positive().default(1_048_576),
});

export const DelegationPolicySchema = z.object({
  allowed: z.boolean().default(false),
  maxDepth: z.number().int().nonnegative().default(0),
  allowedTargets: z.array(IdSchema).default([]),
  allowedCapabilities: z.array(z.string().min(1)).default([]),
  maxChildTasks: z.number().int().nonnegative().default(0),
});

export const PermissionProfileSchema = z.object({
  grants: z.array(z.string().min(1)).default([]),
  denied: z.array(z.string().min(1)).default([]),
  allowSecrets: z.boolean().default(false),
});

export const AgentDefinitionSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  description: z.string().default(''),
  role: z.string().min(1),
  capabilities: z.array(z.string().min(1)).default([]),
  systemPrompt: z.string().min(1),
  systemPromptVersion: z.string().min(1),
  allowedTools: z.array(z.string().min(1)).default([]),
  allowedMcpServers: z.array(z.string().min(1)).default([]),
  permissionProfile: PermissionProfileSchema.default({
    grants: [],
    denied: [],
    allowSecrets: false,
  }),
  delegationPolicy: DelegationPolicySchema.default({
    allowed: false,
    maxDepth: 0,
    allowedTargets: [],
    allowedCapabilities: [],
    maxChildTasks: 0,
  }),
  model: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    temperature: z.number().min(0).max(2).default(0),
  }),
  executionLimits: ExecutionLimitsSchema.default({
    maxAgentTurns: 10,
    maxToolCalls: 20,
    maxDelegations: 8,
    maxErrors: 3,
    maxRetries: 2,
    maxRuntimeMs: 60_000,
    maxTokenBudget: 10_000,
    maxOutputBytes: 1_048_576,
  }),
  metadata: z.record(z.string(), JsonValueSchema).default({}),
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

export const TaskStatusSchema = z.enum([
  'created',
  'queued',
  'assigned',
  'running',
  'waiting_for_tool',
  'waiting_for_agent',
  'completed',
  'failed',
  'rejected',
  'cancelled',
  'timed_out',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSchema = z.object({
  taskId: IdSchema,
  parentTaskId: IdSchema.nullable(),
  rootTaskId: IdSchema,
  workflowId: IdSchema,
  createdByAgent: IdSchema,
  assignedToAgent: IdSchema,
  objective: z.string().min(1),
  instructions: z.string().default(''),
  input: JsonValueSchema.default({}),
  expectedOutput: z.string().default(''),
  constraints: z.array(z.string()).default([]),
  priority: z.number().int().min(0).max(100).default(50),
  status: TaskStatusSchema.default('created'),
  createdAt: IsoDateSchema,
  startedAt: IsoDateSchema.nullable().default(null),
  finishedAt: IsoDateSchema.nullable().default(null),
  deadline: IsoDateSchema.nullable().default(null),
  retryPolicy: z.object({
    maxRetries: z.number().int().nonnegative().default(0),
    backoffMs: z.number().int().nonnegative().default(0),
  }),
  executionBudget: ExecutionBudgetSchema,
  metadata: z.record(z.string(), JsonValueSchema).default({}),
});
export type Task = z.infer<typeof TaskSchema>;

export const ContextEnvelopeSchema = z.object({
  public: z.record(z.string(), JsonValueSchema).default({}),
  workflow: z.record(z.string(), JsonValueSchema).default({}),
  taskLocal: z.record(z.string(), JsonValueSchema).default({}),
  protected: z.record(z.string(), JsonValueSchema).default({}),
  secrets: z.record(z.string(), z.string()).default({}),
  explicitlyOmitted: z.array(z.string()).default([]),
});
export type ContextEnvelope = z.infer<typeof ContextEnvelopeSchema>;

export const PolicyDecisionSchema = z.object({
  allowed: z.boolean(),
  reason: z.string(),
  rule: z.string(),
});
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export const DelegationEventSchema = z.object({
  delegationId: IdSchema,
  delegator: IdSchema,
  delegate: IdSchema,
  taskId: IdSchema,
  timestamp: IsoDateSchema,
  reason: z.string(),
  capabilityMatch: z.array(z.string()),
  contextPassed: ContextEnvelopeSchema,
  contextOmitted: z.array(z.string()),
  permissionsDelegated: z.array(z.string()),
  permissionsWithheld: z.array(z.string()),
  requestedBudget: ExecutionBudgetSchema,
  grantedBudget: ExecutionBudgetSchema,
  delegationDepth: z.number().int().nonnegative(),
  policyDecision: PolicyDecisionSchema,
  traceId: IdSchema,
  spanId: IdSchema,
});
export type DelegationEvent = z.infer<typeof DelegationEventSchema>;

export const ToolCallSchema = z.object({
  callId: IdSchema,
  toolName: z.string().min(1),
  provider: z.string().min(1),
  arguments: JsonValueSchema,
  normalizedArguments: JsonValueSchema,
  callerAgent: IdSchema,
  taskId: IdSchema,
  permissionDecision: PolicyDecisionSchema,
  startedAt: IsoDateSchema,
  finishedAt: IsoDateSchema.nullable(),
  durationMs: z.number().nonnegative().nullable(),
  output: JsonValueSchema.optional(),
  error: z.string().nullable(),
  errorCode: z
    .enum([
      'VALIDATION_ERROR',
      'PERMISSION_DENIED',
      'POLICY_DENIED',
      'SANDBOX_ERROR',
      'TIMEOUT',
      'TOOL_EXECUTION_ERROR',
      'OUTPUT_VALIDATION_ERROR',
      'UNKNOWN_TOOL',
      'CANCELLED',
      'APPROVAL_DENIED',
    ])
    .nullable()
    .optional(),
  outputSizeBytes: z.number().int().nonnegative().optional(),
  sandboxId: IdSchema.nullable(),
  mcpServer: IdSchema.nullable(),
  redactionMetadata: z.array(z.string()).default([]),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const PromptAssemblySchema = z.object({
  promptId: IdSchema,
  version: z.string().min(1),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  rendered: z.string(),
});

export const AgentExecutionSchema = z.object({
  executionId: IdSchema,
  agentId: IdSchema,
  model: z.string(),
  taskId: IdSchema,
  promptAssembly: PromptAssemblySchema,
  input: JsonValueSchema,
  output: JsonValueSchema,
  toolCallIds: z.array(IdSchema),
  delegationIds: z.array(IdSchema),
  tokenUsage: z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
  }),
  durationMs: z.number().nonnegative(),
  retryCount: z.number().int().nonnegative(),
  finishReason: z.string(),
  policyEvents: z.array(PolicyDecisionSchema),
});
export type AgentExecution = z.infer<typeof AgentExecutionSchema>;

export const WorkflowLimitsSchema = z.object({
  maxDelegationDepth: z.number().int().nonnegative().default(4),
  maxChildTasksPerTask: z.number().int().nonnegative().default(8),
  maxTotalTasks: z.number().int().positive().default(100),
  maxAgentTurns: z.number().int().positive().default(20),
  maxToolCalls: z.number().int().nonnegative().default(50),
  maxRetries: z.number().int().nonnegative().default(2),
  maxRuntimeMs: z.number().int().positive().default(300_000),
  maxTokenBudget: z.number().int().nonnegative().default(100_000),
});
export type WorkflowLimits = z.infer<typeof WorkflowLimitsSchema>;

export const WorkflowStepSchema = z.object({
  id: IdSchema,
  agent: IdSchema,
  objective: z.string().min(1),
  instructions: z.string().default(''),
  capability: z.string().min(1).optional(),
  dependsOn: z.array(IdSchema).default([]),
  parentStepId: IdSchema.optional(),
  context: ContextEnvelopeSchema.default({
    public: {},
    workflow: {},
    taskLocal: {},
    protected: {},
    secrets: {},
    explicitlyOmitted: [],
  }),
});
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

export const WorkflowDefinitionSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  description: z.string().default(''),
  entryAgent: IdSchema,
  agents: z.array(IdSchema).min(1),
  steps: z.array(WorkflowStepSchema).min(1),
  requiredEvaluations: z.array(z.string()).default([]),
  successConditions: z.array(z.string()).default([]),
  budget: z
    .object({
      maxTotalTokens: z.number().int().nonnegative().optional(),
      maxModelCalls: z.number().int().nonnegative().optional(),
      maxToolCalls: z.number().int().nonnegative().optional(),
      maxRuntimeMs: z.number().int().positive().optional(),
      onExhausted: z.enum(['terminate', 'request_approval']).default('terminate'),
    })
    .default({ onExhausted: 'terminate' }),
  limits: WorkflowLimitsSchema.default({
    maxDelegationDepth: 4,
    maxChildTasksPerTask: 8,
    maxTotalTasks: 100,
    maxAgentTurns: 20,
    maxToolCalls: 50,
    maxRetries: 2,
    maxRuntimeMs: 300_000,
    maxTokenBudget: 100_000,
  }),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
export type WorkflowDefinitionInput = z.input<typeof WorkflowDefinitionSchema>;

export const WorkflowRunSchema = z.object({
  workflowId: IdSchema,
  runId: IdSchema,
  status: z.enum(['created', 'running', 'completed', 'failed', 'cancelled', 'timed_out']),
  rootTaskId: IdSchema,
  taskIds: z.array(IdSchema),
  startedAt: IsoDateSchema,
  finishedAt: IsoDateSchema.nullable(),
  traceId: IdSchema,
  metadata: z.record(z.string(), JsonValueSchema).default({}),
});
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

export const RuntimeEventSchema = z.object({
  eventId: IdSchema,
  type: z.string().min(1),
  timestamp: IsoDateSchema,
  workflowId: IdSchema,
  taskId: IdSchema.nullable(),
  agentId: IdSchema.nullable(),
  traceId: IdSchema,
  spanId: IdSchema,
  payload: JsonValueSchema,
});
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;

export const PromptDefinitionSchema = z.object({
  id: IdSchema,
  version: z.string().min(1),
  type: z.enum(['system', 'agent', 'delegation', 'evaluator', 'security', 'workflow', 'test']),
  owner: z.string().min(1),
  inputSchema: z.record(z.string(), z.string()).default({}),
  content: z.string().min(1),
  contentHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  metadata: z.record(z.string(), JsonValueSchema).default({}),
});
export type PromptDefinition = z.infer<typeof PromptDefinitionSchema>;

export interface ModelRequest {
  agent: AgentDefinition;
  task: Task;
  systemPrompt: string;
  context: ContextEnvelope;
}

export interface ModelResponse {
  output: JsonValue;
  tokenUsage: { input: number; output: number };
  finishReason: string;
}

export interface ModelProvider {
  readonly id: string;
  generate(request: ModelRequest): Promise<ModelResponse>;
  stream?(request: ModelRequest): AsyncIterable<string>;
  generateStructured?<T>(request: ModelRequest, schema: z.ZodType<T>): Promise<T>;
}

export class MawlError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly details: Record<string, JsonValue> = {},
  ) {
    super(message);
    this.name = 'MawlError';
  }
}

export const nowIso = (): string => new Date().toISOString();
export const createId = (prefix: string): string => `${prefix}:${randomUUID()}`;
export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export const clampBudget = (
  requested: ExecutionBudget,
  ceiling: ExecutionBudget,
): ExecutionBudget => ({
  maxTokens: Math.min(requested.maxTokens, ceiling.maxTokens),
  maxToolCalls: Math.min(requested.maxToolCalls, ceiling.maxToolCalls),
  maxRuntimeMs: Math.min(requested.maxRuntimeMs, ceiling.maxRuntimeMs),
});

export const asJsonValue = (value: unknown): JsonValue => {
  const result = JsonValueSchema.safeParse(value);
  if (!result.success) throw new MawlError('Value is not JSON serializable', 'INVALID_JSON');
  return result.data;
};

// Typed model actions and security identities extend the foundational schemas
// while preserving compatible serialized records.
export const PrincipalTypeSchema = z.enum(['user', 'agent', 'service', 'mcp_server', 'tool']);
export type PrincipalType = z.infer<typeof PrincipalTypeSchema>;

export const PrincipalSchema = z.object({
  id: IdSchema,
  type: PrincipalTypeSchema,
  roles: z.array(z.string().min(1)).default([]),
  capabilities: z.array(z.string().min(1)).default([]),
  claims: z.record(z.string(), z.string()).default({}),
  attributes: z.record(z.string(), JsonValueSchema).default({}),
});
export type Principal = z.infer<typeof PrincipalSchema>;

export const ExecutionIdentitySchema = z.object({
  principal: PrincipalSchema,
  workflowId: IdSchema,
  taskId: IdSchema,
  executionId: IdSchema,
  sessionId: IdSchema.nullable().default(null),
});
export type ExecutionIdentity = z.infer<typeof ExecutionIdentitySchema>;

export const PermissionDecisionRecordSchema = z.object({
  decisionId: IdSchema,
  principal: PrincipalSchema,
  permission: z.string().min(1),
  resource: z.string().min(1),
  action: z.string().min(1),
  allowed: z.boolean(),
  reason: z.string().min(1),
  matchedPolicy: z.string().min(1),
  timestamp: IsoDateSchema,
});
export type PermissionDecisionRecord = z.infer<typeof PermissionDecisionRecordSchema>;

export const ContextualPolicyDecisionSchema = z.object({
  decisionId: IdSchema,
  allow: z.boolean(),
  reason: z.string().min(1),
  policyId: IdSchema,
  severity: z.enum(['info', 'low', 'medium', 'high', 'critical']),
  metadata: z.record(z.string(), JsonValueSchema).default({}),
  timestamp: IsoDateSchema,
});
export type ContextualPolicyDecision = z.infer<typeof ContextualPolicyDecisionSchema>;

export const FinalAnswerActionSchema = z.object({
  action: z.literal('final_answer'),
  output: JsonValueSchema,
});
export const ToolCallActionSchema = z.object({
  action: z.literal('tool_call'),
  tool: z.string().min(1),
  arguments: JsonValueSchema,
});
export const DelegateTaskActionSchema = z.object({
  action: z.literal('delegate_task'),
  agent: IdSchema,
  objective: z.string().min(1),
  instructions: z.string().default(''),
  context: ContextEnvelopeSchema.default({
    public: {},
    workflow: {},
    taskLocal: {},
    protected: {},
    secrets: {},
    explicitlyOmitted: [],
  }),
  requestedPermissions: z.array(z.string().min(1)).default([]),
  capability: z.string().min(1).optional(),
});
export const RequestPermissionActionSchema = z.object({
  action: z.literal('request_permission'),
  permission: z.string().min(1),
  resource: z.string().min(1).default('*'),
  reason: z.string().min(1),
});
export const AgentActionSchema = z.discriminatedUnion('action', [
  FinalAnswerActionSchema,
  ToolCallActionSchema,
  DelegateTaskActionSchema,
  RequestPermissionActionSchema,
]);
export type FinalAnswerAction = z.infer<typeof FinalAnswerActionSchema>;
export type ToolCallAction = z.infer<typeof ToolCallActionSchema>;
export type DelegateTaskAction = z.infer<typeof DelegateTaskActionSchema>;
export type RequestPermissionAction = z.infer<typeof RequestPermissionActionSchema>;
export type AgentAction = z.infer<typeof AgentActionSchema>;

export const PromptTrustSchema = z.enum(['trusted', 'untrusted']);
export const PromptInjectionSourceSchema = z.enum([
  'user_input',
  'tool_output',
  'mcp_output',
  'child_output',
]);
export type PromptInjectionSource = z.infer<typeof PromptInjectionSourceSchema>;

export const PromptInjectionCategorySchema = z.enum([
  'instruction_override',
  'authority_impersonation',
  'policy_disable_attempt',
  'secret_exfiltration_request',
  'tool_activation_request',
  'unknown_suspicious_instruction',
]);
export type PromptInjectionCategory = z.infer<typeof PromptInjectionCategorySchema>;

export const PromptInjectionSeveritySchema = z.enum(['info', 'warning', 'high']);
export type PromptInjectionSeverity = z.infer<typeof PromptInjectionSeveritySchema>;

export const PromptInjectionSignalSchema = z.object({
  id: IdSchema,
  source: PromptInjectionSourceSchema,
  categories: z.array(PromptInjectionCategorySchema).min(1),
  severity: PromptInjectionSeveritySchema,
  matchedIndicators: z.array(z.string().min(1)).min(1),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  detectedAt: IsoDateSchema,
});
export type PromptInjectionSignal = z.infer<typeof PromptInjectionSignalSchema>;

export const PromptLayerSourceSchema = z.enum([
  'runtime_policy',
  'security_policy',
  'agent_system',
  'workflow',
  'task',
  'user_input',
  'tool_output',
  'mcp_output',
  'child_output',
  'runtime_context',
]);
export const PromptLayerSchema = z.object({
  id: IdSchema,
  source: PromptLayerSourceSchema,
  trust: PromptTrustSchema,
  content: z.string(),
  version: z.string().min(1),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  provenance: z.string().min(1),
});
export type PromptLayer = z.infer<typeof PromptLayerSchema>;

export const DetailedPromptAssemblySchema = z.object({
  assemblyId: IdSchema,
  agentId: IdSchema,
  promptIds: z.array(IdSchema),
  versions: z.array(z.string().min(1)),
  hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
  layers: z.array(PromptLayerSchema),
  rendered: z.string(),
  renderedHash: z.string().regex(/^[a-f0-9]{64}$/),
  variables: z.record(z.string(), JsonValueSchema),
  redactions: z.array(z.string()),
  promptInjectionSignals: z.array(PromptInjectionSignalSchema).default([]),
});
export type DetailedPromptAssembly = z.infer<typeof DetailedPromptAssemblySchema>;

// Provider-neutral evaluation, usage, approval, and monitoring records.
export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  cachedTokens: z.number().int().nonnegative().default(0),
  modelCalls: z.number().int().nonnegative().default(0),
  toolCalls: z.number().int().nonnegative().default(0),
  runtimeMs: z.number().nonnegative().default(0),
  sandboxMs: z.number().nonnegative().default(0),
  estimatedCost: z.number().nonnegative().nullable().default(null),
  currency: z.string().min(1).default('USD'),
});
export type Usage = z.infer<typeof UsageSchema>;

export const ResourceBudgetSchema = z.object({
  maxTotalTokens: z.number().int().nonnegative().optional(),
  maxModelCalls: z.number().int().nonnegative().optional(),
  maxToolCalls: z.number().int().nonnegative().optional(),
  maxRuntimeMs: z.number().int().positive().optional(),
  onExhausted: z.enum(['terminate', 'request_approval']).default('terminate'),
});
export type ResourceBudget = z.infer<typeof ResourceBudgetSchema>;

export const EvaluationSeveritySchema = z.enum(['info', 'warning', 'error', 'critical']);
export const EvaluationViolationSchema = z.object({
  code: z.string().min(1),
  severity: EvaluationSeveritySchema,
  message: z.string().min(1),
  taskId: IdSchema.nullable().default(null),
  agentId: IdSchema.nullable().default(null),
  evidence: z.record(z.string(), JsonValueSchema).default({}),
});
export type EvaluationViolation = z.infer<typeof EvaluationViolationSchema>;

export const DelegationDimensionSchema = z.object({
  agentSelection: z.number().min(0).max(100),
  taskDecomposition: z.number().min(0).max(100),
  contextQuality: z.number().min(0).max(100),
  contextMinimization: z.number().min(0).max(100),
  permissionMinimization: z.number().min(0).max(100),
  costEfficiency: z.number().min(0).max(100),
  recursionHealth: z.number().min(0).max(100),
  resultIntegration: z.number().min(0).max(100),
});
export const DelegationEvaluationSchema = z.object({
  score: z.number().min(0).max(100),
  dimensions: DelegationDimensionSchema,
  violations: z.array(EvaluationViolationSchema),
  recommendations: z.array(z.string().min(1)),
  diagnosticOnly: z.literal(true).default(true),
  evaluatorVersion: z.string().min(1),
});
export type DelegationEvaluation = z.infer<typeof DelegationEvaluationSchema>;

export const ApprovalRequestSchema = z.object({
  requestId: IdSchema,
  workflowId: IdSchema,
  taskId: IdSchema,
  agentId: IdSchema,
  operation: z.string().min(1),
  resource: z.string().min(1),
  riskTypes: z.array(z.string().min(1)),
  reason: z.string().min(1),
  requestedAt: IsoDateSchema,
  metadata: z.record(z.string(), JsonValueSchema).default({}),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalDecisionSchema = z.object({
  requestId: IdSchema,
  approved: z.boolean(),
  decidedBy: IdSchema,
  reason: z.string().min(1),
  decidedAt: IsoDateSchema,
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const MonitorAlertSchema = z.object({
  alertId: IdSchema,
  monitor: z.string().min(1),
  severity: EvaluationSeveritySchema,
  workflowId: IdSchema,
  taskId: IdSchema.nullable().default(null),
  message: z.string().min(1),
  terminate: z.boolean().default(false),
  timestamp: IsoDateSchema,
  evidence: z.record(z.string(), JsonValueSchema).default({}),
});
export type MonitorAlert = z.infer<typeof MonitorAlertSchema>;
