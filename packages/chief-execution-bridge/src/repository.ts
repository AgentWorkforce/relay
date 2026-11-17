import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';

/** A git failure. Carries a short code only: never stderr, which can quote a remote URL. */
export class GitError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'GitError';
  }
}

/**
 * Runs one git command and resolves with its stdout, or rejects with a {@link GitError}
 * of `git_timeout`, `git_unavailable` or `git_exit`.
 */
export type GitRunner = (args: string[], options: { cwd: string; timeoutMs: number }) => Promise<string>;

const FETCH_TIMEOUT_MS = 120_000;
const LOCAL_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const REMOTE_HEAD_PREFIX = 'refs/remotes/origin/';
const REVISION = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * Overrides for settings a spawned agent could have planted in the checkout's own
 * `.git/config` or hooks to run a command when the bridge next touches the repository.
 */
const SAFE_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];

/**
 * The environment git runs with: nothing inherited but what git needs to find itself and the
 * service user's own git configuration and credentials. Never the bridge's token.
 */
export function gitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0' };
  for (const name of ['PATH', 'HOME', 'LANG'] as const) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  return env;
}

/** The real runner: `git` through execFile, no shell, a timeout and {@link gitEnvironment}. */
export const execGit: GitRunner = (args, { cwd, timeoutMs }) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      [...SAFE_CONFIG, ...args],
      { cwd, env: gitEnvironment(), timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
      (error, stdout) => {
        if (!error) {
          resolve(String(stdout));
          return;
        }
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
        if (failure.code === 'ENOENT') reject(new GitError('git_unavailable'));
        else if (failure.killed || failure.signal) reject(new GitError('git_timeout'));
        else reject(new GitError('git_exit'));
      }
    );
  });

/**
 * Brings a checkout to the tip of its remote's default branch and leaves nothing else in it.
 *
 * The working tree is reset and every untracked and ignored file removed, so the checkout
 * must be one the bridge owns: nothing outside a task may keep work in it.
 * @param run The git runner.
 * @param directory The configured working folder, which must be the repository's top level.
 * @returns The commit the checkout now holds.
 * @throws GitError with a `repository_*` code naming the step that failed, or `git_timeout`
 *   or `git_unavailable`.
 */
export async function refreshRepository(run: GitRunner, directory: string): Promise<{ revision: string }> {
  const git = async (step: string, args: string[], timeoutMs = LOCAL_TIMEOUT_MS) => {
    try {
      return (await run(args, { cwd: directory, timeoutMs })).trim();
    } catch (error) {
      const code = error instanceof GitError ? error.code : 'git_exit';
      throw new GitError(code === 'git_exit' ? `repository_${step}_failed` : code);
    }
  };
  // Resetting and cleaning act on the whole repository, so the folder must be its top level.
  // A folder that is only inside some other repository would otherwise wipe that one.
  const [toplevel, expected] = await Promise.all([
    git('toplevel', ['rev-parse', '--show-toplevel']),
    realpath(directory).catch(() => undefined),
  ]);
  if (!expected || (await realpath(toplevel).catch(() => undefined)) !== expected) {
    throw new GitError('repository_not_toplevel');
  }
  await git('fetch', ['fetch', '--prune', '--quiet', 'origin'], FETCH_TIMEOUT_MS);
  const remoteHead = async () => {
    const ref = await git('default_branch', ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    if (!ref.startsWith(REMOTE_HEAD_PREFIX) || ref.length === REMOTE_HEAD_PREFIX.length) {
      throw new GitError('repository_default_branch_failed');
    }
    return ref;
  };
  let ref: string;
  try {
    ref = await remoteHead();
  } catch {
    // A clone made without a remote HEAD, or one whose default branch was renamed.
    await git('default_branch', ['remote', 'set-head', 'origin', '--auto'], FETCH_TIMEOUT_MS);
    ref = await remoteHead();
  }
  await git('reset', ['reset', '--hard', '--quiet', ref]);
  await git('clean', ['clean', '-fdx', '--quiet']);
  const revision = await git('revision', ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!REVISION.test(revision)) throw new GitError('repository_revision_failed');
  return { revision };
}
