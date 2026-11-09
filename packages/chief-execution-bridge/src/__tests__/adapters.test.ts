import type { CoreClient } from '@agent-relay/core-bridge';
import { CoreRpcError } from '@agent-relay/core-bridge';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreNode } from '../core-node.js';
import { exitCode, RelayError } from '../ports.js';
import { RelayHttpClient } from '../relay-http.js';

const TOKEN = 'at_live_secret_value';
type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;
let server: Server | undefined;

async function serve(handler: Handler): Promise<string> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => handler(req, res, Buffer.concat(chunks).toString()));
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};

describe('RelayHttpClient over loopback HTTP', () => {
  it('sends the agent token and reads identity', async () => {
    let auth: string | undefined;
    const origin = await serve((req, res) => {
      auth = req.headers.authorization;
      json(res, 200, { ok: true, data: { id: 'a1', workspace_id: 'w1' } });
    });
    await expect(new RelayHttpClient(origin, TOKEN).identity()).resolves.toMatchObject({
      agentId: 'a1',
      workspaceId: 'w1',
    });
    expect(auth).toBe(`Bearer ${TOKEN}`);
  });

  it('invokes spawn with the core-compatible body and idempotency key', async () => {
    let seen: { url?: string; key?: string | string[]; body?: unknown } = {};
    const origin = await serve((req, res, body) => {
      seen = { url: req.url, key: req.headers['idempotency-key'], body: JSON.parse(body) };
      json(res, 201, {
        ok: true,
        data: { invocation_id: 'inv1', status: 'dispatched', dispatched_node_id: 'n1' },
      });
    });
    const receipt = await new RelayHttpClient(origin, TOKEN).invokeSpawn({
      name: 'chief-x',
      harness: 'claude',
      task: 'do it',
      targetNodeName: 'node-one',
      directory: '/srv/app',
      idempotencyKey: 'chief-spawn-1234567890',
    });
    expect(seen).toEqual({
      url: '/v1/actions/spawn/invoke',
      key: 'chief-spawn-1234567890',
      body: {
        input: {
          name: 'chief-x',
          cli: 'claude',
          task: 'do it',
          target_node: 'node-one',
          worker_cwd: '/srv/app',
          verify_ready: true,
        },
      },
    });
    expect(receipt).toMatchObject({ id: 'inv1', status: 'dispatched', nodeId: 'n1', spawned: false });
  });

  it('reads spawned and ready only when exactly true', async () => {
    const origin = await serve((_req, res) => {
      json(res, 200, {
        ok: true,
        data: { id: 'inv1', status: 'completed', output: { name: 'x', spawned: 'true', ready: 1 } },
      });
    });
    await expect(new RelayHttpClient(origin, TOKEN).invocation('inv1')).resolves.toMatchObject({
      spawned: false,
      ready: false,
    });
  });

  it('accepts the in-flight invoked status and maps denied to failed', async () => {
    let status = 'invoked';
    const origin = await serve((_req, res) => json(res, 200, { ok: true, data: { id: 'inv1', status } }));
    const client = new RelayHttpClient(origin, TOKEN);
    await expect(client.invocation('inv1')).resolves.toMatchObject({ status: 'invoked' });
    status = 'denied';
    await expect(client.invocation('inv1')).resolves.toMatchObject({ status: 'failed' });
  });

  it('lists every conversation and reads the last message ID', async () => {
    let url: string | undefined;
    const origin = await serve((req, res) => {
      url = req.url;
      json(res, 200, {
        ok: true,
        data: [
          { id: 'c1', type: '1:1', participants: [{ agent_id: 'a' }], last_message: { id: '5' } },
          { id: 'c2', type: '1:1', participants: [], last_message: null },
        ],
      });
    });
    const listed = await new RelayHttpClient(origin, TOKEN).conversations();
    expect(url).toBe('/v1/dm/conversations');
    expect(listed.map((c) => c.lastMessageId)).toEqual(['5', undefined]);
  });

  it('refuses a receipt for a different invocation', async () => {
    const origin = await serve((_req, res) =>
      json(res, 200, { ok: true, data: { id: 'inv2', status: 'running' } })
    );
    await expect(new RelayHttpClient(origin, TOKEN).invocation('inv1')).rejects.toMatchObject({
      code: 'relay_response_invalid',
    });
  });

  it('sends a report by exact address with its key', async () => {
    let seen: { key?: string | string[]; body?: unknown } = {};
    const origin = await serve((req, res, body) => {
      seen = { key: req.headers['idempotency-key'], body: JSON.parse(body) };
      json(res, 201, { ok: true, data: {} });
    });
    await new RelayHttpClient(origin, TOKEN).sendReport({
      address: 'chief@host',
      text: 'Worker accepted',
      data: { chief_report: { sequence: 1 } },
      idempotencyKey: 'chief-report-abc',
    });
    expect(seen).toEqual({
      key: 'chief-report-abc',
      body: {
        address: 'chief@host',
        text: 'Worker accepted',
        mode: 'wait',
        data: { chief_report: { sequence: 1 } },
      },
    });
  });

  it('classifies 5xx and 429 as retryable and 403 as final', async () => {
    let status = 503;
    const origin = await serve((_req, res) => json(res, status, { error: 'x' }));
    const client = new RelayHttpClient(origin, TOKEN);
    await expect(client.identity()).rejects.toMatchObject({ code: 'relay_http_503', retryable: true });
    status = 429;
    await expect(client.identity()).rejects.toMatchObject({ retryable: true });
    status = 403;
    await expect(client.identity()).rejects.toMatchObject({ code: 'relay_http_403', retryable: false });
  });

  it('never puts a response body or token in an error', async () => {
    const origin = await serve((_req, res) => json(res, 500, { provider_secret: 'sk-provider-body' }));
    const error = (await new RelayHttpClient(origin, TOKEN)
      .identity()
      .catch((e: unknown) => e)) as RelayError;
    expect(error).toBeInstanceOf(RelayError);
    const rendered = `${error.message} ${JSON.stringify(error)} ${String(error.stack)}`;
    expect(rendered).not.toContain('sk-provider-body');
    expect(rendered).not.toContain(TOKEN);
  });

  it('does not follow a redirect with the token', async () => {
    let hits = 0;
    const origin = await serve((_req, res) => {
      hits += 1;
      res.writeHead(302, { location: '/elsewhere' });
      res.end();
    });
    await expect(new RelayHttpClient(origin, TOKEN).identity()).rejects.toMatchObject({
      code: 'relay_transport_failed',
      retryable: true,
    });
    expect(hits).toBe(1);
  });

  it("accepts Relaycast's variable-length snowflake message IDs", async () => {
    const origin = await serve((_req, res) =>
      json(res, 200, {
        ok: true,
        data: [{ id: '245678901234567890', agent_id: 'a', agent_name: 'n', text: 't' }],
      })
    );
    await expect(new RelayHttpClient(origin, TOKEN).messages('c1', { limit: 1 })).resolves.toMatchObject([
      { id: '245678901234567890' },
    ]);
  });

  it('refuses a message ID that is not a snowflake', async () => {
    const origin = await serve((_req, res) =>
      json(res, 200, { ok: true, data: [{ id: 'dm_1', agent_id: 'a', agent_name: 'n', text: 't' }] })
    );
    await expect(new RelayHttpClient(origin, TOKEN).messages('c1', { limit: 1 })).rejects.toMatchObject({
      code: 'relay_response_invalid',
    });
  });

  it('stops reading a response as soon as it passes the size limit', async () => {
    let cancelled = false;
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    await expect(
      new RelayHttpClient('https://relay.example', TOKEN, fetchImpl).identity()
    ).rejects.toMatchObject({ code: 'relay_response_too_large', retryable: true });
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(6);
  });

  it('reports a body that fails partway as a transport failure', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('reset'));
      },
    });
    const fetchImpl = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    await expect(
      new RelayHttpClient('https://relay.example', TOKEN, fetchImpl).identity()
    ).rejects.toMatchObject({ code: 'relay_transport_failed' });
  });

  it('refuses a malformed success', async () => {
    const origin = await serve((_req, res) => json(res, 200, { ok: true, data: { nope: 1 } }));
    await expect(new RelayHttpClient(origin, TOKEN).identity()).rejects.toMatchObject({
      code: 'relay_response_invalid',
    });
  });

  it('refuses an empty token', () => {
    expect(() => new RelayHttpClient('https://relay.example', ' ')).toThrow('relay_token_missing');
  });
});

