/**
 * Download the standalone Relaycast server (`relaycast-engine`) from the
 * relaycast GitHub release into the canonical bin slot, the same way
 * install.sh does: a per-platform asset plus its `.sha256` sidecar, verified
 * before it is ever moved into place.
 *
 * The standalone binary embeds its own runtime and SQLite, so it runs no
 * matter which Node version the CLI is on and needs no npm install scripts.
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const RELEASE_BASE = 'https://github.com/AgentWorkforce/relaycast/releases/download';
/** The binary is tens of megabytes; bounded so a stalled download cannot hang `relay init`. */
export const ENGINE_DOWNLOAD_TIMEOUT_MS = 300_000;
/** Short: the checksum is tiny, and a stalled GitHub should not hold up every restart for long. */
export const ENGINE_CHECKSUM_TIMEOUT_MS = 15_000;

/** The platform facts that pick a release asset. */
export interface EnginePlatform {
  platform: NodeJS.Platform;
  arch: string;
  /** Linux with musl libc (Alpine), which needs the `linux-musl-*` build. */
  musl: boolean;
}

/** Fetch a URL's body, rejecting on a non-2xx status or after `timeoutMs`. */
export type DownloadFile = (url: string, options: { timeoutMs: number }) => Promise<Uint8Array>;

/** Thrown when a download answers with an HTTP error, e.g. 404 for an unpublished asset. */
export class DownloadHttpError extends Error {
  constructor(
    public readonly url: string,
    public readonly status: number
  ) {
    super(`HTTP ${status} for ${url}`);
  }
}

/**
 * The release asset name for a platform, or undefined when relaycast publishes none for it.
 * @param version - Pinned engine version, e.g. `11.1.0`
 * @param target - Platform, architecture and libc
 * @returns e.g. `relaycast-engine-11.1.0-linux-musl-x64`
 */
export function engineAssetName(version: string, target: EnginePlatform): string | undefined {
  const arch = target.arch === 'x64' || target.arch === 'arm64' ? target.arch : undefined;
  if (!arch) return undefined;
  switch (target.platform) {
    case 'darwin':
      return `relaycast-engine-${version}-darwin-${arch}`;
    case 'linux':
      return `relaycast-engine-${version}-linux-${target.musl ? 'musl-' : ''}${arch}`;
    case 'win32':
      return arch === 'x64' ? `relaycast-engine-${version}-windows-x64.exe` : undefined;
    default:
      return undefined;
  }
}

/**
 * Whether this Linux system uses musl libc. Reads the `ldd` script first (as
 * detect-libc does), then looks for the musl loader, then asks Node's report.
 * @returns true on musl-based Linux, false everywhere else
 */
export function detectMusl(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const ldd = fs.readFileSync('/usr/bin/ldd', 'utf8');
    if (ldd.includes('musl')) return true;
    if (ldd.includes('GNU C Library') || ldd.includes('GLIBC')) return false;
  } catch {
    // No ldd script; try the next signal.
  }
  try {
    if (fs.readdirSync('/lib').some((name) => name.startsWith('ld-musl-'))) return true;
  } catch {
    // Unreadable /lib.
  }
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
    if (report?.header) return !report.header.glibcVersionRuntime;
  } catch {
    // Reports unsupported in this runtime.
  }
  return false;
}

/** This machine's platform facts. */
export function currentEnginePlatform(): EnginePlatform {
  return { platform: process.platform, arch: process.arch, musl: detectMusl() };
}

/**
 * The version a `relaycast-engine` binary reports for `--version`, if any.
 * @param binary - Path to the binary
 * @returns The first semver in its output, or undefined
 */
export function readEngineVersion(binary: string): string | undefined {
  try {
    const out = execFileSync(binary, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0];
  } catch {
    return undefined;
  }
}

/** Default {@link DownloadFile}: global fetch with a bounded timeout. */
export const fetchDownload: DownloadFile = async (url, { timeoutMs }) => {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new DownloadHttpError(url, response.status);
  return new Uint8Array(await response.arrayBuffer());
};

