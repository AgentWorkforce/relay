import type {
  AgentActivity,
  AgentObservabilityMetadata,
  AgentSessionEvent,
  ObservabilityFidelity,
} from './types.js';

export interface ActiveToolObservation {
  callId: string;
  name?: string;
}

export interface PendingApprovalObservation {
  approvalId: string;
  callId?: string;
}

/** Immutable input/output state for {@link reduceAgentActivity}. */
export interface AgentActivityState {
  activity: AgentActivity;
  starting: boolean;
  turnId?: string;
  turnActive: boolean;
  turnFinished: boolean;
  failed: boolean;
  errorReason?: string;
  waitingReason?: string;
  lastSequence: number;
  activeTextBlocks: ReadonlySet<string>;
  activeReasoningBlocks: ReadonlySet<string>;
  activeTools: ReadonlyMap<string, ActiveToolObservation>;
  pendingApprovals: ReadonlyMap<string, PendingApprovalObservation>;
}

export interface AgentActivityReduction {
  state: AgentActivityState;
  /** Omitted when the semantic event did not change the public activity. */
  transition?: Extract<AgentSessionEvent, { type: 'activity.changed' }>;
}

export function createAgentActivityState(activity: AgentActivity = 'idle'): AgentActivityState {
  return {
    activity,
    starting: false,
    turnActive: false,
    turnFinished: false,
    failed: activity === 'error',
    lastSequence: -1,
    activeTextBlocks: new Set(),
    activeReasoningBlocks: new Set(),
    activeTools: new Map(),
    pendingApprovals: new Map(),
  };
}

interface MutableActivityState {
  activity: AgentActivity;
  starting: boolean;
  turnId?: string;
  turnActive: boolean;
  turnFinished: boolean;
  failed: boolean;
  errorReason?: string;
  waitingReason?: string;
  lastSequence: number;
  activeTextBlocks: Set<string>;
  activeReasoningBlocks: Set<string>;
  activeTools: Map<string, ActiveToolObservation>;
  pendingApprovals: Map<string, PendingApprovalObservation>;
}

function cloneState(state: AgentActivityState): MutableActivityState {
  return {
    activity: state.activity,
    starting: state.starting,
    ...(state.turnId ? { turnId: state.turnId } : {}),
    turnActive: state.turnActive,
    turnFinished: state.turnFinished,
    failed: state.failed,
    ...(state.errorReason ? { errorReason: state.errorReason } : {}),
    ...(state.waitingReason ? { waitingReason: state.waitingReason } : {}),
    lastSequence: state.lastSequence,
    activeTextBlocks: new Set(state.activeTextBlocks),
    activeReasoningBlocks: new Set(state.activeReasoningBlocks),
    activeTools: new Map(state.activeTools),
    pendingApprovals: new Map(state.pendingApprovals),
  };
}

function clearTurnWork(state: MutableActivityState): void {
  state.activeTextBlocks.clear();
  state.activeReasoningBlocks.clear();
  state.activeTools.clear();
  state.pendingApprovals.clear();
}

function toolKey(event: Extract<AgentSessionEvent, { type: 'tool.called' }>): string {
  return event.callId ?? event.run ?? event.tool;
}

function completedToolKey(
  event: Extract<AgentSessionEvent, { type: 'tool.completed' | 'tool.failed' }>
): string {
  return event.callId ?? event.run ?? event.tool;
}

function newestValue<T>(values: ReadonlyMap<string, T>): T | undefined {
  let newest: T | undefined;
  for (const value of values.values()) newest = value;
  return newest;
}

interface DerivedActivity {
  activity: AgentActivity;
  reason: string;
  fidelity?: ObservabilityFidelity;
  tool?: ActiveToolObservation;
  approval?: PendingApprovalObservation;
}

function deriveActivity(state: AgentActivityState): DerivedActivity {
  if (state.failed) return { activity: 'error', reason: state.errorReason ?? 'runtime_error' };
  const approval = newestValue(state.pendingApprovals);
  if (approval) return { activity: 'waiting', reason: 'tool_approval', approval };
  if (state.waitingReason) return { activity: 'waiting', reason: state.waitingReason };
  const tool = newestValue(state.activeTools);
  if (tool) return { activity: 'using_tool', reason: 'tool_call', tool };
  if (state.activeTextBlocks.size > 0) return { activity: 'typing', reason: 'text_output' };
  if (state.activeReasoningBlocks.size > 0) return { activity: 'thinking', reason: 'reasoning' };
  if (state.starting) return { activity: 'starting', reason: 'session_starting' };
  if (state.turnActive) {
    return { activity: 'thinking', reason: 'turn_processing', fidelity: 'inferred' };
  }
  return { activity: 'idle', reason: 'settled' };
}

