/**
 * CLI binary resolver — finds the actual binary path for a given agent CLI.
 *
 * Checks PATH first, then falls back to well-known install directories
 * from the CLI registry. Results are memoized.
 */

import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { accessSync, constants as constantsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import type { AgentCli } from './workflows/types.js';
import { getCliDefinition, COMMON_SEARCH_PATHS } from './cli-registry.js';

const execFileAsync = promisify(execFile);

// ── Types ──────────────────────────────────────────────────────────────────

export interface ResolvedCli {
  /** The binary name that was found */
  binary: string;
  /** The full path to the binary */
  path: string;
}

// ── Memoization ────────────────────────────────────────────────────────────

const resolveCache = new Map<string, ResolvedCli>();

/**
 * Clear the resolution cache. Useful for testing or after PATH changes.
 */
export function clearResolveCache(): void {
  resolveCache.clear();
}

// ── Path expansion ─────────────────────────────────────────────────────────

function expandHome(p: string): string {
  if (p.startsWith('~/')) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

// ── Async resolver ─────────────────────────────────────────────────────────

/**
 * Resolve a CLI to its binary path. Checks PATH via `which`, then falls
 * back to well-known install directories from the CLI registry.
 *
 * Results are memoized. Returns `undefined` if the binary cannot be found.
 */
export async function resolveCli(cli: AgentCli): Promise<ResolvedCli | undefined> {
  const cached = resolveCache.get(cli);
  if (cached) return cached;

  const def = getCliDefinition(cli);
  if (!def) return undefined;

  for (const binary of def.binaries) {
    // Try PATH first via `which`
    try {
      const { stdout } = await execFileAsync('which', [binary]);
      const path = stdout.trim();
      if (path) {
        const result: ResolvedCli = { binary, path };
        resolveCache.set(cli, result);
        return result;
      }
    } catch {
      // not in PATH
    }

    // Try well-known install directories (CLI-specific + common)
    const searchDirs = [...(def.searchPaths ?? []), ...COMMON_SEARCH_PATHS];
    const seen = new Set<string>();
    for (const dir of searchDirs) {
      const expanded = expandHome(dir);
      if (seen.has(expanded)) continue;
      seen.add(expanded);

      const candidate = join(expanded, binary);
      try {
        await access(candidate, constants.X_OK);
        const result: ResolvedCli = { binary, path: candidate };
        resolveCache.set(cli, result);
        return result;
      } catch {
        // not found here
      }
    }
  }

  return undefined;
}

// ── Sync resolver (for hot paths that can't be async) ──────────────────────

/**
 * Synchronous version of `resolveCli`. Uses `which` via execFileSync
 * and synchronous fs.accessSync. Prefer the async version when possible.
 */
export function resolveCliSync(cli: AgentCli): ResolvedCli | undefined {
  const cached = resolveCache.get(cli);
  if (cached) return cached;

  const def = getCliDefinition(cli);
  if (!def) return undefined;

  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');

  for (const binary of def.binaries) {
    // Try PATH first via `which`
    try {
      const stdout = execFileSync('which', [binary], { stdio: ['pipe', 'pipe', 'ignore'] });
      const path = stdout.toString().trim();
      if (path) {
        const result: ResolvedCli = { binary, path };
        resolveCache.set(cli, result);
        return result;
      }
    } catch {
      // not in PATH
    }

    // Try well-known install directories
    const searchDirs = [...(def.searchPaths ?? []), ...COMMON_SEARCH_PATHS];
    const seen = new Set<string>();
    for (const dir of searchDirs) {
      const expanded = expandHome(dir);
      if (seen.has(expanded)) continue;
      seen.add(expanded);

      const candidate = join(expanded, binary);
      try {
        accessSync(candidate, constantsSync.X_OK);
        const result: ResolvedCli = { binary, path: candidate };
        resolveCache.set(cli, result);
        return result;
      } catch {
        // not found here
      }
    }
  }

  return undefined;
}
