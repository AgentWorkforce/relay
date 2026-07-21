import type { AgentEventEnvelope } from '@agent-relay/harness-driver';
import { describe, expect, it, vi } from 'vitest';
import { attachNative } from '../../../packages/cli/src/cli/lib/attach-native.js';

function envelope(sequence: number, delta: string): AgentEventEnvelope {
  return {
    protocol_version: 1,
    name: 'Worker',
    sequence,
    timestamp: `2026-07-15T00:00:0${sequence}.000Z`,
    event: { kind: 'text.delta', delta },
  };
}

describe('native harness attach replay contract', () => {
  it('renders history then live events once in sequence order across the attach race', async () => {
    const output: string[] = [];
    const live = [envelope(2, 'duplicate-history'), envelope(3, 'live-c')];
    const iterator = {
      next: vi.fn(async () => {
        const value = live.shift();
        return value ? { done: false as const, value } : { done: true as const, value: undefined as never };
      }),
      return: vi.fn(async () => ({ done: true as const, value: undefined as never })),
    };
    const subscribeAgentEvents = vi.fn(() => ({
      [Symbol.asyncIterator]: () => iterator,
    }));
    const client = {
      currentEventSeq: async () => 41,
      subscribeAgentEvents,
      getAgentEventHistory: async () => ({
        protocol_version: 1,
        name: 'Worker',
        events: [envelope(1, 'history-a'), envelope(2, 'history-b')],
        high_water_sequence: 2,
        oldest_available_sequence: 1,
        gap: false,
      }),
      onEvent: () => () => undefined,
      sendNativeHarnessCommand: vi.fn(),
      disconnect: vi.fn(),
    };

    await expect(
      attachNative(
        'Worker',
        'view',
        { brokerUrl: 'http://broker' },
        {
          connect: () => client as never,
          output: { stdout: (text) => output.push(text), stderr: (text) => output.push(text) },
          onSignal: () => () => undefined,
        }
      )
    ).resolves.toBe(0);

    expect(subscribeAgentEvents).toHaveBeenCalledWith('Worker', {
      sinceSequence: 0,
      sinceBrokerSeq: 41,
    });
    expect(output.join('')).toBe('history-ahistory-blive-c');
    expect(iterator.return).toHaveBeenCalled();
  });

  it('reports a replay gap without pretending retained history is complete', async () => {
    const stderr: string[] = [];
    const iterator = {
      next: async () => ({ done: true as const, value: undefined as never }),
      return: async () => ({ done: true as const, value: undefined as never }),
    };
    const client = {
      currentEventSeq: async () => 7,
      subscribeAgentEvents: () => ({ [Symbol.asyncIterator]: () => iterator }),
      getAgentEventHistory: async () => ({
        protocol_version: 1,
        name: 'Worker',
        events: [envelope(9, 'retained')],
        high_water_sequence: 9,
        oldest_available_sequence: 9,
        gap: true,
      }),
      onEvent: () => () => undefined,
      sendNativeHarnessCommand: vi.fn(),
      disconnect: vi.fn(),
    };

    await attachNative(
      'Worker',
      'view',
      { brokerUrl: 'http://broker' },
      {
        connect: () => client as never,
        output: { stdout: () => undefined, stderr: (text) => stderr.push(text) },
        onSignal: () => () => undefined,
      }
    );
    expect(stderr.join('')).toContain('agent-event history was truncated');
  });
});
