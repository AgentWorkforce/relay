import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { execGit, GitError, gitEnvironment, refreshRepository } from './repository.js';
import { reportReason } from './store.js';
import {
  agentNameOf,
  FakeGit,
  makeAssignment,
  makeHarness,
  REVISION,
  type Harness,
} from './__tests__/helpers.js';

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), 'chief-bridge-repo-')));

/** Two existing folders, because a refresh checks the folder is the repository's top level. */
function refreshConfig(overrides: Record<string, unknown> = {}) {
  const root = scratch();
  const app = join(root, 'app');
  const other = join(root, 'other');
  mkdirSync(app);
  mkdirSync(other);
  return { refreshRepositories: true, repositories: { 'acme/app': app, 'acme/other': other }, ...overrides };
}

async function assign(h: Harness, overrides = {}) {
  const made = makeAssignment(overrides);
  h.relay.deliverAssignment(made.assignment, made.digest);
  await h.bridge.tick();
  return made;
}

describe('refreshRepository with a scripted git', () => {
  it('fetches, resets to the remote default branch, cleans and returns the commit', async () => {
    const git = new FakeGit();
    const dir = scratch();
    await expect(refreshRepository(git.run, dir)).resolves.toEqual({ revision: REVISION });
    expect(git.commands()).toEqual([
      'rev-parse --show-toplevel',
      'fetch --prune --quiet origin',
      'symbolic-ref --quiet refs/remotes/origin/HEAD',
      'reset --hard --quiet refs/remotes/origin/main',
      'clean -fdx --quiet',
      'rev-parse --verify HEAD^{commit}',
    ]);
    expect(git.calls.every((c) => c.cwd === dir)).toBe(true);
  });

  it('sets the remote HEAD when the clone has none', async () => {
    const git = new FakeGit();
    git.remoteHeadSet = false;
    await refreshRepository(git.run, scratch());
    expect(git.commands()).toContain('remote set-head origin --auto');
    expect(git.commands()).toContain('reset --hard --quiet refs/remotes/origin/main');
  });

  it.each([
    ['fetch', 'repository_fetch_failed'],
    ['reset', 'repository_reset_failed'],
    ['clean', 'repository_clean_failed'],
  ])('reports a failed %s as %s and goes no further', async (step, code) => {
    const git = new FakeGit();
    git.fail.add(step);
    await expect(refreshRepository(git.run, scratch())).rejects.toThrow(new GitError(code));
    expect(git.commands().at(-1)?.startsWith(step)).toBe(true);
  });

  it('refuses a folder that is not the top level of its repository', async () => {
    const dir = scratch();
    const git = new FakeGit();
    const run = git.run;
    await expect(
      refreshRepository(
        async (args, options) => (args[0] === 'rev-parse' ? `${dir}/..\n` : run(args, options)),
        dir
      )
    ).rejects.toThrow(new GitError('repository_not_toplevel'));
  });

  it('refuses a commit that is not a full object name', async () => {
    const git = new FakeGit();
    git.revision = 'not-a-sha';
    await expect(refreshRepository(git.run, scratch())).rejects.toThrow(
      new GitError('repository_revision_failed')
    );
  });

  it('gives git no inherited secrets and no prompt', () => {
    const env = gitEnvironment({
      PATH: '/bin',
      HOME: '/home/svc',
      LANG: 'C.UTF-8',
      CHIEF_BRIDGE_RELAY_TOKEN: 'secret',
      AWS_SECRET_ACCESS_KEY: 'secret',
    });
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/svc', LANG: 'C.UTF-8', GIT_TERMINAL_PROMPT: '0' });
  });

  it('maps a failed reason to spawn_failed for the chief', () => {
    expect(reportReason('repository_refresh_failed')).toBe('spawn_failed');
  });
});

describe('refreshRepository against real repositories on disk', () => {
  const sh = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, env: { ...gitEnvironment(), GIT_CONFIG_NOSYSTEM: '1' } })
      .toString()
      .trim();

  function fixture() {
    const root = scratch();
    const origin = join(root, 'origin.git');
    const seed = join(root, 'seed');
    const work = join(root, 'work');
    sh(root, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
    sh(root, 'init', '--quiet', '--initial-branch=main', seed);
    for (const [key, value] of [
      ['user.email', 'test@example.invalid'],
      ['user.name', 'test'],
      ['commit.gpgsign', 'false'],
    ] as const) {
      sh(seed, 'config', key, value);
    }
    writeFileSync(join(seed, 'a.txt'), 'one\n');
    sh(seed, 'add', '.');
    sh(seed, 'commit', '--quiet', '-m', 'one');
    sh(seed, 'remote', 'add', 'origin', origin);
    sh(seed, 'push', '--quiet', 'origin', 'main');
    sh(root, 'clone', '--quiet', origin, work);
    const first = sh(work, 'rev-parse', 'HEAD');
    // Upstream moves on after the clone, as on the dev node.
    writeFileSync(join(seed, 'a.txt'), 'two\n');
    sh(seed, 'commit', '--quiet', '-am', 'two');
    sh(seed, 'push', '--quiet', 'origin', 'main');
    return { seed, work, first, latest: sh(seed, 'rev-parse', 'HEAD') };
  }

  it('moves a stale clone to the new tip and leaves it pristine', async () => {
    const { work, first, latest } = fixture();
    writeFileSync(join(work, 'a.txt'), 'edited by an agent\n');
    writeFileSync(join(work, 'stray.txt'), 'untracked\n');
    writeFileSync(join(work, '.gitignore'), 'ignored/\n');
    mkdirSync(join(work, 'ignored'));
    writeFileSync(join(work, 'ignored', 'file'), 'x');
    expect(first).not.toBe(latest);
    await expect(refreshRepository(execGit, work)).resolves.toEqual({ revision: latest });
    expect(sh(work, 'status', '--porcelain', '--ignored')).toBe('');
    expect(existsSync(join(work, 'stray.txt'))).toBe(false);
  });

  it('sets origin/HEAD when the clone lacks it', async () => {
    const { work, latest } = fixture();
    sh(work, 'remote', 'set-head', 'origin', '--delete');
    await expect(refreshRepository(execGit, work)).resolves.toEqual({ revision: latest });
  });

  it('fails with a code when origin cannot be reached', async () => {
    const { work } = fixture();
    sh(work, 'remote', 'set-url', 'origin', join(work, 'missing.git'));
    await expect(refreshRepository(execGit, work)).rejects.toThrow(new GitError('repository_fetch_failed'));
  });

  it('refuses a subfolder of a repository', async () => {
    const { work } = fixture();
    mkdirSync(join(work, 'sub'));
    await expect(refreshRepository(execGit, join(work, 'sub'))).rejects.toThrow(
      new GitError('repository_not_toplevel')
    );
    expect(sh(work, 'status', '--porcelain')).toBe('');
  });
});

