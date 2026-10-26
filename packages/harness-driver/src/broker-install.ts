/**
 * Converge an npm install onto the canonical broker location.
 *
 * `npm i -g agent-relay` ships the broker inside node_modules through the
 * platform optional dependency `@agent-relay/broker-<platform>-<arch>`. On the
 * CLI's first run (not in a postinstall script: many users install with
 * `ignore-scripts`), {@link ensureCanonicalBroker} copies that broker into
 * `<install root>/bin/agent-relay-broker[.exe]` so every install method ends
 * with the broker in the same place (see ./install-paths.ts).
 *
 * Guarantees:
 *   - Atomic: the copy is written to a temp file in the target directory,
 *     verified, chmod 0755, then renamed over the target.
 *   - Integrity: when the npm package ships `<binary>.sha256`, the source must
 *     match it; the temp copy must always hash identically to the source.
 *   - No races: a lock file in the bin directory serialises concurrent CLI
 *     processes; a process that finds the lock held skips this run.
 *   - No downgrades: a canonical broker whose version is equal to or newer than
 *     the npm one (for example from install.sh or the desktop app) is left
 *     alone. A canonical file that cannot report a version is replaced.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { getOptionalDepBrokerPath } from './broker-path.js';
import { getCanonicalBrokerPath } from './install-paths.js';

/** Set to `1` to disable copying the npm broker into the canonical bin directory. */
export const SKIP_BROKER_INSTALL_ENV = 'AGENT_RELAY_SKIP_BROKER_INSTALL';

const DEFAULT_LOCK_STALE_MS = 120_000;
const VERSION_PROBE_TIMEOUT_MS = 5_000;

export type EnsureCanonicalBrokerSkipReason =
  | 'disabled'
  | 'override'
  | 'no-source'
  | 'source-is-canonical'
  | 'unknown-source-version'
  | 'up-to-date'
  | 'newer-installed'
  | 'locked'
  | 'checksum-mismatch'
  | 'error';

export type EnsureCanonicalBrokerResult =
  | {
      action: 'installed' | 'upgraded';
      path: string;
      version: string;
      /** Version the replaced broker reported; absent when it reported none. */
      previousVersion?: string;
    }
  | {
      action: 'skipped';
      reason: EnsureCanonicalBrokerSkipReason;
      path: string;
      detail?: string;
    };

export interface EnsureCanonicalBrokerOptions {
  /** Environment for overrides (default: process.env). */
  env?: Record<string, string | undefined>;
  /** Broker to copy (default: the npm optional-dependency binary). */
  sourcePath?: string | null;
  /** Version of `sourcePath` (default: its package.json version, else `--version`). */
  sourceVersion?: string | null;
  /** Destination (default: the canonical broker path). */
  targetPath?: string;
  /** Version probe for a binary; returns null when it cannot report one. */
  readVersion?: (binaryPath: string) => string | null;
  /** Age after which a lock is considered abandoned (default 120s). */
  lockStaleMs?: number;
}

const SEMVER_RE = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/u;

/**
 * Extract the first semantic version from text such as
 * `agent-relay-broker 14.0.0`.
 * @param text - Output to scan
 * @returns The version string, or null if none is present
 */
export function parseVersion(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = SEMVER_RE.exec(text);
  return match ? match[0] : null;
}

