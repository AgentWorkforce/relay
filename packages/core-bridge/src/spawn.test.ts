import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { CoreClient, HelloResult } from './client.js';
import { CoreBridgeError, CoreRpcError } from './errors.js';
import {
  DEFAULT_SPAWN_ACTION_TIMEOUT_MS,
  isReleaseConfirmed,
  newIdempotencyKey,
  spawnInvoke,
  spawnRelease,
  spawnStatus,
  spawnTargets,
  type SpawnControlInvocation,
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

  it('send no caller on a bound connection, under the same key order', async () => {
    const { client, calls } = fakeClient();
    const { caller_name: _invoker, ...boundInvoke } = invoke;
    const { caller_name: _releaser, ...boundRelease } = release;
    await spawnInvoke(client, boundInvoke);
    await spawnStatus(client, { action: 'spawn', invocation_id: 'inv_1' });
    await spawnRelease(client, boundRelease);
    for (const call of calls) expect(call.params).not.toHaveProperty('caller_name');
    expect(Object.keys(calls[0].params as object)).toEqual([
      'node_id',
      'node_name',
      'name',
      'harness',
      'task',
      'directory',
      'idempotency_key',
    ]);
    expect(Object.keys(calls[1].params as object)).toEqual(['action', 'invocation_id']);
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
    await spawnInvoke(client, invoke, { actionTimeoutMs: 900_000, timeoutMs: 1, signal });
    await spawnRelease(client, release, { actionTimeoutMs: 120_000 });
    expect(options).toEqual([
      { timeoutMs: DEFAULT_SPAWN_ACTION_TIMEOUT_MS, signal },
      { timeoutMs: 42, signal },
      { timeoutMs: 84, signal },
      { timeoutMs: 900_000, signal },
      { timeoutMs: 120_000 },
    ]);
    expect(DEFAULT_SPAWN_ACTION_TIMEOUT_MS).toBe(360_000);
  });

  it('refuse a caller_secret on every spawn control before filtering, without echoing it', async () => {
    const { client, calls } = fakeClient();
    const secret = 'rsc_never_sent_value';
    const legacy = async (promise: Promise<unknown>) => {
      const error = await promise.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CoreBridgeError);
      expect((error as CoreBridgeError).code).toBe('legacy_credential_refused');
      expect((error as Error).message).not.toContain(secret);
    };
    for (const caller_secret of [secret, '', undefined, null]) {
      await legacy(spawnInvoke(client, { ...invoke, caller_secret } as never));
      await legacy(
        spawnStatus(client, {
          caller_name: 'lead',
          caller_secret,
          action: 'spawn',
          invocation_id: 'inv_1',
        } as never)
      );
      await legacy(spawnRelease(client, { ...release, caller_secret } as never));
    }
    // Even before the method check: nothing reaches the core.
    const bare = fakeClient(['hello']);
    await legacy(spawnInvoke(bare.client, { ...invoke, caller_secret: secret } as never));
    expect(calls).toEqual([]);
    expect(bare.calls).toEqual([]);
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
    await expect(spawnInvoke(client, invoke)).resolves.toEqual({ id: 'inv_slow', released: false });
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

  describe('released', () => {
    const receipt = (fields: Record<string, unknown>) => ({
      id: 'inv_release',
      agent_id: null,
      status: 'completed',
      node_id: 'node_1',
      name: 'worker-1',
      spawned: false,
      ready: false,
      task_unconfirmed: false,
      error_code: null,
      ...fields,
    });
    const fixtures: Array<[string, Record<string, unknown>, boolean]> = [
      ['true', receipt({ released: true }), true],
      ['false', receipt({ released: false }), false],
      ['absent, though completed', receipt({}), false],
      ['null', receipt({ released: null }), false],
      ['the string "true"', receipt({ released: 'true' }), false],
      ['1', receipt({ released: 1 }), false],
      [
        'a failed release',
        receipt({ status: 'failed', error_code: 'release_failed', released: false }),
        false,
      ],
      [
        'a failed release without the field',
        receipt({ status: 'failed', error_code: 'release_failed' }),
        false,
      ],
    ];
    const replying = (reply: unknown) =>
      ({ ...fakeClient().client, call: async () => structuredClone(reply) }) as unknown as CoreClient;
    const calls = (client: CoreClient) => [
      spawnInvoke(client, invoke),
      spawnStatus(client, { caller_name: 'lead', action: 'release', invocation_id: 'inv_release' }),
      spawnRelease(client, release),
    ];

    it.each(fixtures)('is %s → %s on invoke, status and release', async (_label, reply, expected) => {
      for (const answer of await Promise.all(calls(replying(reply)))) {
        expect(answer.released).toBe(expected);
        expect(typeof answer.released).toBe('boolean');
        // Nothing else in the reply changes.
        expect({ ...answer, released: reply.released }).toEqual(reply);
      }
    });

    it.each(fixtures)(
      'confirms a release that is %s only on released === true',
      (_label, reply, expected) => {
        expect(isReleaseConfirmed(reply)).toBe(expected);
        expect(isReleaseConfirmed(reply)).toBe(reply.released === true);
      }
    );

    it('reads the shared release receipt vectors as the core records them', async () => {
      // The same file the core's Rust test checks its recorded receipts against.
      const vectors = JSON.parse(
        readFileSync(
          new URL('../../../crates/relay-node/tests/fixtures/spawn-release-receipts.json', import.meta.url),
          'utf8'
        )
      ) as {
        version: number;
        cases: Array<{ name: string; receipt: SpawnControlInvocation; confirmed: boolean }>;
      };
      expect(vectors.version).toBe(1);
      expect(vectors.cases.length).toBeGreaterThanOrEqual(4);
      for (const vector of vectors.cases) {
        expect(isReleaseConfirmed(vector.receipt), vector.name).toBe(vector.confirmed);
        const answer = await spawnRelease(replying(vector.receipt), release);
        expect(answer.released, vector.name).toBe(vector.confirmed);
        expect({ ...answer, released: vector.receipt.released }, vector.name).toEqual(vector.receipt);
      }
    });

    it('never confirms from status alone, nor a missing invocation', () => {
      const completed: SpawnControlInvocation = {
        ...(receipt({}) as SpawnControlInvocation),
        status: 'completed',
        released: false,
      };
      expect(isReleaseConfirmed(completed)).toBe(false);
      expect(isReleaseConfirmed({})).toBe(false);
      expect(isReleaseConfirmed(null)).toBe(false);
      expect(isReleaseConfirmed(undefined)).toBe(false);
    });
  });
});
