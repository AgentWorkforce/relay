import { EventEmitter } from 'node:events';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CliDetectError,
  INSTALL_DOCS,
  SUPPORTED_CLIS,
  findCli,
  probeVersion,
} from './detect-cli.js';

class FakeChild extends EventEmitter {
  pid = 12345;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  lastSignal: NodeJS.Signals | number | undefined;
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.lastSignal = signal;
    return true;
  }
}

describe('SUPPORTED_CLIS / INSTALL_DOCS', () => {
  it('contains exactly claude, codex, gemini', () => {
    expect([...SUPPORTED_CLIS]).toEqual(['claude', 'codex', 'gemini']);
  });

  it('has an INSTALL_DOCS entry for every supported cli', () => {
    for (const cli of SUPPORTED_CLIS) {
      expect(INSTALL_DOCS[cli]).toMatch(/^https?:\/\//);
    }
  });
});

describe('findCli', () => {
  it('returns the first executable hit on PATH', async () => {
    const accessed: string[] = [];
    const result = await findCli('claude', {
      platform: 'darwin',
      pathEnv: '/a/bin:/b/bin',
      accessExecutable: async (filePath) => {
        accessed.push(filePath);
        if (filePath === path.join('/b/bin', 'claude')) {
          return;
        }
        throw new Error('not found');
      },
      resolveRealPath: (filePath) => filePath.replace('/b/bin', '/real/bin'),
    });
    expect(result.binPath).toBe(path.join('/real/bin', 'claude'));
    expect(accessed[0]).toBe(path.join('/a/bin', 'claude'));
  });

  it('skips non-executable matches', async () => {
    let calls = 0;
    const result = await findCli('codex', {
      platform: 'linux',
      pathEnv: '/x/bin:/y/bin',
      accessExecutable: async (filePath) => {
        calls += 1;
        if (filePath === path.join('/x/bin', 'codex')) {
          const err = new Error('not exec') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
        return;
      },
      resolveRealPath: (filePath) => filePath,
    });
    expect(calls).toBe(2);
    expect(result.binPath).toBe(path.join('/y/bin', 'codex'));
  });

  it('throws NEEDS_CLI_INSTALL with the docs URL when no candidate is found', async () => {
    await expect(
      findCli('gemini', {
        platform: 'linux',
        pathEnv: '/a/bin',
        accessExecutable: async () => {
          throw new Error('absent');
        },
      }),
    ).rejects.toMatchObject({
      code: 'NEEDS_CLI_INSTALL',
      exitCode: 2,
      message: expect.stringMatching(/NEEDS_CLI_INSTALL.*gemini.*not found on PATH/),
    });
    await expect(
      findCli('gemini', {
        platform: 'linux',
        pathEnv: '/a/bin',
        accessExecutable: async () => {
          throw new Error('absent');
        },
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(INSTALL_DOCS.gemini),
    });
  });

  it('falls back to the original path when realpath fails', async () => {
    const result = await findCli('claude', {
      platform: 'linux',
      pathEnv: '/only/bin',
      accessExecutable: async () => undefined,
      resolveRealPath: () => {
        throw new Error('symlink loop');
      },
    });
    expect(result.binPath).toBe(path.join('/only/bin', 'claude'));
  });

  it('uses PATHEXT candidate names on win32', async () => {
    const probed: string[] = [];
    const result = await findCli('codex', {
      platform: 'win32',
      pathEnv: 'C:/x',
      pathExt: '.EXE;.CMD',
      accessExecutable: async (filePath) => {
        probed.push(filePath);
        if (filePath.endsWith('codex.cmd')) {
          return;
        }
        throw new Error('miss');
      },
      resolveRealPath: (filePath) => filePath,
    });
    expect(result.binPath).toContain('codex.cmd');
    expect(probed.some((p) => p.endsWith('codex.exe'))).toBe(true);
  });
});

describe('probeVersion', () => {
  let child: FakeChild;
  let spawnCalls: Array<{ command: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }>;

  const stubSpawn = () => {
    child = new FakeChild();
    spawnCalls = [];
    return ((command: string, args: readonly string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => {
      spawnCalls.push({ command, args, cwd: opts.cwd, env: opts.env });
      return child as unknown as ReturnType<typeof child.kill> extends never ? never : any;
    }) as any;
  };

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('parses semver from stdout', async () => {
    const spawn = stubSpawn();
    const promise = probeVersion('/usr/bin/claude', { spawn, tmpDir: '/tmp' });
    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from('claude version 1.2.3 (commit abcdef)\n'));
      child.emit('close', 0, null);
    });
    const result = await promise;
    expect(result.version).toBe('1.2.3');
    expect(result.raw).toContain('claude version 1.2.3');
    expect(spawnCalls[0]?.args).toEqual(['--version']);
    expect(spawnCalls[0]?.cwd).toBe('/tmp');
    expect(spawnCalls[0]?.env.PATH).toBeDefined();
    expect(Object.keys(spawnCalls[0]?.env ?? {}).every((key) =>
      ['PATH', 'HOME', 'XDG_CONFIG_HOME', 'SystemRoot', 'TEMP', 'TMP'].includes(key),
    )).toBe(true);
  });

  it('stores "unknown" when no semver token is present', async () => {
    const spawn = stubSpawn();
    const promise = probeVersion('/usr/bin/codex', { spawn });
    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from('beta build\n'));
      child.emit('close', 0, null);
    });
    const result = await promise;
    expect(result.version).toBe('unknown');
    expect(result.raw).toBe('beta build\n');
  });

  it('rejects with CLI_VERSION_FAILED on non-zero exit', async () => {
    const spawn = stubSpawn();
    const promise = probeVersion('/usr/bin/gemini', { spawn });
    process.nextTick(() => {
      child.stderr.emit('data', Buffer.from('gemini: error: bad install\n'));
      child.emit('close', 1, null);
    });
    await expect(promise).rejects.toBeInstanceOf(CliDetectError);
    await expect(promise).rejects.toMatchObject({
      code: 'CLI_VERSION_FAILED',
      exitCode: 3,
      message: expect.stringContaining('gemini: error: bad install'),
    });
  });

  it('rejects with CLI_VERSION_FAILED on timeout and sends SIGKILL', async () => {
    vi.useFakeTimers();
    const spawn = stubSpawn();
    const promise = probeVersion('/usr/bin/claude', { spawn, versionTimeoutMs: 25 });
    vi.advanceTimersByTime(30);
    child.emit('close', null, 'SIGKILL');
    await expect(promise).rejects.toMatchObject({
      code: 'CLI_VERSION_FAILED',
      message: expect.stringMatching(/timed out after 25ms/),
    });
    expect(child.killed).toBe(true);
    expect(child.lastSignal).toBe('SIGKILL');
  });

  it('rejects with CLI_VERSION_FAILED if spawn throws synchronously', async () => {
    const spawn = (() => {
      throw new Error('spawn refused');
    }) as any;
    await expect(probeVersion('/usr/bin/claude', { spawn })).rejects.toMatchObject({
      code: 'CLI_VERSION_FAILED',
      exitCode: 3,
      message: expect.stringContaining('spawn refused'),
    });
  });

  it('rejects with CLI_VERSION_FAILED when the child emits an error event', async () => {
    const spawn = stubSpawn();
    const promise = probeVersion('/usr/bin/codex', { spawn });
    process.nextTick(() => {
      child.emit('error', new Error('ENOENT'));
    });
    await expect(promise).rejects.toMatchObject({ code: 'CLI_VERSION_FAILED' });
  });
});
