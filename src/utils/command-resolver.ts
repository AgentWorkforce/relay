/**
 * Command Path Resolver
 *
 * Resolves full paths for CLI commands to avoid posix_spawnp failures
 * when PATH isn't properly inherited in spawned processes.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * Resolve the full path of a command using 'which' and resolve any symlinks
 * Returns the full path if found, or the original command if not found
 * (letting the spawn fail with a clearer error)
 */
export function resolveCommand(command: string): string {
  // If already an absolute path, just resolve symlinks
  if (command.startsWith('/')) {
    return resolveSymlinks(command);
  }

  try {
    const output = execSync(`which ${command}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      // Ensure we have a reasonable PATH
      env: {
        ...process.env,
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin',
      },
    });
    const resolvedPath = output.trim();
    if (resolvedPath) {
      // Resolve any symlinks to get the actual binary path
      // This fixes posix_spawnp issues with symlinked binaries
      return resolveSymlinks(resolvedPath);
    }
  } catch (err: any) {
    // Command not found in PATH - log for debugging
    console.warn(`[command-resolver] 'which ${command}' failed:`, err.message?.split('\n')[0] || 'unknown error');
  }

  // Return original command - spawn will fail with a clearer error
  return command;
}

/**
 * Resolve symlinks to get the actual file path
 * Uses fs.realpathSync which handles all symlink levels
 */
function resolveSymlinks(filePath: string): string {
  try {
    const resolved = fs.realpathSync(filePath);
    if (resolved !== filePath) {
      console.log(`[command-resolver] Resolved symlink: ${filePath} -> ${resolved}`);
    }
    return resolved;
  } catch (err: any) {
    // If realpath fails, return original (spawn will give clearer error)
    console.warn(`[command-resolver] realpath failed for ${filePath}:`, err.message);
    return filePath;
  }
}

/**
 * Check if a command exists in PATH
 */
export function commandExists(command: string): boolean {
  try {
    execSync(`which ${command}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}
