import { describe, expect, it } from 'vitest';

import type { CoreClient, HelloResult } from './client.js';
import { CoreBridgeError, CoreRpcError } from './errors.js';
import {
  newIdempotencyKey,
  spawnInvoke,
  spawnRelease,
  spawnStatus,
  spawnTargets,
  type SpawnInvokeParams,
  type SpawnReleaseParams,
} from './spawn.js';

const ALL_METHODS = ['hello', 'spawn.targets', 'spawn.invoke', 'spawn.status', 'spawn.release'];

/** A client double that records calls instead of speaking to a core. */
function fakeClient(methods: string[] = ALL_METHODS) {
  const calls: { method: string; params: unknown }[] = [];
  const options: Array<unknown> = [];
  const hello: HelloResult = { bridge_version: 2, daemon_version: '17.2.1', pid: 1, methods, topics: [] };
  const client = {
    hello,
    socket: '/tmp/core.sock',
    closed: false,
    call: async (method: string, params?: unknown, opts?: unknown) => {
      calls.push({ method, params });
      options.push(opts);
      return { id: 'inv_1' };
    },
  } as unknown as CoreClient;
  return { client, calls, options };
}

const KEY = 'a'.repeat(32);

const invoke: SpawnInvokeParams = {
  caller_name: 'lead',
  node_id: 'node_1',
  node_name: 'laptop',
  name: 'worker-1',
  harness: 'claude',
  task: 'Write the tests.',
  directory: '/home/me/project',
  idempotency_key: KEY,
};

const release: SpawnReleaseParams = {
  caller_name: 'lead',
  node_id: 'node_1',
  node_name: 'laptop',
  name: 'worker-1',
  expected_agent_id: 'agent_1',
  idempotency_key: KEY,
};

async function invalidParams(promise: Promise<unknown>): Promise<CoreBridgeError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CoreBridgeError);
  expect((error as CoreBridgeError).code).toBe('invalid_params');
  return error as CoreBridgeError;
}

