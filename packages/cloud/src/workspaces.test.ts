import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readWorkspaceStore, resolveActiveWorkspaceEntry, setWorkspaceKey } from './workspace-store.js';
import { joinWorkspace, resolveActiveWorkspace, resolveWorkspaceByKey } from './workspaces.js';
import { AUTH_FILE_PATH } from './types.js';

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

      if (method === 'GET' && url === 'https://cloud.example.test/api/v1/workspaces/rk_live_healed/resolve') {
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
    expect(readWorkspaceStore().workspaces.ops).toEqual({
      key: 'rk_live_healed',
      cloudWorkspaceId: 'rw_ops',
    });

    const joinCall = fetchSpy.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST'
    );
    expect(joinCall).toBeDefined();
    expect(JSON.parse(String((joinCall![1] as RequestInit).body))).toEqual({
      agentName: 'cli-workspace-self-heal',
    });
  });

  it('self-heals even when the primary resolve throws a non-404 error (e.g. 403 from a rotated key)', async () => {
    // Regression test: resolveWorkspaceDescriptor throws (doesn't return
    // `{ lastUnsupported }`) for any non-404/405 response. Before wrapping the
    // primary resolve in a catch, this propagated straight out of
    // resolveActiveWorkspace and skipped the self-heal block entirely, even
    // though a cached cloudWorkspaceId was available to retry with.
    // (403, not 401: a 401 makes authorizedApiFetch attempt a token refresh +
    // retry first, which is a separate concern from this test.)
    setWorkspaceKey('ops', 'rk_live_stale', undefined, 'rw_ops');

    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (method === 'GET' && url.includes('rk_live_stale')) {
        return new Response(JSON.stringify({ error: 'Forbidden' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (method === 'POST' && url === 'https://cloud.example.test/api/v1/workspaces/rw_ops/join') {
        return new Response(JSON.stringify({ workspaceId: 'rw_ops', relaycastApiKey: 'rk_live_healed' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (method === 'GET' && url === 'https://cloud.example.test/api/v1/workspaces/rk_live_healed/resolve') {
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
    expect(readWorkspaceStore().workspaces.ops).toEqual({
      key: 'rk_live_healed',
      cloudWorkspaceId: 'rw_ops',
    });
  });

  it('rethrows a transient transport/network error unchanged, without self-healing or touching the stored key', async () => {
    // A network failure hitting the resolve endpoint is NOT a "this key
    // doesn't resolve" signal — only a genuine non-2xx HTTP response from
    // resolve itself (WorkspaceResolveHttpError) is self-healable. Treating a
    // transient blip as self-healable would mint a new key and overwrite the
    // local store even though the original key may still be perfectly valid.
    setWorkspaceKey('ops', 'rk_live_ops', undefined, 'rw_ops');

    const fetchSpy = vi.fn(async () => {
      throw new TypeError('fetch failed: network error');
    });
    vi.stubGlobal('fetch', fetchSpy);

    await expect(resolveActiveWorkspace()).rejects.toThrow('fetch failed: network error');

    // Never attempted to self-heal: no POST /join call, and the stored key is untouched.
    expect(fetchSpy.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(
      false
    );
    expect(readWorkspaceStore().workspaces.ops).toEqual({ key: 'rk_live_ops', cloudWorkspaceId: 'rw_ops' });
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

    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      'https://cloud.example.test/api/v1/workspaces/rw_ops/join'
    );
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

describe('resolveWorkspaceByKey', () => {
  const resolvedWorkspace = {
    workspace: {
      name: 'Selected',
      key: 'rk_live_selected',
      cloudWorkspaceId: 'cloud_selected',
      relaycastWorkspaceId: 'rw_selected',
      relayfileWorkspaceId: 'rf_selected',
      relayauthWorkspaceId: 'ra_selected',
    },
  };

  it('ignores an ambient API host when an isolated environment omits it', async () => {
    process.env.CLOUD_API_URL = 'http://ambient.example.test';
    const originalReadFile = fsPromises.readFile.bind(fsPromises);
    const readFileSpy = vi.spyOn(fsPromises, 'readFile').mockImplementation(async (...args) => {
      if (String(args[0]) === AUTH_FILE_PATH) {
        return JSON.stringify({
          apiUrl: 'https://stored.example.test',
          accessToken: 'stored-access-token',
          refreshToken: 'stored-refresh-token',
          accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
        });
      }
      return originalReadFile(...args);
    });
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(resolvedWorkspace), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      await resolveWorkspaceByKey('rk_live_selected', { env: {} });
      expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
        'https://stored.example.test/api/v1/workspaces/current/resolve'
      );
    } finally {
      readFileSpy.mockRestore();
    }
  });

  it('sends the selected key in a POST body and never in the request URL', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify(resolvedWorkspace), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetchSpy);

    await expect(resolveWorkspaceByKey('rk_live_selected')).resolves.toMatchObject({
      key: 'rk_live_selected',
      cloudWorkspaceId: 'cloud_selected',
    });

    const [request, init] = fetchSpy.mock.calls[0]!;
    expect(String(request)).toBe('https://cloud.example.test/api/v1/workspaces/current/resolve');
    expect(String(request)).not.toContain('rk_live_selected');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).redirect).toBe('error');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      workspaceKey: 'rk_live_selected',
    });
  });

  it('uses credentials from explicit resolver env instead of ambient process env', async () => {
    process.env.CLOUD_API_ACCESS_TOKEN = 'ambient-access-token';
    const env = {
      ...process.env,
      CLOUD_API_URL: 'https://cloud.explicit.example.test',
      CLOUD_API_ACCESS_TOKEN: 'explicit-access-token',
      CLOUD_API_REFRESH_TOKEN: 'explicit-refresh-token',
      CLOUD_API_ACCESS_TOKEN_EXPIRES_AT: '2999-01-01T00:00:00.000Z',
    };
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify(resolvedWorkspace), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetchSpy);

    await resolveWorkspaceByKey('rk_live_selected', { env });

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer explicit-access-token');
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      'https://cloud.explicit.example.test/api/v1/workspaces/current/resolve'
    );
  });

  it.each([
    'http://cloud.example.test',
    'http://localhost:8787',
    'http://127.0.0.1:8787',
    'http://[::1]:8787',
    'https://user:password@cloud.example.test',
    'file:///tmp/cloud',
  ])('rejects unsafe resolver transport before any credential request: %s', async (apiUrl) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(resolveWorkspaceByKey('rk_live_selected', { apiUrl })).rejects.toThrow('requires HTTPS');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects an insecure stored session host before refreshing its credentials', async () => {
    process.env.CLOUD_API_URL = 'http://insecure.example.test';
    process.env.CLOUD_API_ACCESS_TOKEN_EXPIRES_AT = '2000-01-01T00:00:00.000Z';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(
      resolveWorkspaceByKey('rk_live_selected', { apiUrl: 'https://cloud.example.test' })
    ).rejects.toThrow('requires HTTPS');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects an insecure refresh-selected host before retrying the selected key', async () => {
    const fetchSpy = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/api/v1/auth/token/refresh')) {
        return new Response(
          JSON.stringify({
            accessToken: 'rotated-access-token',
            refreshToken: 'rotated-refresh-token',
            accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
            apiUrl: 'http://unsafe.example.test',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 401 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    await expect(resolveWorkspaceByKey('rk_live_selected')).rejects.toThrow('requires HTTPS');

    expect(fetchSpy.mock.calls.map((call) => String(call[0]))).toEqual([
      'https://cloud.example.test/api/v1/workspaces/current/resolve',
      'https://cloud.example.test/api/v1/auth/token/refresh',
    ]);
  });

  it('accepts the canonical Cloud relaycastApiKey echo without a legacy key alias', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              workspace: {
                ...resolvedWorkspace.workspace,
                key: undefined,
                relaycastApiKey: 'rk_live_selected',
              },
            }),
            { status: 200 }
          )
      )
    );
    await expect(resolveWorkspaceByKey('rk_live_selected')).resolves.toMatchObject({
      key: 'rk_live_selected',
    });
  });

  it('fails closed when Cloud returns a descriptor for a different selected key', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            workspace: {
              ...resolvedWorkspace.workspace,
              key: 'rk_live_other',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    );
    vi.stubGlobal('fetch', fetchSpy);

    await expect(resolveWorkspaceByKey('rk_live_selected')).rejects.toThrow(
      'Cloud resolved a different workspace credential than the selected project pin.'
    );
  });

  it('fails closed when Cloud omits the selected key from the resolver response', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            workspace: {
              ...resolvedWorkspace.workspace,
              key: undefined,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    );
    vi.stubGlobal('fetch', fetchSpy);

    await expect(resolveWorkspaceByKey('rk_live_selected')).rejects.toThrow(
      'Cloud resolved a different workspace credential than the selected project pin.'
    );
  });

  it('does not change the active workspace while resolving a selected project key', async () => {
    setWorkspaceKey('active', 'rk_live_active');
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify(resolvedWorkspace), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetchSpy);

    await resolveWorkspaceByKey('rk_live_selected');

    expect(readWorkspaceStore().active).toBe('active');
    expect(readWorkspaceStore().workspaces.active?.key).toBe('rk_live_active');
  });
});