function comparePrerelease(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1; // a release outranks its prereleases
  if (b === undefined) return -1;
  const as = a.split('.');
  const bs = b.split('.');
  for (let i = 0; i < Math.max(as.length, bs.length); i += 1) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/u.test(x);
    const yn = /^\d+$/u.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Compare two semantic versions.
 * @returns -1, 0 or 1 like a sort comparator; null if either is unparseable
 */
export function compareVersions(a: string, b: string): number | null {
  const ma = SEMVER_RE.exec(a);
  const mb = SEMVER_RE.exec(b);
  if (!ma || !mb) return null;
  for (let i = 1; i <= 3; i += 1) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return comparePrerelease(ma[4], mb[4]);
}

/**
 * Run `<binary> --version` and parse the version it prints.
 * @param binaryPath - Executable to probe
 * @returns The version, or null if the binary could not run or printed none
 */
export function readBinaryVersion(binaryPath: string): string | null {
  try {
    const out = execFileSync(binaryPath, ['--version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    return parseVersion(out);
  } catch {
    return null;
  }
}

/** Version from the package.json of the npm package that ships `binaryPath` (`<pkg>/bin/<file>`). */
function readPackageVersion(binaryPath: string): string | null {
  try {
    const pkgJson = join(dirname(dirname(binaryPath)), 'package.json');
    const parsed = JSON.parse(readFileSync(pkgJson, 'utf-8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parseVersion(parsed.version) : null;
  } catch {
    return null;
  }
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/** Expected digest from a `<binary>.sha256` sidecar (`<hex>` or `<hex>  <name>`), or null. */
function readSidecarSha256(binaryPath: string): string | null {
  const sidecar = `${binaryPath}.sha256`;
  if (!existsSync(sidecar)) return null;
  const match = /\b([0-9a-fA-F]{64})\b/u.exec(readFileSync(sidecar, 'utf-8'));
  return match ? match[1].toLowerCase() : null;
}

interface VersionCache {
  size: number;
  mtimeMs: number;
  version: string;
}

function versionCachePath(targetPath: string): string {
  return join(dirname(targetPath), `.${basename(targetPath)}.version.json`);
}

/**
 * Version of the canonical broker, served from a stat-keyed cache so a normal
 * CLI run does not execute the broker just to learn its version.
 */
function readTargetVersion(targetPath: string, readVersion: (p: string) => string | null): string | null {
  let stat;
  try {
    stat = statSync(targetPath);
  } catch {
    return null;
  }
  const cachePath = versionCachePath(targetPath);
  try {
    const cached = JSON.parse(readFileSync(cachePath, 'utf-8')) as Partial<VersionCache>;
    if (cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && typeof cached.version === 'string') {
      return cached.version;
    }
  } catch {
    // No usable cache.
  }
  const version = readVersion(targetPath);
  if (version) writeVersionCache(targetPath, version);
  return version;
}

function writeVersionCache(targetPath: string, version: string): void {
  try {
    const stat = statSync(targetPath);
    const entry: VersionCache = { size: stat.size, mtimeMs: stat.mtimeMs, version };
    writeFileSync(versionCachePath(targetPath), `${JSON.stringify(entry)}\n`);
  } catch {
    // The cache is an optimisation only.
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Take an exclusive lock file. Returns a release function, or null when a
 * live process holds the lock. An abandoned lock (owner dead, or older than
 * `staleMs`) is removed and taken once.
 */
function acquireLock(lockPath: string, staleMs: number): (() => void) | null {
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx', 0o644);
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, token }));
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          const held = JSON.parse(readFileSync(lockPath, 'utf-8')) as { token?: string };
          if (held.token === token) unlinkSync(lockPath);
        } catch {
          // Already gone.
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    let stale: boolean;
    try {
      const stat = statSync(lockPath);
      const held = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid?: unknown };
      const pid = typeof held.pid === 'number' ? held.pid : NaN;
      stale = Date.now() - stat.mtimeMs > staleMs || !Number.isInteger(pid) || !isProcessAlive(pid);
    } catch (err) {
      // Vanished between open and stat: retry. Unparseable while being
      // written: treat as held unless it is also old.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      try {
        stale = Date.now() - statSync(lockPath).mtimeMs > staleMs;
      } catch {
        continue;
      }
    }
    if (!stale) return null;
    try {
      unlinkSync(lockPath);
    } catch {
      // Another process removed it first; fall through and race for it.
    }
  }
  return null;
}

interface ConvergenceInputs {
  sourcePath: string;
  sourceVersion: string;
}

/** Decide whether this run should converge at all; returns a skip reason or the inputs. */
function resolveInputs(
  options: EnsureCanonicalBrokerOptions,
  env: Record<string, string | undefined>,
  targetPath: string,
  readVersion: (p: string) => string | null
): ConvergenceInputs | { skip: EnsureCanonicalBrokerSkipReason; detail?: string } {
  const flag = env[SKIP_BROKER_INSTALL_ENV]?.trim().toLowerCase();
  if (flag === '1' || flag === 'true') return { skip: 'disabled' };
  // An explicit broker override means the operator chose a binary; do not
  // populate the canonical slot behind their back.
  if (env.BROKER_BINARY_PATH?.trim() || env.AGENT_RELAY_BIN?.trim()) return { skip: 'override' };

  const sourcePath = options.sourcePath === undefined ? getOptionalDepBrokerPath() : options.sourcePath;
  if (!sourcePath || !existsSync(sourcePath)) return { skip: 'no-source' };
  if (sameFile(sourcePath, targetPath)) return { skip: 'source-is-canonical' };

  const declared =
    options.sourceVersion === undefined ? readPackageVersion(sourcePath) : options.sourceVersion;
  const sourceVersion = declared ?? readVersion(sourcePath);
  if (!sourceVersion) return { skip: 'unknown-source-version', detail: sourcePath };
  return { sourcePath, sourceVersion };
}

/**
 * Copy `sourcePath` over `targetPath` through a verified temp file in the
 * target directory. Returns a checksum-mismatch description, or null on success.
 */
function copyAtomically(sourcePath: string, targetPath: string): string | null {
  const sourceHash = sha256File(sourcePath);
  const expected = readSidecarSha256(sourcePath);
  if (expected && expected !== sourceHash) {
    return `expected ${expected}, got ${sourceHash}`;
  }

  const tempPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  );
  try {
    copyFileSync(sourcePath, tempPath);
    chmodSync(tempPath, 0o755);
    const copiedHash = sha256File(tempPath);
    if (copiedHash !== sourceHash) {
      return `copy hashed ${copiedHash}, source ${sourceHash}`;
    }
    renameSync(tempPath, targetPath);
    return null;
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // Renamed into place, or never created.
    }
  }
}

