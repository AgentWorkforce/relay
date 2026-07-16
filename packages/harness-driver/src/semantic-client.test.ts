import { describe, expect, it, vi } from 'vitest';

import { HarnessDriverClient } from './client.js';
import { resolveStaticHarnessConfig } from './harness.js';
import { BrokerDriver } from './broker-driver.js';

describe('semantic broker client', () => {
  it('streams broker runtime evidence and disposes the observer on process exit', async () => {
    let brokerHandler: ((event: Record<string, unknown>) => void) | undefined;
    const unsubscribe = vi.fn();
    const client = {
      spawnHeadless: vi.fn(),
      spawnPty: vi.fn(async () => {
        brokerHandler?.({ kind: 'agent_spawned', name: 'Worker', runtime: 'pty', cli: 'claude' });
        brokerHandler?.({ kind: 'worker_stream', name: 'Worker', stream: 'stdout', chunk: 'early' });
        return { name: 'Worker', sessionId: 'session-pty' };
      }),
      listAgents: vi.fn(async () => []),
      release: vi.fn(),
      connectEvents: vi.fn(),
      onEvent: vi.fn((handler: (event: Record<string, unknown>) => void) => {
        brokerHandler = handler;
        return unsubscribe;
      }),
    };
    const runtime = await new BrokerDriver({ client: client as never }).spawn({
      name: 'Worker',
      cli: 'claude',
      transport: 'pty',
    });
    const seen: string[] = [];
    await runtime.observeBrokerEvents?.((event) => {
      seen.push(event.kind);
    });

    brokerHandler?.({ kind: 'agent_exited', name: 'Worker', code: 1 });

    await vi.waitFor(() => expect(seen).toEqual(['agent_spawned', 'worker_stream', 'agent_exited']));
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('resolves a broker-owned semantic sidecar without changing its stdio contract', () => {
    expect(
      resolveStaticHarnessConfig({
        name: 'Worker',
        cli: 'codex',
        definition: {
          runtime: 'semantic',
          command: 'node',
          args: ['/opt/relay/sidecar.js', '--adapter', '{args}'],
          sessionId: 'session-1',
          metadata: { semanticProtocolVersion: 1 },
        },
        args: ['codex'],
        cwd: '/workspace',
      })
    ).toEqual({
      runtime: 'semantic',
      command: 'node',
      args: ['/opt/relay/sidecar.js', '--adapter', 'codex'],
      sessionId: 'session-1',
      cwd: '/workspace',
      metadata: { semanticProtocolVersion: 1 },
    });
  });

  it('does not inject PTY task arguments into a semantic sidecar by default', () => {
    expect(
      resolveStaticHarnessConfig({
        name: 'Worker',
        cli: 'codex',
        task: 'do not pass this to the sidecar executable',
        definition: {
          runtime: 'semantic',
          command: 'node',
          sessionId: 'session-1',
        },
      }).args
    ).toEqual([]);
  });

  it('routes a semantic sidecar config through the headless broker spawn seam', async () => {
    const spawnHeadless = vi.fn(async () => ({ name: 'Worker', runtime: 'headless' }));
    const client = {
      spawnHeadless,
      spawnPty: vi.fn(),
      listAgents: vi.fn(async () => []),
      release: vi.fn(),
    };
    const driver = new BrokerDriver({ client: client as never });
    await driver.spawn({
      name: 'Worker',
      cli: 'codex',
      harnessConfig: {
        runtime: 'semantic',
        command: 'node',
        args: ['/opt/relay/sidecar.js'],
        sessionId: 'session-1',
      },
    });
    expect(spawnHeadless).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Worker',
        harnessConfig: expect.objectContaining({ runtime: 'semantic' }),
      })
    );
    expect(client.spawnPty).not.toHaveBeenCalled();
  });

  it('reconciles semantic history with live events before exposing them to Relaycast', async () => {
    const envelope = (sequence: number) => ({
      protocol_version: 1 as const,
      name: 'Worker',
      sequence,
      timestamp: `2026-07-16T00:00:0${sequence}.000Z`,
      event: { kind: 'activity.changed', sequence },
    });
    const client = {
      spawnHeadless: vi.fn(async () => ({ name: 'Worker', sessionId: 'session-1' })),
      spawnPty: vi.fn(),
      listAgents: vi.fn(async () => []),
      release: vi.fn(),
      connectEvents: vi.fn(),
      onEvent: vi.fn(() => () => undefined),
      currentEventSeq: vi.fn(async () => 40),
      getSemanticHistory: vi.fn(async () => ({
        protocol_version: 1,
        name: 'Worker',
        events: [envelope(1), envelope(2)],
        high_water_sequence: 2,
        oldest_available_sequence: 1,
        gap: false,
      })),
      subscribeSemanticEvents: vi.fn(() => ({
        async *[Symbol.asyncIterator]() {
          yield envelope(2);
          yield envelope(3);
        },
      })),
    };
    const driver = new BrokerDriver({ client: client as never });
    const runtime = await driver.spawn({
      name: 'Worker',
      cli: 'codex',
      harnessConfig: { runtime: 'semantic', command: 'node' },
    });
    const seen: number[] = [];
    const dispose = await runtime.observeSemanticEvents?.((event) => {
      seen.push(event.sequence);
    });
    await vi.waitFor(() => expect(seen).toEqual([1, 2, 3]));
    await dispose?.();
    expect(client.currentEventSeq).toHaveBeenCalledTimes(1);
    expect(client.subscribeSemanticEvents).toHaveBeenCalledWith('Worker', {
      sinceSequence: 0,
      sinceBrokerSeq: 40,
    });
  });

  it('closes and unregisters a semantic observer when the broker reports a crash', async () => {
    let brokerHandler: ((event: Record<string, unknown>) => void) | undefined;
    let resolveNext: ((value: IteratorResult<never>) => void) | undefined;
    const iteratorReturn = vi.fn(async () => {
      resolveNext?.({ done: true, value: undefined as never });
      return { done: true, value: undefined as never };
    });
    const unsubscribe = vi.fn();
    const client = {
      spawnHeadless: vi.fn(async () => ({ name: 'Worker', sessionId: 'session-1' })),
      spawnPty: vi.fn(),
      listAgents: vi.fn(async () => []),
      release: vi.fn(),
      currentEventSeq: vi.fn(async () => 1),
      onEvent: vi.fn((handler: (event: Record<string, unknown>) => void) => {
        brokerHandler = handler;
        return unsubscribe;
      }),
      getSemanticHistory: vi.fn(async () => ({
        events: [{
          protocol_version: 1,
          name: 'Worker',
          sequence: 1,
          timestamp: '2026-07-16T00:00:00Z',
          event: { kind: 'diagnostic', message: 'listener failure test' },
        }],
      })),
      subscribeSemanticEvents: vi.fn(() => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<never>>((resolve) => (resolveNext = resolve)),
          return: iteratorReturn,
        }),
      })),
    };
    const runtime = await new BrokerDriver({ client: client as never }).spawn({
      name: 'Worker',
      cli: 'codex',
      harnessConfig: { runtime: 'semantic', command: 'node' },
    });
    const onError = vi.fn();
    const dispose = await runtime.observeSemanticEvents?.(
      () => {
        throw new Error('listener rejected');
      },
      onError
    );

    brokerHandler?.({ kind: 'agent_exited', name: 'Worker', code: 1 });

    await vi.waitFor(() => expect(iteratorReturn).toHaveBeenCalled());
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    await dispose?.();
    await runtime.release('after crash');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('fetches per-agent history from an exclusive sequence cursor', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            protocol_version: 1,
            name: 'A/B',
            events: [],
            high_water_sequence: 9,
            oldest_available_sequence: 3,
            gap: false,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    );
    const client = new HarnessDriverClient({ baseUrl: 'http://broker', apiKey: 'secret', fetch });
    await expect(client.getSemanticHistory('A/B', 7)).resolves.toMatchObject({ high_water_sequence: 9 });
    expect(fetch).toHaveBeenCalledWith(
      'http://broker/api/spawned/A%2FB/semantic/history?sinceSequence=7',
      expect.objectContaining({ headers: expect.objectContaining({ 'X-API-Key': 'secret' }) })
    );
  });

  it('sends a versioned idempotent command and waits for its acknowledgement', async () => {
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      expect(request).toEqual({
        protocol_version: 1,
        kind: 'submit_user_message',
        idempotency_key: 'input-1',
        text: 'continue',
        mode: 'active',
      });
      return new Response(
        JSON.stringify({
          protocol_version: 1,
          request_id: 'req-1',
          idempotency_key: 'input-1',
          accepted: true,
          active_turn: true,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    const client = new HarnessDriverClient({ baseUrl: 'http://broker', fetch });
    await expect(
      client.sendSemanticCommand('Worker', {
        kind: 'submit_user_message',
        idempotency_key: 'input-1',
        text: 'continue',
        mode: 'active',
      })
    ).resolves.toMatchObject({ accepted: true, active_turn: true });
  });

  it('sends the versioned compact lifecycle command with optional instructions', async () => {
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        protocol_version: 1,
        kind: 'compact',
        idempotency_key: 'compact-1',
        instructions: 'Retain open decisions',
      });
      return new Response(
        JSON.stringify({
          protocol_version: 1,
          request_id: 'req-compact',
          idempotency_key: 'compact-1',
          accepted: true,
          active_turn: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    const client = new HarnessDriverClient({ baseUrl: 'http://broker', fetch });
    await expect(
      client.sendSemanticCommand('Worker', {
        kind: 'compact',
        idempotency_key: 'compact-1',
        instructions: 'Retain open decisions',
      })
    ).resolves.toMatchObject({ accepted: true, active_turn: false });
  });
});
