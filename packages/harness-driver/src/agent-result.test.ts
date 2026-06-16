import { describe, expect, it, vi } from 'vitest';

import { SpawnedAgentHandle } from './agent-handle.js';
import { HarnessDriverClient } from './client.js';
import type { BrokerEvent } from './protocol.js';

// ── waitForResult ──────────────────────────────────────────────────────────

type EventListener = (event: BrokerEvent) => void;

/** Duck-typed stand-in for the slice of HarnessDriverClient the handle uses. */
function createStubClient(history: BrokerEvent[] = []) {
  const listeners = new Set<EventListener>();
  const stub = {
    connectEvents: vi.fn(),
    queryEvents: (filter?: { kind?: string; name?: string; since?: number; limit?: number }) => {
      let events = [...history];
      if (filter?.kind) {
        events = events.filter((event) => event.kind === filter.kind);
      }
      if (filter?.name) {
        events = events.filter((event) => 'name' in event && event.name === filter.name);
      }
      if (filter?.since !== undefined) {
        const since = filter.since;
        events = events.filter(
          (event) => 'timestamp' in event && typeof event.timestamp === 'number' && event.timestamp >= since
        );
      }
      if (filter?.limit !== undefined) {
        events = events.slice(-filter.limit);
      }
      return events;
    },
    getLastEvent: (kind: string, name?: string) =>
      [...history].reverse().find((event) => event.kind === kind && (!name || event.name === name)),
    onEvent: (listener: EventListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    release: vi.fn(async (name: string) => ({ name })),
    emit: (event: BrokerEvent) => {
      history.push(event);
      for (const listener of listeners) listener(event);
    },
  };
  return stub;
}

function createHandle(stub: ReturnType<typeof createStubClient>, name = 'worker') {
  return new SpawnedAgentHandle({ name, runtime: 'pty' }, stub as unknown as HarnessDriverClient);
}

const resultEvent = (name: string, data: unknown, final = true): BrokerEvent =>
  ({ kind: 'agent_result', name, result_id: 'res_1', data, final }) as BrokerEvent;

describe('SpawnedAgentHandle.waitForResult', () => {
  it('resolves with the submitted result for this agent', async () => {
    const stub = createStubClient();
    const handle = createHandle(stub);

    const pending = handle.waitForResult<{ score: number }>();
    stub.emit(resultEvent('someone-else', { score: 1 })); // ignored
    stub.emit(resultEvent('worker', { score: 42 }));

    const info = await pending;
    expect(info.reason).toBe('result');
    expect(info.resultId).toBe('res_1');
    expect(info.data?.score).toBe(42);
    expect(info.final).toBe(true);
    expect(stub.connectEvents).toHaveBeenCalled();
  });

  it('replays the first result already in broker event history', async () => {
    const stub = createStubClient([
      resultEvent('worker', { done: true }, false),
      resultEvent('someone-else', { done: false }),
      resultEvent('worker', { done: false }),
    ]);
    const handle = createHandle(stub);

    const info = await handle.waitForResult();
    expect(info).toMatchObject({ reason: 'result', data: { done: true }, final: false });
  });

  it('resolves with reason "exited" when the agent exits without a result', async () => {
    const stub = createStubClient();
    const handle = createHandle(stub);

    const pending = handle.waitForResult();
    stub.emit({ kind: 'agent_exited', name: 'worker', code: 0 } as BrokerEvent);

    const info = await pending;
    expect(info.reason).toBe('exited');
    expect(info.exit).toEqual({ reason: 'exited', code: 0, signal: undefined });
  });

  it('resolves with reason "timeout" when no result arrives in time', async () => {
    const stub = createStubClient();
    const handle = createHandle(stub);

    const info = await handle.waitForResult(5);
    expect(info).toEqual({ reason: 'timeout' });
  });
});

// ── lifecycle helpers ──────────────────────────────────────────────────────

describe('SpawnedAgentHandle lifecycle helpers', () => {
  it('exposes prior exit info and replays it for waitForExit', async () => {
    const stub = createStubClient([
      { kind: 'agent_exited', name: 'worker', code: 7, signal: 'SIGTERM' } as BrokerEvent,
    ]);
    const handle = createHandle(stub);

    expect(handle.exitCode).toBe(7);
    expect(handle.exitSignal).toBe('SIGTERM');

    await expect(handle.waitForExit()).resolves.toEqual({
      reason: 'exited',
      code: 7,
      signal: 'SIGTERM',
    });
    expect(stub.connectEvents).toHaveBeenCalled();
  });

  it('resolves waitForIdle on the next idle event for this agent', async () => {
    const stub = createStubClient();
    const handle = createHandle(stub);

    const pending = handle.waitForIdle();
    stub.emit({ kind: 'agent_idle', name: 'someone-else', idle_secs: 12 } as BrokerEvent);
    stub.emit({ kind: 'agent_idle', name: 'worker', idle_secs: 3 } as BrokerEvent);

    await expect(pending).resolves.toEqual({ reason: 'idle', idleSecs: 3 });
  });

  it('resolves waitForIdle when the agent exits first', async () => {
    const stub = createStubClient();
    const handle = createHandle(stub);

    const pending = handle.waitForIdle();
    stub.emit({ kind: 'agent_exit', name: 'worker' } as BrokerEvent);

    await expect(pending).resolves.toEqual({ reason: 'exited', exit: { reason: 'exited' } });
  });

  it('forwards release requests to the client', async () => {
    const stub = createStubClient();
    const handle = createHandle(stub);

    await expect(handle.release('done')).resolves.toEqual({ name: 'worker' });
    expect(stub.release).toHaveBeenCalledWith('worker', 'done');
  });
});

describe('HarnessDriverClient spawn serialization', () => {
  it('forwards task-exit spawn options to the broker', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ name: 'worker', runtime: 'pty' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new HarnessDriverClient({
      baseUrl: 'http://127.0.0.1:3889',
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.spawnPty({
      name: 'worker',
      cli: 'codex',
      task: 'Ship it',
      spawnMode: 'task_exit',
      exitAfterTask: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3889/api/spawn',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(String),
      })
    );
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      name: 'worker',
      cli: 'codex',
      task: 'Ship it',
      spawnMode: 'task_exit',
      exitAfterTask: true,
    });
  });
});

