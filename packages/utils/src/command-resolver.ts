/**
 * Command Path Resolver
 *
 * Resolves full paths for CLI commands to avoid posix_spawnp failures
 * when PATH isn't properly inherited in spawned processes.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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
    console.warn(
      `[command-resolver] 'which ${command}' failed:`,
      err.message?.split('\n')[0] || 'unknown error'
    );
  }

  // Return original command - spawn will fail with a clearer error
  return command;
}

/**
 * Resolve symlinks to get the actual file path, preserving shim behaviour.
 *
 * Provider CLIs installed via version managers (mise, asdf, rtx, direnv,
 * pkgx, jenv/pyenv/rbenv/nodenv/tfenv/volta, ...) are exposed as symlinked
 * shims that all point at the manager binary. Those shims dispatch to the
 * real tool based on `argv[0]` (the shim's own basename). If we canonicalise
 * the shim we collapse it to the manager binary (`/opt/homebrew/bin/mise`) —
 * the child then sees `argv[0] = "mise"` and the manager parses
 * provider-specific flags like `--dangerously-bypass-approvals-and-sandbox`
 * as its own arguments, aborting the worker before it can start.
 *
 * Rule: if realpath would change the executable's basename, treat it as a
 * shim and keep the caller-facing path so `argv[0]` stays intact. Otherwise
 * return the canonicalised path (still helps with posix_spawnp on hosts with
 * quirky PATH handling, which is why this helper exists in the first place).
 */
function resolveSymlinks(filePath: string): string {
  try {
    const resolved = fs.realpathSync(filePath);
    if (resolved === filePath) {
      return filePath;
    }
    const originalName = path.basename(filePath);
    const resolvedName = path.basename(resolved);
    if (originalName !== resolvedName) {
      if (process.env.DEBUG_SPAWN === '1') {
        console.log(
          `[command-resolver] Preserving shim ${filePath} (target ${resolved} has a different basename — likely a mise/asdf-style dispatcher)`
        );
      }
      return absolutizeShimPath(filePath);
    }
    if (process.env.DEBUG_SPAWN === '1') {
      console.log(`[command-resolver] Resolved symlink: ${filePath} -> ${resolved}`);
    }
    return resolved;
  } catch (err: any) {
    // If realpath fails, return original (spawn will give clearer error)
    // Only warn in debug mode - this is common and not actionable
    if (process.env.DEBUG_SPAWN === '1') {
      console.warn(`[command-resolver] realpath failed for ${filePath}:`, err.message);
    }
    return filePath;
  }
}

/**
 * Return an absolute path for `filePath` without following the final
 * component's symlink, so `argv[0]` stays as the shim's basename when the
 * child is spawned.
 */
function absolutizeShimPath(filePath: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  try {
    const parent = path.dirname(filePath);
    const canonicalParent = fs.realpathSync(parent === '' ? '.' : parent);
    return path.join(canonicalParent, path.basename(filePath));
  } catch {
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
