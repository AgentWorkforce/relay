import { describe, expect, it, vi } from 'vitest';

import { requestWorkspaceSession } from './start.js';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('requestWorkspaceSession', () => {
  it('joins an existing workspace without creating a new one', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        workspaceId: 'rw_a7f3x9k2',
        token: 'join-token',
        relayfileUrl: 'https://relayfile.example',
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
      expect.objectContaining({ method: 'POST' }),
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
      joinCommand: 'agent-relay on <cli> --workspace rw_a7f3x9k2',
    });
  });

  it('creates a workspace and then joins it when the create response has no token', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          workspaceId: 'rw_b9c1d2e3',
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
    expect(JSON.parse((fetchFn.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({
      name: 'my-project',
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
      joinCommand: 'agent-relay on <cli> --workspace rw_b9c1d2e3',
    });
  });
});