// ── agentResultSchema coercion ─────────────────────────────────────────────

function createSpawnCapture() {
  const bodies: Record<string, unknown>[] = [];
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ name: 'worker', runtime: 'pty' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  const client = new HarnessDriverClient({
    baseUrl: 'http://broker.test',
    fetch: fetchMock as unknown as typeof globalThis.fetch,
  });
  return { client, bodies };
}

describe('agentResultSchema spawn coercion', () => {
  const jsonSchema = {
    type: 'object',
    properties: { score: { type: 'number' } },
    required: ['score'],
  };

  it('passes raw JSON Schema through unchanged (pty spawn)', async () => {
    const { client, bodies } = createSpawnCapture();
    await client.spawnPty({ name: 'worker', cli: 'claude', agentResultSchema: jsonSchema });
    expect(bodies[0].agentResultSchema).toEqual(jsonSchema);
  });

  it('converts a zod-style validator to JSON Schema before spawning (pty spawn)', async () => {
    const { client, bodies } = createSpawnCapture();
    const validator = {
      safeParse: (input: unknown) => ({ success: true, data: input }),
      toJSONSchema: () => jsonSchema,
    };
    await client.spawnPty({ name: 'worker', cli: 'claude', agentResultSchema: validator });
    expect(bodies[0].agentResultSchema).toEqual(jsonSchema);
  });

  it('converts a zod-style validator on cli spawns too', async () => {
    const { client, bodies } = createSpawnCapture();
    const validator = {
      safeParse: (input: unknown) => ({ success: true, data: input }),
      toJSONSchema: () => jsonSchema,
    };
    await client.spawnCli({ name: 'worker', cli: 'claude', agentResultSchema: validator });
    expect(bodies[0].agentResultSchema).toEqual(jsonSchema);
  });

  it('omits the field when no schema is provided', async () => {
    const { client, bodies } = createSpawnCapture();
    await client.spawnPty({ name: 'worker', cli: 'claude' });
    expect('agentResultSchema' in bodies[0]).toBe(false);
  });
});
