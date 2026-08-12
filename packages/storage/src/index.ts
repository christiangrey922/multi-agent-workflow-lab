import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type {
  AgentDefinition,
  DelegationEvent,
  PromptDefinition,
  RuntimeEvent,
  Task,
  ToolCall,
  WorkflowRun,
} from '@mawl/core';
import type { EventSink } from '@mawl/observability';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:' + 'sqlite') as typeof import('node:sqlite');

export interface RuntimeStore extends EventSink {
  putWorkflow(workflow: WorkflowRun): Promise<void>;
  getWorkflow(runId: string): Promise<WorkflowRun | undefined>;
  putTask(task: Task): Promise<void>;
  getTask(taskId: string): Promise<Task | undefined>;
  putAgent(agent: AgentDefinition): Promise<void>;
  putDelegation(event: DelegationEvent): Promise<void>;
  putToolCall(call: ToolCall): Promise<void>;
  putPromptVersion(prompt: PromptDefinition & { contentHash: string }): Promise<void>;
  putPermissionEvent(event: RuntimeEvent): Promise<void>;
  events(workflowId?: string): Promise<RuntimeEvent[]>;
  close(): Promise<void>;
}

export class InMemoryStore implements RuntimeStore {
  readonly workflows = new Map<string, WorkflowRun>();
  readonly tasks = new Map<string, Task>();
  readonly agents = new Map<string, AgentDefinition>();
  readonly delegations = new Map<string, DelegationEvent>();
  readonly toolCalls = new Map<string, ToolCall>();
  readonly promptVersions = new Map<string, PromptDefinition & { contentHash: string }>();
  readonly permissionEvents: RuntimeEvent[] = [];
  readonly runtimeEvents: RuntimeEvent[] = [];

  public async putWorkflow(workflow: WorkflowRun): Promise<void> {
    this.workflows.set(workflow.runId, structuredClone(workflow));
  }

  public async getWorkflow(runId: string): Promise<WorkflowRun | undefined> {
    const value = this.workflows.get(runId);
    return value ? structuredClone(value) : undefined;
  }

  public async putTask(task: Task): Promise<void> {
    this.tasks.set(task.taskId, structuredClone(task));
  }

  public async getTask(taskId: string): Promise<Task | undefined> {
    const value = this.tasks.get(taskId);
    return value ? structuredClone(value) : undefined;
  }

  public async putAgent(agent: AgentDefinition): Promise<void> {
    this.agents.set(agent.id, structuredClone(agent));
  }

  public async putDelegation(event: DelegationEvent): Promise<void> {
    this.delegations.set(event.delegationId, structuredClone(event));
  }

  public async putToolCall(call: ToolCall): Promise<void> {
    this.toolCalls.set(call.callId, structuredClone(call));
  }

  public async putPromptVersion(prompt: PromptDefinition & { contentHash: string }): Promise<void> {
    this.promptVersions.set(`${prompt.id}@${prompt.version}`, structuredClone(prompt));
  }

  public async putPermissionEvent(event: RuntimeEvent): Promise<void> {
    this.permissionEvents.push(structuredClone(event));
  }

  public async appendEvent(event: RuntimeEvent): Promise<void> {
    this.runtimeEvents.push(structuredClone(event));
  }

  public async events(workflowId?: string): Promise<RuntimeEvent[]> {
    const selected = workflowId
      ? this.runtimeEvents.filter((event) => event.workflowId === workflowId)
      : this.runtimeEvents;
    return structuredClone(selected);
  }

  public async close(): Promise<void> {}
}

type Persistable =
  | AgentDefinition
  | DelegationEvent
  | (PromptDefinition & { contentHash: string })
  | RuntimeEvent
  | Task
  | ToolCall
  | WorkflowRun;

export class SQLiteStore implements RuntimeStore {
  readonly #db: DatabaseSyncType;

  public constructor(filename: string) {
    this.#db = new DatabaseSync(filename);
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.#migrate();
  }

  public async putWorkflow(workflow: WorkflowRun): Promise<void> {
    this.#put('workflows', workflow.runId, workflow);
  }

  public async getWorkflow(runId: string): Promise<WorkflowRun | undefined> {
    return this.#get<WorkflowRun>('workflows', runId);
  }

  public async putTask(task: Task): Promise<void> {
    this.#put('tasks', task.taskId, task);
  }

  public async getTask(taskId: string): Promise<Task | undefined> {
    return this.#get<Task>('tasks', taskId);
  }

  public async putAgent(agent: AgentDefinition): Promise<void> {
    this.#put('agents', agent.id, agent);
  }

  public async putDelegation(event: DelegationEvent): Promise<void> {
    this.#put('delegations', event.delegationId, event);
  }

  public async putToolCall(call: ToolCall): Promise<void> {
    this.#put('tool_calls', call.callId, call);
  }

  public async putPromptVersion(prompt: PromptDefinition & { contentHash: string }): Promise<void> {
    this.#put('prompt_versions', `${prompt.id}@${prompt.version}`, prompt);
  }

  public async putPermissionEvent(event: RuntimeEvent): Promise<void> {
    this.#put('permission_events', event.eventId, event);
  }

  public async appendEvent(event: RuntimeEvent): Promise<void> {
    this.#put('runtime_events', event.eventId, event, event.workflowId, event.timestamp);
  }

  public async events(workflowId?: string): Promise<RuntimeEvent[]> {
    const statement = workflowId
      ? this.#db.prepare(
          'SELECT data FROM runtime_events WHERE workflow_id = ? ORDER BY timestamp, rowid',
        )
      : this.#db.prepare('SELECT data FROM runtime_events ORDER BY timestamp, rowid');
    const rows = workflowId ? statement.all(workflowId) : statement.all();
    return rows.map((row) => JSON.parse(String(row.data)) as RuntimeEvent);
  }

  public async close(): Promise<void> {
    this.#db.close();
  }

  #put(table: string, id: string, value: Persistable, workflowId = '', timestamp = ''): void {
    this.#db
      .prepare(
        `INSERT INTO ${table} (id, workflow_id, timestamp, data) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET workflow_id=excluded.workflow_id, timestamp=excluded.timestamp, data=excluded.data`,
      )
      .run(id, workflowId, timestamp, JSON.stringify(value));
  }

  #get<T>(table: string, id: string): T | undefined {
    const row = this.#db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id);
    return row ? (JSON.parse(String(row.data)) as T) : undefined;
  }

  #migrate(): void {
    for (const table of [
      'workflows',
      'tasks',
      'agents',
      'delegations',
      'tool_calls',
      'prompt_versions',
      'permission_events',
      'runtime_events',
    ]) {
      this.#db.exec(
        `CREATE TABLE IF NOT EXISTS ${table} (
          id TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL DEFAULT '',
          timestamp TEXT NOT NULL DEFAULT '',
          data TEXT NOT NULL
        )`,
      );
    }
    this.#db.exec(
      'CREATE INDEX IF NOT EXISTS runtime_events_workflow_time ON runtime_events(workflow_id, timestamp)',
    );
  }
}

export class JSONLTraceExporter {
  public async export(events: readonly RuntimeEvent[], filename: string): Promise<void> {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const content = events.map((event) => JSON.stringify(event)).join('\n');
    await fs.writeFile(filename, content.length > 0 ? `${content}\n` : '', 'utf8');
  }

  public async import(filename: string): Promise<RuntimeEvent[]> {
    const content = await fs.readFile(filename, 'utf8');
    return content
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RuntimeEvent);
  }
}
