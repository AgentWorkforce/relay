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
