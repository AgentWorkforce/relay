/**
 * Cross-Platform File Permission Sandbox
 *
 * Wraps CLI commands with OS-level sandboxing to enforce file permissions.
 * This provides hard enforcement regardless of which CLI is being spawned.
 *
 * Supported platforms:
 * - macOS: Uses sandbox-exec (Seatbelt)
 * - Linux: Uses bubblewrap (bwrap) or Landlock
 * - Windows: Policy-only (no hard enforcement)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { FilePermissions, FilePermissionPresetType } from './types.js';

// =============================================================================
// Types
// =============================================================================

export interface SandboxResult {
  /** The command to execute (may be wrapped) */
  command: string;
  /** The arguments (may include sandbox args) */
  args: string[];
  /** Whether hard sandbox enforcement is active */
  sandboxed: boolean;
  /** Platform-specific sandbox method used */
  method: 'sandbox-exec' | 'bwrap' | 'landlock' | 'none';
  /** Path to temporary profile file (if any, caller should clean up) */
  profilePath?: string;
}

export interface SandboxCapabilities {
  /** Whether any sandboxing is available */
  available: boolean;
  /** Available sandbox methods */
  methods: ('sandbox-exec' | 'bwrap' | 'landlock')[];
  /** Current platform */
  platform: NodeJS.Platform;
}

// =============================================================================
// Presets
// =============================================================================

/**
 * Predefined file permission configurations for common use cases.
 */
export const FILE_PERMISSION_PRESETS: Record<FilePermissionPresetType, FilePermissions> = {
  'block-secrets': {
    disallowed: [
      '.env',
      '.env.*',
      '*.env',
      '.env.local',
      '.env.production',
      '.env.development',
      'secrets',
      'secrets/**',
      '.secrets',
      '.secrets/**',
      '*.pem',
      '*.key',
      '*.p12',
      '*.pfx',
      '*.jks',
      '**/credentials*',
      '**/password*',
      '.git/config', // May contain tokens
      '.npmrc', // May contain tokens
      '.pypirc',
    ],
  },

  'source-only': {
    allowed: ['src/**', 'lib/**', 'tests/**', 'test/**', 'spec/**', 'docs/**'],
    readOnly: [
      'package.json',
      'package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      'tsconfig.json',
      'tsconfig.*.json',
      '*.config.js',
      '*.config.ts',
    ],
    disallowed: ['.env*', 'secrets/**'],
  },

  'read-only': {
    writable: [], // Empty = nothing writable
  },

  'docs-only': {
    allowed: ['docs/**', 'README.md', 'CHANGELOG.md', '*.md', 'LICENSE*'],
    readOnly: ['src/**'], // Can read source for reference
    disallowed: ['.env*', 'secrets/**'],
  },
};

// =============================================================================
// Capability Detection
// =============================================================================

let cachedCapabilities: SandboxCapabilities | null = null;

/**
 * Detect available sandboxing capabilities on the current system.
 */
export function detectCapabilities(): SandboxCapabilities {
  if (cachedCapabilities) {
    return cachedCapabilities;
  }

  const platform = os.platform();
  const methods: SandboxCapabilities['methods'] = [];

  if (platform === 'darwin') {
    // macOS: Check for sandbox-exec
    if (commandExists('sandbox-exec')) {
      methods.push('sandbox-exec');
    }
  } else if (platform === 'linux') {
    // Linux: Check for bubblewrap
    if (commandExists('bwrap')) {
      methods.push('bwrap');
    }
    // Check for Landlock support (kernel 5.13+)
    if (hasLandlockSupport()) {
      methods.push('landlock');
    }
  }

  cachedCapabilities = {
    available: methods.length > 0,
    methods,
    platform,
  };

  return cachedCapabilities;
}

/**
 * Check if a command exists in PATH.
 */
function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Linux Landlock is supported (kernel 5.13+).
 */
function hasLandlockSupport(): boolean {
  try {
    // Landlock ABI is exposed via /sys/kernel/security/landlock
    return fs.existsSync('/sys/kernel/security/lsm') &&
      fs.readFileSync('/sys/kernel/security/lsm', 'utf-8').includes('landlock');
  } catch {
    return false;
  }
}

// =============================================================================
// Sandbox Application
// =============================================================================

/**
 * Apply file permission sandbox to a command.
 *
 * @param command - The CLI command to execute
 * @param args - Command arguments
 * @param permissions - File permissions to enforce
 * @param projectRoot - Project root for resolving relative paths
 * @returns Wrapped command with sandbox enforcement
 */
