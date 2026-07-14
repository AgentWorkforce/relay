import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readWorkspaceStore, resolveActiveWorkspaceEntry, setWorkspaceKey } from './workspace-store.js';
import { joinWorkspace, resolveActiveWorkspace } from './workspaces.js';

let dir: string;
const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ws-'));
  process.env = {
    ...originalEnv,
    AGENT_RELAY_HOME: dir,
    CLOUD_API_URL: 'https://cloud.example.test',
    CLOUD_API_ACCESS_TOKEN: 'access-token',
    CLOUD_API_REFRESH_TOKEN: 'refresh-token',
    CLOUD_API_ACCESS_TOKEN_EXPIRES_AT: '2999-01-01T00:00:00.000Z',
  };
});

afterEach(() => {
  process.env = { ...originalEnv };
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('resolveActiveWorkspace', () => {
  it('resolves the active workspace key into a canonical descriptor', async () => {
    setWorkspaceKey('ops', 'rk_live_ops');
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            workspace: {
              name: 'Ops',
              key: 'rk_live_ops',
              cloudWorkspaceId: 'rw_ops',
              relaycastWorkspaceId: 'rc_ops',
              relaycastApiKey: 'rk_live_ops',
              relayfileWorkspaceId: 'rw_ops',
              relayauthWorkspaceId: 'rw_ops',
              organizationId: 'org_1',
              slug: 'ops',
              urls: {
                relayfileUrl: 'https://relayfile.example.test',
              },
              provisioned: true,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    );
    vi.stubGlobal('fetch', fetchSpy);

    await expect(resolveActiveWorkspace()).resolves.toEqual({
      name: 'Ops',
      key: 'rk_live_ops',
      cloudWorkspaceId: 'rw_ops',
      relaycastWorkspaceId: 'rc_ops',
      relaycastApiKey: 'rk_live_ops',
      relayfileWorkspaceId: 'rw_ops',
      relayauthWorkspaceId: 'rw_ops',
      organizationId: 'org_1',
      slug: 'ops',
      urls: {
        relayfileUrl: 'https://relayfile.example.test',
      },
      apiUrl: 'https://cloud.example.test',
      provisioned: true,
    });

    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      'https://cloud.example.test/api/v1/workspaces/rk_live_ops/resolve'
    );
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer access-token');
  });

  it('caches the resolved cloudWorkspaceId locally so a future orphaned key can self-heal', async () => {
    setWorkspaceKey('ops', 'rk_live_ops');
    expect(resolveActiveWorkspaceEntry()?.entry.cloudWorkspaceId).toBeUndefined();

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              workspace: {
                key: 'rk_live_ops',
                cloudWorkspaceId: 'rw_ops',
                relaycastWorkspaceId: 'rc_ops',
                relayfileWorkspaceId: 'rw_ops',
                relayauthWorkspaceId: 'rw_ops',
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
      )
    );

    await resolveActiveWorkspace();

    expect(resolveActiveWorkspaceEntry()?.entry).toEqual({ key: 'rk_live_ops', cloudWorkspaceId: 'rw_ops' });
  });

  it('self-heals an orphaned/rotated key via joinWorkspace when a cloudWorkspaceId is cached', async () => {
    // This alias previously resolved successfully to rw_ops (cloudWorkspaceId
    // cached), but the stored key no longer resolves — e.g. rotated server-side,
    // or orphaned by the AgentWorkforce/relay#1260 `workspace create` bug.
    setWorkspaceKey('ops', 'rk_live_stale', undefined, 'rw_ops');

    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (method === 'GET' && url.includes('rk_live_stale')) {
        return new Response(JSON.stringify({ error: 'Workspace not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (method === 'POST' && url === 'https://cloud.example.test/api/v1/workspaces/rw_ops/join') {
        return new Response(JSON.stringify({ workspaceId: 'rw_ops', relaycastApiKey: 'rk_live_healed' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (
        method === 'GET' &&
        url === 'https://cloud.example.test/api/v1/workspaces/rk_live_healed/resolve'
      ) {
        return new Response(
          JSON.stringify({
            workspace: {
              key: 'rk_live_healed',
              cloudWorkspaceId: 'rw_ops',
              relaycastWorkspaceId: 'rc_ops',
              relayfileWorkspaceId: 'rw_ops',
              relayauthWorkspaceId: 'rw_ops',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchSpy);

    const descriptor = await resolveActiveWorkspace();

    expect(descriptor.key).toBe('rk_live_healed');
    expect(descriptor.cloudWorkspaceId).toBe('rw_ops');
    // The healed key is persisted locally so subsequent calls don't self-heal
    // again on every resolve.
    expect(readWorkspaceStore().workspaces.ops).toEqual({ key: 'rk_live_healed', cloudWorkspaceId: 'rw_ops' });

    const joinCall = fetchSpy.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(joinCall).toBeDefined();
    expect(JSON.parse(String((joinCall![1] as RequestInit).body))).toEqual({
      agentName: 'cli-workspace-self-heal',
    });
  });

  it('falls through to the original resolve error when there is no cached cloudWorkspaceId to self-heal from', async () => {
    // A pure `workspace create` orphan (AgentWorkforce/relay#1260): never
    // successfully resolved, so there is nothing for self-heal to retry with.
    setWorkspaceKey('ops', 'rk_live_orphan');

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'Workspace not found' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          })
      )
    );

    await expect(resolveActiveWorkspace()).rejects.toThrow(/Workspace not found/);
  });

  it('falls through to the original resolve error when self-heal itself fails (e.g. no longer a member)', async () => {
    setWorkspaceKey('ops', 'rk_live_stale', undefined, 'rw_ops');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (method === 'POST') {
          return new Response(JSON.stringify({ error: 'Workspace not found' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ error: 'Workspace not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      })
    );

    await expect(resolveActiveWorkspace()).rejects.toThrow(/Workspace not found/);
  });
});

describe('joinWorkspace', () => {
  it('joins an existing workspace by id and returns its relaycastApiKey', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ workspaceId: 'rw_ops', relaycastApiKey: 'rk_live_joined' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetchSpy);

    await expect(joinWorkspace('rw_ops')).resolves.toEqual({
      workspaceId: 'rw_ops',
      relaycastApiKey: 'rk_live_joined',
    });

    expect(String(fetchSpy.mock.calls[0][0])).toBe('https://cloud.example.test/api/v1/workspaces/rw_ops/join');
    expect((fetchSpy.mock.calls[0][1] as RequestInit).method).toBe('POST');
  });

  it('throws when the response is missing relaycastApiKey', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ workspaceId: 'rw_ops' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
      )
    );

    await expect(joinWorkspace('rw_ops')).rejects.toThrow(/missing relaycastApiKey/);
  });

  it('rejects an empty workspace id without making a request', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(joinWorkspace('  ')).rejects.toThrow(/Workspace id is required/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
