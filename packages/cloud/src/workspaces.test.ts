import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readWorkspaceStore, setWorkspaceKey } from './workspace-store.js';
import { resolveActiveWorkspace, resolveWorkspaceByKey } from './workspaces.js';

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

  it.each(['http://cloud.example.test', 'https://user:password@cloud.example.test', 'file:///tmp/cloud'])(
    'rejects unsafe resolver transport before any credential request: %s',
    async (apiUrl) => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      await expect(resolveWorkspaceByKey('rk_live_selected', { apiUrl })).rejects.toThrow('requires HTTPS');
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  );

  it.each([307, 308])('never forwards a workspace key to a redirect target (%s)', async (status) => {
    let forwardedRequests = 0;
    let sourceRequests = 0;
    const target = createServer((_request, response) => {
      forwardedRequests++;
      response.end('{}');
    });
    target.listen(0, '127.0.0.1');
    await once(target, 'listening');
    const targetAddress = target.address() as { port: number };
    const source = createServer((_request, response) => {
      sourceRequests++;
      response.writeHead(status, { location: `http://127.0.0.1:${targetAddress.port}/capture` });
      response.end();
    });
    source.listen(0, '127.0.0.1');
    await once(source, 'listening');
    const sourceAddress = source.address() as { port: number };
    process.env.CLOUD_API_URL = `http://127.0.0.1:${sourceAddress.port}`;
    try {
      await expect(resolveWorkspaceByKey('rk_live_selected')).rejects.toThrow();
      expect(sourceRequests).toBe(1);
      expect(forwardedRequests).toBe(0);
    } finally {
      source.closeAllConnections();
      target.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => source.close(() => resolve())),
        new Promise<void>((resolve) => target.close(() => resolve())),
      ]);
    }
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