export function applySandbox(
  command: string,
  args: string[],
  permissions: FilePermissions,
  projectRoot: string
): SandboxResult {
  const capabilities = detectCapabilities();

  if (!capabilities.available) {
    return {
      command,
      args,
      sandboxed: false,
      method: 'none',
    };
  }

  // Prefer sandbox-exec on macOS
  if (capabilities.methods.includes('sandbox-exec')) {
    return applyMacOSSandbox(command, args, permissions, projectRoot);
  }

  // Prefer bwrap on Linux (more widely available than Landlock)
  if (capabilities.methods.includes('bwrap')) {
    return applyBwrapSandbox(command, args, permissions, projectRoot);
  }

  // Fallback: no sandbox
  return {
    command,
    args,
    sandboxed: false,
    method: 'none',
  };
}

/**
 * Resolve a file permission preset to its configuration.
 */
export function resolvePreset(preset: FilePermissionPresetType): FilePermissions {
  return FILE_PERMISSION_PRESETS[preset];
}

/**
 * Merge file permissions, with explicit permissions taking precedence over presets.
 */
export function mergePermissions(
  preset: FilePermissionPresetType | undefined,
  explicit: FilePermissions | undefined
): FilePermissions | undefined {
  if (!preset && !explicit) {
    return undefined;
  }

  const base = preset ? resolvePreset(preset) : {};
  if (!explicit) {
    return base;
  }

  return {
    allowed: explicit.allowed ?? base.allowed,
    disallowed: [...(base.disallowed ?? []), ...(explicit.disallowed ?? [])],
    readOnly: [...(base.readOnly ?? []), ...(explicit.readOnly ?? [])],
    writable: explicit.writable ?? base.writable,
    allowNetwork: explicit.allowNetwork ?? base.allowNetwork,
  };
}

// =============================================================================
// macOS Sandbox (Seatbelt)
// =============================================================================

/**
 * Generate a macOS Seatbelt sandbox profile.
 */
