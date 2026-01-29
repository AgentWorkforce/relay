/**
 * CLI Resolution Utilities
 *
 * Handles mapping and detection of CLI commands for different providers.
 * Cursor has two CLI names: 'agent' (newer) and 'cursor-agent' (older).
 */

import { execSync } from 'node:child_process';
import { createLogger } from '@agent-relay/utils/logger';

const log = createLogger('cli-resolution');

/**
 * Check if a command exists in PATH
 */
export function commandExists(cmd: string): boolean {
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    execSync(`${whichCmd} ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Cache for detected Cursor CLI command
let detectedCursorCli: string | null = null;

/**
 * Reset the Cursor CLI detection cache.
 * Useful for testing.
 */
export function resetCursorCliCache(): void {
  detectedCursorCli = null;
}

/**
 * Detect which Cursor CLI command is available.
 * Newer versions use 'agent', older versions use 'cursor-agent'.
 * Returns null if neither is found.
 */
export function detectCursorCli(): string | null {
  if (detectedCursorCli !== null) {
    return detectedCursorCli;
  }

  // Try newer 'agent' command first
  if (commandExists('agent')) {
    detectedCursorCli = 'agent';
    log.debug('Detected Cursor CLI: agent (newer version)');
    return 'agent';
  }

  // Fall back to older 'cursor-agent' command
  if (commandExists('cursor-agent')) {
    detectedCursorCli = 'cursor-agent';
    log.debug('Detected Cursor CLI: cursor-agent (older version)');
    return 'cursor-agent';
  }

  log.debug('Cursor CLI not found (neither agent nor cursor-agent)');
  return null;
}

/**
 * Resolve CLI command for a provider.
 * For cursor, detects whether 'agent' or 'cursor-agent' is available.
 */
export function resolveCli(rawCommand: string): string {
  const cmdLower = rawCommand.toLowerCase();

  // Handle cursor specially - detect which CLI is installed
  if (cmdLower === 'cursor' || cmdLower === 'cursor-agent') {
    const cursorCli = detectCursorCli();
    if (cursorCli) {
      return cursorCli;
    }
    // Fall back to 'agent' if detection fails (let it fail at spawn time)
    return 'agent';
  }

  // Handle other mappings
  if (cmdLower === 'google') {
    return 'gemini';
  }

  // Return as-is for other commands
  return rawCommand;
}

/**
 * CLI command mapping for providers (kept for reference, resolveCli handles logic)
 * Maps provider names to actual CLI command names
 */
export const CLI_COMMAND_MAP: Record<string, string> = {
  cursor: 'agent', // Cursor CLI installs as 'agent' (newer versions)
  'cursor-agent': 'agent', // Cursor CLI older name, also maps to 'agent'
  google: 'gemini', // Google provider uses 'gemini' CLI
  // Other providers use their name as the command (claude, codex, etc.)
};