describe('the bridge with refreshRepositories', () => {
  it('does not touch git when the flag is off', async () => {
    const h = await makeHarness();
    await assign(h);
    expect(h.relay.spawns).toHaveLength(1);
    expect(h.git.calls).toHaveLength(0);
    expect(h.relay.spawns[0]?.task).not.toContain('reset to commit');
  });

  it('refreshes before spawning, records the commit and names it in the task', async () => {
    const h = await makeHarness(refreshConfig());
    await assign(h);
    expect(h.git.commands()).toContain('fetch --prune --quiet origin');
    expect(h.store.task('task-1')?.revision).toBe(REVISION);
    expect(h.relay.spawns).toHaveLength(1);
    expect(h.relay.spawns[0]?.task).toContain(`reset to commit ${REVISION}`);
    expect(h.logs).toContainEqual({
      event: 'repository_refreshed',
      fields: { taskId: 'task-1', revision: REVISION },
    });
  });

  it('fails the task without spawning when the fetch fails', async () => {
    const git = new FakeGit();
    git.fail.add('fetch');
    const h = await makeHarness(refreshConfig({ reportExtensions: true }), { git });
    await assign(h);
    expect(h.relay.invokeCalls).toBe(0);
    expect(h.relay.states()).toEqual(['1:accepted', '2:failed']);
    expect(h.store.task('task-1')?.reason).toBe('repository_refresh_failed');
    expect(h.relay.deliveredReports().at(-1)?.reason).toBe('spawn_failed');
    // Nothing was launched, so no stop is owed.
    expect(h.store.stopPending()).toHaveLength(0);
    expect(git.commands().some((c) => c.startsWith('reset'))).toBe(false);
    expect(h.logs).toContainEqual({
      event: 'repository_refresh_failed',
      fields: { taskId: 'task-1', code: 'repository_fetch_failed' },
    });
  });

  it('repeats an uncertain invoke with the recorded commit and no second refresh', async () => {
    const h = await makeHarness(refreshConfig());
    h.relay.loseNextInvokeResponse = true;
    await assign(h);
    const fetches = () => h.git.commands().filter((c) => c.startsWith('fetch')).length;
    expect(fetches()).toBe(1);
    h.git.revision = 'f'.repeat(40);
    await h.bridge.tick();
    expect(fetches()).toBe(1);
    expect(h.relay.spawns).toHaveLength(1);
    expect(h.relay.spawns[0]?.task).toContain(REVISION);
    expect(h.store.task('task-1')?.state).toBe('running');
  });

  it('never refreshes a folder another task is still using', async () => {
    const h = await makeHarness(refreshConfig());
    await assign(h, { taskId: 'task-a' });
    const second = makeAssignment({ taskId: 'task-b' });
    h.relay.deliverAssignment(second.assignment, second.digest);
    await h.bridge.tick();
    expect(h.git.commands().filter((c) => c.startsWith('fetch'))).toHaveLength(1);
    h.relay.deliver('agent-spawned', agentNameOf(h, 'task-a'), 'CHIEF_RESULT: completed');
    await h.bridge.tick();
    await h.bridge.tick();
    expect(h.git.commands().filter((c) => c.startsWith('fetch'))).toHaveLength(2);
    expect(h.relay.spawns).toHaveLength(2);
  });

  it('never refreshes a folder shared by two repository names while one is in use', async () => {
    const config = refreshConfig();
    const shared = config.repositories['acme/app'];
    const h = await makeHarness({ ...config, repositories: { 'acme/app': shared, 'acme/other': shared } });
    await assign(h, { taskId: 'task-a' });
    await assign(h, { taskId: 'task-b', repository: 'acme/other' });
    expect(h.git.commands().filter((c) => c.startsWith('fetch'))).toHaveLength(1);
    expect(h.relay.spawns).toHaveLength(1);
    expect(h.store.task('task-b')?.state).toBe('queued');
    expect(h.logs).toContainEqual({ event: 'repository_busy', fields: { taskId: 'task-b' } });
  });

  it('does not refresh twice when two passes overlap', async () => {
    const h = await makeHarness(refreshConfig());
    const made = makeAssignment();
    h.relay.deliverAssignment(made.assignment, made.digest);
    h.git.holdNextFetch = true;
    const first = h.bridge.tick();
    // Let the first pass reach its fetch.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await h.bridge.tick();
    h.git.release();
    await first;
    expect(h.git.commands().filter((c) => c.startsWith('fetch'))).toHaveLength(1);
    expect(h.relay.spawns).toHaveLength(1);
  });
});
