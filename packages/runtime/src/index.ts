import { promises as fs } from 'node:fs';
import { AgentRegistry } from '@mawl/agents';
import {
  AgentExecutionSchema,
  DelegationEventSchema,
  MawlError,
  TaskSchema,
  WorkflowDefinitionSchema,
  WorkflowRunSchema,
  asJsonValue,
  clampBudget,
  createId,
  nowIso,
  type ContextEnvelope,
  type DelegationEvent,
  type ExecutionBudget,
  type JsonValue,
  type ModelProvider,
  type RuntimeEvent,
  type Task,
  type TaskStatus,
  type WorkflowDefinition,
  type WorkflowDefinitionInput,
  type WorkflowLimits,
  type WorkflowRun,
  type WorkflowStep,
} from '@mawl/core';
import { EventBus } from '@mawl/observability';
import { DelegationPolicy } from '@mawl/permissions';
import { PromptRegistry } from '@mawl/prompts';
import { ContextBoundary } from '@mawl/security';
import type { RuntimeStore } from '@mawl/storage';
import { parse } from 'yaml';

export * from './agent-runtime.js';
export * from './replay.js';
export * from './scheduler.js';

export class TaskGraph {
  readonly #tasks = new Map<string, Task>();
  readonly #dependencies = new Map<string, Set<string>>();
  readonly #assignmentKeys = new Set<string>();

  public addTask(task: Task): void {
    if (this.#tasks.has(task.taskId)) {
      throw new MawlError(`Duplicate task: ${task.taskId}`, 'DUPLICATE_TASK');
    }
    if (task.parentTaskId && !this.#tasks.has(task.parentTaskId)) {
      throw new MawlError(`Unknown parent task: ${task.parentTaskId}`, 'UNKNOWN_PARENT_TASK');
    }
    const assignmentKey = task.parentTaskId
      ? `${task.parentTaskId}|${task.assignedToAgent}|${task.objective}`
      : undefined;
    if (assignmentKey && this.#assignmentKeys.has(assignmentKey)) {
      throw new MawlError('Duplicate assignment detected', 'DUPLICATE_ASSIGNMENT');
    }
    if (assignmentKey) this.#assignmentKeys.add(assignmentKey);
    this.#tasks.set(task.taskId, task);
    this.#dependencies.set(task.taskId, new Set());
  }

  public get(taskId: string): Task {
    const task = this.#tasks.get(taskId);
    if (!task) throw new MawlError(`Unknown task: ${taskId}`, 'UNKNOWN_TASK');
    return task;
  }

  public list(): Task[] {
    return [...this.#tasks.values()];
  }

  public children(parentTaskId: string): Task[] {
    return this.list().filter((task) => task.parentTaskId === parentTaskId);
  }

  public depth(taskId: string): number {
    let depth = 0;
    let current = this.get(taskId);
    while (current.parentTaskId) {
      depth += 1;
      current = this.get(current.parentTaskId);
    }
    return depth;
  }

  public wouldCreateAgentLoop(parentTaskId: string, targetAgentId: string): boolean {
    let current: Task | undefined = this.get(parentTaskId);
    while (current) {
      if (current.assignedToAgent === targetAgentId) return true;
      current = current.parentTaskId ? this.#tasks.get(current.parentTaskId) : undefined;
    }
    return false;
  }

  public addDependency(taskId: string, dependencyId: string): void {
    this.get(taskId);
    this.get(dependencyId);
    const dependencies = this.#dependencies.get(taskId);
    if (!dependencies) throw new MawlError('Task dependency set missing', 'GRAPH_INVARIANT');
    dependencies.add(dependencyId);
    if (this.#hasDependencyPath(dependencyId, taskId)) {
      dependencies.delete(dependencyId);
      throw new MawlError('Task dependency cycle detected', 'TASK_DEPENDENCY_LOOP');
    }
  }

  public dependenciesComplete(taskId: string): boolean {
    const dependencies = this.#dependencies.get(taskId) ?? new Set<string>();
    return [...dependencies].every((dependencyId) => this.get(dependencyId).status === 'completed');
  }

  public transition(taskId: string, status: TaskStatus): Task {
    const task = this.get(taskId);
    task.status = status;
    if (status === 'running' && task.startedAt === null) task.startedAt = nowIso();
    if (['completed', 'failed', 'rejected', 'cancelled', 'timed_out'].includes(status)) {
      task.finishedAt = nowIso();
    }
    return task;
  }

  public cancelSubtree(taskId: string): Task[] {
    const cancelled: Task[] = [];
    const visit = (currentId: string): void => {
      const task = this.get(currentId);
      if (!['completed', 'failed', 'rejected', 'cancelled', 'timed_out'].includes(task.status)) {
        this.transition(currentId, 'cancelled');
        cancelled.push(task);
      }
      for (const child of this.children(currentId)) visit(child.taskId);
    };
    visit(taskId);
    return cancelled;
  }

  #hasDependencyPath(from: string, to: string, seen = new Set<string>()): boolean {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return [...(this.#dependencies.get(from) ?? [])].some((dependency) =>
      this.#hasDependencyPath(dependency, to, seen),
    );
  }
}

