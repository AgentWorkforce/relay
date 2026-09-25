import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import type { HarnessV1, HarnessV1Session } from '@ai-sdk/harness';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiSdkAdapterRegistry } from './adapter-registry.js';
import { runAiSdkSidecar } from './sidecar.js';

function fakeHarness() {
  const submitUserMessage = vi.fn(async () => undefined);
  const turnResolvers: Array<() => void> = [];
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
        done: new Promise<void>((resolveTurn) => turnResolvers.push(resolveTurn)),
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
  return {
    harness,
    session,
    submitUserMessage,
    settle() {
      turnResolvers.shift()?.();
    },
  };
}

function hasDeliveryFrame(output: Array<Record<string, unknown>>, type: string, deliveryId: string): boolean {
  return output.some(
    (frame) =>
      frame.type === type &&
      (frame.payload as Record<string, unknown> | undefined)?.delivery_id === deliveryId
  );
}

async function waitFor(predicate: () => boolean) {
  for (let attempts = 0; attempts < 400; attempts += 1) {
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
  it('requires a stable session id for durable deferred delivery', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'relay-sidecar-'));
    await expect(
      runAiSdkSidecar(
        {
          name: 'Worker',
          harness: 'fake',
          workspace: resolve(root, 'workspace'),
          runtimeRoot: resolve(root, 'runtime'),
        },
        { input: new PassThrough(), write: () => undefined }
      )
    ).rejects.toThrow('A stable sessionId is required for deferred delivery persistence');
  });

  it('requires a stable runtime root for durable deferred delivery', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'relay-sidecar-'));
    await expect(
      runAiSdkSidecar(
        {
          name: 'Worker',
          harness: 'fake',
          workspace: resolve(root, 'workspace'),
          sessionId: 'sidecar-session',
        },
        { input: new PassThrough(), write: () => undefined }
      )
    ).rejects.toThrow('A stable runtimeRoot is required for deferred delivery persistence');
  });

  it('keeps wait deliveries pending until the deferred message is accepted', async () => {
    vi.stubEnv('RELAY_AGENT_TOKEN', 'at_live_native');
    vi.stubEnv('RELAY_WORKSPACE_KEY', 'rk_live_native');
    const fixture = fakeHarness();
    vi.spyOn(aiSdkAdapterRegistry, 'require').mockReturnValue({
      ...aiSdkAdapterRegistry.require('codex'),
      createHarness: async () => fixture.harness,
    });
    const root = await mkdtemp(resolve(tmpdir(), 'relay-sidecar-deferred-'));
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
    input.write(`${JSON.stringify({ v: 2, type: 'init_worker', payload: { agent: {} } })}\n`);
    input.write(
      `${JSON.stringify({
        v: 2,
        type: 'deliver_relay',
        payload: {
          delivery_id: 'active',
          event_id: 'event-active',
          from: 'Human',
          target: 'Worker',
          body: 'active',
        },
      })}\n`
    );
    await waitFor(() => hasDeliveryFrame(output, 'delivery_ack', 'active'));
    input.write(
      `${JSON.stringify({
        v: 2,
        type: 'deliver_relay',
        payload: {
          delivery_id: 'deferred',
          event_id: 'event-deferred',
          from: 'Human',
          target: 'Worker',
          body: 'later',
          injection_mode: 'wait',
        },
      })}\n`
    );
    await waitFor(() => hasDeliveryFrame(output, 'delivery_queued', 'deferred'));
    expect(hasDeliveryFrame(output, 'delivery_ack', 'deferred')).toBe(false);

    fixture.settle();
    await waitFor(() => hasDeliveryFrame(output, 'delivery_ack', 'deferred'));

    input.write(
      `${JSON.stringify({
        v: 2,
        type: 'deliver_relay',
        payload: {
          delivery_id: 'deferred-failed',
          event_id: 'event-deferred-failed',
          from: 'Human',
          target: 'Worker',
          body: 'later failure',
          injection_mode: 'wait',
        },
      })}\n`
    );
    await waitFor(() => hasDeliveryFrame(output, 'delivery_queued', 'deferred-failed'));
    vi.mocked(fixture.session.doPromptTurn).mockRejectedValueOnce(new Error('acceptance failed'));
    fixture.settle();
    await waitFor(() => hasDeliveryFrame(output, 'delivery_failed', 'deferred-failed'));
    expect(hasDeliveryFrame(output, 'delivery_ack', 'deferred-failed')).toBe(false);
    input.end();
    await running;
  }, 15_000);

  it('reports the final outcome of a deferred delivery restored after restart', async () => {
    vi.stubEnv('RELAY_AGENT_TOKEN', 'at_live_native');
    vi.stubEnv('RELAY_WORKSPACE_KEY', 'rk_live_native');
    const original = fakeHarness();
    const restarted = fakeHarness();
    const createHarness = vi
      .fn()
      .mockResolvedValueOnce(original.harness)
      .mockResolvedValueOnce(restarted.harness);
    vi.spyOn(aiSdkAdapterRegistry, 'require').mockReturnValue({
      ...aiSdkAdapterRegistry.require('codex'),
      createHarness,
    });
    const root = await mkdtemp(resolve(tmpdir(), 'relay-sidecar-restored-outcome-'));
    const config = {
      name: 'Worker',
      harness: 'fake',
      workspace: resolve(root, 'workspace'),
      runtimeRoot: resolve(root, 'runtime'),
      sessionId: 'sidecar-session',
    };

    const firstInput = new PassThrough();
    const firstOutput: Array<Record<string, unknown>> = [];
    const firstRun = runAiSdkSidecar(config, {
      input: firstInput,
      write: (line) => firstOutput.push(JSON.parse(line)),
    });
    await waitFor(() => firstOutput.some((frame) => frame.type === 'agent_event'));
    firstInput.write(
      `${JSON.stringify({
        v: 2,
        type: 'deliver_relay',
        payload: {
          delivery_id: 'active',
          event_id: 'event-active',
          from: 'Human',
          target: 'Worker',
          body: 'active',
        },
      })}\n`
    );
    await waitFor(() => hasDeliveryFrame(firstOutput, 'delivery_ack', 'active'));
    firstInput.write(
      `${JSON.stringify({
        v: 2,
        type: 'deliver_relay',
        payload: {
          delivery_id: 'restored',
          event_id: 'event-restored',
          from: 'Human',
          target: 'Worker',
          body: 'after restart',
          injection_mode: 'wait',
        },
      })}\n`
    );
    await waitFor(() => hasDeliveryFrame(firstOutput, 'delivery_queued', 'restored'));
    firstInput.write(
      `${JSON.stringify({
        v: 2,
        type: 'deliver_relay',
        payload: {
          delivery_id: 'restored-failed',
          event_id: 'event-restored-failed',
          from: 'Human',
          target: 'Worker',
          body: 'fail after restart',
          injection_mode: 'wait',
        },
      })}\n`
    );
    await waitFor(() => hasDeliveryFrame(firstOutput, 'delivery_queued', 'restored-failed'));
    firstInput.end();
    await firstRun;

    const restartedInput = new PassThrough();
    const restartedOutput: Array<Record<string, unknown>> = [];
    const restartedRun = runAiSdkSidecar(config, {
      input: restartedInput,
      write: (line) => restartedOutput.push(JSON.parse(line)),
    });
    await waitFor(() => hasDeliveryFrame(restartedOutput, 'delivery_ack', 'restored'));
    expect(restartedOutput).toContainEqual({
      v: 2,
      type: 'delivery_ack',
      payload: {
        delivery_id: 'restored',
        event_id: 'event-restored',
        state: 'queued',
      },
    });
    expect(restarted.session.doPromptTurn).toHaveBeenCalledTimes(1);
    vi.mocked(restarted.session.doPromptTurn).mockRejectedValueOnce(new Error('restored acceptance failed'));
    restarted.settle();
    await waitFor(() => hasDeliveryFrame(restartedOutput, 'delivery_failed', 'restored-failed'));
    expect(restartedOutput).toContainEqual({
      v: 2,
      type: 'delivery_failed',
      payload: {
        delivery_id: 'restored-failed',
        event_id: 'event-restored-failed',
        reason: 'restored acceptance failed',
      },
    });
    restartedInput.end();
    await restartedRun;
  }, 15_000);

  it('retires durable delivery state on broker worker shutdown', async () => {
    vi.stubEnv('RELAY_AGENT_TOKEN', 'at_live_native');
    vi.stubEnv('RELAY_WORKSPACE_KEY', 'rk_live_native');
    const fixture = fakeHarness();
    vi.spyOn(aiSdkAdapterRegistry, 'require').mockReturnValue({
      ...aiSdkAdapterRegistry.require('codex'),
      createHarness: async () => fixture.harness,
    });
    const root = await mkdtemp(resolve(tmpdir(), 'relay-sidecar-shutdown-'));
    const runtimeRoot = resolve(root, 'runtime');
    const sessionId = 'sidecar-session';
    const sessionStore = resolve(
      runtimeRoot,
      'deferred-relay',
      createHash('sha256').update(sessionId).digest('hex')
    );
    const input = new PassThrough();
    const output: Array<Record<string, unknown>> = [];
    const running = runAiSdkSidecar(
      {
        name: 'Worker',
        harness: 'fake',
        workspace: resolve(root, 'workspace'),
        runtimeRoot,
        sessionId,
      },
      { input, write: (line) => output.push(JSON.parse(line)) }
    );
    await waitFor(() => output.some((frame) => frame.type === 'agent_event'));
    input.write(
      `${JSON.stringify({
        v: 2,
        type: 'deliver_relay',
        payload: {
          delivery_id: 'active',
          event_id: 'event-active',
          from: 'Human',
          target: 'Worker',
          body: 'active',
        },
      })}\n`
    );
    await waitFor(() => hasDeliveryFrame(output, 'delivery_ack', 'active'));
    input.write(
      `${JSON.stringify({
        v: 2,
        type: 'deliver_relay',
        payload: {
          delivery_id: 'deferred',
          event_id: 'event-deferred',
          from: 'Human',
          target: 'Worker',
          body: 'later',
          injection_mode: 'wait',
        },
      })}\n`
    );
    await waitFor(() => hasDeliveryFrame(output, 'delivery_queued', 'deferred'));
    await expect(stat(sessionStore)).resolves.toBeDefined();

    input.write(`${JSON.stringify({ v: 2, type: 'shutdown_worker', payload: {} })}\n`);
    await running;

    expect(output.some((frame) => frame.type === 'worker_exited')).toBe(true);
    expect(fixture.session.doDestroy).toHaveBeenCalledTimes(1);
    await expect(stat(sessionStore)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports worker exit when broker shutdown cleanup fails', async () => {
    vi.stubEnv('RELAY_AGENT_TOKEN', 'at_live_native');
    vi.stubEnv('RELAY_WORKSPACE_KEY', 'rk_live_native');
    const fixture = fakeHarness();
    vi.spyOn(aiSdkAdapterRegistry, 'require').mockReturnValue({
      ...aiSdkAdapterRegistry.require('codex'),
      createHarness: async () => fixture.harness,
    });
    const root = await mkdtemp(resolve(tmpdir(), 'relay-sidecar-shutdown-failure-'));
    const runtimeRoot = resolve(root, 'runtime');
    const sessionId = 'sidecar-session';
    const sessionStore = resolve(
      runtimeRoot,
      'deferred-relay',
      createHash('sha256').update(sessionId).digest('hex')
    );
    const input = new PassThrough();
    const output: Array<Record<string, unknown>> = [];
    const running = runAiSdkSidecar(
      {
        name: 'Worker',
        harness: 'fake',
        workspace: resolve(root, 'workspace'),
        runtimeRoot,
        sessionId,
      },
      { input, write: (line) => output.push(JSON.parse(line)) }
    );
    await waitFor(() => output.some((frame) => frame.type === 'agent_event'));
    input.write(
      `${JSON.stringify({
        v: 2,
        type: 'deliver_relay',
        payload: {
          delivery_id: 'active',
          event_id: 'event-active',
          from: 'Human',
          target: 'Worker',
          body: 'active',
        },
      })}\n`
    );
    await waitFor(() => hasDeliveryFrame(output, 'delivery_ack', 'active'));
    input.write(
      `${JSON.stringify({
        v: 2,
        type: 'deliver_relay',
        payload: {
          delivery_id: 'deferred',
          event_id: 'event-deferred',
          from: 'Human',
          target: 'Worker',
          body: 'later',
          injection_mode: 'wait',
        },
      })}\n`
    );
    await waitFor(() => hasDeliveryFrame(output, 'delivery_queued', 'deferred'));
    await rm(sessionStore, { recursive: true });
    await writeFile(sessionStore, 'blocked');

    input.write(`${JSON.stringify({ v: 2, type: 'shutdown_worker', payload: {} })}\n`);
    await expect(running).rejects.toBeDefined();

    expect(output).toContainEqual({ v: 2, type: 'worker_exited', payload: { code: 1 } });
    expect(fixture.session.doDestroy).toHaveBeenCalledTimes(1);
  });

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
