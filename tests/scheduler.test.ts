import { TaskScheduler } from '@mawl/runtime';
import { describe, expect, it } from 'vitest';

describe('TaskScheduler', () => {
  it('runs ready fan-out tasks concurrently and fan-in after both complete', async () => {
    const scheduler = new TaskScheduler();
    const order: string[] = [];
    scheduler.enqueue({
      id: 'root',
      timeoutMs: 100,
      run: async () => {
        order.push('root');
      },
    });
    for (const id of ['a', 'b']) {
      scheduler.enqueue({
        id,
        parentId: 'root',
        dependencies: ['root'],
        timeoutMs: 100,
        run: async () => {
          order.push(`${id}:start`);
          await new Promise((resolve) => setTimeout(resolve, 5));
          order.push(`${id}:end`);
        },
      });
    }
    scheduler.enqueue({
      id: 'join',
      dependencies: ['a', 'b'],
      timeoutMs: 100,
      run: async () => {
        order.push('join');
      },
    });
    const results = await scheduler.runAll();
    expect([...results.values()].every((result) => result.status === 'completed')).toBe(true);
    expect(order.indexOf('join')).toBeGreaterThan(order.indexOf('a:end'));
    expect(order.indexOf('join')).toBeGreaterThan(order.indexOf('b:end'));
  });

  it('times out a scheduled task', async () => {
    const scheduler = new TaskScheduler();
    scheduler.enqueue({
      id: 'slow',
      timeoutMs: 5,
      run: async () => new Promise((resolve) => setTimeout(resolve, 30)),
    });
    expect((await scheduler.runAll()).get('slow')?.status).toBe('timed_out');
  });

  it('propagates cancellation to descendants', async () => {
    const scheduler = new TaskScheduler();
    scheduler.enqueue({ id: 'root', timeoutMs: 100, run: async () => undefined });
    scheduler.enqueue({
      id: 'child',
      parentId: 'root',
      dependencies: ['root'],
      timeoutMs: 100,
      run: async () => undefined,
    });
    scheduler.cancel('root');
    const results = await scheduler.runAll();
    expect(results.get('root')?.status).toBe('cancelled');
    expect(results.get('child')?.status).toBe('cancelled');
  });

  it('rejects dependency cycles deterministically', () => {
    const scheduler = new TaskScheduler();
    scheduler.enqueue({
      id: 'a',
      dependencies: ['b'],
      timeoutMs: 100,
      run: async () => undefined,
    });
    expect(() =>
      scheduler.enqueue({
        id: 'b',
        dependencies: ['a'],
        timeoutMs: 100,
        run: async () => undefined,
      }),
    ).toThrow(/cycle/iu);
  });
});
