import { describe, expect, it, vi } from 'vitest';

import { CloudLiveTeleportClient } from './live-teleport.js';

const input = {
  sessionId: 'session-1',
  threadId: 'thread-1',
  generation: 2,
  workspaceRoot: '/workspace',
  source: {
    kind: 'relayfile-checkpoint-seal' as const,
    receipt: { sealId: 'seal-1', sealToken: 'opaque' },
  },
  idempotencyKey: 'session-1:2:acquire',
};

function verification(
  overrides: {
    digest?: string;
    workspaceRevision?: string;
    eventCursor?: string;
    pendingWriteback?: number;
  } = {}
) {
  return {
    version: 1,
    kind: 'relayfile-destination-verification',
    verificationId: 'verify-2',
    workspaceId: 'workspace-1',
    localRoot: '/workspace',
    remoteRoot: '/',
    sessionId: 'session-1',
    generation: 2,
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

describe('CloudLiveTeleportClient', () => {
  it('polls an exact 202 acquire with the same idempotency body until active', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ status: 'verifying', retryAfterMs: 0 }, { status: 202 }))
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

    await expect(client.acquire(input)).rejects.toThrow('forbidden provider field');
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

  it('bounds a permanently verifying acquire while replaying the same request', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ status: 'verifying', retryAfterMs: 0 }, { status: 202 })
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
