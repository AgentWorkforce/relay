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
    workspaceRevision: 'rev-40',
    eventCursor: 'evt-50',
    issuedAt: '2026-08-23T12:00:00.000Z',
    expiresAt: '2026-08-23T12:01:00.000Z',
    ...overrides,
  };
}

function checkpointOutput(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    kind: 'relayfile-checkpoint-seal',
    workspaceId: 'ws_123',
    localRoot: '/repo',
    sessionId: 'session-1',
    generation: 4,
    receipt: receipt(),
    resumeId: 'resume_opaque_123',
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
    resumeId: 'resume_opaque_123',
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
      resumeId: 'resume_opaque_123',
      workspaceId: 'ws_123',
      localRoot: '/repo',
    });

    await handle.resumeLocal();

    const resumeCall = runner.mock.calls[1]![0];
    expect(resumeCall.args).toEqual(['mount', 'resume-seal', '--root', '/repo', '--json']);
    expect(resumeCall.args.join(' ')).not.toContain('resume_opaque_123');
    expect(resumeCall.stdin).toBe(`${JSON.stringify({ resumeId: 'resume_opaque_123' })}\n`);
  });

  it('uses the same stdin-only resume contract after controller restart', async () => {
    const runner = vi.fn<RelayfileLifecycleCommandRunner>(async () => resumeOutput());
    const lifecycle = createRelayfileSealLifecycle({ runner });

    await lifecycle.resumePersistedLocalMount({
      sessionId: 'session-1',
      generation: 4,
      threadId: 'thread-1',
      workspaceRoot: '/repo',
      source: { kind: 'relayfile-checkpoint-seal', receipt: receipt() },
      restore: { resumeId: 'resume_opaque_123', workspaceId: 'ws_123', localRoot: '/repo' },
    });

    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['mount', 'resume-seal', '--root', '/repo', '--json'],
        stdin: `${JSON.stringify({ resumeId: 'resume_opaque_123' })}\n`,
      })
    );
  });

  it.each([
    ['wrong local root', checkpointOutput({ localRoot: '/other' })],
    ['wrong session', checkpointOutput({ sessionId: 'session-other' })],
    ['wrong generation', checkpointOutput({ generation: 5 })],
    ['non-logical receipt root', checkpointOutput({ receipt: receipt({ root: '/repo' }) })],
    ['caller-shaped digest', checkpointOutput({ receipt: receipt({ digest: 'caller-says-ok' }) })],
    ['missing one-use token', checkpointOutput({ receipt: receipt({ sealToken: '' }) })],
  ])('fails closed on %s', async (_name, output) => {
    const lifecycle = createRelayfileSealLifecycle({ runner: async () => output });
    await expect(
      lifecycle.checkpointAndSeal({
        sessionId: 'session-1',
        generation: 4,
        threadId: 'thread-1',
        workspaceRoot: '/repo',
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
