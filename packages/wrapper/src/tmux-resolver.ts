/**
 * Tmux Binary Resolver
 *
 * Locates tmux binary with fallback to bundled version.
 * Priority:
 * 1. System tmux (in PATH)
 * 2. Bundled tmux within the agent-relay package (bin/tmux)
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Get the package root directory (where agent-relay is installed)
 * This works whether we're in dist/utils/ or src/utils/
 */
function getPackageRoot(): string {
  // Navigate up from dist/utils or src/utils to package root
  return path.resolve(__dirname, '..', '..');
}

/** Path where bundled tmux binary is installed (within the package) */
export function getBundledTmuxDir(): string {
  return path.join(getPackageRoot(), 'bin');
}

export function getBundledTmuxPath(): string {
  return path.join(getBundledTmuxDir(), 'tmux');
}

// Legacy exports for backwards compatibility
export const BUNDLED_TMUX_DIR = getBundledTmuxDir();
export const BUNDLED_TMUX_PATH = getBundledTmuxPath();

/** Minimum supported tmux version */
export const MIN_TMUX_VERSION = '3.0';

export interface TmuxInfo {
  /** Full path to tmux binary */
  path: string;
  /** Version string (e.g., "3.6a") */
  version: string;
  /** Whether this is the bundled version */
  isBundled: boolean;
}

/**
 * Check if tmux exists at a given path and get its version
 */
function getTmuxVersion(tmuxPath: string): string | null {
  try {
    const output = execSync(`"${tmuxPath}" -V`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Output format: "tmux 3.6a" or similar
    const match = output.trim().match(/tmux\s+(\d+\.\d+\w?)/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Find tmux in system PATH
 */
function findSystemTmux(): string | null {
  try {
    const output = execSync('which tmux', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve tmux binary path with fallback to bundled version.
 * Returns null if tmux is not available.
 */
export function resolveTmux(): TmuxInfo | null {
  // 1. Check system tmux first
  const systemPath = findSystemTmux();
  if (systemPath) {
    const version = getTmuxVersion(systemPath);
    if (version) {
      return {
        path: systemPath,
        version,
        isBundled: false,
      };
    }
  }

  // 2. Check bundled tmux (within the package)
  const bundledPath = getBundledTmuxPath();
  if (fs.existsSync(bundledPath)) {
    const version = getTmuxVersion(bundledPath);
    if (version) {
      return {
        path: bundledPath,
        version,
        isBundled: true,
      };
    }
  }

  return null;
}

/**
 * Get the tmux command to use. Throws if tmux is not available.
 */
export function getTmuxPath(): string {
  const info = resolveTmux();
  if (!info) {
    throw new TmuxNotFoundError();
  }
  return info.path;
}

/**
 * Check if tmux is available (either system or bundled)
 */
export function isTmuxAvailable(): boolean {
  return resolveTmux() !== null;
}

/**
 * Get platform identifier for downloading binaries
 */
export function getPlatformIdentifier(): string | null {
  const platform = os.platform();
  const arch = os.arch();

  if (platform === 'darwin') {
    return arch === 'arm64' ? 'macos-arm64' : 'macos-x86_64';
  } else if (platform === 'linux') {
    return arch === 'arm64' ? 'linux-arm64' : 'linux-x86_64';
  }

  // Unsupported platform
  return null;
}

/**
 * Error thrown when tmux is not available
 */
export class TmuxNotFoundError extends Error {
  constructor() {
    const platformInstructions = (() => {
      switch (os.platform()) {
        case 'darwin':
          return '  macOS: brew install tmux';
        case 'linux':
          return '  Ubuntu/Debian: sudo apt install tmux\n  Fedora: sudo dnf install tmux\n  Arch: sudo pacman -S tmux';
        case 'win32':
          return '  Windows: tmux requires WSL (Windows Subsystem for Linux)\n  Install WSL, then: sudo apt install tmux';
        default:
          return '  See: https://github.com/tmux/tmux/wiki/Installing';
      }
    })();

    super(
      `tmux is required but not found.\n\nInstall tmux:\n${platformInstructions}\n\nThen reinstall agent-relay: npm install agent-relay`
    );
    this.name = 'TmuxNotFoundError';
  }
}

/**
 * Parse version string to compare versions
 */
function parseVersion(version: string): { major: number; minor: number } {
  const match = version.match(/(\d+)\.(\d+)/);
  if (!match) {
    return { major: 0, minor: 0 };
  }
  return { major: parseInt(match[1], 10), minor: parseInt(match[2], 10) };
}

/**
 * Check if installed tmux version meets minimum requirements
 */
export function checkTmuxVersion(): { ok: boolean; version: string | null; minimum: string } {
  const info = resolveTmux();
  if (!info) {
    return { ok: false, version: null, minimum: MIN_TMUX_VERSION };
  }

  const installed = parseVersion(info.version);
  const required = parseVersion(MIN_TMUX_VERSION);

  const ok =
    installed.major > required.major ||
    (installed.major === required.major && installed.minor >= required.minor);

  return { ok, version: info.version, minimum: MIN_TMUX_VERSION };
}