export interface DelegationRequest {
  parentTask: Task;
  targetAgentId: string;
  objective: string;
  instructions?: string;
  capability?: string;
  requestedPermissions?: string[];
  context: ContextEnvelope;
  requestedBudget: ExecutionBudget;
  reason: string;
  traceId: string;
}

export interface DelegationResult {
  task: Task;
  event: DelegationEvent;
}

export class DelegationEngine {
  public constructor(
    private readonly agents: AgentRegistry,
    private readonly graph: TaskGraph,
    private readonly events: EventBus,
    private readonly store: RuntimeStore,
    private readonly limits: WorkflowLimits,
    private readonly policy = new DelegationPolicy(),
    private readonly contextBoundary = new ContextBoundary(),
  ) {}

  public async delegate(request: DelegationRequest): Promise<DelegationResult> {
    const parent = this.agents.get(request.parentTask.assignedToAgent);
    const target = this.agents.get(request.targetAgentId);
    const spanId = createId('span');
    const depth = this.graph.depth(request.parentTask.taskId) + 1;
    await this.events.emit({
      type: 'delegation.requested',
      workflowId: request.parentTask.workflowId,
      taskId: request.parentTask.taskId,
      agentId: parent.id,
      traceId: request.traceId,
      spanId,
      payload: { targetAgentId: target.id, objective: request.objective, depth },
    });

    const checks = [
      this.policy.canDelegate(parent),
      this.policy.canDelegateTo(parent, target),
      this.policy.canDelegateCapability(parent, request.capability),
      ...(request.requestedPermissions ?? []).map((permission) =>
        this.policy.canDelegatePermission(parent, permission),
      ),
    ];
    const deny = checks.find((check) => !check.allowed);
    if (deny) return this.#deny(request, deny.reason, deny.rule, spanId);
    if (request.capability && !target.capabilities.includes(request.capability)) {
      return this.#deny(
        request,
        `Target lacks capability ${request.capability}`,
        'delegation.capability_mismatch',
        spanId,
      );
    }
    const maxDepth = Math.min(this.limits.maxDelegationDepth, parent.delegationPolicy.maxDepth);
    if (depth > maxDepth) {
      return this.#deny(
        request,
        `Maximum delegation depth ${maxDepth} exceeded`,
        'delegation.max_depth',
        spanId,
      );
    }
    if (this.graph.wouldCreateAgentLoop(request.parentTask.taskId, target.id)) {
      return this.#deny(
        request,
        'Recursive delegation loop detected',
        'delegation.loop_detection',
        spanId,
      );
    }
    const childLimit = Math.min(
      this.limits.maxChildTasksPerTask,
      parent.delegationPolicy.maxChildTasks,
    );
    if (this.graph.children(request.parentTask.taskId).length >= childLimit) {
      return this.#deny(
        request,
        'Maximum child task fan-out exceeded',
        'delegation.max_children',
        spanId,
      );
    }
    if (this.graph.list().length >= this.limits.maxTotalTasks) {
      return this.#deny(
        request,
        'Maximum total task count exceeded',
        'delegation.max_tasks',
        spanId,
      );
    }

    const parentBudget = request.parentTask.executionBudget;
    const grantedBudget = clampBudget(request.requestedBudget, parentBudget);
    const permissionSet = this.policy.reducePermissions(parent, target);
    if (request.requestedPermissions) {
      permissionSet.delegated = permissionSet.delegated.filter((permission) =>
        request.requestedPermissions?.includes(permission),
      );
      permissionSet.withheld = [
        ...new Set([
          ...permissionSet.withheld,
          ...request.requestedPermissions.filter(
            (permission) => !permissionSet.delegated.includes(permission),
          ),
        ]),
      ];
    }
    const transferred = this.contextBoundary.transfer(request.context, parent, target);
    const taskId = createId('task');
    const task = TaskSchema.parse({
      taskId,
      parentTaskId: request.parentTask.taskId,
      rootTaskId: request.parentTask.rootTaskId,
      workflowId: request.parentTask.workflowId,
      createdByAgent: parent.id,
      assignedToAgent: target.id,
      objective: request.objective,
      instructions: request.instructions ?? '',
      input: transferred.passed.public,
      expectedOutput: 'Structured result suitable for the parent task',
      constraints: [],
      priority: request.parentTask.priority,
      status: 'assigned',
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      deadline: null,
      retryPolicy: {
        maxRetries: Math.min(
          request.parentTask.retryPolicy.maxRetries,
          target.executionLimits.maxRetries,
          this.limits.maxRetries,
        ),
        backoffMs: request.parentTask.retryPolicy.backoffMs,
      },
      executionBudget: grantedBudget,
      metadata: { delegationDepth: depth, context: transferred.passed },
    });
    this.graph.addTask(task);
    await this.store.putTask(task);
    const delegationEvent = DelegationEventSchema.parse({
      delegationId: createId('delegation'),
      delegator: parent.id,
      delegate: target.id,
      taskId,
      timestamp: nowIso(),
      reason: request.reason,
      capabilityMatch: request.capability ? [request.capability] : [],
      contextPassed: transferred.passed,
      contextOmitted: transferred.omitted,
      permissionsDelegated: permissionSet.delegated,
      permissionsWithheld: permissionSet.withheld,
      requestedBudget: request.requestedBudget,
      grantedBudget,
      delegationDepth: depth,
      policyDecision: {
        allowed: true,
        reason: 'All delegation policies passed',
        rule: 'delegation.all',
      },
      traceId: request.traceId,
      spanId,
    });
    await this.store.putDelegation(delegationEvent);
    await this.events.emit({
      type: 'delegation.allowed',
      workflowId: task.workflowId,
      taskId,
      agentId: parent.id,
      traceId: request.traceId,
      spanId,
      payload: { delegationId: delegationEvent.delegationId, delegate: target.id },
    });
    await this.events.emit({
      type: 'delegation.created',
      workflowId: task.workflowId,
      taskId,
      agentId: target.id,
      traceId: request.traceId,
      spanId,
      payload: delegationEvent,
    });
    await this.events.emit({
      type: 'task.created',
      workflowId: task.workflowId,
      taskId,
      agentId: target.id,
      traceId: request.traceId,
      payload: task,
    });
    return { task, event: delegationEvent };
  }

  async #deny(
    request: DelegationRequest,
    reason: string,
    rule: string,
    spanId: string,
  ): Promise<never> {
    await this.events.emit({
      type: 'delegation.denied',
      workflowId: request.parentTask.workflowId,
      taskId: request.parentTask.taskId,
      agentId: request.parentTask.assignedToAgent,
      traceId: request.traceId,
      spanId,
      payload: { targetAgentId: request.targetAgentId, reason, rule },
    });
    throw new MawlError(reason, 'DELEGATION_DENIED', {
      rule,
      targetAgentId: request.targetAgentId,
    });
  }
}

