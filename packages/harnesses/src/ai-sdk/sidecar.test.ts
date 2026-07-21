import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import type { HarnessV1, HarnessV1Session } from '@ai-sdk/harness';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiSdkAdapterRegistry } from './adapter-registry.js';
import { runAiSdkSidecar } from './sidecar.js';

function fakeHarness() {
  const submitUserMessage = vi.fn(async () => undefined);
  const session: HarnessV1Session = {
    sessionId: 'sidecar-session',
    isResume: false,
    doPromptTurn: vi.fn(async ({ emit }) => {
      emit({ type: 'text-start', id: 'text-1' });
      emit({ type: 'text-delta', id: 'text-1', delta: 'hello' });
      emit({ type: 'text-end', id: 'text-1' });
      emit({ type: 'tool-call', toolCallId: 'tool-1', toolName: 'read', input: '{}' });
      emit({ type: 'tool-approval-request', approvalId: 'approval-1', toolCallId: 'tool-1' });
      return {
        done: new Promise<void>(() => undefined),
        submitToolResult: vi.fn(async () => undefined),
        submitUserMessage,
        submitToolApproval: vi.fn(async () => undefined),
      };
    }),
    doContinueTurn: vi.fn(),
    doCompact: vi.fn(),
    doSuspendTurn: vi.fn(),
    doDetach: vi.fn(),
    doStop: vi.fn(),
    doDestroy: vi.fn(async () => undefined),
  };
  const harness: HarnessV1 = {
    specificationVersion: 'harness-v1',
    harnessId: 'fake',
    builtinTools: {},
    doStart: vi.fn(async () => session),
  };
  return { harness, session, submitUserMessage };
}

