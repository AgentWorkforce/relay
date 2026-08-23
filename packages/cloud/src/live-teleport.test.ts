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

function convergence(overrides: { destinationSha?: string; pendingWriteback?: number } = {}) {
  const watermark = {
    cursor: 'evt_19312',
    manifestSha256: 'a'.repeat(64),
    files: 12,
    bytes: 2048,
    conflictArtifacts: ['.relay/conflicts/shared.txt.writer-b'],
    conflictDigest: 'b'.repeat(64),
  };
  return {
    verdict: 'converged',
    source: { ...watermark, sealedAt: '2026-08-23T11:59:00.000Z' },
    destination: {
      ...watermark,
      cursor: 'evt_19313',
      manifestSha256: overrides.destinationSha ?? watermark.manifestSha256,
      pendingWriteback: overrides.pendingWriteback ?? 0,
      hasPendingWriteback: false,
      outboxNeedsAttention: false,
      ephemeralPaths: [],
    },
  };
}

describe('CloudLiveTeleportClient', () => {
  it('accepts only the provider-neutral Cloud WSS bridge contract', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        sessionId: 'session-1',
        generation: 2,
        environmentId: 'env-2',
        connectPath: '/api/v1/live-teleports/connect/session-1/g/2?ticket=opaque',
        workspaceCwd: '/workspace',
        expiresAt: '2026-08-23T12:00:00.000Z',
        convergence: convergence(),
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
          environmentId: 'env-2',
          connectPath: '/api/v1/live-teleports/connect/ticket',
          workspaceCwd: '/workspace',
          expiresAt: '2026-08-23T12:00:00.000Z',
          convergence: convergence(),
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
          environmentId: 'env-2',
          execServerUrl: 'ws://127.0.0.1:4500',
          connectPath: '/api/v1/live-teleports/connect/ticket',
          workspaceCwd: '/workspace',
          expiresAt: '2026-08-23T12:00:00.000Z',
          convergence: convergence(),
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
            environmentId: 'env-2',
            connectPath,
            workspaceCwd: '/workspace',
            expiresAt: '2026-08-23T12:00:00.000Z',
            convergence: convergence(),
          }),
        'https://cloud.agentrelay.test'
      );
      await expect(client.acquire(input)).rejects.toThrow(/connectPath/);
    }
  });

  it('rejects a time-based convergence claim whose destination hash differs', async () => {
    const client = new CloudLiveTeleportClient(
      async () =>
        Response.json({
          sessionId: 'session-1',
          generation: 2,
          environmentId: 'env-2',
          connectPath: '/api/v1/live-teleports/connect/ticket',
          workspaceCwd: '/workspace',
          expiresAt: '2026-08-23T12:00:00.000Z',
          convergence: convergence({ destinationSha: 'f'.repeat(64) }),
        }),
      'https://cloud.agentrelay.test'
    );

    await expect(client.acquire(input)).rejects.toThrow('non-converged hash/cursor proof');
  });

  it('rejects matching hashes when the destination outbox is not drained', async () => {
    const client = new CloudLiveTeleportClient(
      async () =>
        Response.json({
          sessionId: 'session-1',
          generation: 2,
          environmentId: 'env-2',
          connectPath: '/api/v1/live-teleports/connect/ticket',
          workspaceCwd: '/workspace',
          expiresAt: '2026-08-23T12:00:00.000Z',
          convergence: convergence({ pendingWriteback: 1 }),
        }),
      'https://cloud.agentrelay.test'
    );

    await expect(client.acquire(input)).rejects.toThrow('non-converged hash/cursor proof');
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
    await expect(
      client.revoke({ sessionId: 'session-1', generation: 2, idempotencyKey: 'revoke-2' })
    ).resolves.toMatchObject({ status: 'revoked' });
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
