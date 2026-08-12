import { AgentRegistry } from '@mawl/agents';
import {
  AgentDefinitionSchema,
  TaskSchema,
  WorkflowLimitsSchema,
  nowIso,
  type AgentDefinition,
  type Task,
  type WorkflowLimits,
} from '@mawl/core';
import { EventBus } from '@mawl/observability';
import { PromptRegistry } from '@mawl/prompts';
import { DelegationEngine, TaskGraph } from '@mawl/runtime';
import { InMemoryStore } from '@mawl/storage';

export const makeAgent = (
  id: string,
  options: {
    capabilities?: string[];
    allowedTargets?: string[];
    allowedCapabilities?: string[];
    allowedTools?: string[];
    grants?: string[];
    denied?: string[];
    allowDelegation?: boolean;
    maxDepth?: number;
    maxChildTasks?: number;
    maxRuntimeMs?: number;
  } = {},
): AgentDefinition =>
  AgentDefinitionSchema.parse({
    id,
    name: id,
    description: `${id} test agent`,
    role: id,
    capabilities: options.capabilities ?? [],
    systemPrompt: `agents.${id}`,
    systemPromptVersion: '1.0.0',
    allowedTools: options.allowedTools ?? [],
    allowedMcpServers: [],
    permissionProfile: {
      grants: options.grants ?? ['context:public'],
      denied: options.denied ?? [],
      allowSecrets: false,
    },
    delegationPolicy: {
      allowed: options.allowDelegation ?? true,
      maxDepth: options.maxDepth ?? 5,
      allowedTargets: options.allowedTargets ?? [],
      allowedCapabilities: options.allowedCapabilities ?? [],
      maxChildTasks: options.maxChildTasks ?? 5,
    },
    model: { provider: 'mock', model: 'test', temperature: 0 },
    executionLimits: {
      maxAgentTurns: 5,
      maxToolCalls: 5,
      maxRetries: 1,
      maxRuntimeMs: options.maxRuntimeMs ?? 1000,
      maxTokenBudget: 1000,
    },
    metadata: {},
  });

export const makeTask = (
  assignedToAgent: string,
  parentTaskId: string | null = null,
  rootTaskId = 'task:root',
  objective = 'test objective',
): Task =>
  TaskSchema.parse({
    taskId: parentTaskId
      ? `task:${assignedToAgent}:${Math.random().toString(16).slice(2)}`
      : rootTaskId,
    parentTaskId,
    rootTaskId,
    workflowId: 'run:test',
    createdByAgent: assignedToAgent,
    assignedToAgent,
    objective,
    instructions: '',
    input: {},
    expectedOutput: '',
    constraints: [],
    priority: 50,
    status: 'assigned',
    createdAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    deadline: null,
    retryPolicy: { maxRetries: 1, backoffMs: 0 },
    executionBudget: { maxTokens: 1000, maxToolCalls: 5, maxRuntimeMs: 1000 },
    metadata: {},
  });

export const makeLimits = (override: Partial<WorkflowLimits> = {}): WorkflowLimits =>
  WorkflowLimitsSchema.parse({
    maxDelegationDepth: 5,
    maxChildTasksPerTask: 5,
    maxTotalTasks: 20,
    maxAgentTurns: 20,
    maxToolCalls: 20,
    maxRetries: 1,
    maxRuntimeMs: 10_000,
    maxTokenBudget: 10_000,
    ...override,
  });

export const delegationFixture = (
  parent: AgentDefinition,
  child: AgentDefinition,
  limits = makeLimits(),
): {
  agents: AgentRegistry;
  store: InMemoryStore;
  events: EventBus;
  graph: TaskGraph;
  engine: DelegationEngine;
  root: Task;
} => {
  const agents = new AgentRegistry();
  agents.register(parent);
  agents.register(child);
  const store = new InMemoryStore();
  const events = new EventBus(store);
  const graph = new TaskGraph();
  const root = makeTask(parent.id);
  graph.addTask(root);
  const engine = new DelegationEngine(agents, graph, events, store, limits);
  return { agents, store, events, graph, engine, root };
};

export const makePromptRegistry = (agents: readonly AgentDefinition[]): PromptRegistry => {
  const registry = new PromptRegistry();
  for (const agent of agents) {
    registry.register({
      id: agent.systemPrompt,
      version: agent.systemPromptVersion,
      type: 'agent',
      owner: 'tests',
      inputSchema: { objective: 'string' },
      content: 'Handle objective: {{objective}}',
      metadata: {},
    });
  }
  return registry;
};
