/**
 * Shared utility for finding the relay-pty binary path.
 *
 * This is used by both:
 * - packages/bridge/src/spawner.ts (AgentSpawner)
 * - packages/wrapper/src/relay-pty-orchestrator.ts (RelayPtyOrchestrator)
 *
 * Supports all installation scenarios:
 * - npx agent-relay (no postinstall, uses platform-specific binary)
 * - npm install -g agent-relay (nvm, volta, fnm, n, asdf, Homebrew, system)
 * - npm install agent-relay (local project)
 * - pnpm/yarn global
 * - Development (monorepo with Rust builds)
 * - Docker containers
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Supported platforms and their binary names.
 * Windows is not supported (relay-pty requires PTY which doesn't work on Windows).
 */
const SUPPORTED_PLATFORMS: Record<string, Record<string, string>> = {
  darwin: {
    arm64: 'relay-pty-darwin-arm64',
    x64: 'relay-pty-darwin-x64',
  },
  linux: {
    arm64: 'relay-pty-linux-arm64',
    x64: 'relay-pty-linux-x64',
  },
};

/**
 * Get the platform-specific binary name for the current system.
 * Returns null if the platform is not supported.
 */
function getPlatformBinaryName(): string | null {
  const platform = os.platform();
  const arch = os.arch();

  return SUPPORTED_PLATFORMS[platform]?.[arch] ?? null;
}

/**
 * Check if the current platform is supported.
 */
export function isPlatformSupported(): boolean {
  const platform = os.platform();
  const arch = os.arch();
  return SUPPORTED_PLATFORMS[platform]?.[arch] !== undefined;
}

/**
 * Get a human-readable description of supported platforms.
 */