function generateSeatbeltProfile(
  permissions: FilePermissions,
  projectRoot: string
): string {
  const lines: string[] = [
    '(version 1)',
    '',
    '; Default deny all file operations',
    '(deny default)',
    '',
    '; Allow basic process operations',
    '(allow process-fork)',
    '(allow process-exec)',
    '(allow signal)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow ipc-posix-shm-read-data)',
    '(allow ipc-posix-shm-write-data)',
    '',
    '; Allow system library access (required for any process)',
    '(allow file-read* (subpath "/usr/lib"))',
    '(allow file-read* (subpath "/usr/share"))',
    '(allow file-read* (subpath "/System"))',
    '(allow file-read* (subpath "/Library"))',
    '(allow file-read* (subpath "/private/var/db"))',
    '(allow file-read* (subpath "/dev"))',
    '(allow file-write* (subpath "/dev/null"))',
    '(allow file-write* (subpath "/dev/tty"))',
    '',
    '; Allow user library access',
    `(allow file-read* (subpath "${os.homedir()}/Library"))`,
    `(allow file-read* (subpath "${os.homedir()}/.local"))`,
    `(allow file-read* (subpath "${os.homedir()}/.config"))`,
    '',
    '; Allow temp directory access',
    '(allow file-read* (subpath "/private/tmp"))',
    '(allow file-write* (subpath "/private/tmp"))',
    '(allow file-read* (subpath "/var/folders"))',
    '(allow file-write* (subpath "/var/folders"))',
    '',
  ];

  // Network access
  if (permissions.allowNetwork !== false) {
    lines.push('; Allow network access (for API calls)');
    lines.push('(allow network*)');
    lines.push('');
  }

  // Disallowed paths (highest priority - deny first)
  if (permissions.disallowed?.length) {
    lines.push('; Explicitly denied paths');
    for (const pattern of permissions.disallowed) {
      const resolved = resolvePath(pattern, projectRoot);
      lines.push(`(deny file* (subpath "${resolved}"))`);
      // Also deny the literal pattern for globs
      if (pattern !== resolved) {
        lines.push(`(deny file* (literal "${path.join(projectRoot, pattern)}"))`);
      }
    }
    lines.push('');
  }

  // Read-only paths
  if (permissions.readOnly?.length) {
    lines.push('; Read-only paths');
    for (const pattern of permissions.readOnly) {
      const resolved = resolvePath(pattern, projectRoot);
      lines.push(`(allow file-read* (subpath "${resolved}"))`);
    }
    lines.push('');
  }

  // Writable paths
  if (permissions.writable?.length) {
    lines.push('; Writable paths');
    for (const pattern of permissions.writable) {
      const resolved = resolvePath(pattern, projectRoot);
      lines.push(`(allow file-read* (subpath "${resolved}"))`);
      lines.push(`(allow file-write* (subpath "${resolved}"))`);
    }
    lines.push('');
  }

  // Allowed paths (if whitelist mode)
  if (permissions.allowed?.length) {
    lines.push('; Allowed paths (whitelist)');
    for (const pattern of permissions.allowed) {
      const resolved = resolvePath(pattern, projectRoot);
      lines.push(`(allow file-read* (subpath "${resolved}"))`);
      lines.push(`(allow file-write* (subpath "${resolved}"))`);
    }
    lines.push('');
  } else {
    // No whitelist = allow project root by default
    lines.push('; Default: allow project root');
    lines.push(`(allow file-read* (subpath "${projectRoot}"))`);
    lines.push(`(allow file-write* (subpath "${projectRoot}"))`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Apply macOS sandbox-exec wrapper.
 */
function applyMacOSSandbox(
  command: string,
  args: string[],
  permissions: FilePermissions,
  projectRoot: string
): SandboxResult {
  const profile = generateSeatbeltProfile(permissions, projectRoot);

  // Write profile to temp file
  const profilePath = path.join(os.tmpdir(), `relay-sandbox-${Date.now()}.sb`);
  fs.writeFileSync(profilePath, profile, { mode: 0o600 });

  return {
    command: 'sandbox-exec',
    args: ['-f', profilePath, command, ...args],
    sandboxed: true,
    method: 'sandbox-exec',
    profilePath,
  };
}

// =============================================================================
// Linux Sandbox (bubblewrap)
// =============================================================================

/**
 * Apply Linux bubblewrap wrapper.
 */
function applyBwrapSandbox(
  command: string,
  args: string[],
  permissions: FilePermissions,
  projectRoot: string
): SandboxResult {
  const bwrapArgs: string[] = [
    '--die-with-parent',
    '--new-session',
  ];

  // Start with read-only root filesystem
  bwrapArgs.push('--ro-bind', '/', '/');

  // Allow /tmp and /var/tmp as writable
  bwrapArgs.push('--tmpfs', '/tmp');
  bwrapArgs.push('--tmpfs', '/var/tmp');

  // Make /dev available
  bwrapArgs.push('--dev', '/dev');

  // Make /proc available (needed for many tools)
  bwrapArgs.push('--proc', '/proc');

  // Disallowed paths - replace with empty tmpfs
  if (permissions.disallowed?.length) {
    for (const pattern of permissions.disallowed) {
      const resolved = resolvePath(pattern, projectRoot);
      if (fs.existsSync(resolved)) {
        bwrapArgs.push('--tmpfs', resolved);
      }
    }
  }

  // Read-only paths - bind as read-only
  if (permissions.readOnly?.length) {
    for (const pattern of permissions.readOnly) {
      const resolved = resolvePath(pattern, projectRoot);
      if (fs.existsSync(resolved)) {
        bwrapArgs.push('--ro-bind', resolved, resolved);
      }
    }
  }

  // Writable paths - bind as read-write
  if (permissions.writable?.length) {
    for (const pattern of permissions.writable) {
      const resolved = resolvePath(pattern, projectRoot);
      if (fs.existsSync(resolved)) {
        bwrapArgs.push('--bind', resolved, resolved);
      }
    }
  }

  // Allowed paths (whitelist) - bind as read-write
  if (permissions.allowed?.length) {
    for (const pattern of permissions.allowed) {
      const resolved = resolvePath(pattern, projectRoot);
      if (fs.existsSync(resolved)) {
        bwrapArgs.push('--bind', resolved, resolved);
      }
    }
  } else {
    // No whitelist = allow project root
    bwrapArgs.push('--bind', projectRoot, projectRoot);
  }

  // Network isolation (optional)
  if (permissions.allowNetwork === false) {
    bwrapArgs.push('--unshare-net');
  }

  // Set working directory
  bwrapArgs.push('--chdir', projectRoot);

  // Add the actual command
  bwrapArgs.push('--', command, ...args);

  return {
    command: 'bwrap',
    args: bwrapArgs,
    sandboxed: true,
    method: 'bwrap',
  };
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Resolve a path pattern relative to project root.
 * Handles both absolute paths and relative patterns.
 */
function resolvePath(pattern: string, projectRoot: string): string {
  // If it's a glob pattern, just join with project root
  if (pattern.includes('*')) {
    return path.join(projectRoot, pattern.replace(/\*\*/g, '').replace(/\*/g, ''));
  }

  // If absolute, use as-is
  if (path.isAbsolute(pattern)) {
    return pattern;
  }

  // Otherwise, resolve relative to project root
  return path.resolve(projectRoot, pattern);
}

/**
 * Clean up temporary sandbox profile file.
 */
export function cleanupSandboxProfile(result: SandboxResult): void {
  if (result.profilePath) {
    try {
      fs.unlinkSync(result.profilePath);
    } catch {
      // Ignore cleanup errors
    }
  }
}
