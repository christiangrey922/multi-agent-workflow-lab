import {
  MawlError,
  RuntimeEventSchema,
  asJsonValue,
  createId,
  nowIso,
  type JsonValue,
  type RuntimeEvent,
} from '@mawl/core';

export type ReplayMode = 'exact' | 'model-rerun' | 'tool-rerun' | 'dry-run';

export interface ReplayOptions {
  mode: ReplayMode;
  rerunModel?: (event: RuntimeEvent) => Promise<JsonValue>;
  rerunTool?: (event: RuntimeEvent) => Promise<JsonValue>;
  sideEffectPermissions?: readonly string[];
}

export interface WorkflowReplayResult {
  workflowId: string;
  mode: ReplayMode;
  sourceEventCount: number;
  reconstructedTaskStates: Record<string, string>;
  replayEvents: RuntimeEvent[];
  modelCallsRerun: number;
  toolCallsRerun: number;
  sideEffectsBlocked: string[];
}

export class WorkflowReplayEngine {
  public async replay(
    source: readonly RuntimeEvent[],
    options: ReplayOptions,
  ): Promise<WorkflowReplayResult> {
    const first = source[0];
    if (!first) throw new MawlError('Cannot replay an empty trace', 'EMPTY_TRACE');
    const taskStates: Record<string, string> = {};
    const replayEvents: RuntimeEvent[] = [];
    const blocked: string[] = [];
    let modelCallsRerun = 0;
    let toolCallsRerun = 0;
    for (const event of source) {
      if (event.taskId && event.type.startsWith('task.')) {
        taskStates[event.taskId] = event.type.slice(5);
      }
      if (options.mode === 'exact' || options.mode === 'dry-run') continue;
      if (options.mode === 'model-rerun' && event.type === 'agent.started') {
        if (!options.rerunModel)
          throw new MawlError('Model rerun adapter is missing', 'REPLAY_ADAPTER_MISSING');
        const output = await options.rerunModel(event);
        replayEvents.push(replayEvent(event, 'replay.model.output', { output }));
        modelCallsRerun += 1;
      }
      if (options.mode === 'tool-rerun' && event.type === 'tool.requested') {
        if (!options.rerunTool)
          throw new MawlError('Tool rerun adapter is missing', 'REPLAY_ADAPTER_MISSING');
        const payload = record(event.payload);
        const toolName = stringValue(payload.toolName);
        if (isExternalSideEffect(toolName, payload)) {
          if (!options.sideEffectPermissions?.includes(toolName)) {
            blocked.push(toolName);
            replayEvents.push(
              replayEvent(event, 'replay.side_effect.blocked', {
                toolName,
                reason: 'Explicit replay permission is required',
              }),
            );
            continue;
          }
        }
        const output = await options.rerunTool(event);
        replayEvents.push(replayEvent(event, 'replay.tool.output', { toolName, output }));
        toolCallsRerun += 1;
      }
    }
    return {
      workflowId: first.workflowId,
      mode: options.mode,
      sourceEventCount: source.length,
      reconstructedTaskStates: taskStates,
      replayEvents,
      modelCallsRerun,
      toolCallsRerun,
      sideEffectsBlocked: blocked,
    };
  }
}

const replayEvent = (
  source: RuntimeEvent,
  type: string,
  payload: Record<string, JsonValue>,
): RuntimeEvent =>
  RuntimeEventSchema.parse({
    eventId: createId('replay-event'),
    type,
    timestamp: nowIso(),
    workflowId: source.workflowId,
    taskId: source.taskId,
    agentId: source.agentId,
    traceId: source.traceId,
    spanId: createId('replay-span'),
    payload: asJsonValue(payload),
  });

const isExternalSideEffect = (toolName: string, payload: Record<string, unknown>): boolean => {
  const riskTypes = Array.isArray(payload.riskTypes)
    ? payload.riskTypes.filter((item): item is string => typeof item === 'string')
    : [];
  return (
    riskTypes.includes('external_side_effect') ||
    /(?:shell|write|delete|send|create|update|payment|publish)/iu.test(toolName)
  );
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const stringValue = (value: unknown): string => (typeof value === 'string' ? value : 'unknown');
