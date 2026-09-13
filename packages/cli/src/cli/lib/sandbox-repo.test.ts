import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resolveSandboxRepository } from './sandbox-repo.js';

function gitMock(): ReturnType<typeof vi.fn> {
  return vi.fn((_command: string, args: readonly string[]) => {
    if (args.includes('--show-toplevel')) return '/checkout\n';
    if (args.includes('get-url')) return 'git@github.com:AgentWorkforce/relay.git\n';
    if (args.includes('HEAD')) return '0123456789abcdef0123456789abcdef01234567\n';
    if (args.includes('status')) return '';
    if (args.includes('@{u}')) return 'origin/main\n';
    if (args.includes('merge-base')) return '';
    throw new Error('unexpected git invocation');
  });
}

describe('resolveSandboxRepository', () => {
  it('returns a public repo, exact revision, and sandbox-relative cwd', () => {
    const result = resolveSandboxRepository('/checkout', '/checkout/packages/cli', {
      execFileSync: gitMock() as never,
    });
    expect(result).toEqual({
      repository: 'AgentWorkforce/relay',
      repositoryName: 'relay',
      revision: '0123456789abcdef0123456789abcdef01234567',
      projectRoot: '/checkout',
      workerCwd: '/srv/agent-workforce/relay/packages/cli',
    });
  });

  it('rejects an arbitrary local cwd outside the checkout', () => {
    expect(() =>
      resolveSandboxRepository('/checkout', '/Users/operator/private', { execFileSync: gitMock() as never })
    ).toThrow(/outside the checked-out repository/);
  });

  it('rejects tracked edits but permits the generated workspace pin', () => {
    const dirty = gitMock();
    dirty.mockImplementation((_command: string, args: readonly string[]) => {
      if (args.includes('status')) return ' M src/index.ts\0?? .agentworkforce/relay/workspace-key.json\0';
      return (gitMock() as never)(_command, args);
    });
    expect(() => resolveSandboxRepository('/checkout', undefined, { execFileSync: dirty as never })).toThrow(
      /clean checkout.*src\/index\.ts/
    );
  });

  it('rejects untracked source files', () => {
    const dirty = gitMock();
    dirty.mockImplementation((_command: string, args: readonly string[]) => {
      if (args.includes('status')) return '?? scratch.ts\0';
      return (gitMock() as never)(_command, args);
    });
    expect(() => resolveSandboxRepository('/checkout', undefined, { execFileSync: dirty as never })).toThrow(
      /clean checkout.*scratch\.ts/
    );
  });

  it('rejects untracked user configuration beside generated relay metadata', () => {
    for (const file of ['.agentworkforce/relay/config.json', '.agentworkforce/relay/teams.json']) {
      const dirty = gitMock();
      dirty.mockImplementation((_command: string, args: readonly string[]) => {
        if (args.includes('status')) return `?? ${file}\0`;
        return (gitMock() as never)(_command, args);
      });
      expect(() =>
        resolveSandboxRepository('/checkout', undefined, { execFileSync: dirty as never })
      ).toThrow(/clean checkout/);
    }
  });

  it('rejects non-HTTPS/SSH GitHub remote URLs', () => {
    const run = gitMock();
    run.mockImplementation((_command: string, args: readonly string[]) => {
      if (args.includes('get-url')) return 'ftp://github.com/AgentWorkforce/relay.git\n';
      return (gitMock() as never)(_command, args);
    });
    expect(() => resolveSandboxRepository('/checkout', undefined, { execFileSync: run as never })).toThrow(
      /GitHub owner\/name/
    );
  });

  it('rejects a branch whose exact HEAD is ahead of its upstream', () => {
    const ahead = gitMock();
    ahead.mockImplementation((_command: string, args: readonly string[]) => {
      if (args.includes('merge-base')) throw new Error('not ancestor');
      return (gitMock() as never)(_command, args);
    });
    expect(() => resolveSandboxRepository('/checkout', undefined, { execFileSync: ahead as never })).toThrow(
      /not pushed/
    );
  });

  it('rejects a Git checkout with no usable origin', () => {
    const run = vi.fn((_command: string, args: readonly string[]) => {
      if (args.includes('--show-toplevel')) return '/checkout\n';
      throw new Error('no origin');
    });
    expect(() => resolveSandboxRepository('/checkout', undefined, { execFileSync: run as never })).toThrow(
      /no usable origin/
    );
  });

  it('falls back only for a confirmed non-Git directory', () => {
    const outside = vi.fn(() => {
      throw { status: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git' };
    });
    expect(
      resolveSandboxRepository('/plain', undefined, { cwd: () => '/plain', execFileSync: outside as never })
    ).toBeUndefined();
    for (const failure of [
      { status: 128, stderr: 'fatal: detected dubious ownership' },
      { code: 'ETIMEDOUT' },
      { code: 'ENOENT' },
    ]) {
      const run = vi.fn(() => {
        throw failure;
      });
      expect(() => resolveSandboxRepository('/checkout', undefined, { execFileSync: run as never })).toThrow(
        /Cannot inspect/
      );
    }
  });

  it('accepts SSH URL origins and does not require an upstream for detached HEAD', () => {
    const run = gitMock();
    run.mockImplementation((command: string, args: readonly string[]) => {
      if (args.includes('get-url')) return 'ssh://git@github.com/AgentWorkforce/relay.git\n';
      if (args.includes('@{u}')) throw new Error('detached');
      return gitMock()(command, args);
    });
    expect(
      resolveSandboxRepository('/checkout', undefined, { cwd: () => '/checkout', execFileSync: run as never })
        ?.repository
    ).toBe('AgentWorkforce/relay');
  });

  it('honors a selected Relay project when the shell is outside Git', () => {
    const run = gitMock();
    run.mockImplementation((command: string, args: readonly string[]) => {
      if (args[1] === '/outside') throw { status: 128, stderr: 'fatal: not a git repository' };
      return gitMock()(command, args);
    });
    expect(
      resolveSandboxRepository('/checkout', undefined, { cwd: () => '/outside', execFileSync: run as never })
    ).toMatchObject({ projectRoot: '/checkout', workerCwd: '/srv/agent-workforce/relay' });
  });

  it('keeps the porcelain XY columns and rejects tracked changes to generated metadata', () => {
    const run = gitMock();
    run.mockImplementation((command: string, args: readonly string[]) => {
      if (args.includes('status')) return ' M .agentworkforce/relay/workspace-key.json\0';
      return gitMock()(command, args);
    });
    expect(() =>
      resolveSandboxRepository('/checkout', undefined, { cwd: () => '/checkout', execFileSync: run as never })
    ).toThrow('".agentworkforce/relay/workspace-key.json"');
    run.mockImplementation((command: string, args: readonly string[]) => {
      if (args.includes('status')) return '?? .agentworkforce/relay/workspace-key.json\0';
      return gitMock()(command, args);
    });
    expect(
      resolveSandboxRepository('/checkout', undefined, { cwd: () => '/checkout', execFileSync: run as never })
        ?.revision
    ).toMatch(/^[a-f0-9]{40}$/);
  });

  it('maps a symlinked nested invocation to the actual Git root and relative directory', () => {
    const realpath = (value: string) => (value === '/linked/packages/cli' ? '/checkout/packages/cli' : value);
    expect(
      resolveSandboxRepository('/linked/packages/cli', undefined, {
        cwd: () => '/linked/packages/cli',
        execFileSync: gitMock() as never,
        realpathSync: realpath as never,
      })
    ).toMatchObject({ projectRoot: '/checkout', workerCwd: '/srv/agent-workforce/relay/packages/cli' });
  });

  it('retains repository inference with an explicit remote cwd override', () => {
    expect(
      resolveSandboxRepository('/checkout', '/workspace/context', {
        cwd: () => '/checkout',
        execFileSync: gitMock() as never,
      })
    ).toMatchObject({ repository: 'AgentWorkforce/relay', workerCwd: '/workspace/context' });
    expect(() =>
      resolveSandboxRepository('/checkout', '/workspace/../../Users/private', {
        cwd: () => '/checkout',
        execFileSync: gitMock() as never,
      })
    ).toThrow(/escapes/);
  });

  it('infers a real nested checkout and refuses dirty or unpushed work', () => {
    const fixture = realpathSync(mkdtempSync(path.join(tmpdir(), 'relay-sandbox-repo-')));
    const checkout = path.join(fixture, 'cloud');
    const remote = path.join(fixture, 'remote.git');
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    };
    const run = ((file: string, args: string[], options: object = {}) =>
      execFileSync(file, args, { ...options, env, timeout: 10_000 })) as typeof execFileSync;
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', checkout, ...args], { env, encoding: 'utf8', timeout: 10_000 }).trim();
    try {
      mkdirSync(checkout);
      git('init', '--initial-branch=main');
      git('config', 'user.name', 'Sandbox Fixture');
      git('config', 'user.email', 'fixture@example.test');
      mkdirSync(path.join(checkout, 'packages', 'web'), { recursive: true });
      writeFileSync(path.join(checkout, 'packages', 'web', 'index.ts'), 'export const version = 1;\n');
      git('add', '.');
      git('-c', 'commit.gpgsign=false', 'commit', '-m', 'initial');
      execFileSync('git', ['init', '--bare', remote], { env, stdio: 'ignore', timeout: 10_000 });
      git('remote', 'add', 'origin', remote);
      git('push', '--set-upstream', 'origin', 'main');
      git('remote', 'set-url', 'origin', 'git@github.com:AgentWorkforce/cloud.git');
      const revision = git('rev-parse', 'HEAD');
      const nested = path.join(checkout, 'packages', 'web');
      const deps = { execFileSync: run, cwd: () => nested };
      expect(resolveSandboxRepository(nested, undefined, deps)).toEqual({
        repository: 'AgentWorkforce/cloud',
        repositoryName: 'cloud',
        revision,
        projectRoot: checkout,
        workerCwd: '/srv/agent-workforce/cloud/packages/web',
      });
      mkdirSync(path.join(checkout, '.agentworkforce', 'relay'), { recursive: true });
      writeFileSync(path.join(checkout, '.agentworkforce', 'relay', 'workspace-key.json'), '{}\n');
      expect(resolveSandboxRepository(nested, undefined, deps)?.revision).toBe(revision);
      writeFileSync(path.join(checkout, 'packages', 'web', 'index.ts'), 'export const version = 2;\n');
      expect(() => resolveSandboxRepository(nested, undefined, deps)).toThrow(
        /clean checkout.*packages\/web\/index.ts/
      );
      git('add', 'packages/web/index.ts');
      git('-c', 'commit.gpgsign=false', 'commit', '-m', 'local only');
      expect(() => resolveSandboxRepository(nested, undefined, deps)).toThrow(/not pushed/);
      git('checkout', '--detach', revision);
      expect(resolveSandboxRepository(nested, undefined, deps)?.revision).toBe(revision);
      expect(
        resolveSandboxRepository(fixture, undefined, { execFileSync: run, cwd: () => fixture })
      ).toBeUndefined();
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
