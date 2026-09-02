import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const COMMAND_TIMEOUT_MS = 60_000;
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
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
    });
    killer.on('error', () => child.kill('SIGKILL'));
    killer.on('close', (code) => {
      if (code !== 0) child.kill('SIGKILL');
    });
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

function git(repoRoot, args, timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('timeoutMs must be a positive integer');
  }
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
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
      terminateProcessTree(child);
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) {
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
  await git(repoRoot, ['worktree', 'add', '--detach', worktree, 'HEAD'], timeoutMs);
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
