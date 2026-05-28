import { describe, expect, it, vi } from 'vitest';

import { bootstrapGatewayAccess } from './bootstrap.js';

const futureAuth = {
  apiUrl: 'https://app.agentrelay.com',
  accessToken: 'tok-1',
  refreshToken: 'refresh-1',
  accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

describe('bootstrapGatewayAccess', () => {
  it('calls the cloud bootstrap endpoint and returns gateway access', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        workspaceId: 'ws_real',
        gatewayUrl: 'wss://api.agentgateway.dev/v1/agent-events',
        apiKey: 'scoped-key',
      }),
      text: async () => '',
    })) as unknown as typeof fetch;

    const access = await bootstrapGatewayAccess({
      workspace: 'my-team',
      fetchImpl,
      readAuth: async () => futureAuth,
      refreshAuth: async () => futureAuth,
    });

    expect(access).toEqual({
      workspaceId: 'ws_real',
      gatewayUrl: 'wss://api.agentgateway.dev/v1/agent-events',
      apiKey: 'scoped-key',
    });
    const calledUrl = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
    expect(calledUrl).toBe('https://app.agentrelay.com/api/v1/workspaces/my-team/agent-events');
  });

  it('throws a clear error when not logged in', async () => {
    await expect(
      bootstrapGatewayAccess({ workspace: 'my-team', readAuth: async () => null })
    ).rejects.toThrow(/Not logged in/);
  });

  it('surfaces endpoint failures', async () => {
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
        fetchImpl,
        readAuth: async () => futureAuth,
        refreshAuth: async () => futureAuth,
      })
    ).rejects.toThrow(/Gateway bootstrap failed: 403/);
  });
});
