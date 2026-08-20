import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureCloudSession: vi.fn(),
  authorizedApiFetch: vi.fn(),
}));

vi.mock('./auth.js', () => ({
  ensureCloudSession: mocks.ensureCloudSession,
  authorizedApiFetch: mocks.authorizedApiFetch,
}));

import {
  CloudFleetSandboxProvisionError,
  deleteCloudFleetSandbox,
  ensureCloudFleetSandbox,
} from './fleet-sandbox.js';

const auth = {
  accessToken: 'access',
  refreshToken: 'refresh',
  accessTokenExpiresAt: '2099-01-01T00:00:00Z',
  apiUrl: 'https://agentrelay.test/cloud',
};
const refreshedAuth = { ...auth, accessToken: 'refreshed' };
const CLOUD_WORKSPACE_ID = '50587328-441d-4acb-b8f3-dbe1b3c5de99';

describe('Cloud fleet sandbox client', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.ensureCloudSession.mockResolvedValue({ auth, client: {} });
  });

  it('resolves the unified workspace and provisions a ready mounted sandbox', async () => {
    mocks.authorizedApiFetch
      .mockResolvedValueOnce({
        response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
        auth: refreshedAuth,
      })
      .mockResolvedValueOnce({
        response: Response.json(
          {
            outcome: 'provisioned',
            nodeId: 'node-1',
            nodeName: 'daytona-codex',
            sandboxId: 'sandbox-1',
            relayWorkspaceId: 'rw_abc',
            relayfileMounted: true,
            relayfileMountPath: '/workspace',
          },
          { status: 201 }
        ),
        auth: refreshedAuth,
      });

    const result = await ensureCloudFleetSandbox({
      workspaceId: 'rw_abc',
      name: 'daytona-codex',
      requiredCapability: 'spawn:codex',
      maxAgents: 1,
      mountRelayfile: true,
      forceProvision: true,
      waitTimeoutMs: 90_000,
    });

    expect(mocks.authorizedApiFetch).toHaveBeenNthCalledWith(
      1,
      auth,
      '/api/v1/workspaces/rw_abc/resolve',
      { method: 'GET', signal: expect.any(AbortSignal) },
      { interactive: false }
    );
    const ensureCall = mocks.authorizedApiFetch.mock.calls[1];
    expect(ensureCall?.[0]).toEqual(refreshedAuth);
    expect(ensureCall?.[1]).toBe('/api/v1/fleet/nodes/sandbox/ensure');
    expect(JSON.parse(String(ensureCall?.[2]?.body))).toEqual({
      workspaceId: CLOUD_WORKSPACE_ID,
      name: 'daytona-codex',
      requiredCapability: 'spawn:codex',
      maxAgents: 1,
      mountRelayfile: true,
      forceProvision: true,
      waitTimeoutMs: 90_000,
    });
    expect(result).toEqual({
      outcome: 'provisioned',
      cloudWorkspaceId: CLOUD_WORKSPACE_ID,
      nodeId: 'node-1',
      nodeName: 'daytona-codex',
      sandboxId: 'sandbox-1',
      relayWorkspaceId: 'rw_abc',
      relayfileMounted: true,
      relayfileMountPath: '/workspace',
    });
  });

  it('preserves a bounded provisioning timeout so the CLI can report it', async () => {
    mocks.authorizedApiFetch
      .mockResolvedValueOnce({
        response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
        auth,
      })
      .mockResolvedValueOnce({
        response: Response.json(
          {
            outcome: 'provisioning_timeout',
            sandboxId: 'sandbox-1',
            relayWorkspaceId: 'rw_abc',
            nodeName: 'daytona-codex',
            waitedMs: 90_000,
          },
          { status: 202 }
        ),
        auth,
      });

    await expect(
      ensureCloudFleetSandbox({
        workspaceId: 'rw_abc',
        requiredCapability: 'spawn:codex',
      })
    ).resolves.toMatchObject({
      outcome: 'provisioning_timeout',
      sandboxId: 'sandbox-1',
      nodeName: 'daytona-codex',
      waitedMs: 90_000,
    });
  });

  it('turns Cloud authorization failures into actionable errors', async () => {
    mocks.authorizedApiFetch.mockResolvedValueOnce({
      response: Response.json({ error: 'Forbidden' }, { status: 403 }),
      auth,
    });

    await expect(
      ensureCloudFleetSandbox({
        workspaceId: 'rw_abc',
        requiredCapability: 'spawn:codex',
      })
    ).rejects.toThrow('owner or admin');
  });

  it('rejects a malformed Cloud workspace identity before provisioning', async () => {
    mocks.authorizedApiFetch.mockResolvedValueOnce({
      response: Response.json({ cloudWorkspaceId: 'not-a-uuid' }),
      auth,
    });

    await expect(
      ensureCloudFleetSandbox({
        workspaceId: 'rw_abc',
        requiredCapability: 'spawn:codex',
      })
    ).rejects.toThrow('invalid cloudWorkspaceId');
    expect(mocks.authorizedApiFetch).toHaveBeenCalledTimes(1);
  });

  it('preserves the sandbox identity from a malformed successful response', async () => {
    mocks.authorizedApiFetch
      .mockResolvedValueOnce({
        response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
        auth,
      })
      .mockResolvedValueOnce({
        response: Response.json(
          {
            outcome: 'provisioned',
            nodeName: 'daytona-codex',
            sandboxId: 'sandbox-1',
            relayWorkspaceId: 'rw_abc',
            relayfileMounted: true,
          },
          { status: 201 }
        ),
        auth,
      });

    const error = await ensureCloudFleetSandbox({
      workspaceId: 'rw_abc',
      requiredCapability: 'spawn:codex',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CloudFleetSandboxProvisionError);
    expect(error).toMatchObject({
      cloudWorkspaceId: CLOUD_WORKSPACE_ID,
      sandboxId: 'sandbox-1',
      nodeName: 'daytona-codex',
      outcomeUnknown: true,
    });
  });

  it('rejects a timeout response that omits waitedMs', async () => {
    mocks.authorizedApiFetch
      .mockResolvedValueOnce({
        response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
        auth,
      })
      .mockResolvedValueOnce({
        response: Response.json(
          {
            outcome: 'provisioning_timeout',
            sandboxId: 'sandbox-1',
            relayWorkspaceId: 'rw_abc',
            nodeName: 'daytona-codex',
          },
          { status: 202 }
        ),
        auth,
      });

    await expect(
      ensureCloudFleetSandbox({
        workspaceId: 'rw_abc',
        requiredCapability: 'spawn:codex',
      })
    ).rejects.toThrow('missing waitedMs');
  });

  it('deletes only the named sandbox in the resolved Cloud workspace', async () => {
    mocks.authorizedApiFetch.mockResolvedValueOnce({
      response: Response.json({ sandboxId: 'sandbox-1', deleted: true }),
      auth,
    });

    await deleteCloudFleetSandbox({
      cloudWorkspaceId: CLOUD_WORKSPACE_ID,
      sandboxId: 'sandbox-1',
    });

    expect(mocks.authorizedApiFetch).toHaveBeenCalledWith(
      auth,
      '/api/v1/fleet/nodes/sandbox/sandbox-1',
      {
        method: 'DELETE',
        signal: expect.any(AbortSignal),
        body: JSON.stringify({ workspaceId: CLOUD_WORKSPACE_ID }),
      },
      { interactive: false }
    );
  });
});
