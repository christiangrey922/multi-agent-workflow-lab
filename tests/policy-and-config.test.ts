import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '@mawl/agents';
import { AgentDefinitionSchema, WorkflowDefinitionSchema } from '@mawl/core';
import { EventBus } from '@mawl/observability';
import { PromptRegistry } from '@mawl/prompts';
import { InMemoryStore } from '@mawl/storage';
import { ToolExecutor, ToolRegistry } from '@mawl/tools';
import { makeAgent } from './helpers.js';

describe('policy and configuration', () => {
  it('denies a tool call that is not allowlisted', async () => {
    const agent = makeAgent('restricted', { allowedTools: [] });
    const registry = new ToolRegistry();
    registry.register({
      name: 'dangerous.write',
      provider: 'test',
      execute: async () => ({ ok: true }),
    });
    const store = new InMemoryStore();
    const executor = new ToolExecutor(registry, new EventBus(store));
    const call = await executor.invoke(
      agent,
      'dangerous.write',
      {},
      {
        workflowId: 'run:test',
        taskId: 'task:test',
        traceId: 'trace:test',
      },
    );
    expect(call.permissionDecision.allowed).toBe(false);
    expect(call.error).toMatch(/not allowlisted/iu);
  });

  it('rejects prompt modification without a version change', () => {
    const registry = new PromptRegistry();
    const base = {
      id: 'test.prompt',
      version: '1.0.0',
      type: 'test',
      owner: 'tests',
      inputSchema: {},
      content: 'first content',
      metadata: {},
    } as const;
    const first = registry.register(base);
    expect(first.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => registry.register({ ...base, content: 'silently changed' })).toThrow(
      /without a version change/iu,
    );
  });

  it('rejects invalid agent configuration', () => {
    const registry = new AgentRegistry();
    expect(() => registry.register({ id: 'bad agent', name: '' })).toThrow();
    expect(AgentDefinitionSchema.safeParse({ id: '' }).success).toBe(false);
  });

  it('rejects invalid workflow configuration', () => {
    expect(
      WorkflowDefinitionSchema.safeParse({
        id: 'invalid',
        name: 'Invalid',
        entryAgent: 'orchestrator',
        agents: [],
        steps: [],
      }).success,
    ).toBe(false);
  });
});
