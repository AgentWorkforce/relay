import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const COMMAND_TIMEOUT_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const TREE_KILL_TIMEOUT_MS = 5_000;
const MAX_ERROR_OUTPUT = 64 * 1024;

function assertPathSegment(value, label) {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..') {
    throw new Error(`${label} must be a single safe path segment`);
  }
}

function appendBounded(current, chunk) {
  return `${current}${chunk}`.slice(-MAX_ERROR_OUTPUT);
}

function terminateProcessTree(child) {
  if (!child.pid) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(fallback);
        resolve();
      };
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
      });
      const fallback = setTimeout(() => {
        child.kill('SIGKILL');
        finish();
      }, TREE_KILL_TIMEOUT_MS);
      killer.on('error', () => {
        child.kill('SIGKILL');
        finish();
      });
      killer.on('close', (code) => {
        if (code !== 0) child.kill('SIGKILL');
        finish();
      });
    });
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
  return Promise.resolve();
}

function git(repoRoot, args, timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`timeoutMs must be an integer between 1 and ${MAX_TIMER_DELAY_MS}`);
  }
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let termination = Promise.resolve();
    let settled = false;
    const child = spawn('git', ['-C', repoRoot, ...args], {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      termination = terminateProcessTree(child);
      void termination.then(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`git ${args.join(' ')} timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on('close', async (code, signal) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      if (timedOut) {
        await termination;
        reject(new Error(`git ${args.join(' ')} timed out after ${timeoutMs}ms`));
      } else if (code !== 0) {
        reject(
          new Error(
            `git ${args.join(' ')} failed (${code ?? signal ?? 'unknown'}): ${String(
              stderr || stdout
            ).trim()}`
          )
        );
      } else {
        resolve();
      }
    });
  });
}

export async function prepareRunWorktree(
  repoRoot,
  workspaceRoot,
  runId,
  { timeoutMs = COMMAND_TIMEOUT_MS } = {}
) {
  assertPathSegment(runId, 'runId');
  const worktrees = path.join(workspaceRoot, 'worktrees');
  const worktree = path.join(worktrees, runId);
  mkdirSync(worktrees, { recursive: true });
  try {
    await git(repoRoot, ['worktree', 'add', '--detach', worktree, 'HEAD'], timeoutMs);
  } catch (error) {
    // `git worktree add` may create both a directory and administrative entry
    // before checkout/filter failure. Clean both so a retry with this run ID
    // does not collide with state from the failed attempt.
    try {
      await git(repoRoot, ['worktree', 'remove', '--force', '--force', worktree], timeoutMs);
    } catch {
      rmSync(worktree, { recursive: true, force: true });
    }
    try {
      await git(repoRoot, ['worktree', 'prune'], timeoutMs);
    } catch {
      // Preserve the original add failure; the exact worktree directory is gone.
    }
    throw error;
  }
  return worktree;
}

export async function removeRunWorktree(repoRoot, worktree, { timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  try {
    if (worktree && existsSync(worktree)) {
      await git(repoRoot, ['worktree', 'remove', '--force', worktree], timeoutMs);
    }
  } finally {
    await git(repoRoot, ['worktree', 'prune'], timeoutMs);
  }
}
