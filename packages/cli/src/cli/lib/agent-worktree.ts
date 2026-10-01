import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Per-agent git worktrees: every agent spawned with `--worktree` edits its own
 * checkout on its own branch (`relay/<name>`), so parallel agents never write
 * over each other's files. `diff` shows what one agent changed and `merge`
 * brings that branch into the main checkout, surfacing same-line edits as
 * ordinary git conflicts instead of silent overwrites.
 */

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (args: string[], cwd: string, env?: NodeJS.ProcessEnv) => GitResult;

export const defaultGitRunner: GitRunner = (args, cwd, env) => {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new Error(`Could not run git: ${result.error.message}`);
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

/** Where agent checkouts live, relative to the main checkout. */
export const WORKTREES_DIR = path.join('.agentworkforce', 'relay', 'worktrees');

const BRANCH_PREFIX = 'relay/';
/**
 * Relay's own state (connection files, workspace keys) lives in .agentworkforce/
 * and must never be counted as, or committed with, an agent's work.
 */
const WORK_PATHSPEC = ['--', '.', ':(exclude).agentworkforce'];
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface AgentWorktree {
  /** The main checkout the agent branch merges back into. */
  root: string;
  /** The agent's own checkout. */
  path: string;
  branch: string;
}

export function agentBranch(name: string): string {
  return `${BRANCH_PREFIX}${name}`;
}

/** Reject names that cannot be both a directory and a git branch. */
export function validateWorktreeAgentName(name: string): void {
  if (!NAME_PATTERN.test(name) || name.includes('..') || name.endsWith('.lock') || name.endsWith('.')) {
    throw new Error(
      `Agent name "${name}" can't be used with --worktree. Use letters, numbers, ".", "_" or "-" (for example --name auth-fix).`
    );
  }
}

function git(runner: GitRunner, args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  const result = runner(args, cwd, env);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

function succeeds(runner: GitRunner, args: string[], cwd: string): boolean {
  return runner(args, cwd).status === 0;
}

interface WorktreeEntry {
  path: string;
  branch?: string;
}

function listWorktrees(runner: GitRunner, cwd: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  for (const block of git(runner, ['worktree', 'list', '--porcelain'], cwd).split('\n\n')) {
    const lines = block.split('\n');
    const pathLine = lines.find((line) => line.startsWith('worktree '));
    if (!pathLine) continue;
    const branchLine = lines.find((line) => line.startsWith('branch '));
    entries.push({
      path: pathLine.slice('worktree '.length),
      branch: branchLine?.slice('branch refs/heads/'.length),
    });
  }
  return entries;
}

/**
 * Resolve the main checkout for `cwd`. Commands run from inside an agent's
 * worktree still act on the main checkout, which git always lists first.
 */
export function resolveMainCheckout(cwd: string, runner: GitRunner = defaultGitRunner): string {
  const probe = runner(['rev-parse', '--show-toplevel'], cwd);
  if (probe.status !== 0) {
    throw new Error(`${cwd} is not inside a git repository. --worktree needs a git repository.`);
  }
  const main = listWorktrees(runner, cwd)[0];
  if (!main) throw new Error('git did not report a main checkout for this repository.');
  return main.path;
}

/** Find the worktree an agent was spawned into, or undefined when it has none. */
export function findAgentWorktree(
  cwd: string,
  name: string,
  runner: GitRunner = defaultGitRunner
): AgentWorktree | undefined {
  if (runner(['rev-parse', '--show-toplevel'], cwd).status !== 0) return undefined;
  const entries = listWorktrees(runner, cwd);
  const root = entries[0]?.path;
  if (!root) return undefined;
  const branch = agentBranch(name);
  const entry = entries.slice(1).find((candidate) => candidate.branch === branch);
  return entry ? { root, path: entry.path, branch } : undefined;
}

function requireAgentWorktree(cwd: string, name: string, runner: GitRunner): AgentWorktree {
  const worktree = findAgentWorktree(cwd, name, runner);
  if (!worktree) {
    throw new Error(
      `Agent "${name}" has no worktree in this repository. Only agents spawned with --worktree have one.`
    );
  }
  return worktree;
}

export interface CreatedWorktree extends AgentWorktree {
  /** False when an existing checkout for this agent was reused. */
  created: boolean;
  /** True when the main checkout has uncommitted changes the agent will not see. */
  mainCheckoutDirty: boolean;
}

/**
 * Give an agent its own checkout on branch `relay/<name>`, starting from the
 * main checkout's current commit. Re-spawning an agent with the same name
 * reuses its checkout so unmerged work is never thrown away.
 */
export function createAgentWorktree(
  cwd: string,
  name: string,
  runner: GitRunner = defaultGitRunner
): CreatedWorktree {
  validateWorktreeAgentName(name);
  const root = resolveMainCheckout(cwd, runner);
  if (!succeeds(runner, ['rev-parse', '--verify', '-q', 'HEAD'], root)) {
    throw new Error('This repository has no commits yet. Make a first commit before using --worktree.');
  }
  const mainCheckoutDirty = git(runner, ['status', '--porcelain', ...WORK_PATHSPEC], root).trim().length > 0;

  const existing = findAgentWorktree(root, name, runner);
  if (existing) return { ...existing, created: false, mainCheckoutDirty };

  const dir = path.join(root, WORKTREES_DIR);
  mkdirSync(dir, { recursive: true });
  // Keep agent checkouts out of `git status` even in repos that do not ignore
  // .agentworkforce/ — `*` also ignores this file, so the directory vanishes.
  const ignoreFile = path.join(dir, '.gitignore');
  if (!existsSync(ignoreFile)) writeFileSync(ignoreFile, '*\n');

  const worktreePath = path.join(dir, name);
  if (existsSync(worktreePath)) {
    throw new Error(
      `${worktreePath} already exists but is not a git worktree. Remove it or pick another --name.`
    );
  }
  const branch = agentBranch(name);
  const branchExists = succeeds(runner, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], root);
  git(
    runner,
    branchExists
      ? ['worktree', 'add', worktreePath, branch]
      : ['worktree', 'add', '-b', branch, worktreePath, 'HEAD'],
    root
  );
  return { root, path: worktreePath, branch, created: true, mainCheckoutDirty };
}

/** Remove a worktree this process just created (used when the spawn itself fails). */
export function removeFreshWorktree(worktree: AgentWorktree, runner: GitRunner = defaultGitRunner): void {
  runner(['worktree', 'remove', '--force', worktree.path], worktree.root);
  runner(['branch', '-D', worktree.branch], worktree.root);
}

/** The commit the agent's branch started from, relative to the main checkout. */
function mergeBase(runner: GitRunner, worktree: AgentWorktree): string {
  return git(runner, ['merge-base', 'HEAD', worktree.branch], worktree.root).trim();
}

/**
 * Show everything the agent changed since its branch left the main checkout:
 * commits, uncommitted edits and new files. New files are staged into a
 * throwaway index so the agent's real index is never touched.
 */
export function diffAgentWorktree(
  cwd: string,
  name: string,
  options: { stat?: boolean; color?: boolean } = {},
  runner: GitRunner = defaultGitRunner
): string {
  const worktree = requireAgentWorktree(cwd, name, runner);
  const base = mergeBase(runner, worktree);
  const tempDir = mkdtempSync(path.join(tmpdir(), 'relay-worktree-diff-'));
  try {
    const indexPath = path.join(tempDir, 'index');
    const realIndex = path.resolve(
      worktree.path,
      git(runner, ['rev-parse', '--git-path', 'index'], worktree.path).trim()
    );
    if (existsSync(realIndex)) copyFileSync(realIndex, indexPath);
    const env = { GIT_INDEX_FILE: indexPath };
    git(runner, ['add', '-A', ...WORK_PATHSPEC], worktree.path, env);
    return git(
      runner,
      [
        'diff',
        '--cached',
        options.color ? '--color=always' : '--no-color',
        ...(options.stat ? ['--stat'] : []),
        base,
      ],
      worktree.path,
      env
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/** Commit the agent's uncommitted edits to its branch, authored by the agent. */
function commitPendingWork(runner: GitRunner, worktree: AgentWorktree, name: string): boolean {
  if (git(runner, ['status', '--porcelain', ...WORK_PATHSPEC], worktree.path).trim().length === 0)
    return false;
  git(runner, ['add', '-A', ...WORK_PATHSPEC], worktree.path);
  // Fall back to a committer identity when the user never configured one, so
  // a missing `user.email` does not strand the agent's work.
  const hasIdentity = succeeds(runner, ['config', 'user.email'], worktree.path);
  git(
    runner,
    [
      ...(hasIdentity ? [] : ['-c', 'user.name=agent-relay', '-c', 'user.email=agent-relay@localhost']),
      'commit',
      '--no-verify',
      '--author',
      `${name} (relay agent) <${name}@agent-relay.local>`,
      '-m',
      `${name}: work from relay agent`,
    ],
    worktree.path
  );
  return true;
}

export type MergeResult =
  | { status: 'merged'; branch: string; root: string; committedPending: boolean; files: string[] }
  | { status: 'nothing-to-merge'; branch: string; root: string }
  | { status: 'conflict'; branch: string; root: string; committedPending: boolean; conflicts: string[] };

/**
 * Merge an agent's branch into whatever branch the main checkout has checked
 * out. Uncommitted agent edits are committed first so nothing is left behind.
 * Conflicts are left in place, exactly like `git merge`, for a person or a
 * resolver agent to settle.
 */
export function mergeAgentWorktree(
  cwd: string,
  name: string,
  runner: GitRunner = defaultGitRunner
): MergeResult {
  const worktree = requireAgentWorktree(cwd, name, runner);
  const { root, branch } = worktree;
  const inProgress = runner(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], root);
  if (inProgress.status === 0) {
    // Re-running `merge <name>` on this agent's own paused merge (typically to
    // add --resolve) picks it back up instead of forcing an abort and redo.
    const branchTip = git(runner, ['rev-parse', branch], root).trim();
    const conflicts = git(runner, ['diff', '--name-only', '--diff-filter=U'], root)
      .split('\n')
      .filter(Boolean);
    if (inProgress.stdout.trim() === branchTip && conflicts.length > 0) {
      return { status: 'conflict', branch, root, committedPending: false, conflicts };
    }
    throw new Error(
      `${root} is already in the middle of a merge. Finish it (git commit) or cancel it (git merge --abort) first.`
    );
  }
  const committedPending = commitPendingWork(runner, worktree, name);
  if (succeeds(runner, ['merge-base', '--is-ancestor', branch, 'HEAD'], root)) {
    return { status: 'nothing-to-merge', branch, root };
  }
  const files = git(runner, ['diff', '--name-only', `HEAD...${branch}`], root)
    .split('\n')
    .filter(Boolean);
  const merge = runner(
    ['merge', '--no-ff', '--no-edit', '-m', `Merge work from relay agent ${name} (${branch})`, branch],
    root
  );
  if (merge.status === 0) return { status: 'merged', branch, root, committedPending, files };

  const conflicts = git(runner, ['diff', '--name-only', '--diff-filter=U'], root).split('\n').filter(Boolean);
  if (conflicts.length > 0) return { status: 'conflict', branch, root, committedPending, conflicts };
  const detail = (merge.stderr || merge.stdout).trim();
  const blocked = detail.match(/would be overwritten by merge:\n((?:\s+\S.*\n?)+)/);
  if (blocked) {
    const blockedFiles = blocked[1]!
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    throw new Error(
      `Can't merge ${name} yet: you have uncommitted changes to files it also changed:\n` +
        blockedFiles.map((file) => `  ${file}`).join('\n') +
        `\nCommit them, or set them aside with \`git stash\` (and \`git stash pop\` after), then run the merge again.`
    );
  }
  throw new Error(`git merge failed${detail ? `:\n${detail}` : ''}`);
}

export type CleanupResult =
  | { status: 'removed'; path: string }
  | { status: 'kept'; path: string; reason: 'uncommitted' | 'unmerged' };

/**
 * After an agent is released, delete its checkout and branch when nothing
 * would be lost: no uncommitted edits and every commit already merged. With
 * `discard`, delete regardless.
 */
export function cleanupAgentWorktree(
  worktree: AgentWorktree,
  options: { discard?: boolean } = {},
  runner: GitRunner = defaultGitRunner
): CleanupResult {
  if (!options.discard) {
    if (git(runner, ['status', '--porcelain', ...WORK_PATHSPEC], worktree.path).trim().length > 0) {
      return { status: 'kept', path: worktree.path, reason: 'uncommitted' };
    }
    if (!succeeds(runner, ['merge-base', '--is-ancestor', worktree.branch, 'HEAD'], worktree.root)) {
      return { status: 'kept', path: worktree.path, reason: 'unmerged' };
    }
  }
  git(runner, ['worktree', 'remove', '--force', worktree.path], worktree.root);
  git(runner, ['branch', '-D', worktree.branch], worktree.root);
  return { status: 'removed', path: worktree.path };
}