export function getSupportedPlatforms(): string {
  const platforms: string[] = [];
  for (const [os, archs] of Object.entries(SUPPORTED_PLATFORMS)) {
    for (const arch of Object.keys(archs)) {
      platforms.push(`${os}-${arch}`);
    }
  }
  return platforms.join(', ');
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
 * @param callerDirname - The __dirname of the calling module (needed to resolve relative paths)
 * @returns Path to relay-pty binary, or null if not found
 */
export function findRelayPtyBinary(callerDirname: string): string | null {
  // Check for explicit environment variable override first
  const envOverride = process.env.RELAY_PTY_BINARY;
  if (envOverride && isExecutable(envOverride)) {
    lastSearchPaths = [envOverride];
    return envOverride;
  }

  // Get platform-specific binary name (critical for npx where postinstall doesn't run)
  const platformBinary = getPlatformBinaryName();

  // Normalize path separators for cross-platform regex matching
  const normalizedCaller = callerDirname.replace(/\\/g, '/');

  // Collect all possible package root locations
  const packageRoots: string[] = [];

  // Find node_modules root from caller path
  // Matches: /path/to/node_modules/@agent-relay/bridge/dist/
  // Or: /path/to/node_modules/agent-relay/dist/src/cli/
  const scopedMatch = normalizedCaller.match(/^(.+?\/node_modules)\/@agent-relay\//);
  const directMatch = normalizedCaller.match(/^(.+?\/node_modules\/agent-relay)/);

  if (scopedMatch) {
    // Running from @agent-relay/* package - binary is in sibling agent-relay package
    packageRoots.push(path.join(scopedMatch[1], 'agent-relay'));
  }

  if (directMatch) {
    // Running from agent-relay package directly
    packageRoots.push(directMatch[1]);
  }

  // Development: packages/{package}/dist/ -> project root
  if (!normalizedCaller.includes('node_modules')) {
    packageRoots.push(path.join(callerDirname, '..', '..', '..'));
  }

  const home = process.env.HOME || process.env.USERPROFILE || '';

  // npx cache locations - npm stores packages here when running via npx
  if (home) {
    const npxCacheBase = path.join(home, '.npm', '_npx');
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

  // Global install locations - support ALL major Node version managers
  if (home) {
    // nvm (most common)
    packageRoots.push(
      path.join(home, '.nvm', 'versions', 'node', process.version, 'lib', 'node_modules', 'agent-relay')
    );

    // volta (increasingly popular)
    packageRoots.push(
      path.join(home, '.volta', 'tools', 'image', 'packages', 'agent-relay', 'lib', 'node_modules', 'agent-relay')
    );

    // fnm (fast Node manager)
    packageRoots.push(
      path.join(home, '.fnm', 'node-versions', process.version, 'installation', 'lib', 'node_modules', 'agent-relay')
    );

    // n (simple Node version manager)
    packageRoots.push(
      path.join(home, 'n', 'lib', 'node_modules', 'agent-relay')
    );

    // asdf (universal version manager)
    packageRoots.push(
      path.join(home, '.asdf', 'installs', 'nodejs', process.version.replace('v', ''), 'lib', 'node_modules', 'agent-relay')
    );

    // pnpm global
    packageRoots.push(
      path.join(home, '.local', 'share', 'pnpm', 'global', 'node_modules', 'agent-relay')
    );

    // yarn global (yarn 1.x)
    packageRoots.push(
      path.join(home, '.config', 'yarn', 'global', 'node_modules', 'agent-relay')
    );

    // yarn global (alternative location)
    packageRoots.push(
      path.join(home, '.yarn', 'global', 'node_modules', 'agent-relay')
    );
  }

  // Bash installer locations (curl | bash install method)
  // install.sh puts relay-pty at $INSTALL_DIR/bin/ (default: ~/.agent-relay/bin/)
  const bashInstallerDir = process.env.AGENT_RELAY_INSTALL_DIR
    ? path.join(process.env.AGENT_RELAY_INSTALL_DIR, 'bin')
    : home ? path.join(home, '.agent-relay', 'bin') : null;
  const bashInstallerBinDir = process.env.AGENT_RELAY_BIN_DIR
    || (home ? path.join(home, '.local', 'bin') : null);

  // Universal: derive global node_modules from Node's own executable path.
  // This covers ALL Node installations regardless of version manager
  // (nvm, volta, fnm, mise, asdf, n, system, Homebrew, direct download, etc.)
  // Node binary is at <prefix>/bin/node, global modules at <prefix>/lib/node_modules/
  const nodePrefix = path.resolve(path.dirname(process.execPath), '..');
  packageRoots.push(path.join(nodePrefix, 'lib', 'node_modules', 'agent-relay'));

  // Homebrew npm (macOS)
  packageRoots.push('/usr/local/lib/node_modules/agent-relay');
  packageRoots.push('/opt/homebrew/lib/node_modules/agent-relay');

  // Linux system-wide npm
  packageRoots.push('/usr/lib/node_modules/agent-relay');

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
  const devRoot = normalizedCaller.includes('node_modules')
    ? null
    : path.join(callerDirname, '..', '..', '..');
  if (devRoot) {
    candidates.push(path.join(devRoot, 'relay-pty', 'target', 'release', 'relay-pty'));
    candidates.push(path.join(devRoot, 'relay-pty', 'target', 'debug', 'relay-pty'));
  }
  candidates.push(path.join(process.cwd(), 'relay-pty', 'target', 'release', 'relay-pty'));

  // Bash installer paths (curl | bash install method)
  // install.sh downloads relay-pty to ~/.agent-relay/bin/relay-pty
  if (bashInstallerDir) {
    if (platformBinary) {
      candidates.push(path.join(bashInstallerDir, platformBinary));
    }
    candidates.push(path.join(bashInstallerDir, 'relay-pty'));
  }
  // install.sh also uses ~/.local/bin as the BIN_DIR
  if (bashInstallerBinDir) {
    if (platformBinary) {
      candidates.push(path.join(bashInstallerBinDir, platformBinary));
    }
    candidates.push(path.join(bashInstallerBinDir, 'relay-pty'));
  }

  // Docker container (CI tests)
  candidates.push('/app/bin/relay-pty');

  // System-wide installs
  candidates.push('/usr/local/bin/relay-pty');
  candidates.push('/usr/bin/relay-pty');

  // Store search paths for debugging
  lastSearchPaths = candidates;

  for (const candidate of candidates) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Check if a file exists and is executable.
 */
function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    // File doesn't exist or isn't executable
    return false;
  }
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
