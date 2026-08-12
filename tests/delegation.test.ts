import { describe, expect, it } from 'vitest';
import { MawlError } from '@mawl/core';
import { DelegationEngine } from '@mawl/runtime';
import { delegationFixture, makeAgent, makeLimits } from './helpers.js';

const context = {
  public: { source: 'test' },
  workflow: {},
  taskLocal: {},
  protected: { hidden: true },
  secrets: { token: 'secret' },
  explicitlyOmitted: [],
};

describe('DelegationEngine', () => {
  it('creates an observable parent-to-child delegation', async () => {
    const parent = makeAgent('parent', {
      allowedTargets: ['child'],
      allowedCapabilities: ['research'],
      grants: ['context:public', 'shared'],
    });
    const child = makeAgent('child', {
      capabilities: ['research'],
      grants: ['shared', 'child-only'],
    });
    const fixture = delegationFixture(parent, child);
    const result = await fixture.engine.delegate({
      parentTask: fixture.root,
      targetAgentId: 'child',
      objective: 'research safely',
      capability: 'research',
      context,
      requestedBudget: { maxTokens: 2000, maxToolCalls: 10, maxRuntimeMs: 2000 },
      reason: 'capability match',
      traceId: 'trace:test',
    });
    expect(result.task.parentTaskId).toBe(fixture.root.taskId);
    expect(result.event.permissionsDelegated).toEqual(['shared']);
    expect(result.event.permissionsWithheld).toEqual(['child-only']);
    expect(result.event.contextOmitted).toEqual(expect.arrayContaining(['protected', 'secrets']));
    expect(result.event.grantedBudget).toEqual(fixture.root.executionBudget);
    expect(fixture.events.events().map((event) => event.type)).toContain('delegation.created');
  });

  it('denies unauthorized targets', async () => {
    const parent = makeAgent('parent', { allowedTargets: [] });
    const child = makeAgent('child');
    const fixture = delegationFixture(parent, child);
    await expect(
      fixture.engine.delegate({
        parentTask: fixture.root,
        targetAgentId: 'child',
        objective: 'unauthorized',
        context,
        requestedBudget: fixture.root.executionBudget,
        reason: 'test',
        traceId: 'trace:test',
      }),
    ).rejects.toMatchObject({ code: 'DELEGATION_DENIED' } satisfies Partial<MawlError>);
    expect(fixture.events.events().at(-1)?.type).toBe('delegation.denied');
  });

  it('reduces child permissions to the parent-child intersection', async () => {
    const parent = makeAgent('parent', {
      allowedTargets: ['child'],
      grants: ['shared', 'parent-only'],
    });
    const child = makeAgent('child', { grants: ['shared', 'child-only'] });
    const fixture = delegationFixture(parent, child);
    const result = await fixture.engine.delegate({
      parentTask: fixture.root,
      targetAgentId: 'child',
      objective: 'least privilege',
      context,
      requestedBudget: fixture.root.executionBudget,
      reason: 'permission test',
      traceId: 'trace:test',
    });
    expect(result.event.permissionsDelegated).toEqual(['shared']);
    expect(result.event.permissionsWithheld).toEqual(['child-only']);
    expect(result.event.permissionsDelegated).not.toContain('parent-only');
  });

  it('enforces maximum delegation depth', async () => {
    const parent = makeAgent('parent', { allowedTargets: ['child'], maxDepth: 5 });
    const child = makeAgent('child');
    const fixture = delegationFixture(parent, child, makeLimits({ maxDelegationDepth: 0 }));
    await expect(
      fixture.engine.delegate({
        parentTask: fixture.root,
        targetAgentId: 'child',
        objective: 'too deep',
        context,
        requestedBudget: fixture.root.executionBudget,
        reason: 'test',
        traceId: 'trace:test',
      }),
    ).rejects.toThrow(/Maximum delegation depth/iu);
  });

  it('detects recursive agent loops', async () => {
    const parent = makeAgent('parent', { allowedTargets: ['child'] });
    const child = makeAgent('child', { allowedTargets: ['parent'] });
    const fixture = delegationFixture(parent, child);
    const first = await fixture.engine.delegate({
      parentTask: fixture.root,
      targetAgentId: 'child',
      objective: 'first hop',
      context,
      requestedBudget: fixture.root.executionBudget,
      reason: 'test',
      traceId: 'trace:test',
    });
    const engine = new DelegationEngine(
      fixture.agents,
      fixture.graph,
      fixture.events,
      fixture.store,
      makeLimits(),
    );
    await expect(
      engine.delegate({
        parentTask: first.task,
        targetAgentId: 'parent',
        objective: 'loop back',
        context,
        requestedBudget: first.task.executionBudget,
        reason: 'test',
        traceId: 'trace:test',
      }),
    ).rejects.toThrow(/loop/iu);
  });
});
