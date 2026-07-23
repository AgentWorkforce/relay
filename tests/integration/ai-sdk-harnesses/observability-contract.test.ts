import type { AgentActivity, AgentSessionEvent } from '@agent-relay/sdk';
import { describe, expect, it } from 'vitest';
import { HarnessHost } from '../../../packages/harnesses/src/ai-sdk/harness-host.js';
import {
  AI_SDK_OBSERVABILITY_CAPABILITIES,
  RelayHarnessSession,
} from '../../../packages/harnesses/src/ai-sdk/relay-session.js';
import { FakeHarnessController, FakeSandboxProvider, TEST_IDENTITY, message, settleEvents } from './fakes.js';

const REFERENCE_AGENT_EVENT_TYPES = [
  'session.starting',
  'session.started',
  'turn.started',
  'model.resolved',
  'warning',
  'reasoning.started',
  'reasoning.delta',
  'reasoning.finished',
  'text.started',
  'text.delta',
  'tool.called',
  'tool.approval.requested',
  'tool.completed',
  'text.finished',
  'file.changed',
  'context.compacted',
  'step.finished',
  'turn.finished',
  'usage.updated',
  'tool.approval.resolved',
  'turn.settled',
] as const;

function assertCanonicalObservation(event: AgentSessionEvent): void {
  expect(event.observability, `${event.type} must carry observability metadata`).toBeDefined();
  expect(event.observability).toMatchObject({ source: 'ai-sdk' });
  expect(['exact', 'inferred']).toContain(event.observability?.fidelity);
  expect(event.observability?.sequence).toBeTypeOf('number');
  expect(Number.isInteger(event.observability?.sequence)).toBe(true);
  expect(Number.isNaN(Date.parse(String(event.observability?.timestamp)))).toBe(false);
}

describe('AI SDK reference observability contract', () => {
  it('normalizes agent events in adapter order with valid schema and fidelity', async () => {
    const controller = new FakeHarnessController({ autoComplete: false });
    const host = new HarnessHost({
      harness: controller.harness,
      sandboxProvider: new FakeSandboxProvider(),
      workspace: '/tmp/relay-ai-sdk-contract',
      sessionId: 'observability-order',
    });
    const session = new RelayHarnessSession({ identity: TEST_IDENTITY, host });
    const events: AgentSessionEvent[] = [];
    session.onEvent((event) => {
      events.push(event);
    });

    await host.start();
    const input = message(1);
    await session.receiveMessage(input.message, input.context);
    await settleEvents();
    await host.submitToolApproval({ approvalId: 'approval-1', approved: true, reason: 'contract' });
    controller.complete();
    await settleEvents();

    const agentEvents = events.filter(
      (event) =>
        event.type !== 'activity.changed' &&
        event.type !== 'observability.capabilities' &&
        event.type !== 'message.received' &&
        event.type !== 'delivery.accepted'
    );
    for (const event of agentEvents) assertCanonicalObservation(event);
    const actualTypes = agentEvents.map((event) => event.type);
    for (const expectedType of REFERENCE_AGENT_EVENT_TYPES) {
      expect(actualTypes, `missing reference event ${expectedType}`).toContain(expectedType);
    }
    const positions = REFERENCE_AGENT_EVENT_TYPES.map((type) => actualTypes.indexOf(type));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));

    const directSequences = agentEvents.map((event) => event.observability!.sequence);
    expect(directSequences).toEqual([...directSequences].sort((a, b) => a - b));
    expect(new Set(directSequences).size).toBe(directSequences.length);
    await session.release();
  });

  it('reduces reference activity with approval precedence and an exact settled idle', async () => {
    const controller = new FakeHarnessController({ autoComplete: false });
    const host = new HarnessHost({
      harness: controller.harness,
      sandboxProvider: new FakeSandboxProvider(),
      workspace: '/tmp/relay-ai-sdk-contract',
      sessionId: 'observability-activity',
    });
    const session = new RelayHarnessSession({ identity: TEST_IDENTITY, host });
    const activities: Array<{ activity: AgentActivity; fidelity: string; reason: string }> = [];
    session.onEvent((event) => {
      if (event.type === 'activity.changed') {
        activities.push({
          activity: event.activity,
          fidelity: event.observability.fidelity,
          reason: event.reason,
        });
      }
    });

    await host.start();
    const input = message(1);
    await session.receiveMessage(input.message, input.context);
    await settleEvents();
    expect(activities.some((value) => value.activity === 'waiting' && value.reason === 'tool_approval')).toBe(
      true
    );
    await host.submitToolApproval({ approvalId: 'approval-1', approved: true });
    controller.complete();
    await settleEvents();

    expect(activities.map((value) => value.activity)).toEqual([
      'starting',
      'idle',
      'thinking',
      'typing',
      'using_tool',
      'waiting',
      'thinking',
      'idle',
    ]);
    expect(activities.at(-1)).toEqual({ activity: 'idle', fidelity: 'exact', reason: 'settled' });
    expect(activities.find((value) => value.activity === 'thinking')?.fidelity).toBe('inferred');
    await session.release();
  });

  it('declares every reference activity and agent-event family explicitly', () => {
    for (const [activity, support] of Object.entries(AI_SDK_OBSERVABILITY_CAPABILITIES.activities)) {
      expect(support, `activity ${activity}`).toMatchObject({ available: true });
      if (support.available) expect(support.fidelities.length).toBeGreaterThan(0);
    }
    for (const [family, support] of Object.entries(AI_SDK_OBSERVABILITY_CAPABILITIES.events)) {
      expect(support, `agent-event family ${family}`).toMatchObject({ available: true });
      if (support.available) expect(support.fidelities).toContain('exact');
    }
  });
});
