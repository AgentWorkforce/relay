import { describe, expect, it, vi } from 'vitest';

import {
  createRelayfileSealLifecycle,
  runRelayfileLifecycleJsonCommand,
  type RelayfileLifecycleCommandRunner,
} from './codex-relayfile-seal.js';

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    sealId: 'cps_123',
    sealToken: 'one-use-opaque-token',
    workspaceId: 'ws_123',
    root: '/',
    sessionId: 'session-1',
    generation: 4,
    digest: `sha256:${'a'.repeat(64)}`,
    workspaceRevision: 'rev_40',
    eventCursor: 'evt_50',
    issuedAt: '2026-08-23T12:00:00.000Z',
    expiresAt: '2026-08-23T12:01:00.000Z',
    ...overrides,
  };
}

function checkpointOutput(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    kind: 'relayfile-checkpoint-seal',
    status: 'sealed',
    workspaceId: 'ws_123',
    localRoot: '/repo',
    sessionId: 'session-1',
    generation: 4,
    receipt: receipt(),
    health: {
      pendingWriteback: 0,
      conflicts: 0,
      outboxPending: 0,
      outboxNeedsAttention: false,
    },
    resumeId: 'lifecycle-4',
    sealedAt: '2026-08-23T12:00:00.000Z',
    ...overrides,
  };
}

function resumeOutput(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    kind: 'relayfile-resume-seal',
    workspaceId: 'ws_123',
    localRoot: '/repo',
    resumeId: 'lifecycle-4',
    status: 'ready',
    resumedAt: '2026-08-23T12:00:10.000Z',
    ...overrides,
  };
}