async function waitFor(predicate: () => boolean) {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  throw new Error('Timed out waiting for sidecar output');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('AI SDK native harness sidecar', () => {
  it('speaks worker and native harness protocols with command deduplication', async () => {
    vi.stubEnv('RELAY_AGENT_TOKEN', 'at_live_native');
    vi.stubEnv('RELAY_WORKSPACE_KEY', 'rk_live_native');
    const fixture = fakeHarness();
    vi.spyOn(aiSdkAdapterRegistry, 'require').mockReturnValue({
      ...aiSdkAdapterRegistry.require('codex'),
      createHarness: async () => fixture.harness,
    });
    const root = await mkdtemp(resolve(tmpdir(), 'relay-sidecar-'));
    const input = new PassThrough();
    const output: Array<Record<string, unknown>> = [];
    const running = runAiSdkSidecar(
      {
        name: 'Worker',
        harness: 'fake',
        workspace: resolve(root, 'workspace'),
        runtimeRoot: resolve(root, 'runtime'),
        sessionId: 'sidecar-session',
      },
      { input, write: (line) => output.push(JSON.parse(line)) }
    );
    await waitFor(() => output.some((frame) => frame.type === 'agent_event'));
    const firstAgentEvent = output.find((frame) => frame.type === 'agent_event') as {
      payload: Record<string, unknown>;
    };
    expect(firstAgentEvent.payload).not.toHaveProperty('name');

    input.write(`${JSON.stringify({ v: 2, type: 'init_worker', payload: { agent: {} } })}\n`);
    input.write(
      `${JSON.stringify({
        v: 2,
        type: 'deliver_relay',
        payload: {
          delivery_id: 'delivery-1',
          event_id: 'event-1',
          from: 'Human',
          target: 'Worker',
          body: 'first',
        },
      })}\n`
    );
    input.write(
      `${JSON.stringify({
        v: 2,
        type: 'deliver_relay',
        payload: {
          delivery_id: 'delivery-channel',
          event_id: 'event-channel',
          from: 'Human',
          target: '#general',
          body: 'channel update',
        },
      })}\n`
    );
    input.write(
      `${JSON.stringify({
        v: 2,
        type: 'deliver_relay',
        payload: {
          delivery_id: 'delivery-thread',
          event_id: 'event-thread',
          from: 'Human',
          target: '#general',
          thread_id: 'thread-root',
          body: 'thread update',
        },
      })}\n`
    );
    input.write(
      `${JSON.stringify({
        v: 2,
        type: 'deliver_relay',
        payload: {
          delivery_id: 'delivery-1',
          event_id: 'event-1',
          from: 'Human',
          target: 'Worker',
          body: 'first',
        },
      })}\n`
    );
    const command = {
      v: 2,
      type: 'native_harness_command',
      request_id: 'request-1',
      payload: {
        protocol_version: 1,
        kind: 'submit_user_message',
        idempotency_key: 'input-1',
        text: 'active',
        mode: 'active',
      },
    };
    input.write(`${JSON.stringify(command)}\n`);
    input.write(`${JSON.stringify({ ...command, request_id: 'request-2' })}\n`);
    input.write(
      `${JSON.stringify({
        v: 2,
        type: 'native_harness_command',
        request_id: 'release',
        payload: { protocol_version: 1, kind: 'release', idempotency_key: 'release' },
      })}\n`
    );
    await running;

    expect(output.some((frame) => frame.type === 'worker_ready')).toBe(true);
    expect(output.filter((frame) => frame.type === 'delivery_ack')).toHaveLength(4);
    expect(fixture.session.doPromptTurn).toHaveBeenCalledTimes(1);
    expect(fixture.session.doPromptTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringMatching(
          /<agent-relay-message-json>[\s\S]*"from":"Human"[\s\S]*calling send_dm with to "Human"/
        ),
        instructions: expect.stringContaining('Relay collaboration tools are installed'),
        tools: expect.arrayContaining([expect.objectContaining({ name: 'send_dm' })]),
      })
    );
    const agentEvents = output.filter((frame) => frame.type === 'agent_event') as Array<{
      payload: {
        sequence: number;
        event: { kind: string; activity?: string; observability?: { sequence: number } };
      };
    }>;
    expect(agentEvents[0]?.payload.event.kind).toBe('observability.capabilities');
    expect(agentEvents.map((frame) => frame.payload.sequence)).toEqual(
      agentEvents.map((_, index) => index + 1)
    );
    for (const frame of agentEvents) {
      if (frame.payload.event.observability) {
        expect(frame.payload.event.observability.sequence).toBe(frame.payload.sequence);
      }
    }
    const activities = agentEvents
      .filter((frame) => frame.payload.event.kind === 'activity.changed')
      .map((frame) => frame.payload.event.activity);
    expect(activities).toEqual(
      expect.arrayContaining(['starting', 'idle', 'thinking', 'typing', 'using_tool', 'waiting'])
    );
    const responses = output.filter((frame) => frame.type === 'native_harness_command_response') as Array<{
      payload: { duplicate?: boolean; accepted: boolean };
    }>;
    expect(responses).toHaveLength(3);
    expect(responses[0].payload.accepted).toBe(true);
    expect(responses[1].payload.duplicate).toBe(true);
    expect(fixture.submitUserMessage.mock.calls.map(([prompt]) => prompt)).toEqual([
      expect.stringMatching(
        /"kind":"channel"[\s\S]*"channelName":"general"[\s\S]*calling post_message with channel "general"/
      ),
      expect.stringMatching(
        /"kind":"thread_reply"[\s\S]*"threadId":"thread-root"[\s\S]*calling reply_to_thread with message_id "thread-root"/
      ),
      'active',
    ]);
    expect(fixture.session.doDestroy).toHaveBeenCalledTimes(1);
  });

  it('executes compact through the correlated command surface exactly once', async () => {
    const fixture = fakeHarness();
    vi.spyOn(aiSdkAdapterRegistry, 'require').mockReturnValue({
      ...aiSdkAdapterRegistry.require('codex'),
      createHarness: async () => fixture.harness,
    });
    const root = await mkdtemp(resolve(tmpdir(), 'relay-sidecar-'));
    const input = new PassThrough();
    const output: Array<Record<string, unknown>> = [];
    const running = runAiSdkSidecar(
      {
        name: 'Worker',
        harness: 'fake',
        workspace: resolve(root, 'workspace'),
        runtimeRoot: resolve(root, 'runtime'),
        sessionId: 'sidecar-session',
      },
      { input, write: (line) => output.push(JSON.parse(line)) }
    );
    await waitFor(() => output.some((frame) => frame.type === 'agent_event'));
    const compact = {
      v: 2,
      type: 'native_harness_command',
      request_id: 'compact-1',
      payload: {
        protocol_version: 1,
        kind: 'compact',
        idempotency_key: 'compact-key',
        instructions: 'Keep decisions',
      },
    };
    input.write(`${JSON.stringify(compact)}\n`);
    input.write(`${JSON.stringify({ ...compact, request_id: 'compact-2' })}\n`);
    input.write(
      `${JSON.stringify({
        v: 2,
        type: 'native_harness_command',
        request_id: 'release',
        payload: { protocol_version: 1, kind: 'release', idempotency_key: 'release' },
      })}\n`
    );
    await running;

    expect(fixture.session.doCompact).toHaveBeenCalledTimes(1);
    expect(fixture.session.doCompact).toHaveBeenCalledWith('Keep decisions');
    const responses = output.filter((frame) => frame.type === 'native_harness_command_response') as Array<{
      payload: { accepted: boolean; duplicate?: boolean };
    }>;
    expect(responses).toHaveLength(3);
    expect(responses[0]?.payload).toMatchObject({ accepted: true });
    expect(responses[1]?.payload).toMatchObject({ accepted: true, duplicate: true });
  });

  it('rejects lifecycle commands that cannot safely return durable resume state', async () => {
    const fixture = fakeHarness();
    vi.spyOn(aiSdkAdapterRegistry, 'require').mockReturnValue({
      ...aiSdkAdapterRegistry.require('codex'),
      createHarness: async () => fixture.harness,
    });
    const root = await mkdtemp(resolve(tmpdir(), 'relay-sidecar-'));
    const input = new PassThrough();
    const output: Array<Record<string, unknown>> = [];
    const running = runAiSdkSidecar(
      {
        name: 'Worker',
        harness: 'fake',
        workspace: resolve(root, 'workspace'),
        runtimeRoot: resolve(root, 'runtime'),
        sessionId: 'sidecar-session',
      },
      { input, write: (line) => output.push(JSON.parse(line)) }
    );
    await waitFor(() => output.some((frame) => frame.type === 'agent_event'));
    input.write(
      `${JSON.stringify({
        v: 2,
        type: 'native_harness_command',
        request_id: 'detach',
        payload: { protocol_version: 1, kind: 'detach', idempotency_key: 'detach' },
      })}\n`
    );
    input.write(
      `${JSON.stringify({
        v: 2,
        type: 'native_harness_command',
        request_id: 'release',
        payload: { protocol_version: 1, kind: 'release', idempotency_key: 'release' },
      })}\n`
    );
    await running;

    const responses = output.filter((frame) => frame.type === 'native_harness_command_response') as Array<{
      request_id: string;
      payload: { accepted: boolean; error?: { message?: string } };
    }>;
    expect(responses[0]).toMatchObject({
      request_id: 'detach',
      payload: {
        accepted: false,
        error: { message: 'Unsupported native harness command kind: detach' },
      },
    });
    expect(fixture.session.doDetach).not.toHaveBeenCalled();
  });

  it('rejects conflicting idempotency reuse and bounds retained command receipts', async () => {
    const fixture = fakeHarness();
    vi.spyOn(aiSdkAdapterRegistry, 'require').mockReturnValue({
      ...aiSdkAdapterRegistry.require('codex'),
      createHarness: async () => fixture.harness,
    });
    const root = await mkdtemp(resolve(tmpdir(), 'relay-sidecar-'));
    const input = new PassThrough();
    const output: Array<Record<string, unknown>> = [];
    const running = runAiSdkSidecar(
      {
        name: 'Worker',
        harness: 'fake',
        workspace: resolve(root, 'workspace'),
        runtimeRoot: resolve(root, 'runtime'),
        sessionId: 'sidecar-session',
        maxCommandDedupeEntries: 2,
      },
      { input, write: (line) => output.push(JSON.parse(line)) }
    );
    await waitFor(() => output.some((frame) => frame.type === 'agent_event'));
    const send = (requestId: string, kind: string, key: string, instructions?: string) =>
      input.write(
        `${JSON.stringify({
          v: 2,
          type: 'native_harness_command',
          request_id: requestId,
          payload: {
            protocol_version: 1,
            kind,
            idempotency_key: key,
            ...(instructions ? { instructions } : {}),
          },
        })}\n`
      );
    send('compact-first', 'compact', 'shared', 'first');
    send('conflicting-release', 'release', 'shared');
    send('compact-second', 'compact', 'second', 'second');
    send('compact-third', 'compact', 'third', 'third');
    send('compact-after-eviction', 'compact', 'shared', 'first');
    send('release', 'release', 'release');
    await running;

    const responses = output.filter((frame) => frame.type === 'native_harness_command_response') as Array<{
      request_id: string;
      payload: { accepted: boolean; error?: { code?: string } };
    }>;
    expect(responses.find((frame) => frame.request_id === 'conflicting-release')?.payload).toMatchObject({
      accepted: false,
      error: { code: 'idempotency_conflict' },
    });
    expect(fixture.session.doCompact).toHaveBeenCalledTimes(4);
    expect(fixture.session.doDestroy).toHaveBeenCalledTimes(1);
  });
});
