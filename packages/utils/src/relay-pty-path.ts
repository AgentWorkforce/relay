/**
 * Shared utility for finding the relay-pty binary path.
 *
 * This is used by both:
 * - packages/bridge/src/spawner.ts (AgentSpawner)
 * - packages/wrapper/src/relay-pty-orchestrator.ts (RelayPtyOrchestrator)
 *
 * The search order handles multiple installation scenarios:
 * 1. Development (local Rust build)
 * 2. Local npm install (node_modules/agent-relay)
 * 3. Global npm install via nvm
 * 4. System-wide installs (/usr/local/bin)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Get the platform-specific binary name for the current system.
 * Returns null if the platform is not supported.
 */
function getPlatformBinaryName(): string | null {
  const platform = os.platform();
  const arch = os.arch();

  // Map to supported platforms
  if (platform === 'darwin' && arch === 'arm64') return 'relay-pty-darwin-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'relay-pty-darwin-x64';
  if (platform === 'linux' && arch === 'arm64') return 'relay-pty-linux-arm64';
  if (platform === 'linux' && arch === 'x64') return 'relay-pty-linux-x64';

  return null;
}

/** Cached result of relay-pty binary check */
let cachedBinaryPath: string | null | undefined;
let cacheChecked = false;

/** Store the last search results for debugging */
let lastSearchPaths: string[] = [];

/**
 * Get the paths that were checked in the last binary search.
 * Useful for debugging when the binary is not found.
 */
export function getLastSearchPaths(): string[] {
  return [...lastSearchPaths];
}

/**
 * Find the relay-pty binary.
 *
 * Search order prioritizes platform-specific binaries FIRST because npx doesn't run postinstall.
 * This ensures `npx agent-relay up` works without requiring global installation.
 *
 * Search locations:
 * 1. RELAY_PTY_BINARY environment variable (explicit override)
 * 2. Platform-specific binary in package (works without postinstall)
 * 3. Generic relay-pty binary (created by postinstall)
 * 4. Development builds (local Rust build)
 * 5. System-wide installs (/usr/local/bin)
 * 6. Global npm installs (nvm, Homebrew, pnpm)
 *
 * @param callerDirname - The __dirname of the calling module (needed to resolve relative paths)
 * @returns Path to relay-pty binary, or null if not found
 */
export function findRelayPtyBinary(callerDirname: string): string | null {
  // Check for explicit environment variable override first
  const envOverride = process.env.RELAY_PTY_BINARY;
  if (envOverride && fs.existsSync(envOverride)) {
    lastSearchPaths = [envOverride];
    return envOverride;
  }

  // Get platform-specific binary name (critical for npx where postinstall doesn't run)
  const platformBinary = getPlatformBinaryName();

  // Collect all possible package root locations
  const packageRoots: string[] = [];

  // Find node_modules root from caller path
  // Matches: /path/to/node_modules/@agent-relay/bridge/dist/
  // Or: /path/to/node_modules/agent-relay/dist/src/cli/
  const scopedMatch = callerDirname.match(/^(.+?\/node_modules)\/@agent-relay\//);
  const directMatch = callerDirname.match(/^(.+?\/node_modules\/agent-relay)/);

  if (scopedMatch) {
    // Running from @agent-relay/* package - binary is in sibling agent-relay package
    packageRoots.push(path.join(scopedMatch[1], 'agent-relay'));
  }

  if (directMatch) {
    // Running from agent-relay package directly
    packageRoots.push(directMatch[1]);
  }

  // Development: packages/{package}/dist/ -> project root
  if (!callerDirname.includes('node_modules')) {
    packageRoots.push(path.join(callerDirname, '..', '..', '..'));
  }

  // npx cache locations - npm stores packages here when running via npx
  // The cache path varies by npm version and OS
  if (process.env.HOME) {
    // npm 7+ uses _npx with hash-based directories
    const npxCacheBase = path.join(process.env.HOME, '.npm', '_npx');
    if (fs.existsSync(npxCacheBase)) {
      try {
        const entries = fs.readdirSync(npxCacheBase);
        for (const entry of entries) {
          const npxPackage = path.join(npxCacheBase, entry, 'node_modules', 'agent-relay');
          if (fs.existsSync(npxPackage)) {
            packageRoots.push(npxPackage);
          }
        }
      } catch {
        // Ignore read errors
      }
    }
  }

  // Add cwd-based paths for local installs
  packageRoots.push(path.join(process.cwd(), 'node_modules', 'agent-relay'));

  // Global install locations
  if (process.env.HOME) {
    // nvm global
    packageRoots.push(
      path.join(process.env.HOME, '.nvm', 'versions', 'node', process.version, 'lib', 'node_modules', 'agent-relay')
    );
    // pnpm global
    packageRoots.push(
      path.join(process.env.HOME, '.local', 'share', 'pnpm', 'global', 'node_modules', 'agent-relay')
    );
  }
  // Homebrew npm (macOS)
  packageRoots.push('/usr/local/lib/node_modules/agent-relay');
  packageRoots.push('/opt/homebrew/lib/node_modules/agent-relay');

  // Build candidates list - PRIORITIZE platform-specific binaries
  // This is critical for npx since postinstall doesn't run
  const candidates: string[] = [];

  for (const root of packageRoots) {
    // Platform-specific binary FIRST (works without postinstall)
    if (platformBinary) {
      candidates.push(path.join(root, 'bin', platformBinary));
    }
    // Generic binary (requires postinstall to have run)
    candidates.push(path.join(root, 'bin', 'relay-pty'));
  }

  // Development: local Rust builds
  const devRoot = callerDirname.includes('node_modules')
    ? null
    : path.join(callerDirname, '..', '..', '..');
  if (devRoot) {
    candidates.push(path.join(devRoot, 'relay-pty', 'target', 'release', 'relay-pty'));
    candidates.push(path.join(devRoot, 'relay-pty', 'target', 'debug', 'relay-pty'));
  }
  candidates.push(path.join(process.cwd(), 'relay-pty', 'target', 'release', 'relay-pty'));

  // Docker container (CI tests)
  candidates.push('/app/bin/relay-pty');

  // System-wide installs
  candidates.push('/usr/local/bin/relay-pty');

  // Store search paths for debugging
  lastSearchPaths = candidates;

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Check if relay-pty binary is available (cached).
 * Returns true if the binary exists, false otherwise.
 *
 * @param callerDirname - The __dirname of the calling module
 */
export function hasRelayPtyBinary(callerDirname: string): boolean {
  if (!cacheChecked) {
    cachedBinaryPath = findRelayPtyBinary(callerDirname);
    cacheChecked = true;
  }
  return cachedBinaryPath !== null;
}

/**
 * Get the cached relay-pty binary path.
 * Must call hasRelayPtyBinary() or findRelayPtyBinary() first.
 */
export function getCachedRelayPtyPath(): string | null | undefined {
  return cachedBinaryPath;
}

/**
 * Clear the cached binary path (for testing).
 */
export function clearBinaryCache(): void {
  cachedBinaryPath = undefined;
  cacheChecked = false;
}
