import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  afterEach(() => {
    vi.restoreAllMocks();
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

  it('forwards a repos list into the ensure request body when the caller opts in', async () => {
    mocks.authorizedApiFetch
      .mockResolvedValueOnce({
        response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
        auth,
      })
      .mockResolvedValueOnce({
        response: Response.json(
          {
            outcome: 'provisioned',
            nodeId: 'node-1',
            nodeName: 'jit-repos-node',
            sandboxId: 'sandbox-9',
            relayWorkspaceId: 'rw_abc',
            relayfileMounted: true,
          },
          { status: 201 }
        ),
        auth,
      });

    await ensureCloudFleetSandbox({
      workspaceId: 'rw_abc',
      requiredCapability: 'spawn:codex',
      forceProvision: true,
      repos: ['AgentWorkforce/factory', 'AgentWorkforce/relay'],
    });

    const ensureCall = mocks.authorizedApiFetch.mock.calls[1];
    expect(JSON.parse(String(ensureCall?.[2]?.body))).toEqual({
      workspaceId: CLOUD_WORKSPACE_ID,
      requiredCapability: 'spawn:codex',
      forceProvision: true,
      repos: ['AgentWorkforce/factory', 'AgentWorkforce/relay'],
    });
  });

  it('requests and verifies an exact E2B provider', async () => {
    mocks.authorizedApiFetch
      .mockResolvedValueOnce({
        response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
        auth,
      })
      .mockResolvedValueOnce({
        response: Response.json(
          {
            outcome: 'provisioned',
            providerId: 'e2b',
            nodeId: 'node-e2b',
            nodeName: 'e2b-reviewer',
            sandboxId: 'sandbox-e2b',
            relayWorkspaceId: 'rw_abc',
            relayfileMounted: true,
          },
          { status: 201 }
        ),
        auth,
      });

    const result = await ensureCloudFleetSandbox({
      workspaceId: 'rw_abc',
      requiredCapability: 'spawn:codex',
      forceProvision: true,
      providerId: 'e2b',
    });

    const ensureCall = mocks.authorizedApiFetch.mock.calls[1];
    expect(JSON.parse(String(ensureCall?.[2]?.body))).toEqual(expect.objectContaining({
      providerId: 'e2b',
    }));
    expect(result).toEqual(expect.objectContaining({ providerId: 'e2b' }));
  });

  it('rejects and preserves cleanup identity when Cloud cannot prove the requested provider', async () => {
    mocks.authorizedApiFetch
      .mockResolvedValueOnce({
        response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
        auth,
      })
      .mockResolvedValueOnce({
        response: Response.json(
          {
            outcome: 'provisioned',
            providerId: 'daytona',
            nodeId: 'node-1',
            nodeName: 'wrong-provider',
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
      providerId: 'e2b',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CloudFleetSandboxProvisionError);
    expect(error).toMatchObject({
      sandboxId: 'sandbox-1',
      nodeName: 'wrong-provider',
      providerId: 'daytona',
      outcomeUnknown: true,
    });
    expect(String(error)).toContain('instead of requested provider e2b');
  });

  it.each([
    ['missing', undefined],
    ['invalid', 'modal'],
  ])(
    'preserves the requested provider for cleanup when a %s provider proof arrives on a 201 response',
    async (_case, providerId) => {
      mocks.authorizedApiFetch
        .mockResolvedValueOnce({
          response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
          auth,
        })
        .mockResolvedValueOnce({
          response: Response.json(
            {
              outcome: 'provisioned',
              nodeId: 'node-e2b',
              nodeName: 'e2b-reviewer',
              sandboxId: 'sandbox-e2b',
              relayWorkspaceId: 'rw_abc',
              relayfileMounted: true,
              ...(providerId === undefined ? {} : { providerId }),
            },
            { status: 201 }
          ),
          auth,
        });

      const error = await ensureCloudFleetSandbox({
        workspaceId: 'rw_abc',
        requiredCapability: 'spawn:codex',
        providerId: 'e2b',
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(CloudFleetSandboxProvisionError);
      expect(error).toMatchObject({
        cloudWorkspaceId: CLOUD_WORKSPACE_ID,
        sandboxId: 'sandbox-e2b',
        nodeName: 'e2b-reviewer',
        providerId: 'e2b',
        outcomeUnknown: true,
      });
    }
  );

  it.each([
    ['missing', undefined],
    ['invalid', 'modal'],
  ])(
    'preserves the requested provider for cleanup when a %s provider proof arrives on a 202 timeout response',
    async (_case, providerId) => {
      mocks.authorizedApiFetch
        .mockResolvedValueOnce({
          response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
          auth,
        })
        .mockResolvedValueOnce({
          response: Response.json(
            {
              outcome: 'provisioning_timeout',
              sandboxId: 'sandbox-e2b',
              relayWorkspaceId: 'rw_abc',
              nodeName: 'e2b-reviewer',
              waitedMs: 90_000,
              ...(providerId === undefined ? {} : { providerId }),
            },
            { status: 202 }
          ),
          auth,
        });

      const error = await ensureCloudFleetSandbox({
        workspaceId: 'rw_abc',
        requiredCapability: 'spawn:codex',
        providerId: 'e2b',
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(CloudFleetSandboxProvisionError);
      expect(error).toMatchObject({
        cloudWorkspaceId: CLOUD_WORKSPACE_ID,
        sandboxId: 'sandbox-e2b',
        nodeName: 'e2b-reviewer',
        providerId: 'e2b',
        outcomeUnknown: true,
      });
    }
  );

  it.each([
    ['missing', undefined],
    ['invalid', 'modal'],
  ])(
    'preserves the requested provider for cleanup when a %s provider proof arrives on a non-OK response',
    async (_case, providerId) => {
      mocks.authorizedApiFetch
        .mockResolvedValueOnce({
          response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
          auth,
        })
        .mockResolvedValueOnce({
          response: Response.json(
            {
              error: 'provider rejected request',
              nodeName: 'e2b-reviewer',
              sandboxId: 'sandbox-e2b',
              ...(providerId === undefined ? {} : { providerId }),
            },
            { status: 502 }
          ),
          auth,
        });

      const error = await ensureCloudFleetSandbox({
        workspaceId: 'rw_abc',
        requiredCapability: 'spawn:codex',
        providerId: 'e2b',
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(CloudFleetSandboxProvisionError);
      expect(error).toMatchObject({
        cloudWorkspaceId: CLOUD_WORKSPACE_ID,
        sandboxId: 'sandbox-e2b',
        nodeName: 'e2b-reviewer',
        providerId: 'e2b',
      });
    }
  );

  it('omits repos from the body when the caller did not opt in', async () => {
    mocks.authorizedApiFetch
      .mockResolvedValueOnce({
        response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
        auth,
      })
      .mockResolvedValueOnce({
        response: Response.json(
          {
            outcome: 'provisioned',
            nodeId: 'node-1',
            nodeName: 'bare-node',
            sandboxId: 'sandbox-10',
            relayWorkspaceId: 'rw_abc',
            relayfileMounted: true,
          },
          { status: 201 }
        ),
        auth,
      });

    await ensureCloudFleetSandbox({
      workspaceId: 'rw_abc',
      requiredCapability: 'spawn:codex',
    });

    const ensureCall = mocks.authorizedApiFetch.mock.calls[1];
    const parsedBody = JSON.parse(String(ensureCall?.[2]?.body));
    expect(parsedBody).not.toHaveProperty('repos');
  });

  it('omits repos when the caller passes an empty array', async () => {
    mocks.authorizedApiFetch
      .mockResolvedValueOnce({
        response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
        auth,
      })
      .mockResolvedValueOnce({
        response: Response.json(
          {
            outcome: 'provisioned',
            nodeId: 'node-1',
            nodeName: 'bare-node',
            sandboxId: 'sandbox-11',
            relayWorkspaceId: 'rw_abc',
            relayfileMounted: true,
          },
          { status: 201 }
        ),
        auth,
      });

    await ensureCloudFleetSandbox({
      workspaceId: 'rw_abc',
      requiredCapability: 'spawn:codex',
      repos: [],
    });

    const ensureCall = mocks.authorizedApiFetch.mock.calls[1];
    const parsedBody = JSON.parse(String(ensureCall?.[2]?.body));
    expect(parsedBody).not.toHaveProperty('repos');
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

  it('starts a fresh request budget after a delayed workspace resolution', async () => {
    const signals: AbortSignal[] = [];
    mocks.authorizedApiFetch
      .mockImplementationOnce(async (_auth, _path, init) => {
        signals.push(init.signal as AbortSignal);
        await new Promise((resolve) => setTimeout(resolve, 60));
        return {
          response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
          auth,
        };
      })
      .mockImplementationOnce(async (_auth, _path, init) => {
        signals.push(init.signal as AbortSignal);
        await new Promise((resolve) => setTimeout(resolve, 60));
        return {
          response: Response.json(
            {
              outcome: 'provisioned',
              nodeId: 'node-1',
              nodeName: 'daytona-codex',
              sandboxId: 'sandbox-1',
              relayWorkspaceId: 'rw_abc',
              relayfileMounted: true,
            },
            { status: 201 }
          ),
          auth,
        };
      });

    await expect(
      ensureCloudFleetSandbox(
        {
          workspaceId: 'rw_abc',
          requiredCapability: 'spawn:codex',
        },
        { timeoutMs: 100 }
      )
    ).resolves.toMatchObject({ outcome: 'provisioned', sandboxId: 'sandbox-1' });

    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals[1]?.aborted).toBe(false);
  });

  it('keeps the default provisioning budget beyond the mounted server deadline', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    mocks.authorizedApiFetch
      .mockResolvedValueOnce({
        response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
        auth,
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
          },
          { status: 201 }
        ),
        auth,
      });

    await ensureCloudFleetSandbox({
      workspaceId: 'rw_abc',
      requiredCapability: 'spawn:codex',
    });

    expect(timeoutSpy).toHaveBeenNthCalledWith(1, 120_000);
    expect(timeoutSpy).toHaveBeenNthCalledWith(2, 480_000);
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

  it('passes E2B provider identity through the deletion request', async () => {
    mocks.authorizedApiFetch.mockResolvedValueOnce({
      response: Response.json({ sandboxId: 'sandbox-e2b', providerId: 'e2b', deleted: true }),
      auth,
    });

    await deleteCloudFleetSandbox({
      cloudWorkspaceId: CLOUD_WORKSPACE_ID,
      sandboxId: 'sandbox-e2b',
      providerId: 'e2b',
    });

    expect(mocks.authorizedApiFetch).toHaveBeenCalledWith(
      auth,
      '/api/v1/fleet/nodes/sandbox/sandbox-e2b',
      {
        method: 'DELETE',
        signal: expect.any(AbortSignal),
        body: JSON.stringify({ workspaceId: CLOUD_WORKSPACE_ID, providerId: 'e2b' }),
      },
      { interactive: false }
    );
  });
});