/**
 * Copy the npm-shipped broker into the canonical bin directory when the
 * canonical broker is missing or older. Never throws.
 *
 * @param options - Overrides, mainly for tests
 * @returns What happened, for diagnostics
 */
export function ensureCanonicalBroker(
  options: EnsureCanonicalBrokerOptions = {}
): EnsureCanonicalBrokerResult {
  const env = options.env ?? process.env;
  const targetPath = options.targetPath ?? getCanonicalBrokerPath(env);
  const readVersion = options.readVersion ?? readBinaryVersion;
  const skip = (reason: EnsureCanonicalBrokerSkipReason, detail?: string): EnsureCanonicalBrokerResult => ({
    action: 'skipped',
    reason,
    path: targetPath,
    ...(detail ? { detail } : {}),
  });

  try {
    const inputs = resolveInputs(options, env, targetPath, readVersion);
    if ('skip' in inputs) return skip(inputs.skip, inputs.detail);
    const { sourcePath, sourceVersion } = inputs;

    // Fast path without the lock: the common case is "already converged".
    const preCheck = decide(targetPath, sourceVersion, readVersion);
    if (preCheck.kind !== 'install') return skip(preCheck.kind, preCheck.version);

    const binDir = dirname(targetPath);
    mkdirSync(binDir, { recursive: true, mode: 0o755 });
    const release = acquireLock(
      join(binDir, `.${basename(targetPath)}.lock`),
      options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS
    );
    if (!release) return skip('locked');
    try {
      // Re-check under the lock: another process may have just converged.
      const decision = decide(targetPath, sourceVersion, readVersion);
      if (decision.kind !== 'install') return skip(decision.kind, decision.version);

      const mismatch = copyAtomically(sourcePath, targetPath);
      if (mismatch) return skip('checksum-mismatch', mismatch);
      writeVersionCache(targetPath, sourceVersion);

      if (decision.previous === undefined) {
        return { action: 'installed', path: targetPath, version: sourceVersion };
      }
      return {
        action: 'upgraded',
        path: targetPath,
        version: sourceVersion,
        ...(decision.previous ? { previousVersion: decision.previous } : {}),
      };
    } finally {
      release();
    }
  } catch (err) {
    return skip('error', err instanceof Error ? err.message : String(err));
  }
}

type Decision =
  | { kind: 'up-to-date' | 'newer-installed'; version: string }
  /** previous: undefined = no target; null = target present but reported no version. */
  | { kind: 'install'; previous: string | null | undefined };

function decide(
  targetPath: string,
  sourceVersion: string,
  readVersion: (p: string) => string | null
): Decision {
  if (!existsSync(targetPath)) return { kind: 'install', previous: undefined };
  const installed = readTargetVersion(targetPath, readVersion);
  if (!installed) return { kind: 'install', previous: null };
  const cmp = compareVersions(installed, sourceVersion);
  if (cmp === null) return { kind: 'install', previous: installed };
  if (cmp > 0) return { kind: 'newer-installed', version: installed };
  if (cmp === 0) return { kind: 'up-to-date', version: installed };
  return { kind: 'install', previous: installed };
}

function sameFile(a: string, b: string): boolean {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

/** @internal Exposed for tests. */
export const testInternals = { acquireLock, versionCachePath };
