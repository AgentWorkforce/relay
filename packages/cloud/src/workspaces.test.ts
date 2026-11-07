import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readWorkspaceStore, setWorkspaceKey } from './workspace-store.js';
import { issueWorkspaceToken, resolveActiveWorkspace, resolveWorkspaceByKey } from './workspaces.js';
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

  it('repairs a stale workspace key from the authenticated cloud workspace', async () => {
    setWorkspaceKey('stale', 'rk_live_stale');
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('rk_live_stale')) {
        return Response.json({ error: 'Workspace not found' }, { status: 404 });
      }
      if (url.endsWith('/api/v1/auth/whoami')) {
        return Response.json({
          authenticated: true,
          source: 'token',
          subjectType: 'cli',
          scopes: ['cli:auth'],
          user: { id: 'user_1', email: null, name: null, avatarUrl: null },
          currentOrganization: {
            id: 'org_1',
            slug: 'operations',
            name: 'Operations',
            role: 'owner',
            status: 'active',
          },
          currentWorkspace: {
            id: 'cloud_workspace_1',
            organization_id: 'org_1',
            slug: 'default',
            name: 'Default',
          },
        });
      }
      if (url.endsWith('/api/v1/workspaces/cloud_workspace_1/join')) {
        return Response.json({
          workspaceId: 'rw_default',
          token: 'short-lived-relayfile-token',
          relaycastApiKey: 'rk_live_repaired',
        });
      }
      if (url.endsWith('/api/v1/workspaces/rk_live_repaired/resolve')) {
        return Response.json({
          workspace: {
            name: 'Default',
            key: 'rk_live_repaired',
            cloudWorkspaceId: 'cloud_workspace_1',
            relaycastWorkspaceId: 'rw_default',
            relaycastApiKey: 'rk_live_repaired',
            relayfileWorkspaceId: 'rw_default',
            relayauthWorkspaceId: 'rw_default',
            organizationId: 'org_1',
            slug: 'default',
            urls: {},
            provisioned: true,
          },
        });
      }
      return Response.json({ error: `Unexpected request: ${url}` }, { status: 500 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    await expect(resolveActiveWorkspace()).resolves.toMatchObject({
      name: 'Default',
      key: 'rk_live_repaired',
      cloudWorkspaceId: 'cloud_workspace_1',
      relayfileWorkspaceId: 'rw_default',
    });

    expect(readWorkspaceStore()).toEqual({
      active: 'Default',
      workspaces: {
        stale: { key: 'rk_live_stale' },
        Default: { key: 'rk_live_repaired' },
      },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(6);
  });

  it('bootstraps the active workspace from cloud login when the local store is empty', async () => {
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/v1/auth/whoami')) {
        return Response.json({
          authenticated: true,
          source: 'token',
          subjectType: 'cli',
          scopes: ['cli:auth'],
          user: { id: 'user_1', email: null, name: null, avatarUrl: null },
          currentOrganization: {
            id: 'org_1',
            slug: 'operations',
            name: 'Operations',
            role: 'owner',
            status: 'active',
          },
          currentWorkspace: {
            id: 'cloud_workspace_1',
            organization_id: 'org_1',
            slug: 'default',
            name: 'Default',
          },
        });
      }
      if (url.endsWith('/api/v1/workspaces/cloud_workspace_1/join')) {
        return Response.json({
          workspaceId: 'rw_default',
          token: 'short-lived-relayfile-token',
          relaycastApiKey: 'rk_live_bootstrapped',
        });
      }
      if (url.endsWith('/api/v1/workspaces/rk_live_bootstrapped/resolve')) {
        return Response.json({
          workspace: {
            name: 'Default',
            key: 'rk_live_bootstrapped',
            cloudWorkspaceId: 'cloud_workspace_1',
            relaycastWorkspaceId: 'rw_default',
            relayfileWorkspaceId: 'rw_default',
            relayauthWorkspaceId: 'rw_default',
            urls: {},
          },
        });
      }
      return Response.json({ error: `Unexpected request: ${url}` }, { status: 500 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    await expect(resolveActiveWorkspace({ bootstrapFromCloud: true })).resolves.toMatchObject({
      key: 'rk_live_bootstrapped',
      cloudWorkspaceId: 'cloud_workspace_1',
    });
    expect(readWorkspaceStore()).toEqual({
      active: 'Default',
      workspaces: { Default: { key: 'rk_live_bootstrapped' } },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});

describe('issueWorkspaceToken', () => {
  it('falls back to the canonical join contract when token routes are unavailable', async () => {
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/join')) {
        return Response.json({
          workspaceId: 'rw_default',
          token: 'short-lived-relayfile-token',
          relaycastApiKey: 'rk_live_joined',
        });
      }
      return Response.json({ error: 'Not Found' }, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    await expect(issueWorkspaceToken('cloud_workspace_1', { name: 'Factory Local' })).resolves.toEqual({
      key: 'rk_live_joined',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(String(fetchSpy.mock.calls[3][0])).toBe(
      'https://cloud.example.test/api/v1/workspaces/cloud_workspace_1/join'
    );
    const init = fetchSpy.mock.calls[3][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ agentName: 'Factory-Local' });
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