/** `a > b` comparing major.minor.patch numerically, ignoring prerelease tags (as install.sh). */
function versionGreater(a: string, b: string): boolean {
  const parse = (v: string) =>
    v
      .split('-')[0]
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/** A short, human reason for a failed download. */
function failureReason(error: unknown): string {
  if (error instanceof DownloadHttpError) {
    return error.status === 404
      ? `no release asset ${error.url.slice(error.url.lastIndexOf('/') + 1)}`
      : error.message;
  }
  if (!(error instanceof Error)) return String(error);
  if (error.name === 'TimeoutError') return 'the download timed out';
  return (error.cause as Error | undefined)?.message ?? error.message;
}

export interface EnsureEngineInput {
  version: string;
  /** Final path, `<bin>/relaycast-engine[.exe]`. */
  target: string;
  platform: EnginePlatform;
  download: DownloadFile;
  readVersion: (binary: string) => string | undefined;
  /** One-line progress, shown only when a download actually starts. */
  progress: (line: string) => void;
}

export type EnsureEngineResult =
  | { status: 'present'; version: string }
  | { status: 'installed'; asset: string }
  | { status: 'failed'; reason: string };

/**
 * Make sure the pinned standalone engine is at `target`, downloading it when
 * it is missing or older. Never throws; a failure leaves `target` untouched.
 * @param input - Version, destination and injected effects
 * @returns What happened, with a reason on failure
 */
export async function ensureStandaloneEngine(input: EnsureEngineInput): Promise<EnsureEngineResult> {
  const asset = engineAssetName(input.version, input.platform);
  return ensureReleaseBinary({
    ...input,
    asset,
    url: asset ? `${RELEASE_BASE}/v${input.version}/${asset}` : undefined,
    unsupported: `relaycast publishes no standalone server for ${input.platform.platform}-${input.platform.arch}`,
    description: `the local Relaycast server (relaycast-engine v${input.version}, ${asset})`,
  });
}

/** One release binary to put in place: where it comes from and what it is called. */
export interface EnsureReleaseBinaryInput {
  version: string;
  /** Final path in the bin slot. */
  target: string;
  /** The release asset name, or undefined when none is published for this platform. */
  asset: string | undefined;
  /** The asset's download URL; its checksum is at `${url}.sha256`. */
  url: string | undefined;
  /** Why there is no asset, when `asset` is undefined. */
  unsupported: string;
  /** What is being downloaded, for the progress line. */
  description: string;
  download: DownloadFile;
  readVersion: (binary: string) => string | undefined;
  progress: (line: string) => void;
}

/**
 * Make sure a GitHub release binary of at least `version` is at `target`:
 * download the asset and its `.sha256` sidecar, verify the digest, check the
 * downloaded file runs and reports `version`, then rename it into place
 * atomically. Never throws; a failure leaves `target` untouched.
 * @param input - Version, asset, destination and injected effects
 * @returns What happened, with a reason on failure
 */
export async function ensureReleaseBinary(input: EnsureReleaseBinaryInput): Promise<EnsureEngineResult> {
  const { version, target, asset, url } = input;
  if (fs.existsSync(target)) {
    const installed = input.readVersion(target);
    if (installed === version || (installed && versionGreater(installed, version))) {
      return { status: 'present', version: installed };
    }
  }
  if (!asset || !url) return { status: 'failed', reason: input.unsupported };

  let temp: string | undefined;
  try {
    input.progress(`Downloading ${input.description}…`);
    // The small checksum first: an unpublished asset fails fast, before the large download.
    const sums = await input.download(`${url}.sha256`, { timeoutMs: ENGINE_CHECKSUM_TIMEOUT_MS });
    const expected = Buffer.from(sums).toString('utf8').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    if (!/^[0-9a-f]{64}$/.test(expected)) {
      return { status: 'failed', reason: `${asset}.sha256 is not a SHA-256 digest` };
    }
    const binary = await input.download(url, { timeoutMs: ENGINE_DOWNLOAD_TIMEOUT_MS });
    const actual = createHash('sha256').update(binary).digest('hex');
    if (actual !== expected) {
      return {
        status: 'failed',
        reason: `SHA-256 mismatch for ${asset} (expected ${expected}, got ${actual})`,
      };
    }

    // Same directory as the target, so the rename is atomic and never crosses filesystems.
    const dir = path.dirname(target);
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    temp = path.join(dir, `.${path.basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    fs.writeFileSync(temp, binary, { mode: 0o755, flag: 'wx' });
    fs.chmodSync(temp, 0o755);
    // A verified file can still fail to run here (too old an OS, missing libraries);
    // never let it replace a working binary.
    const runs = input.readVersion(temp);
    if (runs !== version) {
      return { status: 'failed', reason: `the downloaded ${asset} does not run on this machine` };
    }
    fs.renameSync(temp, target);
    temp = undefined;
    return { status: 'installed', asset };
  } catch (error) {
    return { status: 'failed', reason: failureReason(error) };
  } finally {
    if (temp) fs.rmSync(temp, { force: true });
  }
}
