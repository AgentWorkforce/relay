import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readWorkspaceStore, setWorkspaceKey } from './workspace-store.js';
import { issueWorkspaceToken, resolveActiveWorkspace } from './workspaces.js';

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
