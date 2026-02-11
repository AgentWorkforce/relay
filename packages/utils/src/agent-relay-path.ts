/**
 * Shared utility for finding the agent-relay binary path.
 *
 * This is used by both:
 * - packages/bridge/src/spawner.ts (AgentSpawner)
 * - packages/wrapper/src/relay-broker-orchestrator.ts (RelayBrokerOrchestrator)
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
 * Windows is not supported (agent-relay requires PTY which doesn't work on Windows).
 */
const SUPPORTED_PLATFORMS: Record<string, Record<string, string>> = {
  darwin: {
    arm64: 'agent-relay-darwin-arm64',
    x64: 'agent-relay-darwin-x64',
  },
  linux: {
    arm64: 'agent-relay-linux-arm64',
    x64: 'agent-relay-linux-x64',
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

/** Cached result of agent-relay binary check */
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
 * Find the agent-relay binary.
 *
 * Search order prioritizes platform-specific binaries FIRST because npx doesn't run postinstall.
 * This ensures `npx agent-relay up` works without requiring global installation.
 *
 * @param callerDirname - The __dirname of the calling module (needed to resolve relative paths)
 * @returns Path to agent-relay binary, or null if not found
 */
export function findAgentRelayBinary(callerDirname: string): string | null {
  // Check for explicit environment variable override first
  const envOverride = process.env.AGENT_RELAY_BINARY;
  if (envOverride && isExecutable(envOverride) && isPlatformCompatibleBinary(envOverride)) {
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
  // install.sh puts agent-relay at $INSTALL_DIR/bin/ (default: ~/.agent-relay/bin/)
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
    candidates.push(path.join(root, 'bin', 'agent-relay'));
  }

  // Development: local Rust builds
  const devRoot = normalizedCaller.includes('node_modules')
    ? null
    : path.join(callerDirname, '..', '..', '..');
  if (devRoot) {
    candidates.push(path.join(devRoot, 'relay-broker', 'target', 'release', 'agent-relay'));
    candidates.push(path.join(devRoot, 'relay-broker', 'target', 'debug', 'agent-relay'));
  }
  candidates.push(path.join(process.cwd(), 'relay-broker', 'target', 'release', 'agent-relay'));

  // Bash installer paths (curl | bash install method)
  // install.sh downloads agent-relay to ~/.agent-relay/bin/agent-relay
  if (bashInstallerDir) {
    if (platformBinary) {
      candidates.push(path.join(bashInstallerDir, platformBinary));
    }
    candidates.push(path.join(bashInstallerDir, 'agent-relay'));
  }
  // install.sh also uses ~/.local/bin as the BIN_DIR
  if (bashInstallerBinDir) {
    if (platformBinary) {
      candidates.push(path.join(bashInstallerBinDir, platformBinary));
    }
    candidates.push(path.join(bashInstallerBinDir, 'agent-relay'));
  }

  // Docker container (CI tests)
  candidates.push('/app/bin/agent-relay');

  // System-wide installs
  candidates.push('/usr/local/bin/agent-relay');
  candidates.push('/usr/bin/agent-relay');

  // Store search paths for debugging
  lastSearchPaths = candidates;

  for (const candidate of candidates) {
    if (isExecutable(candidate) && isPlatformCompatibleBinary(candidate)) {
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
 * Check if a binary is compatible with the current platform by reading its magic bytes.
 * Prevents using a macOS binary on Linux or vice versa, which would fail at runtime
 * with cryptic errors like "Syntax error: word unexpected".
 */
function isPlatformCompatibleBinary(filePath: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, header, 0, 4, 0);
    if (bytesRead < 4) {
      return false; // Too small to be a valid binary
    }

    const magic = header.readUInt32BE(0);
    const platform = os.platform();

    if (platform === 'darwin') {
      return isMachOBinary(magic);
    }
    if (platform === 'linux') {
      // ELF magic: 0x7f 'E' 'L' 'F'
      return magic === 0x7f454c46;
    }

    // Unknown platform — don't block
    return true;
  } catch {
    // Can't read file (e.g. execute-only permissions) — let execution attempt proceed
    return true;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore close errors */ }
    }
  }
}

/**
 * Check if a magic value corresponds to any valid Mach-O format.
 * Handles all variants: 32/64-bit, native/byte-swapped, and fat/universal.
 */
function isMachOBinary(magic: number): boolean {
  return (
    magic === 0xcffaedfe || // MH_CIGAM_64 — 64-bit, byte-swapped (arm64/x64 LE files read as BE)
    magic === 0xfeedfacf || // MH_MAGIC_64 — 64-bit, native byte order
    magic === 0xcefaedfe || // MH_CIGAM    — 32-bit, byte-swapped
    magic === 0xfeedface || // MH_MAGIC    — 32-bit, native byte order
    magic === 0xcafebabe || // FAT_MAGIC   — universal/fat binary
    magic === 0xbebafeca    // FAT_CIGAM   — universal/fat binary, byte-swapped
  );
}

/**
 * Check if agent-relay binary is available (cached).
 * Returns true if the binary exists, false otherwise.
 *
 * @param callerDirname - The __dirname of the calling module
 */
export function hasAgentRelayBinary(callerDirname: string): boolean {
  if (!cacheChecked) {
    cachedBinaryPath = findAgentRelayBinary(callerDirname);
    cacheChecked = true;
  }
  return cachedBinaryPath !== null;
}

/**
 * Get the cached agent-relay binary path.
 * Must call hasAgentRelayBinary() or findAgentRelayBinary() first.
 */
export function getCachedAgentRelayPath(): string | null | undefined {
  return cachedBinaryPath;
}

/**
 * Clear the cached binary path (for testing).
 */
export function clearBinaryCache(): void {
  cachedBinaryPath = undefined;
  cacheChecked = false;
}
