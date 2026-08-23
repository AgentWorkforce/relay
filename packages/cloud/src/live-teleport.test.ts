import { describe, expect, it, vi } from 'vitest';

import { CloudLiveTeleportClient } from './live-teleport.js';

const receipt = {
  sealId: 'seal-1',
  sealToken: 'opaque-seal-token',
  workspaceId: 'workspace-1',
  root: '/',
  sessionId: 'session-1',
  generation: 2,
  digest: `sha256:${'a'.repeat(64)}`,
  workspaceRevision: 'rev_12',
  eventCursor: 'evt_19313',
};

const input = {
  sessionId: 'session-1',
  threadId: 'thread-1',
  generation: 2,
  workspaceRoot: '/workspace',
  source: {
    kind: 'relayfile-checkpoint-seal' as const,
    receipt,
  },
  idempotencyKey: 'session-1:2:acquire',
};

function verification(
  overrides: {
    digest?: string;
    workspaceRevision?: string;
    eventCursor?: string;
    workspaceId?: string;
    localRoot?: string;
    remoteRoot?: string;
    sessionId?: string;
    generation?: number;
    pendingWriteback?: number;
  } = {}
) {
  return {
    version: 1,
    kind: 'relayfile-destination-verification',
    verificationId: 'verify-2',
    workspaceId: overrides.workspaceId ?? 'workspace-1',
    localRoot: overrides.localRoot ?? '/workspace',
    remoteRoot: overrides.remoteRoot ?? '/',
    sessionId: overrides.sessionId ?? 'session-1',
    generation: overrides.generation ?? 2,
    status: 'converged',
    observed: {
      digest: overrides.digest ?? `sha256:${'a'.repeat(64)}`,
      workspaceRevision: overrides.workspaceRevision ?? 'rev_12',
      eventCursor: overrides.eventCursor ?? 'evt_19313',
    },
    health: {
      pendingWriteback: overrides.pendingWriteback ?? 0,
      conflicts: 0,
      outboxPending: 0,
      outboxNeedsAttention: false,
    },
    verifiedAt: '2026-08-23T11:59:00.000Z',
  };
}

// Frozen constructor parity fixtures derived from Cloud e3f9e5ddc:
// prewarm/route.ts, acquire/route.ts, status/route.ts, and feature-flag.ts.
const cloudRollout = {
  masterEnabled: true,
  eligible: true,
  reason: 'workspace-allowlist' as const,
  percentage: 25,
};

function cloudPrewarmWarming() {
  return {
    sessionId: 'session-1',
    generation: 2,
    prewarmId: 'prewarm-2',
    status: 'warming',
    expiresAt: '2026-08-23T12:30:00.000Z',
    retryAfterMs: 1_000,
  };
}

function cloudAcquireVerifying() {
  return {
    sessionId: 'session-1',
    generation: 2,
    status: 'verifying',
    retryAfterMs: 1_000,
  };
}

function cloudAcquireActive() {
  return {
    sessionId: 'session-1',
    generation: 2,
    threadId: 'thread-1',
    status: 'active',
    environmentId: 'env-2',
    connectPath: '/api/v1/live-teleports/connect/ticket',
    workspaceCwd: '/workspace',
    connectExpiresAt: '2026-08-23T12:05:00.000Z',
    leaseExpiresAt: '2026-08-23T12:45:00.000Z',
    verification: verification(),
  };
}

function cloudActiveStatus(leaseExpiresAt = '2026-08-23T12:45:00.000Z') {
  return {
    sessionId: 'session-1',
    generation: 2,
    status: 'active',
    prewarmId: 'prewarm-2',
    expiresAt: leaseExpiresAt,
    leaseExpiresAt,
    rollout: cloudRollout,
  };
}