describe('createRelayfileSealLifecycle', () => {
  it('binds the exact checkpoint command and keeps resumeId out of argv', async () => {
    const runner = vi
      .fn<RelayfileLifecycleCommandRunner>()
      .mockResolvedValueOnce(checkpointOutput())
      .mockResolvedValueOnce(resumeOutput());
    const lifecycle = createRelayfileSealLifecycle({ binary: 'relayfile-test', runner });

    const handle = await lifecycle.checkpointAndSeal({
      sessionId: 'session-1',
      generation: 4,
      threadId: 'thread-1',
      workspaceRoot: '/repo',
      lifecycleId: 'lifecycle-4',
    });

    expect(runner).toHaveBeenNthCalledWith(1, {
      binary: 'relayfile-test',
      args: [
        'mount',
        'checkpoint-seal',
        '--root',
        '/repo',
        '--session',
        'session-1',
        '--generation',
        '4',
        '--lifecycle-id',
        'lifecycle-4',
        '--timeout',
        '30s',
        '--ttl',
        '60s',
        '--json',
      ],
      signal: undefined,
    });
    expect(handle.source).toEqual({ kind: 'relayfile-checkpoint-seal', receipt: receipt() });
    expect(handle.restore).toEqual({
      lifecycleId: 'lifecycle-4',
      resumeId: 'lifecycle-4',
      workspaceId: 'ws_123',
      localRoot: '/repo',
    });

    await handle.resumeLocal();

    const resumeCall = runner.mock.calls[1]![0];
    expect(resumeCall.args).toEqual(['mount', 'resume-seal', '--root', '/repo', '--json']);
    expect(resumeCall.args.join(' ')).not.toContain('lifecycle-4');
    expect(resumeCall.stdin).toBe(`${JSON.stringify({ resumeId: 'lifecycle-4' })}\n`);
  });

  it('uses the same stdin-only resume contract after controller restart', async () => {
    const runner = vi.fn<RelayfileLifecycleCommandRunner>(async () =>
      resumeOutput({ resumeId: 'resume_opaque_123' })
    );
    const lifecycle = createRelayfileSealLifecycle({ runner });

    await lifecycle.resumePersistedLocalMount({
      sessionId: 'session-1',
      generation: 4,
      threadId: 'thread-1',
      workspaceRoot: '/repo',
      lifecycleId: 'lifecycle-4',
      source: { kind: 'relayfile-checkpoint-seal' },
      restore: {
        lifecycleId: 'lifecycle-4',
        resumeId: 'resume_opaque_123',
        workspaceId: 'ws_123',
        localRoot: '/repo',
      },
    });

    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['mount', 'resume-seal', '--root', '/repo', '--json'],
        stdin: `${JSON.stringify({ resumeId: 'resume_opaque_123' })}\n`,
      })
    );
  });

  it('reconciles an in-flight checkpoint from persisted lifecycle intent alone', async () => {
    const runner = vi.fn<RelayfileLifecycleCommandRunner>(async () => resumeOutput());
    const lifecycle = createRelayfileSealLifecycle({ runner });

    await lifecycle.resumePersistedLocalMount({
      sessionId: 'session-1',
      generation: 4,
      threadId: 'thread-1',
      workspaceRoot: '/repo',
      lifecycleId: 'lifecycle-4',
      restore: { lifecycleId: 'lifecycle-4', localRoot: '/repo' },
    });

    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['mount', 'resume-seal', '--root', '/repo', '--json'],
        stdin: `${JSON.stringify({ resumeId: 'lifecycle-4' })}\n`,
      })
    );
  });

  it.each([
    ['wrong local root', checkpointOutput({ localRoot: '/other' })],
    ['wrong session', checkpointOutput({ sessionId: 'session-other' })],
    ['wrong generation', checkpointOutput({ generation: 5 })],
    ['non-logical receipt root', checkpointOutput({ receipt: receipt({ root: '/repo' }) })],
    ['caller-shaped digest', checkpointOutput({ receipt: receipt({ digest: 'caller-says-ok' }) })],
    ['uppercase digest', checkpointOutput({ receipt: receipt({ digest: `sha256:${'A'.repeat(64)}` }) })],
    ['bare revision', checkpointOutput({ receipt: receipt({ workspaceRevision: '40' }) })],
    ['wrong revision namespace', checkpointOutput({ receipt: receipt({ workspaceRevision: 'evt_40' }) })],
    ['bare cursor', checkpointOutput({ receipt: receipt({ eventCursor: '50' }) })],
    ['wrong cursor namespace', checkpointOutput({ receipt: receipt({ eventCursor: 'rev_50' }) })],
    [
      'unsettled health',
      checkpointOutput({
        health: { pendingWriteback: 1, conflicts: 0, outboxPending: 0, outboxNeedsAttention: false },
      }),
    ],
    ['missing one-use token', checkpointOutput({ receipt: receipt({ sealToken: '' }) })],
  ])('fails closed on %s', async (_name, output) => {
    const lifecycle = createRelayfileSealLifecycle({ runner: async () => output });
    await expect(
      lifecycle.checkpointAndSeal({
        sessionId: 'session-1',
        generation: 4,
        threadId: 'thread-1',
        workspaceRoot: '/repo',
        lifecycleId: 'lifecycle-4',
      })
    ).rejects.toThrow(/relayfile|checkpoint/);
  });

  it('rejects a resume response until readiness and identity are exact', async () => {
    const lifecycle = createRelayfileSealLifecycle({
      runner: vi
        .fn<RelayfileLifecycleCommandRunner>()
        .mockResolvedValueOnce(checkpointOutput())
        .mockResolvedValueOnce(resumeOutput({ status: 'warming' })),
    });
    const handle = await lifecycle.checkpointAndSeal({
      sessionId: 'session-1',
      generation: 4,
      threadId: 'thread-1',
      workspaceRoot: '/repo',
      lifecycleId: 'lifecycle-4',
    });
    await expect(handle.resumeLocal()).rejects.toThrow('did not confirm mount readiness');
  });
});

describe('runRelayfileLifecycleJsonCommand', () => {
  it('kills an aborted child and rejects with AbortError', async () => {
    const controller = new AbortController();
    const running = runRelayfileLifecycleJsonCommand({
      binary: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reports only the stable error code and never echoes arbitrary stderr', async () => {
    const error = await runRelayfileLifecycleJsonCommand({
      binary: process.execPath,
      args: [
        '-e',
        "process.stderr.write('secret-value\\nerror: checkpoint_fuse_unsupported: hidden'); process.exit(2)",
      ],
    }).catch((caught: unknown) => caught);

    expect(String(error)).toContain('checkpoint_fuse_unsupported');
    expect(String(error)).not.toContain('secret-value');
    expect(String(error)).not.toContain('hidden');
  });
});
