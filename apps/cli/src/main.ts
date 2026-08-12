#!/usr/bin/env node
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { AgentRegistry } from '@mawl/agents';
import { asJsonValue } from '@mawl/core';
import {
  DelegationEvaluator,
  PromptQualityValidator,
  RunComparator,
  WorkflowSpecRunner,
  loadWorkflowTestSpec,
  snapshotFromEvents,
  type EvaluationSnapshot,
} from '@mawl/evaluation';
import { McpClientManager, loadMcpServerFile } from '@mawl/mcp';
import {
  MermaidDelegationGraph,
  ObservabilityManager,
  TraceTreeRenderer,
} from '@mawl/observability';
import { PromptRegistry } from '@mawl/prompts';
import { WorkflowReplayEngine, WorkflowRuntime, loadWorkflowFile } from '@mawl/runtime';
import { RestrictedLocalSandbox } from '@mawl/sandbox';
import { InMemoryStore, JSONLTraceExporter, SQLiteStore } from '@mawl/storage';
import { MockModelProvider } from '@mawl/testing';

const findProjectRoot = (start: string): string => {
  let current = start;
  for (;;) {
    if (
      existsSync(path.join(current, 'pnpm-workspace.yaml')) &&
      existsSync(path.join(current, 'agents')) &&
      existsSync(path.join(current, 'prompts'))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return start;
    current = parent;
  }
};

const cwd = findProjectRoot(process.cwd());
const stateDirectory = path.join(cwd, '.mawl');

const print = (value: unknown): void => console.log(JSON.stringify(value, null, 2));

const loadRegistries = async (): Promise<{ agents: AgentRegistry; prompts: PromptRegistry }> => {
  const agents = new AgentRegistry();
  const prompts = new PromptRegistry();
  await agents.loadDirectory(path.join(cwd, 'agents'));
  await prompts.loadDirectory(path.join(cwd, 'prompts'));
  return { agents, prompts };
};

const openStore = async (): Promise<SQLiteStore> => {
  await fs.mkdir(stateDirectory, { recursive: true });
  return new SQLiteStore(path.join(stateDirectory, 'mawl.db'));
};

const usage = (): never => {
  console.error(`Usage:
  mawl run <workflow.yaml> [json-input]
  mawl agents list
  mawl workflow inspect <run-id>
  mawl task inspect <task-id>
  mawl inspect task <task-id>
  mawl inspect agent permissions <agent-id>
  mawl inspect mcp server [server-id]
  mawl trace <run-id>
  mawl trace show <run-id>
  mawl evaluate <run-id>
  mawl compare <run-a> <run-b>
  mawl graph <run-id> [output.mmd]
  mawl replay <run-id> [exact|model-rerun|tool-rerun|dry-run]
  mawl test <workflow-test.yaml>
  mawl doctor
  mawl prompts list
  mawl prompts inspect <prompt-id> [version]
  mawl permissions inspect <agent-id>`);
  process.exitCode = 1;
  throw new Error('Invalid CLI arguments');
};

const main = async (): Promise<void> => {
  const [group, action, target, extra] = process.argv.slice(2);
  if (group === 'run' && action) {
    const { agents, prompts } = await loadRegistries();
    const store = await openStore();
    try {
      const runtime = new WorkflowRuntime({
        agents,
        prompts,
        store,
        provider: new MockModelProvider(),
      });
      const definition = await loadWorkflowFile(path.resolve(cwd, action));
      const result = await runtime.run(definition, target ? asJsonValue(JSON.parse(target)) : {});
      const snapshot = {
        ...result,
        events: [...result.events],
        agents: agents.list(),
      } satisfies EvaluationSnapshot;
      const evaluation = new DelegationEvaluator().evaluate(snapshot);
      const observer = new ObservabilityManager();
      result.events.forEach((event) => observer.record(event));
      const tracePath = path.join(stateDirectory, `${result.run.runId.replaceAll(':', '_')}.jsonl`);
      await new JSONLTraceExporter().export(result.events, tracePath);
      print({
        runId: result.run.runId,
        status: result.run.status,
        tasks: result.tasks.map((task) => ({
          taskId: task.taskId,
          agent: task.assignedToAgent,
          status: task.status,
        })),
        delegationScore: evaluation.score,
        dimensions: evaluation.dimensions,
        metrics: observer.metrics(),
        trace: path.relative(cwd, tracePath),
      });
    } finally {
      await store.close();
    }
    return;
  }

  if (group === 'agents' && action === 'list') {
    const { agents } = await loadRegistries();
    print(agents.list().map(({ id, name, capabilities }) => ({ id, name, capabilities })));
    return;
  }

  if (group === 'prompts' && action === 'list') {
    const { prompts } = await loadRegistries();
    print(
      prompts
        .list()
        .map(({ id, version, type, contentHash }) => ({ id, version, type, contentHash })),
    );
    return;
  }

  if (group === 'prompts' && action === 'inspect' && target) {
    const { prompts } = await loadRegistries();
    print(prompts.get(target, extra));
    return;
  }

  if (group === 'permissions' && action === 'inspect' && target) {
    const { agents } = await loadRegistries();
    print(agents.inspectPermissions(target));
    return;
  }

  if (group === 'inspect' && action === 'agent' && target === 'permissions' && extra) {
    const { agents } = await loadRegistries();
    print(agents.inspectPermissions(extra));
    return;
  }

  if (group === 'inspect' && action === 'mcp' && target === 'server') {
    const manager = new McpClientManager();
    const directory = path.join(cwd, 'mcp-servers');
    if (existsSync(directory)) {
      const files = (await fs.readdir(directory))
        .filter((filename) => filename.endsWith('.yaml') || filename.endsWith('.yml'))
        .sort();
      for (const filename of files) {
        const definition = await loadMcpServerFile(path.join(directory, filename));
        manager.register(definition);
      }
    }
    const inspected = extra
      ? manager.inspect().filter((server) => server.serverId === extra)
      : manager.inspect();
    print(inspected);
    return;
  }

  if (group === 'workflow' && action === 'inspect' && target) {
    const store = await openStore();
    try {
      print((await store.getWorkflow(target)) ?? { error: 'Workflow run not found' });
    } finally {
      await store.close();
    }
    return;
  }

  if (group === 'task' && action === 'inspect' && target) {
    const store = await openStore();
    try {
      print((await store.getTask(target)) ?? { error: 'Task not found' });
    } finally {
      await store.close();
    }
    return;
  }

  if (group === 'inspect' && action === 'task' && target) {
    const store = await openStore();
    try {
      print((await store.getTask(target)) ?? { error: 'Task not found' });
    } finally {
      await store.close();
    }
    return;
  }

  if (
    (group === 'trace' && action === 'show' && target) ||
    (group === 'trace' && action && action !== 'show')
  ) {
    const runId = action === 'show' ? target : action;
    const store = await openStore();
    try {
      const events = await store.events(runId);
      console.log(new TraceTreeRenderer().render(events));
    } finally {
      await store.close();
    }
    return;
  }

  if (group === 'evaluate' && action) {
    const store = await openStore();
    try {
      const { agents } = await loadRegistries();
      print(
        new DelegationEvaluator().evaluate(
          snapshotFromEvents(await store.events(action), agents.list()),
        ),
      );
    } finally {
      await store.close();
    }
    return;
  }

  if (group === 'compare' && action && target) {
    const store = await openStore();
    try {
      const { agents } = await loadRegistries();
      const first = snapshotFromEvents(await store.events(action), agents.list());
      const second = snapshotFromEvents(await store.events(target), agents.list());
      print(new RunComparator().compare(first, second));
    } finally {
      await store.close();
    }
    return;
  }

  if (group === 'graph' && action) {
    const store = await openStore();
    try {
      const graph = new MermaidDelegationGraph().render(await store.events(action));
      if (target) {
        const output = path.resolve(cwd, target);
        await fs.writeFile(output, `${graph}\n`, 'utf8');
        print({ output: path.relative(cwd, output) });
      } else console.log(graph);
    } finally {
      await store.close();
    }
    return;
  }

  if (group === 'replay' && action) {
    const store = await openStore();
    try {
      const mode = target ?? 'exact';
      if (!['exact', 'model-rerun', 'tool-rerun', 'dry-run'].includes(mode)) usage();
      const events = await store.events(action);
      const result = await new WorkflowReplayEngine().replay(events, {
        mode: mode as 'exact' | 'model-rerun' | 'tool-rerun' | 'dry-run',
        rerunModel: async () => ({ source: 'mock-replay', deterministic: true }),
        rerunTool: async (event) => ({ source: 'mock-replay', request: event.payload }),
      });
      print(result);
    } finally {
      await store.close();
    }
    return;
  }

  if (group === 'test' && action) {
    const specFile = path.resolve(cwd, action);
    const spec = await loadWorkflowTestSpec(specFile);
    const runner = new WorkflowSpecRunner(async (workflowFile, input) => {
      const { agents, prompts } = await loadRegistries();
      const store = new InMemoryStore();
      const runtime = new WorkflowRuntime({
        agents,
        prompts,
        store,
        provider: new MockModelProvider(),
      });
      const workflowPath = path.resolve(path.dirname(specFile), workflowFile);
      const result = await runtime.run(await loadWorkflowFile(workflowPath), asJsonValue(input));
      return { ...result, events: [...result.events], agents: agents.list() };
    });
    const result = await runner.run(spec);
    print(result);
    if (!result.passed) process.exitCode = 1;
    return;
  }

  if (group === 'doctor') {
    const checks: { name: string; ok: boolean; detail: string }[] = [];
    const major = Number(process.versions.node.split('.')[0]);
    checks.push({ name: 'node', ok: major >= 22, detail: process.versions.node });
    const { agents, prompts } = await loadRegistries();
    checks.push({
      name: 'agents',
      ok: agents.list().length > 0,
      detail: `${agents.list().length} valid`,
    });
    const promptIssues = new PromptQualityValidator().validate(prompts.list());
    checks.push({
      name: 'prompts',
      ok: promptIssues.length === 0,
      detail: `${prompts.list().length} loaded, ${promptIssues.length} issue(s)`,
    });
    const workflowDirectory = path.join(cwd, 'workflows');
    const workflowFiles = (await fs.readdir(workflowDirectory)).filter((file) =>
      /\.ya?ml$/u.test(file),
    );
    const invalidWorkflows: string[] = [];
    for (const file of workflowFiles) {
      try {
        await loadWorkflowFile(path.join(workflowDirectory, file));
      } catch {
        invalidWorkflows.push(file);
      }
    }
    checks.push({
      name: 'workflows',
      ok: invalidWorkflows.length === 0,
      detail: `${workflowFiles.length} valid, ${invalidWorkflows.length} invalid`,
    });
    const sandbox = new RestrictedLocalSandbox(cwd, ['node']);
    checks.push({
      name: 'sandbox',
      ok: sandbox.id.length > 0,
      detail: 'restricted local process adapter available',
    });
    const mcpDirectory = path.join(cwd, 'mcp-servers');
    const mcpFiles = existsSync(mcpDirectory)
      ? (await fs.readdir(mcpDirectory)).filter((file) => /\.ya?ml$/u.test(file))
      : [];
    let validMcp = 0;
    for (const file of mcpFiles) {
      await loadMcpServerFile(path.join(mcpDirectory, file));
      validMcp += 1;
    }
    checks.push({
      name: 'mcp',
      ok: validMcp === mcpFiles.length,
      detail: `${validMcp} configuration(s) valid`,
    });
    checks.push({
      name: 'provider',
      ok: true,
      detail: process.env.MODEL_API_KEY
        ? 'optional credential configured'
        : 'mock provider ready; optional credential absent',
    });
    print({ healthy: checks.every((check) => check.ok), checks });
    if (checks.some((check) => !check.ok)) process.exitCode = 1;
    return;
  }

  usage();
};

main().catch((error: unknown) => {
  if (error instanceof Error && error.message !== 'Invalid CLI arguments') {
    console.error(JSON.stringify({ error: error.message }, null, 2));
  }
  process.exitCode = 1;
});