export interface RuntimeDependencies {
  agents: AgentRegistry;
  prompts: PromptRegistry;
  provider: ModelProvider;
  store: RuntimeStore;
  eventBus?: EventBus;
}

export interface RuntimeResult {
  run: WorkflowRun;
  tasks: Task[];
  events: readonly RuntimeEvent[];
}

export class WorkflowRuntime {
  public readonly events: EventBus;

  public constructor(private readonly dependencies: RuntimeDependencies) {
    this.events = dependencies.eventBus ?? new EventBus(dependencies.store);
  }

  public async run(
    inputDefinition: WorkflowDefinitionInput,
    input: JsonValue = {},
  ): Promise<RuntimeResult> {
    const definition = WorkflowDefinitionSchema.parse(inputDefinition);
    this.#validateDefinition(definition);
    const traceId = createId('trace');
    const runId = createId('run');
    const usage = { totalTokens: 0, modelCalls: 0, toolCalls: 0, startedAt: Date.now() };
    const graph = new TaskGraph();
    const rootStep = definition.steps[0];
    if (!rootStep) throw new MawlError('Workflow has no root step', 'INVALID_WORKFLOW');
    const rootTaskId = createId('task');
    const rootAgent = this.dependencies.agents.get(rootStep.agent);
    const rootTask = TaskSchema.parse({
      taskId: rootTaskId,
      parentTaskId: null,
      rootTaskId,
      workflowId: runId,
      createdByAgent: rootAgent.id,
      assignedToAgent: rootAgent.id,
      objective: rootStep.objective,
      instructions: rootStep.instructions,
      input: asJsonValue(input),
      expectedOutput: 'Workflow plan and delegated result',
      constraints: [],
      priority: 50,
      status: 'assigned',
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      deadline: null,
      retryPolicy: { maxRetries: definition.limits.maxRetries, backoffMs: 0 },
      executionBudget: {
        maxTokens: definition.limits.maxTokenBudget,
        maxToolCalls: definition.limits.maxToolCalls,
        maxRuntimeMs: definition.limits.maxRuntimeMs,
      },
      metadata: { delegationDepth: 0, stepId: rootStep.id },
    });
    graph.addTask(rootTask);
    const run = WorkflowRunSchema.parse({
      workflowId: definition.id,
      runId,
      status: 'created',
      rootTaskId,
      taskIds: [rootTaskId],
      startedAt: nowIso(),
      finishedAt: null,
      traceId,
      metadata: { definitionName: definition.name },
    });
    await this.dependencies.store.putWorkflow(run);
    for (const agent of this.dependencies.agents.list())
      await this.dependencies.store.putAgent(agent);
    for (const prompt of this.dependencies.prompts.list())
      await this.dependencies.store.putPromptVersion(prompt);
    await this.dependencies.store.putTask(rootTask);
    await this.events.emit({
      type: 'workflow.created',
      workflowId: runId,
      traceId,
      payload: run,
    });
    run.status = 'running';
    await this.dependencies.store.putWorkflow(run);
    await this.events.emit({
      type: 'workflow.started',
      workflowId: runId,
      traceId,
      payload: { definitionId: definition.id },
    });
    await this.events.emit({
      type: 'task.created',
      workflowId: runId,
      taskId: rootTaskId,
      agentId: rootAgent.id,
      traceId,
      payload: rootTask,
    });

    const delegation = new DelegationEngine(
      this.dependencies.agents,
      graph,
      this.events,
      this.dependencies.store,
      definition.limits,
    );
    const taskByStep = new Map<string, Task>([[rootStep.id, rootTask]]);
    const completedSteps = new Set<string>();
    try {
      const rootExecution = await this.#executeTask(rootTask, rootStep, traceId, graph);
      usage.totalTokens += rootExecution.tokenUsage.input + rootExecution.tokenUsage.output;
      usage.modelCalls += 1;
      await this.#enforceWorkflowBudget(definition, runId, rootTask, traceId, usage);
      completedSteps.add(rootStep.id);
      const pending = new Map(definition.steps.slice(1).map((step) => [step.id, step]));
      while (pending.size > 0) {
        const ready = [...pending.values()].filter((step) =>
          step.dependsOn.every((dependency) => completedSteps.has(dependency)),
        );
        if (ready.length === 0) {
          throw new MawlError(
            'Workflow is deadlocked or has a dependency cycle',
            'WORKFLOW_DEADLOCK',
          );
        }
        const executions = ready.map(async (step) => {
          const parentStepId = step.parentStepId ?? step.dependsOn[0] ?? rootStep.id;
          const parentTask = taskByStep.get(parentStepId);
          if (!parentTask) {
            throw new MawlError(`Unknown parent step: ${parentStepId}`, 'UNKNOWN_PARENT_STEP');
          }
          const child = await delegation.delegate({
            parentTask,
            targetAgentId: step.agent,
            objective: step.objective,
            instructions: step.instructions,
            ...(step.capability ? { capability: step.capability } : {}),
            context: {
              ...step.context,
              workflow: { ...step.context.workflow, userInput: input },
            },
            requestedBudget: parentTask.executionBudget,
            reason: `Workflow step ${step.id} became ready`,
            traceId,
          });
          taskByStep.set(step.id, child.task);
          for (const dependencyStep of step.dependsOn) {
            const dependencyTask = taskByStep.get(dependencyStep);
            if (dependencyTask) graph.addDependency(child.task.taskId, dependencyTask.taskId);
          }
          run.taskIds.push(child.task.taskId);
          const execution = await this.#executeTask(child.task, step, traceId, graph);
          usage.totalTokens += execution.tokenUsage.input + execution.tokenUsage.output;
          usage.modelCalls += 1;
          await this.#enforceWorkflowBudget(definition, runId, child.task, traceId, usage);
          await this.events.emit({
            type: 'delegation.result.accepted',
            workflowId: runId,
            taskId: parentTask.taskId,
            agentId: parentTask.assignedToAgent,
            traceId,
            payload: {
              childTaskId: child.task.taskId,
              childAgentId: child.task.assignedToAgent,
              integrationMode: 'workflow_dependency',
              output: execution.output,
            },
          });
          return step.id;
        });
        const finished = await Promise.all(executions);
        for (const stepId of finished) {
          completedSteps.add(stepId);
          pending.delete(stepId);
        }
      }
      run.status = 'completed';
      run.finishedAt = nowIso();
      await this.dependencies.store.putWorkflow(run);
      await this.events.emit({
        type: 'workflow.completed',
        workflowId: runId,
        taskId: rootTaskId,
        agentId: rootAgent.id,
        traceId,
        payload: { taskCount: run.taskIds.length },
      });
    } catch (error) {
      run.status = graph.list().some((task) => task.status === 'timed_out')
        ? 'timed_out'
        : 'failed';
      run.finishedAt = nowIso();
      await this.dependencies.store.putWorkflow(run);
      await this.events.emit({
        type: 'workflow.failed',
        workflowId: runId,
        taskId: rootTaskId,
        agentId: rootAgent.id,
        traceId,
        payload: {
          error: error instanceof Error ? error.message : String(error),
          status: run.status,
        },
      });
      throw error;
    }
    return { run, tasks: graph.list(), events: this.events.events() };
  }

