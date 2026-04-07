import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@agent-relay/cloud', () => ({
  readStoredAuth: vi.fn().mockResolvedValue(null),
  ensureAuthenticated: vi.fn().mockResolvedValue({ accessToken: 'test-token' }),
}));

vi.mock('./dotfiles.js', () => ({
  hasDotfiles: () => false,
  compileDotfiles: vi.fn(),
}));

import { requestWorkspaceSession } from './start.js';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const [, payload = ''] = token.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('requestWorkspaceSession', () => {
  it('joins an existing workspace without creating a new one', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        workspaceId: 'rw_a7f3x9k2',
        token: 'join-token',
        relayfileUrl: 'https://relayfile.example',
        relaycastApiKey: 'rk_live_joined',
      })
    );

    const session = await requestWorkspaceSession({
      authBase: 'https://relayauth.example',
      fallbackRelayfileUrl: 'http://127.0.0.1:8080',
      requestedWorkspaceId: 'rw_a7f3x9k2',
      workspaceName: 'ignored',
      agentName: 'claude',
      scopes: ['fs:read'],
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://relayauth.example/api/v1/workspaces/rw_a7f3x9k2/join',
      expect.objectContaining({ method: 'POST' })
    );
    expect(JSON.parse((fetchFn.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({
      agentName: 'claude',
      scopes: ['fs:read'],
    });
    expect(session).toEqual({
      created: false,
      workspaceId: 'rw_a7f3x9k2',
      token: 'join-token',
      relayfileUrl: 'https://relayfile.example',
      relaycastApiKey: 'rk_live_joined',
      joinCommand: 'agent-relay on <cli> --workspace rw_a7f3x9k2',
    });
  });

  it('creates a workspace and then joins it when the create response has no token', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          workspaceId: 'rw_b9c1d2e3',
          relaycastApiKey: 'rk_live_created',
          joinCommand: 'agent-relay on <cli> --workspace rw_b9c1d2e3',
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          workspaceId: 'rw_b9c1d2e3',
          token: 'scoped-token',
          relayfileUrl: 'https://relayfile.example',
        })
      );

    const session = await requestWorkspaceSession({
      authBase: 'https://relayauth.example',
      fallbackRelayfileUrl: 'http://127.0.0.1:8080',
      workspaceName: 'my-project',
      agentName: 'codex',
      scopes: ['fs:read', 'fs:write'],
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[0]?.[0]).toBe('https://relayauth.example/api/v1/workspaces/create');
    expect(JSON.parse((fetchFn.mock.calls[0]?.[1] as RequestInit).body as string)).toMatchObject({
      name: 'my-project',
      workspaceId: expect.stringMatching(/^rw_[a-z0-9]{8}$/),
    });
    expect(fetchFn.mock.calls[1]?.[0]).toBe('https://relayauth.example/api/v1/workspaces/rw_b9c1d2e3/join');
    expect(JSON.parse((fetchFn.mock.calls[1]?.[1] as RequestInit).body as string)).toEqual({
      agentName: 'codex',
      scopes: ['fs:read', 'fs:write'],
    });
    expect(session).toEqual({
      created: true,
      workspaceId: 'rw_b9c1d2e3',
      token: 'scoped-token',
      relayfileUrl: 'https://relayfile.example',
      relaycastApiKey: 'rk_live_created',
      joinCommand: 'agent-relay on <cli> --workspace rw_b9c1d2e3',
    });
  });

  it('creates a local workspace registry entry with unified JWT claims', async () => {
    const relayDir = mkdtempSync(path.join(tmpdir(), 'agent-relay-on-'));
    try {
      const fetchFn = vi.fn(async () =>
        jsonResponse({
          ok: true,
          data: {
            workspace_id: 'ws_remote_unused',
            api_key: 'rk_live_local',
            created_at: '2026-03-27T00:00:00Z',
          },
        })
      );

      const session = await requestWorkspaceSession({
        authBase: 'http://127.0.0.1:3030',
        fallbackRelayfileUrl: 'http://127.0.0.1:8080',
        workspaceName: 'my-project',
        agentName: 'codex',
        scopes: ['fs:read', 'fs:write'],
        signingSecret: 'dev-secret',
        relayDir,
        fetchFn: fetchFn as unknown as typeof fetch,
      });

      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(fetchFn.mock.calls[0]?.[0]).toBe('https://api.relaycast.dev/v1/workspaces');
      expect(session.created).toBe(true);
      expect(session.workspaceId).toMatch(/^rw_[a-z0-9]{8}$/);
      expect(session.relaycastApiKey).toBe('rk_live_local');
      expect(session.relayfileUrl).toBe('http://127.0.0.1:8080');

      const claims = decodeJwtPayload(session.token);
      expect(claims.wks).toBe(session.workspaceId);
      expect(claims.workspace_id).toBe(session.workspaceId);
      expect(claims.agent_name).toBe('codex');

      const registry = JSON.parse(readFileSync(path.join(relayDir, 'workspaces.json'), 'utf8')) as Record<
        string,
        any
      >;
      expect(registry[session.workspaceId]).toEqual({
        relaycastApiKey: 'rk_live_local',
        relayfileUrl: 'http://127.0.0.1:8080',
        createdAt: '2026-03-27T00:00:00Z',
        agents: ['codex'],
      });
    } finally {
      rmSync(relayDir, { recursive: true, force: true });
    }
  });

  it('uses local session when preferLocalSession is true even with a remote authBase', async () => {
    const relayDir = mkdtempSync(path.join(tmpdir(), 'agent-relay-on-'));
    try {
      const fetchFn = vi.fn(async () =>
        jsonResponse({
          ok: true,
          data: { api_key: 'rk_live_relaycast', created_at: '2026-04-01T00:00:00Z' },
        })
      );

      const session = await requestWorkspaceSession({
        authBase: 'https://agentrelay.dev/cloud',
        fallbackRelayfileUrl: 'http://127.0.0.1:8080',
        workspaceName: 'my-project',
        agentName: 'claude',
        scopes: ['fs:read', 'fs:write'],
        signingSecret: 'dev-secret',
        relayDir,
        preferLocalSession: true,
        fetchFn: fetchFn as unknown as typeof fetch,
      });

      // Should NOT have called the cloud workspace create endpoint
      expect(fetchFn).not.toHaveBeenCalledWith(
        expect.stringContaining('agentrelay.dev/cloud'),
        expect.anything()
      );
      // Should have called the relaycast API for the workspace key
      expect(fetchFn).toHaveBeenCalledWith(
        'https://api.relaycast.dev/v1/workspaces',
        expect.objectContaining({ method: 'POST' })
      );
      expect(session.created).toBe(true);
      expect(session.workspaceId).toMatch(/^rw_[a-z0-9]{8}$/);
      expect(session.relaycastApiKey).toBe('rk_live_relaycast');

      const claims = decodeJwtPayload(session.token);
      expect(claims.wks).toBe(session.workspaceId);
      expect(claims.agent_name).toBe('claude');
    } finally {
      rmSync(relayDir, { recursive: true, force: true });
    }
  });

  it('proceeds without relaycastApiKey when relaycast is unavailable in local session', async () => {
    const relayDir = mkdtempSync(path.join(tmpdir(), 'agent-relay-on-'));
    try {
      const fetchFn = vi.fn(async () => {
        throw new Error('network error');
      });

      const session = await requestWorkspaceSession({
        authBase: 'https://agentrelay.dev/cloud',
        fallbackRelayfileUrl: 'http://127.0.0.1:8080',
        workspaceName: 'my-project',
        agentName: 'claude',
        scopes: ['fs:read'],
        signingSecret: 'dev-secret',
        relayDir,
        preferLocalSession: true,
        fetchFn: fetchFn as unknown as typeof fetch,
      });

      expect(session.created).toBe(true);
      expect(session.workspaceId).toMatch(/^rw_[a-z0-9]{8}$/);
      expect(session.relaycastApiKey).toBeUndefined();
      expect(session.token).toBeTruthy();
    } finally {
      rmSync(relayDir, { recursive: true, force: true });
    }
  });

  it('joins an existing local workspace from .relay/workspaces.json', async () => {
    const relayDir = mkdtempSync(path.join(tmpdir(), 'agent-relay-on-'));
    try {
      writeFileSync(
        path.join(relayDir, 'workspaces.json'),
        `${JSON.stringify(
          {
            rw_a7f3x9k2: {
              relaycastApiKey: 'rk_live_cached',
              relayfileUrl: 'http://127.0.0.1:8080',
              createdAt: '2026-03-27T00:00:00Z',
              agents: ['codex'],
            },
          },
          null,
          2
        )}\n`,
        'utf8'
      );

      const fetchFn = vi.fn();
      const session = await requestWorkspaceSession({
        authBase: 'http://127.0.0.1:3030',
        fallbackRelayfileUrl: 'http://127.0.0.1:9090',
        requestedWorkspaceId: 'rw_a7f3x9k2',
        agentName: 'claude',
        scopes: ['fs:read'],
        signingSecret: 'dev-secret',
        relayDir,
        fetchFn: fetchFn as unknown as typeof fetch,
      });

      expect(fetchFn).not.toHaveBeenCalled();
      expect(session).toEqual({
        created: false,
        workspaceId: 'rw_a7f3x9k2',
        token: session.token,
        relayfileUrl: 'http://127.0.0.1:8080',
        relaycastApiKey: 'rk_live_cached',
        joinCommand: 'agent-relay on <cli> --workspace rw_a7f3x9k2',
      });

      const claims = decodeJwtPayload(session.token);
      expect(claims.wks).toBe('rw_a7f3x9k2');
      expect(claims.workspace_id).toBe('rw_a7f3x9k2');
      expect(claims.agent_name).toBe('claude');

      const registry = JSON.parse(readFileSync(path.join(relayDir, 'workspaces.json'), 'utf8')) as Record<
        string,
        any
      >;
      expect(registry.rw_a7f3x9k2.agents).toEqual(['codex', 'claude']);
    } finally {
      rmSync(relayDir, { recursive: true, force: true });
    }
  });
});
