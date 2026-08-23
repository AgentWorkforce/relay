import { describe, expect, it, vi } from 'vitest';

import { CloudLiveTeleportClient } from './live-teleport.js';

const input = {
  sessionId: 'session-1',
  threadId: 'thread-1',
  generation: 2,
  workspaceRoot: '/workspace',
  source: { kind: 'relayfile-mount' as const, mountStatePath: '/workspace/.relayfile-mount-state.json' },
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
        execServerUrl: 'wss://exec.agentrelay.test/t/session-1/g/2',
        workspaceCwd: '/workspace',
        expiresAt: '2026-08-23T12:00:00.000Z',
        convergence: convergence(),
      })
    );

    await expect(new CloudLiveTeleportClient(fetcher).acquire(input)).resolves.toMatchObject({
      environmentId: 'env-2',
      generation: 2,
    });
    expect(fetcher).toHaveBeenCalledWith(
      '/api/v1/live-teleports/acquire',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('fails closed if Cloud exposes a provider credential or URL', async () => {
    const client = new CloudLiveTeleportClient(async () =>
      Response.json({
        sessionId: 'session-1',
        generation: 2,
        environmentId: 'env-2',
        execServerUrl: 'wss://exec.agentrelay.test/ticket',
        workspaceCwd: '/workspace',
        expiresAt: '2026-08-23T12:00:00.000Z',
        convergence: convergence(),
        providerUrl: 'wss://provider.invalid/raw',
        trafficAccessToken: 'secret',
      })
    );

    await expect(client.acquire(input)).rejects.toThrow('forbidden provider field');
  });

  it('rejects a non-TLS execution address', async () => {
    const client = new CloudLiveTeleportClient(async () =>
      Response.json({
        sessionId: 'session-1',
        generation: 2,
        environmentId: 'env-2',
        execServerUrl: 'ws://127.0.0.1:4500',
        workspaceCwd: '/workspace',
        expiresAt: '2026-08-23T12:00:00.000Z',
        convergence: convergence(),
      })
    );

    await expect(client.acquire(input)).rejects.toThrow('Cloud WSS bridge');
  });

  it('rejects a time-based convergence claim whose destination hash differs', async () => {
    const client = new CloudLiveTeleportClient(async () =>
      Response.json({
        sessionId: 'session-1',
        generation: 2,
        environmentId: 'env-2',
        execServerUrl: 'wss://exec.agentrelay.test/ticket',
        workspaceCwd: '/workspace',
        expiresAt: '2026-08-23T12:00:00.000Z',
        convergence: convergence({ destinationSha: 'f'.repeat(64) }),
      })
    );

    await expect(client.acquire(input)).rejects.toThrow('non-converged hash/cursor proof');
  });

  it('rejects matching hashes when the destination outbox is not drained', async () => {
    const client = new CloudLiveTeleportClient(async () =>
      Response.json({
        sessionId: 'session-1',
        generation: 2,
        environmentId: 'env-2',
        execServerUrl: 'wss://exec.agentrelay.test/ticket',
        workspaceCwd: '/workspace',
        expiresAt: '2026-08-23T12:00:00.000Z',
        convergence: convergence({ pendingWriteback: 1 }),
      })
    );

    await expect(client.acquire(input)).rejects.toThrow('non-converged hash/cursor proof');
  });

  it('does not echo a Cloud error containing an opaque bridge or provider secret', async () => {
    const client = new CloudLiveTeleportClient(async () =>
      Response.json(
        { error: 'provider rejected https://provider.invalid/?token=opaque-secret-value' },
        { status: 502, statusText: 'Bad Gateway' }
      )
    );

    const error = await client.acquire(input).catch((caught: unknown) => caught);
    expect(String(error)).toContain('Bad Gateway');
    expect(String(error)).not.toContain('opaque-secret-value');
    expect(String(error)).not.toContain('provider.invalid');
  });
});
