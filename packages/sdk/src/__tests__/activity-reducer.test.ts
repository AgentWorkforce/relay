import { describe, expect, it } from 'vitest';

import {
  EXACT_OBSERVABILITY,
  createAgentActivityState,
  createAgentObservabilityCapabilities,
  reduceAgentActivity,
  type AgentActivityState,
  type AgentObservabilityMetadata,
  type AgentSessionEvent,
} from '../session/index.js';

function observation(sequence: number, turnId = 'turn-1'): AgentObservabilityMetadata {
  return {
    source: 'ai-sdk',
    fidelity: 'exact',
    sequence,
    timestamp: `2026-07-15T12:00:${String(sequence).padStart(2, '0')}.000Z`,
    turnId,
  };
}

function reduce(state: AgentActivityState, event: AgentSessionEvent): AgentActivityState {
  return reduceAgentActivity(state, event).state;
}

describe('reduceAgentActivity', () => {
  it('fills omitted runtime capability claims as explicitly unavailable', () => {
    const capabilities = createAgentObservabilityCapabilities({
      activities: { starting: EXACT_OBSERVABILITY },
      events: { lifecycle: EXACT_OBSERVABILITY },
    });

    expect(capabilities.activities.starting).toEqual({ available: true, fidelities: ['exact'] });
    expect(capabilities.activities.thinking).toEqual({ available: false });
    expect(capabilities.events.lifecycle).toEqual({ available: true, fidelities: ['exact'] });
    expect(capabilities.events.reasoning).toEqual({ available: false });
  });

  it('follows the reference lifecycle and waits for turn settlement before becoming idle', () => {
    let state = createAgentActivityState();

    let result = reduceAgentActivity(state, {
      type: 'session.starting',
      observability: observation(1),
    });
    expect(result.transition).toMatchObject({
      type: 'activity.changed',
      previousActivity: 'idle',
      activity: 'starting',
      reason: 'session_starting',
    });
    state = result.state;

    result = reduceAgentActivity(state, {
      type: 'session.started',
      observability: observation(2),
    });
    expect(result.transition).toMatchObject({ previousActivity: 'starting', activity: 'idle' });
    state = result.state;

    result = reduceAgentActivity(state, {
      type: 'turn.started',
      turnId: 'turn-1',
      observability: observation(3),
    });
    expect(result.transition).toMatchObject({
      previousActivity: 'idle',
      activity: 'thinking',
      reason: 'turn_processing',
      observability: { fidelity: 'inferred', sequence: 3 },
    });
    state = result.state;

    result = reduceAgentActivity(state, {
      type: 'step.finished',
      turnId: 'turn-1',
      finishReason: 'tool-calls',
      observability: observation(4),
    });
    expect(result.transition).toBeUndefined();
    expect(result.state.activity).toBe('thinking');
    state = result.state;

    result = reduceAgentActivity(state, {
      type: 'turn.finished',
      turnId: 'turn-1',
      finishReason: 'stop',
      observability: observation(5),
    });
    expect(result.transition).toBeUndefined();
    expect(result.state.activity).toBe('thinking');
    state = result.state;

    result = reduceAgentActivity(state, {
      type: 'turn.settled',
      turnId: 'turn-1',
      observability: observation(6),
    });
    expect(result.transition).toMatchObject({
      previousActivity: 'thinking',
      activity: 'idle',
      reason: 'settled',
      observability: { fidelity: 'exact', sequence: 6 },
    });
  });

  it('applies precedence across interleaved blocks, parallel tools, and approvals', () => {
    let state = reduce(createAgentActivityState(), {
      type: 'turn.started',
      turnId: 'turn-1',
      observability: observation(1),
    });
    state = reduce(state, {
      type: 'reasoning.started',
      blockId: 'reason-1',
      observability: observation(2),
    });

    let result = reduceAgentActivity(state, {
      type: 'text.started',
      blockId: 'text-1',
      observability: observation(3),
    });
    expect(result.transition).toMatchObject({ activity: 'typing', reason: 'text_output' });
    state = result.state;

    state = reduce(state, {
      type: 'text.started',
      blockId: 'text-2',
      observability: observation(4),
    });
    result = reduceAgentActivity(state, {
      type: 'text.finished',
      blockId: 'text-1',
      observability: observation(5),
    });
    expect(result.transition).toBeUndefined();
    expect(result.state.activity).toBe('typing');
    state = result.state;

    result = reduceAgentActivity(state, {
      type: 'tool.called',
      callId: 'call-1',
      tool: 'read',
      observability: observation(6),
    });
    expect(result.transition).toMatchObject({
      activity: 'using_tool',
      tool: { callId: 'call-1', name: 'read' },
    });
    state = result.state;

    state = reduce(state, {
      type: 'tool.called',
      callId: 'call-2',
      tool: 'bash',
      observability: observation(7),
    });
    result = reduceAgentActivity(state, {
      type: 'tool.completed',
      callId: 'call-1',
      tool: 'read',
      observability: observation(8),
    });
    expect(result.transition).toBeUndefined();
    expect([...result.state.activeTools.keys()]).toEqual(['call-2']);
    state = result.state;

    result = reduceAgentActivity(state, {
      type: 'tool.approval.requested',
      approvalId: 'approval-2',
      callId: 'call-2',
      tool: 'bash',
      observability: observation(9),
    });
    expect(result.transition).toMatchObject({
      activity: 'waiting',
      reason: 'tool_approval',
      approval: { approvalId: 'approval-2', callId: 'call-2' },
    });
    state = result.state;

    result = reduceAgentActivity(state, {
      type: 'tool.approval.resolved',
      approvalId: 'approval-2',
      callId: 'call-2',
      approved: true,
      observability: observation(10),
    });
    expect(result.transition).toMatchObject({ activity: 'using_tool', reason: 'tool_call' });
    state = result.state;

    result = reduceAgentActivity(state, {
      type: 'tool.completed',
      callId: 'call-2',
      tool: 'bash',
      observability: observation(11),
    });
    expect(result.transition).toMatchObject({ activity: 'typing' });
    state = result.state;

    result = reduceAgentActivity(state, {
      type: 'text.finished',
      blockId: 'text-2',
      observability: observation(12),
    });
    expect(result.transition).toMatchObject({ activity: 'thinking', reason: 'reasoning' });
  });

  it('only enters waiting from explicit dependency evidence', () => {
    let state = reduce(createAgentActivityState(), {
      type: 'turn.started',
      turnId: 'turn-1',
      observability: observation(1),
    });
    state = reduce(state, {
      type: 'diagnostic',
      level: 'info',
      message: 'no output yet',
      observability: observation(2),
    });
    expect(state.activity).toBe('thinking');

    const result = reduceAgentActivity(state, {
      type: 'session.suspended',
      reason: 'external_dependency',
      observability: observation(3),
    });
    expect(result.transition).toMatchObject({ activity: 'waiting', reason: 'external_dependency' });
  });

  it('gives error highest precedence and clears it only on an explicit restart', () => {
    let state = reduce(createAgentActivityState(), {
      type: 'turn.started',
      turnId: 'turn-1',
      observability: observation(1),
    });
    state = reduce(state, {
      type: 'text.started',
      blockId: 'text-1',
      observability: observation(2),
    });

    let result = reduceAgentActivity(state, {
      type: 'error',
      error: 'stream failed',
      observability: observation(3),
    });
    expect(result.transition).toMatchObject({ activity: 'error', reason: 'stream failed' });
    state = result.state;

    result = reduceAgentActivity(state, {
      type: 'text.finished',
      blockId: 'text-1',
      observability: observation(4),
    });
    expect(result.transition).toBeUndefined();
    expect(result.state.activity).toBe('error');
    state = result.state;

    result = reduceAgentActivity(state, {
      type: 'turn.started',
      turnId: 'turn-2',
      observability: observation(5, 'turn-2'),
    });
    expect(result.transition).toMatchObject({ activity: 'thinking' });
  });

  it('does not mutate retained state snapshots and ignores unproven legacy signals', () => {
    const initial = createAgentActivityState();
    const started = reduceAgentActivity(initial, {
      type: 'turn.started',
      turnId: 'turn-1',
      observability: observation(1),
    }).state;
    const withTool = reduceAgentActivity(started, {
      type: 'tool.called',
      callId: 'call-1',
      tool: 'bash',
      observability: observation(2),
    }).state;

    expect(started.activeTools.size).toBe(0);
    expect(withTool.activeTools.size).toBe(1);
    const ignored = reduceAgentActivity(withTool, { type: 'tool.completed', tool: 'bash' });
    expect(ignored.state).toBe(withTool);
    expect(ignored.transition).toBeUndefined();
  });

  it('ignores duplicate and out-of-order observations by sequence', () => {
    const started = reduceAgentActivity(createAgentActivityState(), {
      type: 'turn.started',
      turnId: 'turn-1',
      observability: observation(10),
    }).state;

    const stale = reduceAgentActivity(started, {
      type: 'session.suspended',
      reason: 'external_dependency',
      observability: observation(9),
    });
    expect(stale.state).toBe(started);
    expect(stale.transition).toBeUndefined();
    expect(stale.state.activity).toBe('thinking');
  });
});
