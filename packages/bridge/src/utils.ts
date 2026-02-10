import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { getProjectPaths } from '@agent-relay/config/project-namespace';

export const execAsync = promisify(exec);

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Minimal generateId helper to avoid pulling wrapper
export function generateId(): string {
  return crypto.randomUUID();
}

export function resolvePath(p: string): string {
  if (p.startsWith('~')) {
    p = path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

export function getDefaultLeadName(projectPath: string): string {
  const dirname = path.basename(projectPath);
  return dirname.charAt(0).toUpperCase() + dirname.slice(1);
}

export function getProjectPathsSafe(projectPath: string) {
  return getProjectPaths(projectPath);
}

export function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

export function parseTarget(target: string): { projectId: string; agentName: string } | null {
  const parts = target.split(':');
  if (parts.length !== 2) return null;
  return { projectId: parts[0], agentName: parts[1] };
}

export function escapeForShell(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\\$')
    .replace(/`/g, '\\`')
    .replace(/!/g, '\\!');
}

export function escapeForTmux(str: string): string {
  return str
    .replace(/[\r\n]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\\$')
    .replace(/`/g, '\\`')
    .replace(/!/g, '\\!');
}

/**
 * Resolve the working directory for a spawned agent.
 *
 * Determines the workspace root (the directory containing repos), then resolves
 * CWD relative to it. Two cases:
 *
 * 1. projectRoot IS a git repo (e.g., /data/repos/relay has .git)
 *    → workspace root = parent dir (/data/repos)
 *    → CWD: "relaycast" resolves to /data/repos/relaycast
 *
 * 2. projectRoot is NOT a git repo (e.g., /data/repos — the workspace root itself)
 *    → workspace root = projectRoot (/data/repos)
 *    → CWD: "relaycast" resolves to /data/repos/relaycast
 *
 * Returns { cwd: string } on success, or { error: string } if the path escapes
 * the workspace root (traversal protection).
 *
 * When no cwd is provided, returns projectRoot as the default.
 */
export function resolveAgentCwd(
  projectRoot: string,
  cwd?: string | null,
): { cwd: string } | { error: string } {
  if (!cwd || typeof cwd !== 'string') {
    return { cwd: projectRoot };
  }

  // Determine workspace root: if projectRoot is a git repo, its parent contains
  // sibling repos. Otherwise projectRoot is already the workspace root.
  const isRepo = fs.existsSync(path.join(projectRoot, '.git'));
  const workspaceRoot = isRepo ? path.dirname(projectRoot) : projectRoot;

  const resolvedCwd = path.resolve(workspaceRoot, cwd);
  const normalizedRoot = path.resolve(workspaceRoot);
  const rootWithSep = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : normalizedRoot + path.sep;

  // Ensure the resolved cwd is within the workspace root to prevent traversal
  if (resolvedCwd !== normalizedRoot && !resolvedCwd.startsWith(rootWithSep)) {
    return { error: `Invalid cwd: "${cwd}" must be within the workspace root` };
  }

  return { cwd: resolvedCwd };
}