describe('process exit code', () => {
  it('keeps a machine-readable code, digits included', () => {
    expect(exitCode(new RelayError('relay_http_403', false))).toBe('relay_http_403');
  });

  it.each([new Error('Unexpected token < in JSON'), 'not an error'])('hides %s', (error) => {
    expect(exitCode(error)).toBe('bridge_failed');
  });
});

describe('CoreNode preflight against a fake core', () => {
  const node = { id: 'n1', name: 'node-one' };
  const goodTarget = {
    id: 'n1',
    name: 'node-one',
    live: true,
    handlers_live: true,
    stale: false,
    capabilities: ['spawn:claude'],
    active_agents: 0,
    reserved_agents: 0,
    max_agents: 2,
  };
  const goodSettings = {
    accept_spawns: true,
    spawn_full_access_claude: false,
    spawn_requester_approvals: false,
  };

  function fakeCore(settings: object, targets: object[], calls: string[] = []): () => Promise<CoreClient> {
    return async () =>
      ({
        hello: { methods: ['spawn.targets', 'settings.get', 'agents.end'] },
        call: async (method: string) => {
          calls.push(method);
          if (method === 'settings.get') return settings;
          if (method === 'spawn.targets') return { targets };
          return {};
        },
        close: async () => undefined,
      }) as unknown as CoreClient;
  }

  it('passes a correctly configured node', async () => {
    const core = new CoreNode({ connect: fakeCore(goodSettings, [goodTarget]) });
    await expect(core.preflight('claude', node)).resolves.toBeUndefined();
  });

  it.each([
    [
      'full access on',
      { ...goodSettings, spawn_full_access_claude: true },
      [goodTarget],
      'full_access_enabled',
    ],
    ['full access unreported', { accept_spawns: true }, [goodTarget], 'full_access_enabled'],
    ['spawns off', { ...goodSettings, accept_spawns: false }, [goodTarget], 'spawns_not_accepted'],
    [
      'requester approvals on',
      { ...goodSettings, spawn_requester_approvals: true },
      [goodTarget],
      'requester_approvals_enabled',
    ],
    ['unknown node', goodSettings, [{ ...goodTarget, id: 'other' }], 'node_not_found'],
    ['offline', goodSettings, [{ ...goodTarget, live: false }], 'node_not_live'],
    ['stale', goodSettings, [{ ...goodTarget, stale: true }], 'node_not_live'],
    ['no harness', goodSettings, [{ ...goodTarget, capabilities: ['spawn:codex'] }], 'harness_not_available'],
    [
      'requester approvals unreported',
      { accept_spawns: true, spawn_full_access_claude: false },
      [goodTarget],
      'requester_approvals_enabled',
    ],
    ['full', goodSettings, [{ ...goodTarget, active_agents: 1, reserved_agents: 1 }], 'node_at_capacity'],
  ])('refuses: %s', async (_label, settings, targets, code) => {
    const core = new CoreNode({ connect: fakeCore(settings, targets as object[]) });
    await expect(core.preflight('claude', node)).resolves.toBe(code);
  });

  it('treats max_agents 0 as no limit', async () => {
    const core = new CoreNode({
      connect: fakeCore(goodSettings, [{ ...goodTarget, max_agents: 0, active_agents: 9 }]),
    });
    await expect(core.preflight('claude', node)).resolves.toBeUndefined();
  });

  it('fails closed when the core cannot be reached', async () => {
    const core = new CoreNode({
      connect: async () => {
        throw new Error('nope');
      },
    });
    await expect(core.preflight('claude', node)).resolves.toBe('core_unavailable');
  });

  const failing = (kind: string) => async () =>
    ({
      call: async () => {
        throw new CoreRpcError('x', { kind: kind as never });
      },
      close: async () => undefined,
    }) as unknown as CoreClient;

  it('maps agents.end outcomes', async () => {
    await expect(new CoreNode({ connect: fakeCore(goodSettings, []) }).endAgent('x')).resolves.toBe('ended');
    await expect(new CoreNode({ connect: failing('not_found') }).endAgent('x')).resolves.toBe('not_found');
    await expect(new CoreNode({ connect: failing('refused') }).endAgent('x')).resolves.toBe('refused');
    await expect(new CoreNode({ connect: failing('internal') }).endAgent('x')).rejects.toBeInstanceOf(Error);
  });
});