  async #executeTask(
    task: Task,
    step: WorkflowStep,
    traceId: string,
    graph: TaskGraph,
  ): Promise<import('@mawl/core').AgentExecution> {
    const agent = this.dependencies.agents.get(task.assignedToAgent);
    graph.transition(task.taskId, 'running');
    await this.dependencies.store.putTask(task);
    await this.events.emit({
      type: 'task.started',
      workflowId: task.workflowId,
      taskId: task.taskId,
      agentId: agent.id,
      traceId,
      payload: { stepId: step.id },
    });
    await this.events.emit({
      type: 'agent.started',
      workflowId: task.workflowId,
      taskId: task.taskId,
      agentId: agent.id,
      traceId,
      payload: { model: agent.model.model },
    });
    const prompt = this.dependencies.prompts.render(agent.systemPrompt, agent.systemPromptVersion, {
      objective: task.objective,
    });
    await this.events.emit({
      type: 'prompt.rendered',
      workflowId: task.workflowId,
      taskId: task.taskId,
      agentId: agent.id,
      traceId,
      payload: { promptId: prompt.id, version: prompt.version, contentHash: prompt.contentHash },
    });
    const context = this.#contextFromTask(task);
    const start = performance.now();
    try {
      const response = await withTimeout(
        this.dependencies.provider.generate({
          agent,
          task,
          systemPrompt: prompt.rendered,
          context,
        }),
        Math.min(task.executionBudget.maxRuntimeMs, agent.executionLimits.maxRuntimeMs),
      );
      const execution = AgentExecutionSchema.parse({
        executionId: createId('execution'),
        agentId: agent.id,
        model: agent.model.model,
        taskId: task.taskId,
        promptAssembly: {
          promptId: prompt.id,
          version: prompt.version,
          contentHash: prompt.contentHash,
          rendered: prompt.rendered,
        },
        input: task.input,
        output: response.output,
        toolCallIds: [],
        delegationIds: [],
        tokenUsage: response.tokenUsage,
        durationMs: performance.now() - start,
        retryCount: 0,
        finishReason: response.finishReason,
        policyEvents: [],
      });
      graph.transition(task.taskId, 'completed');
      await this.dependencies.store.putTask(task);
      await this.events.emit({
        type: 'agent.output',
        workflowId: task.workflowId,
        taskId: task.taskId,
        agentId: agent.id,
        traceId,
        payload: execution,
      });
      await this.events.emit({
        type: 'task.completed',
        workflowId: task.workflowId,
        taskId: task.taskId,
        agentId: agent.id,
        traceId,
        payload: { durationMs: execution.durationMs },
      });
      return execution;
    } catch (error) {
      const timedOut = error instanceof MawlError && error.code === 'TASK_TIMEOUT';
      graph.transition(task.taskId, timedOut ? 'timed_out' : 'failed');
      await this.dependencies.store.putTask(task);
      await this.events.emit({
        type: timedOut ? 'task.timed_out' : 'task.failed',
        workflowId: task.workflowId,
        taskId: task.taskId,
        agentId: agent.id,
        traceId,
        payload: { error: error instanceof Error ? error.message : String(error) },
      });
      for (const child of graph.children(task.taskId)) graph.cancelSubtree(child.taskId);
      throw error;
    }
  }

  async #enforceWorkflowBudget(
    definition: WorkflowDefinition,
    workflowId: string,
    task: Task,
    traceId: string,
    usage: { totalTokens: number; modelCalls: number; toolCalls: number; startedAt: number },
  ): Promise<void> {
    const exhausted: string[] = [];
    const tokenLimit = definition.budget.maxTotalTokens ?? definition.limits.maxTokenBudget;
    const runtimeLimit = definition.budget.maxRuntimeMs ?? definition.limits.maxRuntimeMs;
    const toolLimit = definition.budget.maxToolCalls ?? definition.limits.maxToolCalls;
    if (usage.totalTokens > tokenLimit) exhausted.push('maxTotalTokens');
    if (
      definition.budget.maxModelCalls !== undefined &&
      usage.modelCalls > definition.budget.maxModelCalls
    ) {
      exhausted.push('maxModelCalls');
    }
    if (usage.toolCalls > toolLimit) exhausted.push('maxToolCalls');
    if (Date.now() - usage.startedAt > runtimeLimit) exhausted.push('maxRuntimeMs');
    if (exhausted.length === 0) return;
    await this.events.emit({
      type: 'budget.exhausted',
      workflowId,
      taskId: task.taskId,
      agentId: task.assignedToAgent,
      traceId,
      payload: { exhausted, usage, action: definition.budget.onExhausted },
    });
    throw new MawlError('Workflow resource budget exhausted', 'BUDGET_EXHAUSTED', {
      exhausted,
      action: definition.budget.onExhausted,
    });
  }

  #contextFromTask(task: Task): ContextEnvelope {
    const candidate = task.metadata.context;
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      return candidate as unknown as ContextEnvelope;
    }
    return {
      public:
        typeof task.input === 'object' && task.input && !Array.isArray(task.input)
          ? task.input
          : {},
      workflow: {},
      taskLocal: {},
      protected: {},
      secrets: {},
      explicitlyOmitted: [],
    };
  }

  #validateDefinition(definition: WorkflowDefinition): void {
    if (definition.steps[0]?.agent !== definition.entryAgent) {
      throw new MawlError('First workflow step must use the entry agent', 'INVALID_ENTRY_AGENT');
    }
    const stepIds = new Set(definition.steps.map((step) => step.id));
    if (stepIds.size !== definition.steps.length) {
      throw new MawlError('Workflow step IDs must be unique', 'DUPLICATE_WORKFLOW_STEP');
    }
    for (const agentId of definition.agents) this.dependencies.agents.get(agentId);
    for (const step of definition.steps) {
      if (!definition.agents.includes(step.agent)) {
        throw new MawlError(
          `Step ${step.id} uses undeclared agent ${step.agent}`,
          'UNDECLARED_AGENT',
        );
      }
      for (const dependency of step.dependsOn) {
        if (!stepIds.has(dependency)) {
          throw new MawlError(
            `Step ${step.id} has unknown dependency ${dependency}`,
            'UNKNOWN_STEP_DEPENDENCY',
          );
        }
      }
      if (step.parentStepId && !stepIds.has(step.parentStepId)) {
        throw new MawlError(
          `Step ${step.id} has unknown parent ${step.parentStepId}`,
          'UNKNOWN_PARENT_STEP',
        );
      }
    }
  }
}

