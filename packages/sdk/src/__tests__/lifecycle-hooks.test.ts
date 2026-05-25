import { describe, expect, it, vi } from 'vitest';

import { AgentRelayClient } from '../client.js';
import type {
  AfterAgentReleaseContext,
  AfterAgentSpawnContext,
  BeforeAgentReleaseContext,
  BeforeAgentSpawnContext,
  BeforeAgentSpawnHandler,
  SpawnPatch,
} from '../lifecycle-hooks.js';
import type { SpawnPtyInput } from '../types.js';

/**
 * Build a mock fetch that records every request and returns a 200 JSON
 * payload constructed from the request body. For `/api/spawn` POSTs, the
 * response is `{ name, runtime: 'pty' }` so the client's spawn methods
 * can resolve cleanly without a live broker.
 */
function makeMockFetch(
  responses: Array<(req: { method: string; body: unknown; path: string }) => unknown> = []
) {
  const captures: Array<{ path: string; method: string; body: unknown }> = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    const path = new URL(u).pathname;
    const method = (init?.method ?? 'GET').toUpperCase();
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const body = bodyText ? JSON.parse(bodyText) : undefined;
    captures.push({ path, method, body });
    const next = responses.shift();
    const payload = next
      ? next({ method, body, path })
      : path === '/api/spawn'
        ? { name: (body as { name?: string })?.name ?? 'spawned', runtime: 'pty' }
        : path.startsWith('/api/spawned/')
          ? { name: decodeURIComponent(path.slice('/api/spawned/'.length).split('/')[0]) }
          : {};
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return { fetchFn, captures };
}

function makeClient(fetchFn: typeof globalThis.fetch): AgentRelayClient {
  return new AgentRelayClient({ baseUrl: 'http://broker.test', apiKey: 'k', fetch: fetchFn });
}