describe('CloudLiveTeleportClient', () => {
  it('polls an exact 202 acquire with the same idempotency body until active', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(cloudAcquireVerifying(), { status: 202 }))
      .mockResolvedValueOnce(
        Response.json({
          sessionId: 'session-1',
          generation: 2,
          threadId: 'thread-1',
          status: 'active',
          environmentId: 'env-2',
          connectPath: '/api/v1/live-teleports/connect/ticket',
          workspaceCwd: '/workspace',
          connectExpiresAt: '2026-08-23T12:00:00.000Z',
          leaseExpiresAt: '2026-08-23T12:30:00.000Z',
          verification: verification(),
        })
      );
    const client = new CloudLiveTeleportClient(fetcher, 'https://cloud.agentrelay.test');

    await expect(client.acquire(input)).resolves.toMatchObject({ environmentId: 'env-2' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetcher).mock.calls[0]?.[1]?.body).toBe(vi.mocked(fetcher).mock.calls[1]?.[1]?.body);
  });

  it('composes the frozen Cloud e3f9e5ddc warming → verifying → active and renewal constructors', async () => {
    const renewedLease = '2026-08-23T13:15:00.000Z';
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(cloudPrewarmWarming(), { status: 202 }))
      .mockResolvedValueOnce(Response.json(cloudAcquireVerifying(), { status: 202 }))
      .mockResolvedValueOnce(Response.json(cloudAcquireActive()))
      .mockResolvedValueOnce(Response.json(cloudActiveStatus(renewedLease)));
    const client = new CloudLiveTeleportClient(fetcher, 'https://cloud.agentrelay.test');

    await expect(
      client.prewarm({
        sessionId: 'session-1',
        generation: 2,
        workspaceRoot: '/',
        idempotencyKey: 'session-1:2:prewarm',
      })
    ).resolves.toEqual(cloudPrewarmWarming());
    await expect(client.acquire(input)).resolves.toMatchObject({
      sessionId: 'session-1',
      generation: 2,
      environmentId: 'env-2',
      leaseExpiresAt: '2026-08-23T12:45:00.000Z',
    });
    await expect(client.status({ sessionId: 'session-1', generation: 2 })).resolves.toEqual(
      cloudActiveStatus(renewedLease)
    );

    expect(Object.keys(cloudPrewarmWarming()).sort()).toEqual(
      ['expiresAt', 'generation', 'prewarmId', 'retryAfterMs', 'sessionId', 'status'].sort()
    );
    expect(Object.keys(cloudAcquireVerifying()).sort()).toEqual(
      ['generation', 'retryAfterMs', 'sessionId', 'status'].sort()
    );
    expect(Object.keys(cloudActiveStatus()).sort()).toEqual(
      ['expiresAt', 'generation', 'leaseExpiresAt', 'prewarmId', 'rollout', 'sessionId', 'status'].sort()
    );
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      '/api/v1/live-teleports/prewarm',
      '/api/v1/live-teleports/acquire',
      '/api/v1/live-teleports/acquire',
      '/api/v1/live-teleports/status',
    ]);
  });

  it('rejects identity or required-field drift in frozen Cloud prewarm and pending acquire shapes', async () => {
    const stalePrewarm = new CloudLiveTeleportClient(
      async () => Response.json({ ...cloudPrewarmWarming(), sessionId: 'other-session' }, { status: 202 }),
      'https://cloud.agentrelay.test'
    );
    await expect(
      stalePrewarm.prewarm({
        sessionId: 'session-1',
        generation: 2,
        workspaceRoot: '/',
        idempotencyKey: 'session-1:2:prewarm',
      })
    ).rejects.toThrow('mismatched lifecycle metadata');

    const missingExpiry = new CloudLiveTeleportClient(async () => {
      const { expiresAt: _expiresAt, ...response } = cloudPrewarmWarming();
      return Response.json(response, { status: 202 });
    }, 'https://cloud.agentrelay.test');
    await expect(
      missingExpiry.prewarm({
        sessionId: 'session-1',
        generation: 2,
        workspaceRoot: '/',
        idempotencyKey: 'session-1:2:prewarm',
      })
    ).rejects.toThrow('expiresAt');

    const stalePending = new CloudLiveTeleportClient(
      async () => Response.json({ ...cloudAcquireVerifying(), generation: 3 }, { status: 202 }),
      'https://cloud.agentrelay.test'
    );
    await expect(stalePending.acquire(input)).rejects.toThrow('stale lifecycle identity');
  });

  it('enforces Cloud prewarm HTTP, expiry, and retry semantics', async () => {
    const readyResponse = {
      ...cloudPrewarmWarming(),
      status: 'ready',
    };
    const { retryAfterMs: _retryAfterMs, ...ready } = readyResponse;
    const readyClient = new CloudLiveTeleportClient(
      async () => Response.json(ready),
      'https://cloud.agentrelay.test'
    );
    await expect(
      readyClient.prewarm({
        sessionId: 'session-1',
        generation: 2,
        workspaceRoot: '/',
        idempotencyKey: 'session-1:2:prewarm',
      })
    ).resolves.toEqual(ready);

    for (const response of [
      { body: cloudPrewarmWarming(), status: 200 },
      {
        body: { ...cloudPrewarmWarming(), status: 'ready' },
        status: 200,
      },
      {
        body: (() => {
          const { retryAfterMs: _retry, ...withoutRetry } = cloudPrewarmWarming();
          return withoutRetry;
        })(),
        status: 202,
      },
    ]) {
      const client = new CloudLiveTeleportClient(
        async () => Response.json(response.body, { status: response.status }),
        'https://cloud.agentrelay.test'
      );
      await expect(
        client.prewarm({
          sessionId: 'session-1',
          generation: 2,
          workspaceRoot: '/',
          idempotencyKey: 'session-1:2:prewarm',
        })
      ).rejects.toThrow('mismatched lifecycle metadata');
    }
  });

  it('accepts only the provider-neutral Cloud WSS bridge contract', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        sessionId: 'session-1',
        generation: 2,
        threadId: 'thread-1',
        status: 'active',
        environmentId: 'env-2',
        connectPath: '/api/v1/live-teleports/connect/session-1/g/2?ticket=opaque',
        workspaceCwd: '/workspace',
        connectExpiresAt: '2026-08-23T12:00:00.000Z',
        leaseExpiresAt: '2026-08-23T12:30:00.000Z',
        verification: verification(),
      })
    );

    await expect(
      new CloudLiveTeleportClient(fetcher, 'https://cloud.agentrelay.test').acquire(input)
    ).resolves.toMatchObject({
      environmentId: 'env-2',
      generation: 2,
      execServerUrl: 'wss://cloud.agentrelay.test/api/v1/live-teleports/connect/session-1/g/2?ticket=opaque',
    });
    expect(fetcher).toHaveBeenCalledWith(
      '/api/v1/live-teleports/acquire',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('fails closed if Cloud exposes a provider credential or URL', async () => {
    const client = new CloudLiveTeleportClient(
      async () =>
        Response.json({
          sessionId: 'session-1',
          generation: 2,
          threadId: 'thread-1',
          status: 'active',
          environmentId: 'env-2',
          connectPath: '/api/v1/live-teleports/connect/ticket',
          workspaceCwd: '/workspace',
          connectExpiresAt: '2026-08-23T12:00:00.000Z',
          leaseExpiresAt: '2026-08-23T12:30:00.000Z',
          verification: verification(),
          providerUrl: 'wss://provider.invalid/raw',
          trafficAccessToken: 'secret',
        }),
      'https://cloud.agentrelay.test'
    );

    await expect(client.acquire(input)).rejects.toThrow('forbidden sensitive field');
  });

  it('recursively rejects credential-shaped fields at every remote response boundary', async () => {
    const active = {
      sessionId: 'session-1',
      generation: 2,
      threadId: 'thread-1',
      status: 'active',
      environmentId: 'env-2',
      connectPath: '/api/v1/live-teleports/connect/ticket',
      workspaceCwd: '/workspace',
      connectExpiresAt: '2026-08-23T12:00:00.000Z',
      leaseExpiresAt: '2026-08-23T12:45:00.000Z',
      verification: verification(),
    };
    const cases = [
      {
        response: { prewarmId: 'prewarm-2', generation: 2, status: 'ready', nested: { daytonaApiKey: 'x' } },
        invoke: (client: CloudLiveTeleportClient) =>
          client.prewarm({
            sessionId: 'session-1',
            generation: 2,
            workspaceRoot: '/',
            idempotencyKey: 'session-1:2:prewarm',
          }),
      },
      {
        response: {
          sessionId: 'session-1',
          generation: 2,
          status: 'active',
          metadata: { e2bApiKey: 'x' },
        },
        invoke: (client: CloudLiveTeleportClient) => client.status({ sessionId: 'session-1', generation: 2 }),
      },
      {
        response: { ...active, metadata: { child: { accessToken: 'x' } } },
        invoke: (client: CloudLiveTeleportClient) => client.acquire(input),
      },
      {
        response: {
          sessionId: 'session-1',
          generation: 2,
          status: 'revoked',
          metadata: { authorization: 'Bearer x' },
        },
        invoke: (client: CloudLiveTeleportClient) =>
          client.revoke({ sessionId: 'session-1', generation: 2, idempotencyKey: 'session-1:2:revoke' }),
      },
      {
        response: {
          sessionId: 'session-1',
          generation: 2,
          status: 'revoked',
          metadata: { nested: { secret: 'x' } },
        },
        invoke: (client: CloudLiveTeleportClient) =>
          client.revoke({ sessionId: 'session-1', generation: 2, idempotencyKey: 'session-1:2:revoke' }),
      },
    ];

    for (const scenario of cases) {
      const client = new CloudLiveTeleportClient(
        async () => Response.json(scenario.response),
        'https://cloud.agentrelay.test'
      );
      await expect(scenario.invoke(client)).rejects.toThrow('forbidden sensitive field');
    }
  });

  it('rejects unknown non-sensitive fields instead of retaining unparsed remote response data', async () => {
    const client = new CloudLiveTeleportClient(
      async () =>
        Response.json({
          sessionId: 'session-1',
          generation: 2,
          status: 'active',
          leaseExpiresAt: '2026-08-23T12:45:00.000Z',
          metadata: { region: 'unknown' },
        }),
      'https://cloud.agentrelay.test'
    );

    await expect(client.status({ sessionId: 'session-1', generation: 2 })).rejects.toThrow(
      'unexpected response field metadata'
    );
  });

  it('rejects an arbitrary execution URL even when it points at Cloud', async () => {
    const client = new CloudLiveTeleportClient(
      async () =>
        Response.json({
          sessionId: 'session-1',
          generation: 2,
          threadId: 'thread-1',
          status: 'active',
          environmentId: 'env-2',
          execServerUrl: 'ws://127.0.0.1:4500',
          connectPath: '/api/v1/live-teleports/connect/ticket',
          workspaceCwd: '/workspace',
          connectExpiresAt: '2026-08-23T12:00:00.000Z',
          leaseExpiresAt: '2026-08-23T12:30:00.000Z',
          verification: verification(),
        }),
      'https://cloud.agentrelay.test'
    );

    await expect(client.acquire(input)).rejects.toThrow('must not return an arbitrary execServerUrl');
  });

  it('rejects absolute, cross-origin, and traversal connect paths', async () => {
    for (const connectPath of [
      'wss://provider.invalid/raw',
      '//provider.invalid/raw',
      '/api/v1/live-teleports/connect/../../provider',
    ]) {
      const client = new CloudLiveTeleportClient(
        async () =>
          Response.json({
            sessionId: 'session-1',
            generation: 2,
            threadId: 'thread-1',
            status: 'active',
            environmentId: 'env-2',
            connectPath,
            workspaceCwd: '/workspace',
            connectExpiresAt: '2026-08-23T12:00:00.000Z',
            leaseExpiresAt: '2026-08-23T12:30:00.000Z',
            verification: verification(),
          }),
        'https://cloud.agentrelay.test'
      );
      await expect(client.acquire(input)).rejects.toThrow(/connectPath/);
    }
  });

  it('rejects a verification whose authoritative digest is malformed', async () => {
    const client = new CloudLiveTeleportClient(
      async () =>
        Response.json({
          sessionId: 'session-1',
          generation: 2,
          threadId: 'thread-1',
          status: 'active',
          environmentId: 'env-2',
          connectPath: '/api/v1/live-teleports/connect/ticket',
          workspaceCwd: '/workspace',
          connectExpiresAt: '2026-08-23T12:00:00.000Z',
          leaseExpiresAt: '2026-08-23T12:30:00.000Z',
          verification: verification({ digest: 'f'.repeat(64) }),
        }),
      'https://cloud.agentrelay.test'
    );

    await expect(client.acquire(input)).rejects.toThrow('invalid verification.observed.digest');
  });

  it.each([
    ['bare revision', verification({ workspaceRevision: '12' })],
    ['wrong revision namespace', verification({ workspaceRevision: 'evt_12' })],
    ['bare cursor', verification({ eventCursor: '19313' })],
    ['wrong cursor namespace', verification({ eventCursor: 'rev_19313' })],
  ])('rejects %s in Relayfile destination verification', async (_name, proof) => {
    const client = new CloudLiveTeleportClient(
      async () =>
        Response.json({
          sessionId: 'session-1',
          generation: 2,
          threadId: 'thread-1',
          status: 'active',
          environmentId: 'env-2',
          connectPath: '/api/v1/live-teleports/connect/ticket',
          workspaceCwd: '/workspace',
          connectExpiresAt: '2026-08-23T12:00:00.000Z',
          leaseExpiresAt: '2026-08-23T12:30:00.000Z',
          verification: proof,
        }),
      'https://cloud.agentrelay.test'
    );

    await expect(client.acquire(input)).rejects.toThrow(/verification\.observed/);
  });

  it.each([
    ['workspace', verification({ workspaceId: 'workspace-other' })],
    ['remote root', verification({ remoteRoot: '/other' })],
    ['session', verification({ sessionId: 'session-other' })],
    ['generation', verification({ generation: 3 })],
    ['digest', verification({ digest: `sha256:${'b'.repeat(64)}` })],
    ['workspace revision', verification({ workspaceRevision: 'rev_13' })],
    ['event cursor', verification({ eventCursor: 'evt_19314' })],
  ])('rejects destination verification that does not bind the receipt %s', async (_name, proof) => {
    const client = new CloudLiveTeleportClient(
      async () =>
        Response.json({
          sessionId: 'session-1',
          generation: 2,
          threadId: 'thread-1',
          status: 'active',
          environmentId: 'env-2',
          connectPath: '/api/v1/live-teleports/connect/ticket',
          workspaceCwd: '/workspace',
          connectExpiresAt: '2026-08-23T12:00:00.000Z',
          leaseExpiresAt: '2026-08-23T12:45:00.000Z',
          verification: proof,
        }),
      'https://cloud.agentrelay.test'
    );

    const error = await client.acquire(input).catch((caught: unknown) => caught);
    expect(String(error)).toContain('mismatched Relayfile verification');
    expect(String(error)).not.toContain(receipt.sealToken);
  });

  it('rejects destination verification for a different acquired workspace cwd', async () => {
    const client = new CloudLiveTeleportClient(
      async () =>
        Response.json({
          sessionId: 'session-1',
          generation: 2,
          threadId: 'thread-1',
          status: 'active',
          environmentId: 'env-2',
          connectPath: '/api/v1/live-teleports/connect/ticket',
          workspaceCwd: '/workspace',
          connectExpiresAt: '2026-08-23T12:00:00.000Z',
          leaseExpiresAt: '2026-08-23T12:45:00.000Z',
          verification: verification({ localRoot: '/different-workspace' }),
        }),
      'https://cloud.agentrelay.test'
    );

    await expect(client.acquire(input)).rejects.toThrow('mismatched Relayfile verification');
  });

  it('rejects any response that echoes the one-use checkpoint capability', async () => {
    const client = new CloudLiveTeleportClient(
      async () =>
        Response.json({
          sessionId: 'session-1',
          generation: 2,
          threadId: 'thread-1',
          status: 'active',
          environmentId: 'env-2',
          connectPath: '/api/v1/live-teleports/connect/ticket',
          workspaceCwd: '/workspace',
          connectExpiresAt: '2026-08-23T12:00:00.000Z',
          leaseExpiresAt: '2026-08-23T12:45:00.000Z',
          verification: { ...verification(), sealToken: receipt.sealToken },
        }),
      'https://cloud.agentrelay.test'
    );

    const error = await client.acquire(input).catch((caught: unknown) => caught);
    expect(String(error)).toContain('forbidden sensitive field');
    expect(String(error)).not.toContain(receipt.sealToken);
  });

  it('bounds a permanently verifying acquire while replaying the same request', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ ...cloudAcquireVerifying(), retryAfterMs: 1 }, { status: 202 })
    );
    const client = new CloudLiveTeleportClient(fetcher, 'https://cloud.agentrelay.test');

    await expect(client.acquire(input)).rejects.toThrow('bounded verification poll limit');
    expect(fetcher).toHaveBeenCalledTimes(120);
    expect(new Set(fetcher.mock.calls.map((call) => call[1]?.body))).toHaveLength(1);
  });

  it('rejects matching hashes when the destination outbox is not drained', async () => {
    const client = new CloudLiveTeleportClient(
      async () =>
        Response.json({
          sessionId: 'session-1',
          generation: 2,
          threadId: 'thread-1',
          status: 'active',
          environmentId: 'env-2',
          connectPath: '/api/v1/live-teleports/connect/ticket',
          workspaceCwd: '/workspace',
          connectExpiresAt: '2026-08-23T12:00:00.000Z',
          leaseExpiresAt: '2026-08-23T12:30:00.000Z',
          verification: verification({ pendingWriteback: 1 }),
        }),
      'https://cloud.agentrelay.test'
    );

    await expect(client.acquire(input)).rejects.toThrow('mismatched Relayfile verification');
  });

  it('does not echo a Cloud error containing an opaque bridge or provider secret', async () => {
    const client = new CloudLiveTeleportClient(
      async () =>
        Response.json(
          { error: 'provider rejected https://provider.invalid/?token=opaque-secret-value' },
          { status: 502, statusText: 'Bad Gateway' }
        ),
      'https://cloud.agentrelay.test'
    );

    const error = await client.acquire(input).catch((caught: unknown) => caught);
    expect(String(error)).toContain('Bad Gateway');
    expect(String(error)).not.toContain('opaque-secret-value');
    expect(String(error)).not.toContain('provider.invalid');
  });

  it('does not leak the seal token through an acquire transport diagnostic', async () => {
    const client = new CloudLiveTeleportClient(async (_path, init) => {
      throw new Error(`transport rejected ${String(init?.body)}`);
    }, 'https://cloud.agentrelay.test');

    const error = await client.acquire(input).catch((caught: unknown) => caught);
    expect(String(error)).toContain('acquire transport failed');
    expect(String(error)).not.toContain(receipt.sealToken);
  });

  it('parses bounded lifecycle polling and requires explicit revoke confirmation', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          sessionId: 'session-1',
          generation: 2,
          prewarmId: 'prewarm-2',
          status: 'warming',
          retryAfterMs: 250,
          expiresAt: '2026-08-23T12:30:00.000Z',
          rollout: cloudRollout,
        })
      )
      .mockResolvedValueOnce(Response.json({ sessionId: 'session-1', generation: 2, status: 'revoked' }));
    const client = new CloudLiveTeleportClient(fetcher, 'https://cloud.agentrelay.test');

    await expect(client.status({ sessionId: 'session-1', generation: 2 })).resolves.toMatchObject({
      status: 'warming',
      retryAfterMs: 250,
    });
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      '/api/v1/live-teleports/status',
      expect.objectContaining({ method: 'POST' })
    );
    await expect(
      client.revoke({ sessionId: 'session-1', generation: 2, idempotencyKey: 'revoke-2' })
    ).resolves.toMatchObject({ status: 'revoked' });
  });

  it('parses the exact active lease deadline and rejects non-canonical timestamps', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(cloudActiveStatus()))
      .mockResolvedValueOnce(
        Response.json({
          ...cloudActiveStatus(),
          leaseExpiresAt: '2026-08-23T14:45:00+02:00',
        })
      );
    const client = new CloudLiveTeleportClient(fetcher, 'https://cloud.agentrelay.test');

    await expect(client.status({ sessionId: 'session-1', generation: 2 })).resolves.toMatchObject({
      status: 'active',
      leaseExpiresAt: '2026-08-23T12:45:00.000Z',
    });
    await expect(client.status({ sessionId: 'session-1', generation: 2 })).rejects.toThrow(
      'invalid leaseExpiresAt'
    );
  });

  it.each([
    ['unknown reason', { ...cloudRollout, reason: 'manual-override' }],
    ['out-of-range percentage', { ...cloudRollout, percentage: 101 }],
    ['inconsistent eligibility', { ...cloudRollout, reason: 'not-targeted', eligible: true }],
    ['unexpected rollout field', { ...cloudRollout, cohort: 'canary' }],
  ])('rejects %s in Cloud status rollout metadata', async (_name, rollout) => {
    const client = new CloudLiveTeleportClient(
      async () => Response.json({ ...cloudActiveStatus(), rollout }),
      'https://cloud.agentrelay.test'
    );

    await expect(client.status({ sessionId: 'session-1', generation: 2 })).rejects.toThrow(/rollout/);
  });

  it('rejects a cross-session status response even when its rollout and lease are valid', async () => {
    const client = new CloudLiveTeleportClient(
      async () => Response.json({ ...cloudActiveStatus(), sessionId: 'other-session' }),
      'https://cloud.agentrelay.test'
    );

    await expect(client.status({ sessionId: 'session-1', generation: 2 })).rejects.toThrow(
      'stale or cross-session'
    );
  });

  it('accepts cleanup_pending as a non-terminal revoke acknowledgement', async () => {
    const client = new CloudLiveTeleportClient(
      async () =>
        Response.json(
          { sessionId: 'session-1', generation: 2, status: 'cleanup_pending', retryAfterMs: 10 },
          { status: 202 }
        ),
      'https://cloud.agentrelay.test'
    );
    await expect(
      client.revoke({ sessionId: 'session-1', generation: 2, idempotencyKey: 'revoke-2' })
    ).resolves.toMatchObject({ status: 'cleanup_pending' });
  });

  it('accepts only the exact identity-matching HTTP 200 terminal no-row revoke response', async () => {
    const exact = new CloudLiveTeleportClient(
      async () =>
        Response.json({ sessionId: 'session-1', generation: 2, status: 'revoked' }, { status: 200 }),
      'https://cloud.agentrelay.test'
    );
    await expect(
      exact.revoke({ sessionId: 'session-1', generation: 2, idempotencyKey: 'revoke-no-row-2' })
    ).resolves.toEqual({ sessionId: 'session-1', generation: 2, status: 'revoked' });

    const mismatched = new CloudLiveTeleportClient(
      async () =>
        Response.json({ sessionId: 'other-session', generation: 2, status: 'revoked' }, { status: 200 }),
      'https://cloud.agentrelay.test'
    );
    await expect(
      mismatched.revoke({ sessionId: 'session-1', generation: 2, idempotencyKey: 'revoke-no-row-2' })
    ).rejects.toThrow('stale or cross-session');

    const notFound = new CloudLiveTeleportClient(
      async () =>
        Response.json({ sessionId: 'session-1', generation: 2, status: 'revoked' }, { status: 404 }),
      'https://cloud.agentrelay.test'
    );
    await expect(
      notFound.revoke({ sessionId: 'session-1', generation: 2, idempotencyKey: 'revoke-no-row-2' })
    ).rejects.toThrow('request failed (404)');
  });

  it('requires encrypted transport except for explicit loopback development', () => {
    expect(() => new CloudLiveTeleportClient(vi.fn(), 'http://cloud.example.test')).toThrow('must use HTTPS');
    expect(() => new CloudLiveTeleportClient(vi.fn(), 'http://127.0.0.1:3000')).not.toThrow();
  });

  it('rejects a successful revoke response that does not prove fencing', async () => {
    const client = new CloudLiveTeleportClient(
      async () => Response.json({ sessionId: 'session-1', generation: 2, status: 'ready' }),
      'https://cloud.agentrelay.test'
    );
    await expect(
      client.revoke({ sessionId: 'session-1', generation: 2, idempotencyKey: 'revoke-2' })
    ).rejects.toThrow('was not confirmed');
  });
});