function observed(event: AgentSessionEvent): AgentObservabilityMetadata | undefined {
  return event.observability;
}

/**
 * Reduce one canonical semantic observation into a deduplicated activity transition.
 *
 * The reducer is deliberately side-effect free. Sets and maps are cloned so callers
 * can retain prior snapshots, including while tool calls and output blocks overlap.
 * Events without observability provenance are legacy session events and are ignored.
 */
export function reduceAgentActivity(
  previous: AgentActivityState,
  event: AgentSessionEvent
): AgentActivityReduction {
  const observation = observed(event);
  if (!observation || event.type === 'activity.changed') return { state: previous };
  if (observation.sequence <= previous.lastSequence) return { state: previous };

  const state = cloneState(previous);
  state.lastSequence = observation.sequence;

  switch (event.type) {
    case 'session.starting':
      state.starting = true;
      state.turnActive = false;
      state.turnFinished = false;
      state.failed = false;
      state.errorReason = undefined;
      state.waitingReason = undefined;
      clearTurnWork(state);
      break;
    case 'session.started':
    case 'session.resumed':
      state.starting = false;
      state.failed = false;
      state.errorReason = undefined;
      state.waitingReason = undefined;
      break;
    case 'session.suspended':
      state.starting = false;
      state.waitingReason = event.reason;
      break;
    case 'session.detached':
    case 'session.stopped':
    case 'session.destroyed':
    case 'session.released':
      state.starting = false;
      state.turnActive = false;
      state.turnFinished = true;
      state.waitingReason = undefined;
      clearTurnWork(state);
      break;
    case 'session.failed':
      state.starting = false;
      state.failed = true;
      state.errorReason = event.code ?? event.error;
      state.waitingReason = undefined;
      break;
    case 'error':
      state.starting = false;
      state.failed = true;
      state.errorReason = event.code ?? event.error;
      state.waitingReason = undefined;
      break;
    case 'turn.started':
      state.turnId = event.turnId;
      state.turnActive = true;
      state.turnFinished = false;
      state.failed = false;
      state.errorReason = undefined;
      state.waitingReason = undefined;
      clearTurnWork(state);
      break;
    case 'text.started':
    case 'text.delta':
      state.activeTextBlocks.add(event.blockId);
      break;
    case 'text.finished':
      state.activeTextBlocks.delete(event.blockId);
      break;
    case 'reasoning.started':
    case 'reasoning.delta':
      state.activeReasoningBlocks.add(event.blockId);
      break;
    case 'reasoning.finished':
      state.activeReasoningBlocks.delete(event.blockId);
      break;
    case 'tool.called': {
      const callId = toolKey(event);
      state.activeTools.set(callId, { callId, name: event.tool });
      break;
    }
    case 'tool.completed':
    case 'tool.failed':
      state.activeTools.delete(completedToolKey(event));
      break;
    case 'tool.approval.requested':
      state.pendingApprovals.set(event.approvalId, {
        approvalId: event.approvalId,
        ...(event.callId ? { callId: event.callId } : {}),
      });
      break;
    case 'tool.approval.resolved':
      state.pendingApprovals.delete(event.approvalId);
      break;
    case 'turn.finished':
      state.turnFinished = true;
      clearTurnWork(state);
      break;
    case 'turn.settled':
      state.turnFinished = true;
      state.turnActive = false;
      state.waitingReason = undefined;
      clearTurnWork(state);
      break;
    default:
      break;
  }

  const derived = deriveActivity(state);
  if (derived.activity === previous.activity) return { state };

  state.activity = derived.activity;
  const fidelity = derived.fidelity ?? observation.fidelity;
  return {
    state,
    transition: {
      type: 'activity.changed',
      activity: derived.activity,
      previousActivity: previous.activity,
      reason: derived.reason,
      ...(derived.tool ? { tool: derived.tool } : {}),
      ...(derived.approval ? { approval: derived.approval } : {}),
      at: observation.timestamp,
      observability: { ...observation, fidelity },
    },
  };
}
