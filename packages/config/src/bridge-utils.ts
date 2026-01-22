/**
 * Bridge Utilities
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

export const execAsync = promisify(exec);

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Parse a cross-project message target
 * Formats:
 *   "project:agent" -> { projectId: "project", agentName: "agent" }
 *   "*:agent" -> { projectId: "*", agentName: "agent" } (all projects)
 *   "project:*" -> { projectId: "project", agentName: "*" } (broadcast in project)
 *   "*:*" -> { projectId: "*", agentName: "*" } (broadcast everywhere)
 */
export function parseTarget(target: string): { projectId: string; agentName: string } | null {
  const parts = target.split(':');
  if (parts.length !== 2) {
    return null;
  }
  return {
    projectId: parts[0],
    agentName: parts[1],
  };
}

/**
 * Escape string for shell
 */
export function escapeForShell(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')
    .replace(/!/g, '\\!');
}

/**
 * Escape string for tmux send-keys
 */
export function escapeForTmux(str: string): string {
  return str
    .replace(/[\r\n]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')
    .replace(/!/g, '\\!');
}