describe('spawn helpers', () => {
  it('send exactly the struct keys, dropping extras', async () => {
    const { client, calls } = fakeClient();
    await spawnTargets(client);
    await spawnInvoke(client, { ...invoke, token: 'secret' } as SpawnInvokeParams);
    await spawnStatus(client, {
      caller_name: 'lead',
      action: 'spawn',
      invocation_id: 'inv_1',
      extra: 1,
    } as never);
    await spawnRelease(client, { ...release, url: 'https://x' } as SpawnReleaseParams);
    expect(calls).toEqual([
      { method: 'spawn.targets', params: undefined },
      { method: 'spawn.invoke', params: invoke },
      { method: 'spawn.status', params: { caller_name: 'lead', action: 'spawn', invocation_id: 'inv_1' } },
      { method: 'spawn.release', params: release },
    ]);
    expect(Object.keys(calls[1].params as object)).toEqual([
      'caller_name',
      'node_id',
      'node_name',
      'name',
      'harness',
      'task',
      'directory',
      'idempotency_key',
    ]);
  });

  it('keep caller_secret through the key filter on every spawn control', async () => {
    const { client, calls } = fakeClient();
    const caller_secret = 'svc_secret_value';
    await spawnInvoke(client, { ...invoke, caller_secret });
    await spawnStatus(client, {
      caller_name: 'lead',
      caller_secret,
      action: 'spawn',
      invocation_id: 'inv_1',
    });
    await spawnRelease(client, { ...release, caller_secret });
    expect(calls.map((c) => (c.params as Record<string, unknown>).caller_secret)).toEqual([
      caller_secret,
      caller_secret,
      caller_secret,
    ]);
    expect(Object.keys(calls[0].params as object)).toEqual([
      'caller_name',
      'caller_secret',
      'node_id',
      'node_name',
      'name',
      'harness',
      'task',
      'directory',
      'idempotency_key',
    ]);
    expect(Object.keys(calls[1].params as object)).toEqual([
      'caller_name',
      'caller_secret',
      'action',
      'invocation_id',
    ]);
    expect(Object.keys(calls[2].params as object)).toEqual([
      'caller_name',
      'caller_secret',
      'node_id',
      'node_name',
      'name',
      'expected_agent_id',
      'idempotency_key',
    ]);
  });

  it('give slow spawn actions a long default while preserving per-call controls', async () => {
    const { client, options } = fakeClient();
    const signal = new AbortController().signal;
    await spawnInvoke(client, invoke, { signal });
    await spawnStatus(
      client,
      { caller_name: 'lead', action: 'spawn', invocation_id: 'inv_1' },
      {
        timeoutMs: 42,
        signal,
      }
    );
    await spawnRelease(client, release, { timeoutMs: 84, signal });
    expect(options).toEqual([
      { timeoutMs: 360_000, signal },
      { timeoutMs: 42, signal },
      { timeoutMs: 84, signal },
    ]);
  });

  it('refuse an empty, whitespace-only or non-string caller_secret without echoing it', async () => {
    const { client, calls } = fakeClient();
    const error = await invalidParams(spawnInvoke(client, { ...invoke, caller_secret: '' }));
    expect(error.message).toBe(
      'Native spawn input is invalid: caller_secret must be a non-empty string when given.'
    );
    await invalidParams(
      spawnStatus(client, {
        caller_name: 'lead',
        caller_secret: 42 as never,
        action: 'spawn',
        invocation_id: 'inv_1',
      })
    );
    await invalidParams(spawnRelease(client, { ...release, caller_secret: null as never }));
    for (const caller_secret of [' ', '\t', '\r\n']) {
      await invalidParams(spawnInvoke(client, { ...invoke, caller_secret }));
      await invalidParams(
        spawnStatus(client, { caller_name: 'lead', caller_secret, action: 'spawn', invocation_id: 'inv_1' })
      );
      await invalidParams(spawnRelease(client, { ...release, caller_secret }));
    }
    expect(calls).toEqual([]);
  });

  it('keeps a slow successful spawn receipt beyond the bridge default timeout', async () => {
    const { client: fixture } = fakeClient();
    const client = {
      ...fixture,
      call: async <T>(_method: string, _params?: Record<string, unknown>, options?: { timeoutMs?: number }) =>
        new Promise<T>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error('bridge default elapsed')),
            options?.timeoutMs ?? 5
          );
          setTimeout(() => {
            clearTimeout(timeout);
            resolve({ id: 'inv_slow' } as T);
          }, 20);
        }),
    } as CoreClient;
    await expect(spawnInvoke(client, invoke)).resolves.toEqual({ id: 'inv_slow' });
  });

  it('refuse short idempotency keys locally', async () => {
    const { client, calls } = fakeClient();
    const error = await invalidParams(spawnInvoke(client, { ...invoke, idempotency_key: 'short_key' }));
    expect(error.message).toContain('idempotency_key must be at least 16 characters');
    await invalidParams(spawnRelease(client, { ...release, idempotency_key: 'x'.repeat(15) }));
    expect(calls).toEqual([]);
  });

  it('refuse bad name segments locally', async () => {
    const { client, calls } = fakeClient();
    await invalidParams(spawnInvoke(client, { ...invoke, name: 'has space' }));
    await invalidParams(spawnInvoke(client, { ...invoke, caller_name: '' }));
    await invalidParams(spawnInvoke(client, { ...invoke, node_id: 'n'.repeat(201) }));
    await invalidParams(spawnInvoke(client, { ...invoke, idempotency_key: `${KEY}/..` }));
    await invalidParams(spawnRelease(client, { ...release, expected_agent_id: 'a.b' }));
    await invalidParams(spawnStatus(client, { caller_name: 'lead', action: 'spawn', invocation_id: 'x y' }));
    await invalidParams(
      spawnStatus(client, { caller_name: 'lead', action: 'kill' as never, invocation_id: 'inv_1' })
    );
    expect(calls).toEqual([]);
  });

  it('refuse relative directories and NUL bytes locally', async () => {
    const { client, calls } = fakeClient();
    await invalidParams(spawnInvoke(client, { ...invoke, directory: 'project' }));
    await invalidParams(spawnInvoke(client, { ...invoke, directory: '/home/\0me' }));
    await invalidParams(spawnInvoke(client, { ...invoke, harness: '' }));
    expect(calls).toEqual([]);
  });

  it('refuse empty or oversized tasks without echoing them', async () => {
    const { client, calls } = fakeClient();
    await invalidParams(spawnInvoke(client, { ...invoke, task: '   \n' }));
    const secret = `private ${'é'.repeat(32 * 1024)}`;
    const error = await invalidParams(spawnInvoke(client, { ...invoke, task: secret }));
    expect(error.message).toBe('Native spawn input is invalid: task must be non-empty and at most 64 KiB.');
    expect(calls).toEqual([]);
    // Exactly 64 KiB is allowed.
    await spawnInvoke(client, { ...invoke, task: 't'.repeat(64 * 1024) });
    expect(calls).toHaveLength(1);
  });

  it('report method_not_found when the core does not offer the method, sending nothing', async () => {
    const { client, calls } = fakeClient(['hello']);
    for (const call of [
      spawnTargets(client),
      spawnInvoke(client, invoke),
      spawnStatus(client, { caller_name: 'lead', action: 'release', invocation_id: 'inv_1' }),
      spawnRelease(client, release),
    ]) {
      const error = await call.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CoreRpcError);
      expect(error).toMatchObject({ kind: 'method_not_found', rpcCode: -32601, retryable: false });
    }
    expect(calls).toEqual([]);
  });

  it('make 32-hex idempotency keys', () => {
    const a = newIdempotencyKey();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newIdempotencyKey()).not.toBe(a);
  });
});
