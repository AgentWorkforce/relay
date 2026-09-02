import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const COMMAND_TIMEOUT_MS = 60_000;

function assertPathSegment(value, label) {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..') {
    throw new Error(`${label} must be a single safe path segment`);
  }
}

function git(repoRoot, args) {
  const result = spawnSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (${result.status}): ${String(result.stderr || result.stdout).trim()}`
    );
  }
}

export function prepareRunWorktree(repoRoot, workspaceRoot, runId) {
  assertPathSegment(runId, 'runId');
  const worktrees = path.join(workspaceRoot, 'worktrees');
  const worktree = path.join(worktrees, runId);
  mkdirSync(worktrees, { recursive: true });
  git(repoRoot, ['worktree', 'add', '--detach', worktree, 'HEAD']);
  return worktree;
}

export function removeRunWorktree(repoRoot, worktree) {
  if (worktree && existsSync(worktree)) git(repoRoot, ['worktree', 'remove', '--force', worktree]);
  git(repoRoot, ['worktree', 'prune']);
}
