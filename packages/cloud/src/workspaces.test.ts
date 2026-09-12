import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readWorkspaceStore, setWorkspaceKey } from './workspace-store.js';
import { resolveActiveWorkspace, resolveWorkspaceByKey } from './workspaces.js';
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
