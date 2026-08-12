import { MawlError } from '@mawl/core';

export type SchedulerTaskStatus =
  'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out';

export interface ScheduledTask<T = unknown> {
  id: string;
  parentId?: string;
  dependencies?: string[];
  timeoutMs: number;
  run(signal: AbortSignal): Promise<T>;
}

export interface ScheduledTaskResult<T = unknown> {
  id: string;
  status: SchedulerTaskStatus;
  value?: T;
  error?: Error;
  startedAt: string | null;
  finishedAt: string | null;
}

export class TaskScheduler {
  readonly #tasks = new Map<string, ScheduledTask>();
  readonly #results = new Map<string, ScheduledTaskResult>();
  readonly #controllers = new Map<string, AbortController>();

  public enqueue<T>(task: ScheduledTask<T>): void {
    if (this.#tasks.has(task.id))
      throw new MawlError(`Duplicate scheduled task: ${task.id}`, 'DUPLICATE_TASK');
    for (const dependency of task.dependencies ?? []) {
      if (dependency === task.id)
        throw new MawlError('Task cannot depend on itself', 'TASK_DEPENDENCY_LOOP');
    }
    this.#tasks.set(task.id, task);
    this.#results.set(task.id, {
      id: task.id,
      status: 'queued',
      startedAt: null,
      finishedAt: null,
    });
    this.#assertAcyclic();
  }

  public async runAll(): Promise<Map<string, ScheduledTaskResult>> {
    while ([...this.#results.values()].some((result) => result.status === 'queued')) {
      const ready = [...this.#tasks.values()]
        .filter((task) => this.#results.get(task.id)?.status === 'queued')
        .filter((task) =>
          (task.dependencies ?? []).every(
            (dependency) => this.#results.get(dependency)?.status === 'completed',
          ),
        )
        .sort((a, b) => a.id.localeCompare(b.id));
      if (ready.length === 0) {
        const blocked = [...this.#results.values()].filter((result) => result.status === 'queued');
        for (const result of blocked) {
          result.status = 'cancelled';
          result.error = new MawlError(
            'Dependency failed or scheduler deadlocked',
            'TASK_CANCELLED',
          );
          result.finishedAt = new Date().toISOString();
        }
        break;
      }
      await Promise.all(ready.map(async (task) => this.#runOne(task)));
      for (const failed of [...this.#results.values()].filter((result) =>
        ['failed', 'timed_out', 'cancelled'].includes(result.status),
      )) {
        this.#cancelDependents(failed.id);
      }
    }
    return new Map(this.#results);
  }

  public cancel(taskId: string, reason = 'Cancelled by caller'): void {
    const result = this.#results.get(taskId);
    if (!result) throw new MawlError(`Unknown scheduled task: ${taskId}`, 'UNKNOWN_TASK');
    this.#controllers.get(taskId)?.abort(new MawlError(reason, 'TASK_CANCELLED'));
    if (result.status === 'queued') {
      result.status = 'cancelled';
      result.error = new MawlError(reason, 'TASK_CANCELLED');
      result.finishedAt = new Date().toISOString();
    }
    for (const child of this.#children(taskId))
      this.cancel(child.id, `Parent ${taskId} was cancelled`);
  }

  public result(taskId: string): ScheduledTaskResult | undefined {
    const result = this.#results.get(taskId);
    return result ? { ...result } : undefined;
  }

  async #runOne(task: ScheduledTask): Promise<void> {
    const result = this.#results.get(task.id);
    if (result?.status !== 'queued') return;
    result.status = 'running';
    result.startedAt = new Date().toISOString();
    const controller = new AbortController();
    this.#controllers.set(task.id, controller);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort(new MawlError('Scheduled task timed out', 'TASK_TIMEOUT'));
        reject(new MawlError('Scheduled task timed out', 'TASK_TIMEOUT'));
      }, task.timeoutMs);
    });
    try {
      result.value = await Promise.race([task.run(controller.signal), timeout]);
      result.status = 'completed';
    } catch (error) {
      result.error = error instanceof Error ? error : new Error(String(error));
      result.status =
        error instanceof MawlError && error.code === 'TASK_TIMEOUT'
          ? 'timed_out'
          : controller.signal.aborted
            ? 'cancelled'
            : 'failed';
    } finally {
      if (timer) clearTimeout(timer);
      result.finishedAt = new Date().toISOString();
      this.#controllers.delete(task.id);
    }
  }

  #cancelDependents(taskId: string): void {
    for (const task of this.#tasks.values()) {
      if ((task.dependencies ?? []).includes(taskId)) {
        const result = this.#results.get(task.id);
        if (result?.status === 'queued')
          this.cancel(task.id, `Dependency ${taskId} did not complete`);
      }
    }
  }

  #children(parentId: string): ScheduledTask[] {
    return [...this.#tasks.values()].filter((task) => task.parentId === parentId);
  }

  #assertAcyclic(): void {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id))
        throw new MawlError('Scheduler dependency cycle detected', 'TASK_DEPENDENCY_LOOP');
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of this.#tasks.get(id)?.dependencies ?? []) {
        if (this.#tasks.has(dependency)) visit(dependency);
      }
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of this.#tasks.keys()) visit(id);
  }
}
