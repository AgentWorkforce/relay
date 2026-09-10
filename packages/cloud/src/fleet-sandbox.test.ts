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
  AGENT37_RELAYCAST_ORIGIN,
  CANONICAL_RELAYCAST_ORIGIN,
  CloudFleetSandboxProvisionError,
  deleteCloudFleetSandbox,
  ensureCloudFleetSandbox,
  normalizeRelaycastTarget,
} from './fleet-sandbox.js';

const auth = {
  accessToken: 'access',
  refreshToken: 'refresh',
  accessTokenExpiresAt: '2099-01-01T00:00:00Z',
  apiUrl: 'https://agentrelay.test/cloud',
};
const refreshedAuth = { ...auth, accessToken: 'refreshed' };
const CLOUD_WORKSPACE_ID = '50587328-441d-4acb-b8f3-dbe1b3c5de99';
const SANDBOX_ID = 'sbx_123e4567-e89b-42d3-a456-426614174000';
const DAYTONA_PROVIDER_SANDBOX_ID = '223e4567-e89b-42d3-a456-426614174000';
const SANDBOX_NAME = 'fleet-sandbox-123e4567-e89b-42d3-a456-426614174000';
const RELAYCAST_TARGET = {
  route: 'agent37-isolated' as const,
  baseUrl: AGENT37_RELAYCAST_ORIGIN,
  workspaceId: 'rw_abc',
  relaycastApiKey: 'rk_live_agent37',
};
const CANONICAL_RELAYCAST_TARGET = {
  route: 'canonical' as const,
  baseUrl: CANONICAL_RELAYCAST_ORIGIN,
  workspaceId: 'rw_abc',
  relaycastApiKey: 'rk_live_canonical',
};
const NON_AGENT_PROVIDER_IDS = ['daytona', 'e2b', 'vercel', 'freestyle', 'microsandbox'] as const;
const PROVIDER_OUTCOME_MATRIX = NON_AGENT_PROVIDER_IDS.flatMap((providerId) =>
  (['provisioned', 'reused'] as const).map((outcome) => ({ providerId, outcome }))
);