describe('AgentRelayClient lifecycle hooks', () => {
  it('emits beforeAgentSpawn before the HTTP POST and afterAgentSpawn after', async () => {
    const { fetchFn, captures } = makeMockFetch();
    const client = makeClient(fetchFn);
    const events: string[] = [];

    client.addListener('beforeAgentSpawn', (ctx) => {
      events.push(`before:${ctx.kind}:${ctx.input.name}`);
      // Fetch must not have been called yet
      expect(fetchFn).not.toHaveBeenCalled();
    });
    client.addListener('afterAgentSpawn', (ctx) => {
      events.push(`after:${ctx.result?.name ?? 'no-result'}`);
    });

    const result = await client.spawnPty({ name: 'agent-a', cli: 'claude' });

    expect(result).toEqual({ name: 'agent-a', runtime: 'pty' });
    expect(events).toEqual(['before:pty:agent-a', 'after:agent-a']);
    expect(captures).toHaveLength(1);
    expect(captures[0].path).toBe('/api/spawn');
  });

  it('validates spawn responses before returning them', async () => {
    const { fetchFn } = makeMockFetch([() => ({ name: 'agent-bad', runtime: 'invalid' })]);
    const client = makeClient(fetchFn);

    await expect(client.spawnPty({ name: 'agent-bad', cli: 'claude' })).rejects.toThrow();
  });

  it('normalizes null spawn sessionId to undefined', async () => {
    const { fetchFn } = makeMockFetch([() => ({ name: 'agent-null', runtime: 'pty', sessionId: null })]);
    const client = makeClient(fetchFn);

    const result = await client.spawnPty({ name: 'agent-null', cli: 'claude' });

    expect(result.sessionId).toBeUndefined();
  });

  it('folds beforeAgentSpawn patches into resolvedInput before POST', async () => {
    const { fetchFn, captures } = makeMockFetch();
    const client = makeClient(fetchFn);

    client.addListener('beforeAgentSpawn', () => ({
      args: ['--session-id', 'abc-123'],
    }));
    client.addListener('beforeAgentSpawn', () => ({
      task: 'override-task',
    }));

    const after = vi.fn();
    client.addListener('afterAgentSpawn', after);

    await client.spawnPty({ name: 'agent-b', cli: 'claude', args: ['--initial'] });

    expect(captures[0].body).toMatchObject({
      name: 'agent-b',
      cli: 'claude',
      args: ['--session-id', 'abc-123'], // patch replaced the array
      task: 'override-task',
    });
    expect(after).toHaveBeenCalledTimes(1);
    const ctx = after.mock.calls[0][0] as AfterAgentSpawnContext;
    expect(ctx.resolvedInput.args).toEqual(['--session-id', 'abc-123']);
    expect((ctx.resolvedInput as SpawnPtyInput).task).toBe('override-task');
  });

  it('merges patches in registration order (later wins)', async () => {
    const { fetchFn, captures } = makeMockFetch();
    const client = makeClient(fetchFn);

    client.addListener('beforeAgentSpawn', () => ({ model: 'haiku' }));
    client.addListener('beforeAgentSpawn', () => ({ model: 'opus' }));

    await client.spawnPty({ name: 'm', cli: 'claude' });

    expect(captures[0].body).toMatchObject({ model: 'opus' });
  });

  it('void return is observe-only — no patch applied', async () => {
    const { fetchFn, captures } = makeMockFetch();
    const client = makeClient(fetchFn);

    const observer = vi.fn(() => undefined);
    client.addListener('beforeAgentSpawn', observer);

    await client.spawnPty({ name: 'obs', cli: 'claude', args: ['x', 'y'] });

    expect(observer).toHaveBeenCalledTimes(1);
    expect(captures[0].body).toMatchObject({ args: ['x', 'y'] });
  });

  it('hook errors are caught — spawn still proceeds with the prior resolved input', async () => {
    const { fetchFn, captures } = makeMockFetch();
    const client = makeClient(fetchFn);
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});

    client.addListener('beforeAgentSpawn', () => ({ args: ['--first'] }));
    client.addListener('beforeAgentSpawn', () => {
      throw new Error('hook went boom');
    });
    client.addListener('beforeAgentSpawn', () => ({ task: 'survived' }));

    await client.spawnPty({ name: 'resilient', cli: 'claude' });

    expect(captures[0].body).toMatchObject({
      args: ['--first'],
      task: 'survived',
    });
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  it('afterAgentSpawn fires with error context when the HTTP call rejects', async () => {
    const fetchFn = vi.fn(async () => {
      return new Response('boom', { status: 500, statusText: 'Internal Error' });
    });
    const client = new AgentRelayClient({
      baseUrl: 'http://broker.test',
      apiKey: 'k',
      fetch: fetchFn,
    });

    const seen: AfterAgentSpawnContext[] = [];
    client.addListener('afterAgentSpawn', (ctx) => {
      seen.push(ctx);
    });

    await expect(client.spawnPty({ name: 'fail', cli: 'claude' })).rejects.toThrow();
    expect(seen).toHaveLength(1);
    expect(seen[0].error).toBeInstanceOf(Error);
    expect(seen[0].result).toBeUndefined();
    expect(seen[0].resolvedInput.name).toBe('fail');
  });

  it('captures spawnerPid + spawnStartTs on the before context', async () => {
    const { fetchFn } = makeMockFetch();
    const client = makeClient(fetchFn);

    let captured: BeforeAgentSpawnContext | undefined;
    client.addListener('beforeAgentSpawn', (ctx) => {
      captured = ctx;
    });

    await client.spawnPty({ name: 'p', cli: 'claude' });

    expect(captured).toBeDefined();
    expect(captured!.spawnerPid).toBe(process.pid);
    expect(captured!.spawnStartTs).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(captured!.baseUrl).toBe('http://broker.test');
    expect(captured!.kind).toBe('pty');
  });

  it('spawnProvider fires the hooks with kind=provider', async () => {
    const { fetchFn } = makeMockFetch();
    const client = makeClient(fetchFn);
    const before = vi.fn();
    const after = vi.fn();
    client.addListener('beforeAgentSpawn', before);
    client.addListener('afterAgentSpawn', after);

    await client.spawnProvider({ name: 'p', provider: 'claude' });

    expect(before).toHaveBeenCalledTimes(1);
    expect((before.mock.calls[0][0] as BeforeAgentSpawnContext).kind).toBe('provider');
    expect(after).toHaveBeenCalledTimes(1);
    expect((after.mock.calls[0][0] as AfterAgentSpawnContext).kind).toBe('provider');
  });

  it('release fires beforeAgentRelease then afterAgentRelease', async () => {
    const { fetchFn } = makeMockFetch();
    const client = makeClient(fetchFn);
    const order: string[] = [];

    client.addListener('beforeAgentRelease', (ctx: BeforeAgentReleaseContext) => {
      order.push(`before:${ctx.name}:${ctx.reason ?? ''}`);
    });
    client.addListener('afterAgentRelease', (ctx: AfterAgentReleaseContext) => {
      order.push(`after:${ctx.name}:${ctx.durationMs >= 0 ? 'ok' : 'bad'}`);
    });

    await client.release('agent-x', 'cleanup');

    expect(order).toEqual(['before:agent-x:cleanup', 'after:agent-x:ok']);
  });

  it('removeListener stops further deliveries', async () => {
    const { fetchFn } = makeMockFetch();
    const client = makeClient(fetchFn);
    const fn = vi.fn();
    client.addListener('beforeAgentSpawn', fn);
    await client.spawnPty({ name: 'a', cli: 'claude' });
    expect(fn).toHaveBeenCalledTimes(1);

    client.removeListener('beforeAgentSpawn', fn);
    await client.spawnPty({ name: 'b', cli: 'claude' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('accepts a BeforeAgentSpawnHandler-typed function without a cast', async () => {
    // Regression for the addListener overload: a handler that's typed
    // separately as BeforeAgentSpawnHandler (return: void | SpawnPatch
    // | Promise<void | SpawnPatch>) must satisfy the addListener signature
    // without `as` gymnastics. Before the overload landed this assignment
    // failed with TS2345 because the default `void`-returning shape didn't
    // cover the SpawnPatch return.
    const { fetchFn, captures } = makeMockFetch();
    const client = makeClient(fetchFn);

    const handler: BeforeAgentSpawnHandler = (ctx) => {
      if (ctx.input.cli !== 'claude') return;
      return { args: [...(ctx.input.args ?? []), '--from-typed-handler'] };
    };
    client.addListener('beforeAgentSpawn', handler);

    await client.spawnPty({ name: 'typed', cli: 'claude', args: ['--orig'] });

    expect(captures[0].body).toMatchObject({
      args: ['--orig', '--from-typed-handler'],
    });

    // removeListener must accept the same handler shape without casting.
    client.removeListener('beforeAgentSpawn', handler);
    await client.spawnPty({ name: 'typed-2', cli: 'claude', args: ['--orig'] });
    expect(captures[1].body).toMatchObject({ args: ['--orig'] });
  });

  it('patch shape: extending args requires explicit spread', async () => {
    // Documents the array-replace contract: a patch's `args` overrides
    // the previous `args` outright; handlers must spread to extend.
    const { fetchFn, captures } = makeMockFetch();
    const client = makeClient(fetchFn);
    client.addListener(
      'beforeAgentSpawn',
      (ctx): SpawnPatch => ({
        args: [...(ctx.input.args ?? []), '--extra'],
      })
    );

    await client.spawnPty({ name: 'a', cli: 'claude', args: ['--orig'] });

    expect(captures[0].body).toMatchObject({ args: ['--orig', '--extra'] });
  });
});