export class ReplayEngine {
  public reconstruct(events: readonly RuntimeEvent[]): {
    workflowId: string;
    taskStates: Map<string, TaskStatus>;
    delegationEdges: { parent: string; child: string }[];
  } {
    const first = events[0];
    if (!first) throw new MawlError('Cannot replay an empty trace', 'EMPTY_TRACE');
    const taskStates = new Map<string, TaskStatus>();
    const delegationEdges: { parent: string; child: string }[] = [];
    for (const event of events) {
      if (event.taskId && event.type.startsWith('task.')) {
        const suffix = event.type.slice(5);
        const status = suffix === 'started' ? 'running' : suffix;
        if (
          ['created', 'completed', 'failed', 'rejected', 'cancelled', 'timed_out'].includes(status)
        ) {
          taskStates.set(event.taskId, status as TaskStatus);
        }
      }
      if (
        event.type === 'delegation.created' &&
        event.payload &&
        typeof event.payload === 'object'
      ) {
        const payload = event.payload as Record<string, JsonValue>;
        if (typeof payload.taskId === 'string' && typeof payload.delegator === 'string') {
          delegationEdges.push({ parent: payload.delegator, child: payload.taskId });
        }
      }
    }
    return { workflowId: first.workflowId, taskStates, delegationEdges };
  }
}

export const loadWorkflowFile = async (filename: string): Promise<WorkflowDefinition> => {
  const document = parse(await fs.readFile(filename, 'utf8')) as unknown;
  return WorkflowDefinitionSchema.parse(document);
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new MawlError(`Task exceeded ${timeoutMs}ms`, 'TASK_TIMEOUT')),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};
