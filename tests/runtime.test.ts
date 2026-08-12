import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '@mawl/agents';
import { TaskGraph, WorkflowRuntime } from '@mawl/runtime';
import { InMemoryStore } from '@mawl/storage';
import { MockModelProvider } from '@mawl/testing';
import { makeAgent, makePromptRegistry, makeTask } from './helpers.js';

describe('runtime task behavior', () => {
  it('marks a task as timed out', async () => {
    const agent = makeAgent('orchestrator', { maxRuntimeMs: 5 });
    const agents = new AgentRegistry();
    agents.register(agent);
    const store = new InMemoryStore();
    const runtime = new WorkflowRuntime({
      agents,
      prompts: makePromptRegistry([agent]),
      provider: new MockModelProvider({ delayMs: 30 }),
      store,
    });
    await expect(
      runtime.run({
        id: 'timeout-test',
        name: 'Timeout test',
        description: '',
        entryAgent: 'orchestrator',
        agents: ['orchestrator'],
        steps: [
          {
            id: 'root',
            agent: 'orchestrator',
            objective: 'wait too long',
            instructions: '',
            dependsOn: [],
            context: {
              public: {},
              workflow: {},
              taskLocal: {},
              protected: {},
              secrets: {},
              explicitlyOmitted: [],
            },
          },
        ],
        requiredEvaluations: [],
        successConditions: [],
        limits: {
          maxDelegationDepth: 1,
          maxChildTasksPerTask: 1,
          maxTotalTasks: 2,
          maxAgentTurns: 2,
          maxToolCalls: 1,
          maxRetries: 0,
          maxRuntimeMs: 100,
          maxTokenBudget: 100,
        },
      }),
    ).rejects.toMatchObject({ code: 'TASK_TIMEOUT' });
    expect([...store.tasks.values()][0]?.status).toBe('timed_out');
  });

  it('executes parallel child tasks before fan-in', async () => {
    const orchestrator = makeAgent('orchestrator', {
      allowedTargets: ['researcher', 'analyst'],
      allowedCapabilities: ['research', 'analysis'],
      maxChildTasks: 4,
    });
    const researcher = makeAgent('researcher', { capabilities: ['research'] });
    const analyst = makeAgent('analyst', { capabilities: ['analysis'] });
    const agents = new AgentRegistry();
    for (const agent of [orchestrator, researcher, analyst]) agents.register(agent);
    const provider = new MockModelProvider({ delayMs: 5 });
    const runtime = new WorkflowRuntime({
      agents,
      prompts: makePromptRegistry([orchestrator, researcher, analyst]),
      provider,
      store: new InMemoryStore(),
    });
    const result = await runtime.run({
      id: 'parallel-test',
      name: 'Parallel test',
      description: '',
      entryAgent: 'orchestrator',
      agents: ['orchestrator', 'researcher', 'analyst'],
      steps: [
        {
          id: 'root',
          agent: 'orchestrator',
          objective: 'plan',
          instructions: '',
          dependsOn: [],
          context: {
            public: {},
            workflow: {},
            taskLocal: {},
            protected: {},
            secrets: {},
            explicitlyOmitted: [],
          },
        },
        {
          id: 'a',
          agent: 'researcher',
          objective: 'research A',
          instructions: '',
          capability: 'research',
          dependsOn: ['root'],
          parentStepId: 'root',
          context: {
            public: {},
            workflow: {},
            taskLocal: {},
            protected: {},
            secrets: {},
            explicitlyOmitted: [],
          },
        },
        {
          id: 'b',
          agent: 'researcher',
          objective: 'research B',
          instructions: '',
          capability: 'research',
          dependsOn: ['root'],
          parentStepId: 'root',
          context: {
            public: {},
            workflow: {},
            taskLocal: {},
            protected: {},
            secrets: {},
            explicitlyOmitted: [],
          },
        },
        {
          id: 'join',
          agent: 'analyst',
          objective: 'join',
          instructions: '',
          capability: 'analysis',
          dependsOn: ['a', 'b'],
          parentStepId: 'root',
          context: {
            public: {},
            workflow: {},
            taskLocal: {},
            protected: {},
            secrets: {},
            explicitlyOmitted: [],
          },
        },
      ],
      requiredEvaluations: [],
      successConditions: [],
      limits: {
        maxDelegationDepth: 3,
        maxChildTasksPerTask: 4,
        maxTotalTasks: 10,
        maxAgentTurns: 10,
        maxToolCalls: 10,
        maxRetries: 1,
        maxRuntimeMs: 1000,
        maxTokenBudget: 1000,
      },
    });
    expect(result.run.status).toBe('completed');
    expect(result.tasks).toHaveLength(4);
    expect(result.tasks.every((task) => task.status === 'completed')).toBe(true);
    expect(provider.requests.map((request) => request.task.objective)).toEqual([
      'plan',
      'research A',
      'research B',
      'join',
    ]);
  });

  it('propagates cancellation to all descendants', () => {
    const graph = new TaskGraph();
    const root = makeTask('root');
    const child = makeTask('child', root.taskId, root.rootTaskId, 'child');
    const grandchild = makeTask('grandchild', child.taskId, root.rootTaskId, 'grandchild');
    graph.addTask(root);
    graph.addTask(child);
    graph.addTask(grandchild);
    const cancelled = graph.cancelSubtree(root.taskId);
    expect(cancelled).toHaveLength(3);
    expect(graph.list().every((task) => task.status === 'cancelled')).toBe(true);
  });
});
