import { describe, expect, it, vi } from 'vitest';

import { bootstrapGatewayAccess } from './bootstrap.js';

const futureAuth = {
  apiUrl: 'https://app.agentrelay.com',
  accessToken: 'tok-1',
  refreshToken: 'refresh-1',
  accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

const scopes = ['relayfile:fs:read:/slack/**', 'relayfile:fs:write:/slack/**'];

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => '' };
}

describe('bootstrapGatewayAccess', () => {
  it('resolves the gateway URL then provisions a scoped token', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (url.endsWith('/agent-events')) {
        return jsonResponse({
          workspaceId: 'ws_real',
          gatewayUrl: 'wss://api.agentgateway.dev/v1/agent-events',
        });
      }
      if (url.endsWith('/agents/provision')) {
        expect(init?.method).toBe('POST');
        const payload = JSON.parse(init?.body ?? '{}');
        expect(payload.workspaceId).toBe('ws_real');
        expect(payload.agents[0].scopes).toEqual(scopes);
        return jsonResponse({ agents: [{ name: payload.agents[0].name, token: 'scoped-token', scopes }] });
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;

    const access = await bootstrapGatewayAccess({
      workspace: 'my-team',
      scopes,
      fetchImpl,
      readAuth: async () => futureAuth,
      refreshAuth: async () => futureAuth,
    });

    expect(access).toEqual({
      workspaceId: 'ws_real',
      gatewayUrl: 'wss://api.agentgateway.dev/v1/agent-events',
      apiKey: 'scoped-token',
    });
    const calls = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls[0][0]).toBe('https://app.agentrelay.com/api/v1/workspaces/my-team/agent-events');
    expect(calls[1][0]).toBe('https://app.agentrelay.com/api/v1/agents/provision');
  });

  it('throws a clear error when not logged in', async () => {
    await expect(
      bootstrapGatewayAccess({ workspace: 'my-team', scopes, readAuth: async () => null })
    ).rejects.toThrow(/Not logged in/);
  });

  it('surfaces config-endpoint failures', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => 'no access',
      json: async () => ({}),
    })) as unknown as typeof fetch;

    await expect(
      bootstrapGatewayAccess({
        workspace: 'my-team',
        scopes,
        fetchImpl,
        readAuth: async () => futureAuth,
        refreshAuth: async () => futureAuth,
      })
    ).rejects.toThrow(/Gateway bootstrap failed \(config\): 403/);
  });
});