describe('Cloud fleet sandbox client', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.ensureCloudSession.mockResolvedValue({ auth, client: {} });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes a closed Agent37 Relaycast target', () => {
    expect(
      normalizeRelaycastTarget({ ...RELAYCAST_TARGET, baseUrl: `${AGENT37_RELAYCAST_ORIGIN}/` })
    ).toEqual(RELAYCAST_TARGET);
    expect(
      normalizeRelaycastTarget({
        route: 'canonical',
        baseUrl: CANONICAL_RELAYCAST_ORIGIN,
        workspaceId: 'rw_abc',
        relaycastApiKey: 'rk_live_canonical',
      })
    ).toMatchObject({ route: 'canonical', baseUrl: CANONICAL_RELAYCAST_ORIGIN });
  });

  it.each([
    { route: 'agent37-isolated', baseUrl: 'https://evil.example' },
    { route: 'canonical', baseUrl: AGENT37_RELAYCAST_ORIGIN },
    { route: 'agent37-isolated', baseUrl: 'https://agent37-cast.agentrelay.com/path' },
    { route: 'agent37-isolated', baseUrl: 'https://user:pass@agent37-cast.agentrelay.com' },
  ])('rejects a route mapped to an untrusted Relaycast origin', (target) => {
    expect(() => normalizeRelaycastTarget({ ...RELAYCAST_TARGET, ...target })).toThrow(/relaycast/i);
  });

  it.each([
    { ...RELAYCAST_TARGET, relaycastApiKey: 'rk_test_not_live' },
    { ...RELAYCAST_TARGET, workspaceId: '' },
    { ...RELAYCAST_TARGET, relaycastApiKey: undefined },
  ])('rejects an incomplete Relaycast target', (target) => {
    expect(() => normalizeRelaycastTarget(target)).toThrow(/Relaycast|workspace/);
  });

  it('rejects the legacy generic API key field', () => {
    expect(() =>
      normalizeRelaycastTarget({
        route: RELAYCAST_TARGET.route,
        baseUrl: RELAYCAST_TARGET.baseUrl,
        workspaceId: RELAYCAST_TARGET.workspaceId,
        apiKey: RELAYCAST_TARGET.relaycastApiKey,
      })
    ).toThrow(/API key/);
  });

  it('rejects a provisioned response with an untrusted server-owned Relaycast route', async () => {
    mocks.authorizedApiFetch
      .mockResolvedValueOnce({
        response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
        auth,
      })
      .mockResolvedValueOnce({
        response: Response.json({
          outcome: 'provisioned',
          providerId: 'agent37',
          nodeId: 'node-1',
          nodeName: SANDBOX_NAME,
          sandboxId: SANDBOX_ID,
          relayWorkspaceId: 'rw_abc',
          relaycastTarget: { ...RELAYCAST_TARGET, baseUrl: 'https://evil.example' },
          relayfileMounted: true,
        }),
        auth,
      });

    await expect(
      ensureCloudFleetSandbox({
        workspaceId: 'rw_abc',
        name: SANDBOX_NAME,
        sandboxId: SANDBOX_ID,
        requiredCapability: 'spawn:codex',
        forceProvision: true,
        workloadProfile: 'long-running-agent',
      })
    ).rejects.toThrow(/untrusted relaycastTarget.baseUrl/);
  });

  it('rejects a canonical target for an explicitly requested Agent37 provider', async () => {
    mocks.authorizedApiFetch
      .mockResolvedValueOnce({
        response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
        auth,
      })
      .mockResolvedValueOnce({
        response: Response.json({
          outcome: 'provisioned',
          providerId: 'agent37',
          nodeId: 'node-1',
          nodeName: SANDBOX_NAME,
          sandboxId: SANDBOX_ID,
          relayWorkspaceId: 'rw_abc',
          relaycastTarget: {
            route: 'canonical',
            baseUrl: CANONICAL_RELAYCAST_ORIGIN,
            workspaceId: 'rw_abc',
            relaycastApiKey: 'rk_live_canonical',
          },
          relayfileMounted: false,
        }),
        auth,
      });

    await expect(
      ensureCloudFleetSandbox({
        workspaceId: 'rw_abc',
        requiredCapability: 'spawn:codex',
        providerId: 'agent37',
        mountRelayfile: false,
      })
    ).rejects.toThrow(/mapped Agent37 to a non-isolated/);
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
            nodeName: SANDBOX_NAME,
            sandboxId: SANDBOX_ID,
            providerSandboxId: 'provider-sandbox-1',
            relayWorkspaceId: 'rw_abc',
            relaycastTarget: RELAYCAST_TARGET,
            relayfileMounted: true,
            relayfileMountPath: '/workspace',
            providerId: 'agent37',
          },
          { status: 201 }
        ),
        auth: refreshedAuth,
      });

    const result = await ensureCloudFleetSandbox({
      workspaceId: 'rw_abc',
      name: SANDBOX_NAME,
      sandboxId: SANDBOX_ID,
      requiredCapability: 'spawn:codex',
      maxAgents: 1,
      mountRelayfile: true,
      forceProvision: true,
      workloadProfile: 'long-running-agent',
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
      sandboxId: SANDBOX_ID,
      name: SANDBOX_NAME,
      requiredCapability: 'spawn:codex',
      maxAgents: 1,
      mountRelayfile: true,
      forceProvision: true,
      workloadProfile: 'long-running-agent',
      waitTimeoutMs: 90_000,
    });
    expect(result).toEqual({
      outcome: 'provisioned',
      cloudWorkspaceId: CLOUD_WORKSPACE_ID,
      nodeId: 'node-1',
      nodeName: SANDBOX_NAME,
      sandboxId: SANDBOX_ID,
      providerSandboxId: 'provider-sandbox-1',
      relayWorkspaceId: 'rw_abc',
      relaycastTarget: RELAYCAST_TARGET,
      relayfileMounted: true,
      relayfileMountPath: '/workspace',
      providerId: 'agent37',
    });
  });

  it('rejects an invalid sandbox identity before contacting Cloud', async () => {
    await expect(
      ensureCloudFleetSandbox({
        workspaceId: 'rw_abc',
        requiredCapability: 'spawn:codex',
        sandboxId: 'sandbox-1',
        forceProvision: true,
      })
    ).rejects.toThrow('sandboxId must match lowercase sbx_<UUID>');

    await expect(
      ensureCloudFleetSandbox({
        workspaceId: 'rw_abc',
        requiredCapability: 'spawn:codex',
        sandboxId: 'sbx_123E4567-e89b-42d3-a456-426614174000',
        forceProvision: true,
      })
    ).rejects.toThrow('sandboxId must match lowercase sbx_<UUID>');

    expect(mocks.ensureCloudSession).not.toHaveBeenCalled();
    expect(mocks.authorizedApiFetch).not.toHaveBeenCalled();
  });

  it('accepts a legacy non-Agent37 provisioned response without a Relaycast target', async () => {
    mocks.authorizedApiFetch
      .mockResolvedValueOnce({
        response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
        auth,
      })
      .mockResolvedValueOnce({
        response: Response.json(
          {
            outcome: 'provisioned',
            nodeId: 'node-legacy',
            nodeName: 'legacy-custom-node',
            sandboxId: 'legacy-public-sandbox',
            providerSandboxId: 'legacy-provider-sandbox',
            relayWorkspaceId: 'rw_abc',
            relayfileMounted: true,
          },
          { status: 201 }
        ),
        auth,
      });

    await expect(
      ensureCloudFleetSandbox({
        workspaceId: 'rw_abc',
        requiredCapability: 'spawn:codex',
        name: 'legacy-custom-node',
        workloadProfile: 'long-running-agent',
      })
    ).resolves.toEqual(
      expect.objectContaining({
        outcome: 'provisioned',
        nodeName: 'legacy-custom-node',
        relayWorkspaceId: 'rw_abc',
      })
    );

    const ensureBody = JSON.parse(String(mocks.authorizedApiFetch.mock.calls[1]?.[2]?.body));
    expect(ensureBody).toMatchObject({
      name: 'legacy-custom-node',
      workloadProfile: 'long-running-agent',
    });
    expect(ensureBody).not.toHaveProperty('sandboxId');
  });

  it.each(['provisioned', 'provisioning_timeout'] as const)(
    'accepts an older Cloud %s response without providerSandboxId when the exact public identity matches',
    async (outcome) => {
      mocks.authorizedApiFetch
        .mockResolvedValueOnce({
          response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
          auth,
        })
        .mockResolvedValueOnce({
          response: Response.json(
            outcome === 'provisioned'
              ? {
                  outcome,
                  nodeId: 'node-legacy',
                  nodeName: SANDBOX_NAME,
                  sandboxId: SANDBOX_ID,
                  relayWorkspaceId: 'rw_abc',
                  relaycastTarget: RELAYCAST_TARGET,
                  relayfileMounted: true,
                  providerId: 'agent37',
                }
              : {
                  outcome,
                  nodeName: SANDBOX_NAME,
                  sandboxId: SANDBOX_ID,
                  relayWorkspaceId: 'rw_abc',
                  waitedMs: 90_000,
                  providerId: 'agent37',
                },
            { status: outcome === 'provisioned' ? 201 : 202 }
          ),
          auth,
        });

      const result = await ensureCloudFleetSandbox({
        workspaceId: 'rw_abc',
        requiredCapability: 'spawn:codex',
        sandboxId: SANDBOX_ID,
        name: SANDBOX_NAME,
        forceProvision: true,
        workloadProfile: 'long-running-agent',
      });

      expect(result).toMatchObject({
        outcome,
        sandboxId: SANDBOX_ID,
        nodeName: SANDBOX_NAME,
        providerId: 'agent37',
      });
      expect(result).not.toHaveProperty('providerSandboxId');
    }
  );

  it.each(['provisioned', 'provisioning_timeout'] as const)(
    'requires a valid Daytona providerSandboxId for %s responses',
    async (outcome) => {
      for (const providerSandboxId of [undefined, 'not-a-daytona-uuid']) {
        mocks.authorizedApiFetch
          .mockResolvedValueOnce({ response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }), auth })
          .mockResolvedValueOnce({
            response: Response.json(
              outcome === 'provisioned'
                ? {
                    outcome,
                    nodeId: 'node-daytona',
                    nodeName: SANDBOX_NAME,
                    sandboxId: SANDBOX_ID,
                    providerSandboxId,
                    relayWorkspaceId: 'rw_abc',
                    relayfileMounted: true,
                    providerId: 'daytona',
                  }
                : {
                    outcome,
                    nodeName: SANDBOX_NAME,
                    sandboxId: SANDBOX_ID,
                    providerSandboxId,
                    relayWorkspaceId: 'rw_abc',
                    waitedMs: 90_000,
                    providerId: 'daytona',
                  },
              { status: outcome === 'provisioned' ? 201 : 202 }
            ),
            auth,
          });

        await expect(
          ensureCloudFleetSandbox({
            workspaceId: 'rw_abc',
            requiredCapability: 'spawn:codex',
            sandboxId: SANDBOX_ID,
            name: SANDBOX_NAME,
            forceProvision: true,
            providerId: 'daytona',
            workloadProfile: 'long-running-agent',
          })
        ).rejects.toThrow('valid Daytona providerSandboxId');
      }
    }
  );

  it.each(['provisioned', 'provisioning_timeout'] as const)(
    'returns the exact Daytona providerSandboxId for %s responses',
    async (outcome) => {
      mocks.authorizedApiFetch
        .mockResolvedValueOnce({ response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }), auth })
        .mockResolvedValueOnce({
          response: Response.json(
            outcome === 'provisioned'
              ? {
                  outcome,
                  nodeId: 'node-daytona',
                  nodeName: SANDBOX_NAME,
                  sandboxId: SANDBOX_ID,
                  providerSandboxId: DAYTONA_PROVIDER_SANDBOX_ID,
                  relayWorkspaceId: 'rw_abc',
                  relayfileMounted: true,
                  providerId: 'daytona',
                }
              : {
                  outcome,
                  nodeName: SANDBOX_NAME,
                  sandboxId: SANDBOX_ID,
                  providerSandboxId: DAYTONA_PROVIDER_SANDBOX_ID,
                  relayWorkspaceId: 'rw_abc',
                  waitedMs: 90_000,
                  providerId: 'daytona',
                },
            { status: outcome === 'provisioned' ? 201 : 202 }
          ),
          auth,
        });

      await expect(
        ensureCloudFleetSandbox({
          workspaceId: 'rw_abc',
          requiredCapability: 'spawn:codex',
          sandboxId: SANDBOX_ID,
          name: SANDBOX_NAME,
          forceProvision: true,
          providerId: 'daytona',
          workloadProfile: 'long-running-agent',
        })
      ).resolves.toMatchObject({ sandboxId: SANDBOX_ID, providerSandboxId: DAYTONA_PROVIDER_SANDBOX_ID });
    }
  );

  it('requires a deterministic name whenever a sandbox identity is supplied', async () => {
    await expect(
      ensureCloudFleetSandbox({
        workspaceId: 'rw_abc',
        requiredCapability: 'spawn:codex',
        sandboxId: SANDBOX_ID,
        name: 'custom-name',
        forceProvision: true,
        workloadProfile: 'long-running-agent',
      })
    ).rejects.toThrow(SANDBOX_NAME);

    expect(mocks.ensureCloudSession).not.toHaveBeenCalled();
    expect(mocks.authorizedApiFetch).not.toHaveBeenCalled();
  });

  it.each(['provisioned', 'provisioning_timeout'] as const)(
    'fails closed when Cloud echoes a different sandbox identity for %s',
    async (outcome) => {
      mocks.authorizedApiFetch
        .mockResolvedValueOnce({
          response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
          auth,
        })
        .mockResolvedValueOnce({
          response: Response.json(
            outcome === 'provisioned'
              ? {
                  outcome,
                  nodeId: 'node-other',
                  nodeName: SANDBOX_NAME,
                  sandboxId: 'sbx_223e4567-e89b-42d3-a456-426614174000',
                  relayWorkspaceId: 'rw_abc',
                  relayfileMounted: true,
                }
              : {
                  outcome,
                  sandboxId: 'sbx_223e4567-e89b-42d3-a456-426614174000',
                  relayWorkspaceId: 'rw_abc',
                  nodeName: SANDBOX_NAME,
                  waitedMs: 90_000,
                },
            { status: outcome === 'provisioned' ? 201 : 202 }
          ),
          auth,
        });

      const error = await ensureCloudFleetSandbox({
        workspaceId: 'rw_abc',
        requiredCapability: 'spawn:codex',
        sandboxId: SANDBOX_ID,
        name: SANDBOX_NAME,
        forceProvision: true,
        workloadProfile: 'long-running-agent',
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(CloudFleetSandboxProvisionError);
      expect(error).toMatchObject({
        cloudWorkspaceId: CLOUD_WORKSPACE_ID,
        nodeName: SANDBOX_NAME,
        outcomeUnknown: true,
        sandboxId: SANDBOX_ID,
      });
      expect(String(error)).toContain(`instead of requested sandboxId ${SANDBOX_ID}`);
    }
  );

  it.each(['provisioned', 'provisioning_timeout'] as const)(
    'fails closed when Cloud echoes a different deterministic node name for %s',
    async (outcome) => {
      mocks.authorizedApiFetch
        .mockResolvedValueOnce({
          response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
          auth,
        })
        .mockResolvedValueOnce({
          response: Response.json(
            outcome === 'provisioned'
              ? {
                  outcome,
                  nodeId: 'node-other',
                  nodeName: 'fleet-sandbox-other',
                  sandboxId: SANDBOX_ID,
                  relayWorkspaceId: 'rw_abc',
                  relayfileMounted: true,
                }
              : {
                  outcome,
                  sandboxId: SANDBOX_ID,
                  relayWorkspaceId: 'rw_abc',
                  nodeName: 'fleet-sandbox-other',
                  waitedMs: 90_000,
                },
            { status: outcome === 'provisioned' ? 201 : 202 }
          ),
          auth,
        });

      const error = await ensureCloudFleetSandbox({
        workspaceId: 'rw_abc',
        requiredCapability: 'spawn:codex',
        sandboxId: SANDBOX_ID,
        name: SANDBOX_NAME,
        forceProvision: true,
        workloadProfile: 'long-running-agent',
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(CloudFleetSandboxProvisionError);
      expect(error).toMatchObject({
        cloudWorkspaceId: CLOUD_WORKSPACE_ID,
        nodeName: SANDBOX_NAME,
        outcomeUnknown: true,
        sandboxId: SANDBOX_ID,
      });
      expect(String(error)).toContain(`instead of requested nodeName ${SANDBOX_NAME}`);
    }
  );

  it.each([
    ['malformed success', { outcome: 'provisioned' }],
    ['unknown success outcome', { outcome: 'future_cloud_outcome', nodeName: SANDBOX_NAME }],
  ])('rejects a mismatched sandbox identity before parsing a %s response', async (_case, responseFields) => {
    const returnedSandboxId = 'sbx_223e4567-e89b-42d3-a456-426614174000';
    mocks.authorizedApiFetch
      .mockResolvedValueOnce({
        response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
        auth,
      })
      .mockResolvedValueOnce({
        response: Response.json({ ...responseFields, sandboxId: returnedSandboxId }, { status: 201 }),
        auth,
      });

    const error = await ensureCloudFleetSandbox({
      workspaceId: 'rw_abc',
      requiredCapability: 'spawn:codex',
      sandboxId: SANDBOX_ID,
      name: SANDBOX_NAME,
      forceProvision: true,
      workloadProfile: 'long-running-agent',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CloudFleetSandboxProvisionError);
    expect(error).toMatchObject({
      cloudWorkspaceId: CLOUD_WORKSPACE_ID,
      nodeName: SANDBOX_NAME,
      outcomeUnknown: true,
      sandboxId: SANDBOX_ID,
    });
    expect(String(error)).toContain(`instead of requested sandboxId ${SANDBOX_ID}`);
  });

  it('does not trust a mismatched sandbox identity from a non-OK response for cleanup', async () => {
    const returnedSandboxId = 'sbx_223e4567-e89b-42d3-a456-426614174000';
    mocks.authorizedApiFetch
      .mockResolvedValueOnce({
        response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
        auth,
      })
      .mockResolvedValueOnce({
        response: Response.json(
          {
            error: 'provider rejected request',
            nodeName: 'untrusted-node-name',
            sandboxId: returnedSandboxId,
            providerSandboxId: 'untrusted-provider-sandbox',
            providerId: 'agent37',
          },
          { status: 502 }
        ),
        auth,
      });

    const error = await ensureCloudFleetSandbox({
      workspaceId: 'rw_abc',
      requiredCapability: 'spawn:codex',
      sandboxId: SANDBOX_ID,
      name: SANDBOX_NAME,
      forceProvision: true,
      workloadProfile: 'long-running-agent',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CloudFleetSandboxProvisionError);
    expect(error).toMatchObject({
      cloudWorkspaceId: CLOUD_WORKSPACE_ID,
      nodeName: SANDBOX_NAME,
      outcomeUnknown: true,
      sandboxId: undefined,
      providerId: undefined,
    });
    expect(String(error)).toContain(`instead of requested sandboxId ${SANDBOX_ID}`);
  });

  it('does not expose a matching sandbox identity from a non-OK response for cleanup', async () => {
    mocks.authorizedApiFetch
      .mockResolvedValueOnce({
        response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
        auth,
      })
      .mockResolvedValueOnce({
        response: Response.json(
          {
            error: 'provider request failed after allocation',
            nodeName: SANDBOX_NAME,
            sandboxId: SANDBOX_ID,
            providerSandboxId: 'provider-sandbox-1',
            providerId: 'agent37',
          },
          { status: 502 }
        ),
        auth,
      });

    const error = await ensureCloudFleetSandbox({
      workspaceId: 'rw_abc',
      requiredCapability: 'spawn:codex',
      sandboxId: SANDBOX_ID,
      name: SANDBOX_NAME,
      forceProvision: true,
      workloadProfile: 'long-running-agent',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CloudFleetSandboxProvisionError);
    expect(error).toMatchObject({
      cloudWorkspaceId: CLOUD_WORKSPACE_ID,
      nodeName: SANDBOX_NAME,
      outcomeUnknown: true,
      sandboxId: SANDBOX_ID,
      providerId: undefined,
    });
  });

  it.each([500, 502, 503, 504])(
    'marks an identifier-less server failure (%s) unknown without exposing a cleanup ID',
    async (status) => {
      mocks.authorizedApiFetch
        .mockResolvedValueOnce({
          response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
          auth,
        })
        .mockResolvedValueOnce({
          response: Response.json({ error: 'provider timed out after allocation' }, { status }),
          auth,
        });

      const error = await ensureCloudFleetSandbox({
        workspaceId: 'rw_abc',
        requiredCapability: 'spawn:codex',
        sandboxId: SANDBOX_ID,
        name: SANDBOX_NAME,
        providerId: 'e2b',
        forceProvision: true,
        workloadProfile: 'long-running-agent',
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(CloudFleetSandboxProvisionError);
      expect(error).toMatchObject({
        cloudWorkspaceId: CLOUD_WORKSPACE_ID,
        nodeName: SANDBOX_NAME,
        providerId: 'e2b',
        outcomeUnknown: true,
        sandboxId: SANDBOX_ID,
      });
      expect(String(error)).toContain('provider timed out after allocation');
    }
  );

  it('keeps a proven client error ordinary when a stable sandbox ID was supplied', async () => {
    mocks.authorizedApiFetch
      .mockResolvedValueOnce({
        response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
        auth,
      })
      .mockResolvedValueOnce({
        response: Response.json({ error: 'invalid capability' }, { status: 422 }),
        auth,
      });

    const error = await ensureCloudFleetSandbox({
      workspaceId: 'rw_abc',
      requiredCapability: 'spawn:codex',
      sandboxId: SANDBOX_ID,
      name: SANDBOX_NAME,
      forceProvision: true,
    }).catch((caught: unknown) => caught);

    expect(error).not.toBeInstanceOf(CloudFleetSandboxProvisionError);
    expect(error).toMatchObject({ message: expect.stringContaining('invalid capability') });
  });

  it('does not expose a matching sandbox identity from a malformed success for cleanup', async () => {
    mocks.authorizedApiFetch
      .mockResolvedValueOnce({
        response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
        auth,
      })
      .mockResolvedValueOnce({
        response: Response.json(
          {
            outcome: 'provisioned',
            nodeName: SANDBOX_NAME,
            sandboxId: SANDBOX_ID,
          },
          { status: 201 }
        ),
        auth,
      });

    const error = await ensureCloudFleetSandbox({
      workspaceId: 'rw_abc',
      requiredCapability: 'spawn:codex',
      sandboxId: SANDBOX_ID,
      name: SANDBOX_NAME,
      forceProvision: true,
      workloadProfile: 'long-running-agent',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CloudFleetSandboxProvisionError);
    expect(error).toMatchObject({
      cloudWorkspaceId: CLOUD_WORKSPACE_ID,
      nodeName: SANDBOX_NAME,
      outcomeUnknown: true,
      sandboxId: SANDBOX_ID,
      providerId: undefined,
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
            providerSandboxId: 'provider-sandbox-9',
            relayWorkspaceId: 'rw_abc',
            relaycastTarget: RELAYCAST_TARGET,
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

  it('forwards bounded Relayfile mount paths into the ensure request body', async () => {
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
            nodeName: 'scoped-reviewer',
            sandboxId: 'sandbox-scoped',
            providerSandboxId: 'provider-sandbox-scoped',
            relayWorkspaceId: 'rw_abc',
            relaycastTarget: RELAYCAST_TARGET,
            relayfileMounted: true,
          },
          { status: 201 }
        ),
        auth,
      });

    await ensureCloudFleetSandbox({
      workspaceId: 'rw_abc',
      requiredCapability: 'spawn:claude',
      forceProvision: true,
      relayfilePaths: ['/live-review/run-123/**'],
    });

    const ensureCall = mocks.authorizedApiFetch.mock.calls[1];
    expect(JSON.parse(String(ensureCall?.[2]?.body))).toEqual({
      workspaceId: CLOUD_WORKSPACE_ID,
      requiredCapability: 'spawn:claude',
      forceProvision: true,
      relayfilePaths: ['/live-review/run-123/**'],
    });
  });

  it('rejects an explicitly empty Relayfile path list before provisioning', async () => {
    await expect(
      ensureCloudFleetSandbox({
        workspaceId: 'rw_abc',
        requiredCapability: 'spawn:claude',
        relayfilePaths: [],
      })
    ).rejects.toThrow('At least one Relayfile subtree path is required when relayfilePaths is provided.');

    expect(mocks.ensureCloudSession).not.toHaveBeenCalled();
    expect(mocks.authorizedApiFetch).not.toHaveBeenCalled();
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
            providerSandboxId: 'provider-sandbox-e2b',
            relayWorkspaceId: 'rw_abc',
            relaycastTarget: CANONICAL_RELAYCAST_TARGET,
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
    expect(JSON.parse(String(ensureCall?.[2]?.body))).toEqual(
      expect.objectContaining({
        providerId: 'e2b',
      })
    );
    expect(result).toEqual(expect.objectContaining({ providerId: 'e2b' }));
  });

  it('preserves provider attribution on a reused sandbox response', async () => {
    mocks.authorizedApiFetch
      .mockResolvedValueOnce({
        response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
        auth,
      })
      .mockResolvedValueOnce({
        response: Response.json({
          outcome: 'reused',
          providerId: 'e2b',
          nodeId: 'node-e2b',
          nodeName: 'e2b-reviewer',
          status: 'online',
          activeAgents: 0,
          maxAgents: 1,
          relaycastTarget: CANONICAL_RELAYCAST_TARGET,
        }),
        auth,
      });

    await expect(
      ensureCloudFleetSandbox({
        workspaceId: 'rw_abc',
        requiredCapability: 'spawn:codex',
        providerId: 'e2b',
      })
    ).resolves.toEqual(
      expect.objectContaining({
        outcome: 'reused',
        providerId: 'e2b',
      })
    );
  });

  it.each(PROVIDER_OUTCOME_MATRIX)(
    'accepts the canonical Relaycast target for the $providerId $outcome result',
    async ({ providerId, outcome }) => {
      mocks.authorizedApiFetch
        .mockResolvedValueOnce({
          response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
          auth,
        })
        .mockResolvedValueOnce({
          response: Response.json(
            outcome === 'provisioned'
              ? {
                  outcome,
                  providerId,
                  nodeId: `node-${providerId}`,
                  nodeName: `${providerId}-reviewer`,
                  sandboxId: `sandbox-${providerId}`,
                  providerSandboxId:
                    providerId === 'daytona' ? DAYTONA_PROVIDER_SANDBOX_ID : `provider-sandbox-${providerId}`,
                  relayWorkspaceId: 'rw_abc',
                  relaycastTarget: CANONICAL_RELAYCAST_TARGET,
                  relayfileMounted: true,
                }
              : {
                  outcome,
                  providerId,
                  nodeId: `node-${providerId}`,
                  nodeName: `${providerId}-reviewer`,
                  status: 'online',
                  activeAgents: 0,
                  maxAgents: 1,
                  relaycastTarget: CANONICAL_RELAYCAST_TARGET,
                },
            { status: outcome === 'provisioned' ? 201 : 200 }
          ),
          auth,
        });

      await expect(
        ensureCloudFleetSandbox({
          workspaceId: 'rw_abc',
          requiredCapability: 'spawn:codex',
          providerId,
        })
      ).resolves.toEqual(
        expect.objectContaining({
          outcome,
          providerId,
          relaycastTarget: CANONICAL_RELAYCAST_TARGET,
        })
      );
    }
  );

  it.each(PROVIDER_OUTCOME_MATRIX)(
    'accepts a legacy $providerId $outcome result without a Relaycast target',
    async ({ providerId, outcome }) => {
      mocks.authorizedApiFetch
        .mockResolvedValueOnce({
          response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
          auth,
        })
        .mockResolvedValueOnce({
          response: Response.json(
            outcome === 'provisioned'
              ? {
                  outcome,
                  providerId,
                  nodeId: `node-${providerId}`,
                  nodeName: `${providerId}-reviewer`,
                  sandboxId: `sandbox-${providerId}`,
                  providerSandboxId:
                    providerId === 'daytona' ? DAYTONA_PROVIDER_SANDBOX_ID : `provider-sandbox-${providerId}`,
                  relayWorkspaceId: 'rw_abc',
                  relayfileMounted: true,
                }
              : {
                  outcome,
                  providerId,
                  nodeId: `node-${providerId}`,
                  nodeName: `${providerId}-reviewer`,
                  status: 'online',
                  activeAgents: 0,
                  maxAgents: 1,
                },
            { status: outcome === 'provisioned' ? 201 : 200 }
          ),
          auth,
        });

      await expect(
        ensureCloudFleetSandbox({
          workspaceId: 'rw_abc',
          requiredCapability: 'spawn:codex',
          providerId,
        })
      ).resolves.toEqual(
        expect.not.objectContaining({
          relaycastTarget: expect.anything(),
        })
      );
    }
  );

  it.each(PROVIDER_OUTCOME_MATRIX)(
    'rejects an Agent37 Relaycast target for the $providerId $outcome result',
    async ({ providerId, outcome }) => {
      mocks.authorizedApiFetch
        .mockResolvedValueOnce({
          response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
          auth,
        })
        .mockResolvedValueOnce({
          response: Response.json(
            outcome === 'provisioned'
              ? {
                  outcome,
                  providerId,
                  nodeId: `node-${providerId}`,
                  nodeName: `${providerId}-reviewer`,
                  sandboxId: `sandbox-${providerId}`,
                  providerSandboxId:
                    providerId === 'daytona' ? DAYTONA_PROVIDER_SANDBOX_ID : `provider-sandbox-${providerId}`,
                  relayWorkspaceId: 'rw_abc',
                  relaycastTarget: RELAYCAST_TARGET,
                  relayfileMounted: true,
                }
              : {
                  outcome,
                  providerId,
                  nodeId: `node-${providerId}`,
                  nodeName: `${providerId}-reviewer`,
                  status: 'online',
                  activeAgents: 0,
                  maxAgents: 1,
                  relaycastTarget: RELAYCAST_TARGET,
                },
            { status: outcome === 'provisioned' ? 201 : 200 }
          ),
          auth,
        });

      await expect(
        ensureCloudFleetSandbox({
          workspaceId: 'rw_abc',
          requiredCapability: 'spawn:codex',
          providerId,
        })
      ).rejects.toThrow(/non-canonical Relaycast target/);
    }
  );

  it('requires and validates the isolated target for a reused Agent37 sandbox', async () => {
    mocks.authorizedApiFetch
      .mockResolvedValueOnce({
        response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
        auth,
      })
      .mockResolvedValueOnce({
        response: Response.json({
          outcome: 'reused',
          providerId: 'agent37',
          nodeId: 'node-agent37',
          nodeName: 'agent37-reviewer',
          status: 'online',
          activeAgents: 0,
          maxAgents: 1,
          relaycastTarget: RELAYCAST_TARGET,
        }),
        auth,
      });

    await expect(
      ensureCloudFleetSandbox({
        workspaceId: 'rw_abc',
        requiredCapability: 'spawn:codex',
        providerId: 'agent37',
        mountRelayfile: false,
      })
    ).resolves.toEqual(expect.objectContaining({ outcome: 'reused', relaycastTarget: RELAYCAST_TARGET }));
  });

  it('rejects a reused Agent37 response that omits its isolated target', async () => {
    mocks.authorizedApiFetch
      .mockResolvedValueOnce({
        response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
        auth,
      })
      .mockResolvedValueOnce({
        response: Response.json({
          outcome: 'reused',
          providerId: 'agent37',
          nodeId: 'node-agent37',
          nodeName: 'agent37-reviewer',
          status: 'online',
          activeAgents: 0,
          maxAgents: 1,
        }),
        auth,
      });

    await expect(
      ensureCloudFleetSandbox({
        workspaceId: 'rw_abc',
        requiredCapability: 'spawn:codex',
        providerId: 'agent37',
      })
    ).rejects.toThrow(/missing the Agent37 Relaycast target/);
  });

  it('rejects a provisioned Agent37 response that omits its isolated target', async () => {
    mocks.authorizedApiFetch
      .mockResolvedValueOnce({
        response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
        auth,
      })
      .mockResolvedValueOnce({
        response: Response.json(
          {
            outcome: 'provisioned',
            providerId: 'agent37',
            nodeId: 'node-agent37',
            nodeName: SANDBOX_NAME,
            sandboxId: SANDBOX_ID,
            relayWorkspaceId: 'rw_abc',
            relayfileMounted: true,
          },
          { status: 201 }
        ),
        auth,
      });

    await expect(
      ensureCloudFleetSandbox({
        workspaceId: 'rw_abc',
        requiredCapability: 'spawn:codex',
        providerId: 'agent37',
        sandboxId: SANDBOX_ID,
        name: SANDBOX_NAME,
        forceProvision: true,
        workloadProfile: 'long-running-agent',
      })
    ).rejects.toThrow(/missing the Agent37 Relaycast target/);
  });

  it('keeps router-selected responses forward compatible when no exact provider was requested', async () => {
    mocks.authorizedApiFetch
      .mockResolvedValueOnce({
        response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
        auth,
      })
      .mockResolvedValueOnce({
        response: Response.json(
          {
            outcome: 'provisioned',
            providerId: 'future-provider',
            nodeId: 'node-future',
            nodeName: 'future-reviewer',
            sandboxId: 'sandbox-future',
            providerSandboxId: 'provider-sandbox-future',
            relayWorkspaceId: 'rw_abc',
            relaycastTarget: RELAYCAST_TARGET,
            relayfileMounted: true,
          },
          { status: 201 }
        ),
        auth,
      });

    await expect(
      ensureCloudFleetSandbox({
        workspaceId: 'rw_abc',
        requiredCapability: 'spawn:codex',
      })
    ).resolves.toEqual(
      expect.objectContaining({
        outcome: 'provisioned',
        sandboxId: 'sandbox-future',
      })
    );
  });

  it('rejects without exposing cleanup identity when Cloud cannot prove the requested provider', async () => {
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
            providerSandboxId: 'provider-sandbox-1',
            relayWorkspaceId: 'rw_abc',
            relaycastTarget: RELAYCAST_TARGET,
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
      sandboxId: undefined,
      nodeName: undefined,
      providerId: 'e2b',
      outcomeUnknown: true,
    });
    expect(String(error)).toContain('instead of requested provider e2b');
  });

  it.each([
    ['missing', undefined],
    ['invalid', 'modal'],
  ])(
    'rejects without cleanup identity when a %s provider proof arrives on a 201 response',
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
              providerSandboxId: 'provider-sandbox-e2b',
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
        sandboxId: undefined,
        nodeName: undefined,
        providerId: 'e2b',
        outcomeUnknown: true,
      });
    }
  );

  it.each([
    ['missing', undefined],
    ['invalid', 'modal'],
  ])(
    'rejects without cleanup identity when a %s provider proof arrives on a 202 timeout response',
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
              providerSandboxId: 'provider-sandbox-e2b',
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
        sandboxId: undefined,
        nodeName: undefined,
        providerId: 'e2b',
        outcomeUnknown: true,
      });
    }
  );

  it.each([
    ['missing', undefined],
    ['invalid', 'modal'],
  ])(
    'rejects without cleanup identity when a %s provider proof arrives on a non-OK response',
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
              providerSandboxId: 'provider-sandbox-e2b',
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
        sandboxId: undefined,
        nodeName: undefined,
        providerId: 'e2b',
        outcomeUnknown: true,
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
            providerSandboxId: 'provider-sandbox-10',
            relayWorkspaceId: 'rw_abc',
            relaycastTarget: RELAYCAST_TARGET,
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
            providerSandboxId: 'provider-sandbox-11',
            relayWorkspaceId: 'rw_abc',
            relaycastTarget: RELAYCAST_TARGET,
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
            providerSandboxId: 'provider-sandbox-1',
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
      providerSandboxId: 'provider-sandbox-1',
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
              providerSandboxId: DAYTONA_PROVIDER_SANDBOX_ID,
              relayWorkspaceId: 'rw_abc',
              relaycastTarget: CANONICAL_RELAYCAST_TARGET,
              relayfileMounted: true,
              providerId: 'daytona',
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
            providerSandboxId: DAYTONA_PROVIDER_SANDBOX_ID,
            relayWorkspaceId: 'rw_abc',
            relaycastTarget: CANONICAL_RELAYCAST_TARGET,
            relayfileMounted: true,
            providerId: 'daytona',
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

  it('does not expose an unrequested sandbox identity from a malformed successful response', async () => {
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
            providerSandboxId: 'provider-sandbox-1',
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
      sandboxId: undefined,
      nodeName: undefined,
      outcomeUnknown: true,
    });
  });

  it('does not copy a caller sandbox identity into an unknown-response error', async () => {
    mocks.authorizedApiFetch
      .mockResolvedValueOnce({
        response: Response.json({ cloudWorkspaceId: CLOUD_WORKSPACE_ID }),
        auth,
      })
      .mockRejectedValueOnce(new Error('request timed out'));

    const error = await ensureCloudFleetSandbox({
      workspaceId: 'rw_abc',
      requiredCapability: 'spawn:codex',
      sandboxId: SANDBOX_ID,
      name: SANDBOX_NAME,
      forceProvision: true,
      workloadProfile: 'long-running-agent',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CloudFleetSandboxProvisionError);
    expect(error).toMatchObject({
      cloudWorkspaceId: CLOUD_WORKSPACE_ID,
      nodeName: SANDBOX_NAME,
      outcomeUnknown: true,
    });
    expect(error).toMatchObject({ sandboxId: SANDBOX_ID });
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
            providerSandboxId: 'provider-sandbox-1',
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
