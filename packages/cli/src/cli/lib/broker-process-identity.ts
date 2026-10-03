import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CoreDependencies, CoreProjectPaths } from '../commands/core.js';

export type BrokerProcessIdentity = {
  version: 1;
  pid: number;
  stateDirectory: string;
  brokerName: string;
  startedAt: string;
  executable: string;
  lock: { path: string; device: string; inode: string; ctimeNs: string; mtimeNs: string };
};

type IdentityDependencies = Pick<CoreDependencies, 'execCommand' | 'fs' | 'pid'>;

function canonicalDirectory(directory: string, deps?: IdentityDependencies): string {
  try {
    return (deps?.fs.realpathSync ?? fs.realpathSync)(directory);
  } catch {
    return path.resolve(directory);
  }
}

function stateDirectory(paths: CoreProjectPaths, deps?: IdentityDependencies): string {
  return canonicalDirectory(paths.dataDir, deps);
}

function identityPrefix(paths: CoreProjectPaths, deps?: IdentityDependencies): string {
  const scope = createHash('sha256').update(stateDirectory(paths, deps)).digest('hex');
  return `broker-identity-${scope}`;
}

/**
 * Directory holding identity records: the broker's own state directory, so
 * `node down --state-dir <dir>` finds the record from any working directory
 * (relay#1820). For the default state dir this is the project data dir.
 */
export function brokerIdentityDirectory(paths: CoreProjectPaths, deps?: IdentityDependencies): string {
  return stateDirectory(paths, deps);
}

/**
 * Directories searched for identity records, newest layout first. Earlier
 * releases wrote every record under the invoking project's data dir even when
 * `--state-dir` redirected broker state; keep reading there so brokers started
 * by those releases stay verifiable.
 */
function identityDirectories(paths: CoreProjectPaths, deps?: IdentityDependencies): string[] {
  const primary = brokerIdentityDirectory(paths, deps);
  const legacy = canonicalDirectory(path.join(paths.projectRoot, '.agentworkforce', 'relay'), deps);
  return primary === legacy ? [primary] : [primary, legacy];
}

function identityFilename(
  directory: string,
  paths: CoreProjectPaths,
  deps: IdentityDependencies | undefined,
  brokerName: string
): string {
  const name = createHash('sha256').update(brokerName).digest('hex');
  return path.join(directory, `${identityPrefix(paths, deps)}-${name}.json`);
}

export function brokerIdentityPath(
  paths: CoreProjectPaths,
  deps?: IdentityDependencies,
  brokerName = path.basename(paths.projectRoot) || 'project'
): string {
  return identityFilename(brokerIdentityDirectory(paths, deps), paths, deps, brokerName);
}

function normalizedStart(value: string): string | null {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (
    !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(
      normalized
    )
  )
    return null;
  return Number.isFinite(Date.parse(`${normalized} UTC`)) ? normalized : null;
}

/** Fixed OS fields only: no rendered argv, command names, or user paths.
 * txt mappings identify executable objects by device and inode on macOS/Linux.
 * Missing tools, unsupported systems, and incomplete output prove no identity. */
export async function readBrokerProcessIdentity(
  pid: number,
  deps: IdentityDependencies,
  platform = process.platform
): Promise<Pick<BrokerProcessIdentity, 'startedAt' | 'executable'> | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === deps.pid || !['darwin', 'linux'].includes(platform))
    return null;
  try {
    const startCommand = `LC_ALL=C TZ=UTC ps -p ${pid} -o lstart=`;
    const startedAt = normalizedStart((await deps.execCommand(startCommand)).stdout);
    if (!startedAt) return null;
    // Linux omits descriptor fields unless explicitly selected, unlike macOS.
    const details = (await deps.execCommand(`lsof -nP -a -p ${pid} -d txt -FfDi`)).stdout;
    const fields = details.trim().split('\n');
    if (fields.shift() !== `p${pid}`) return null;
    const objects: string[] = [];
    for (let i = 0; i < fields.length; i += 3) {
      const [descriptor, device, inode] = fields.slice(i, i + 3);
      if (descriptor !== 'ftxt' || !/^D0x[0-9a-f]+$/i.test(device ?? '') || !/^i[1-9]\d*$/.test(inode ?? ''))
        return null;
      objects.push(`${device.slice(1).toLowerCase()}:${inode.slice(1)}`);
    }
    if (!objects.length || normalizedStart((await deps.execCommand(startCommand)).stdout) !== startedAt)
      return null;
    return { startedAt, executable: [...new Set(objects)].sort().join(',') };
  } catch {
    return null;
  }
}

/** Locate the record for `brokerName`, preferring the state-dir location over the legacy one. */
function findBrokerIdentityRecord(
  paths: CoreProjectPaths,
  deps: IdentityDependencies,
  brokerName: string
): { identity: BrokerProcessIdentity; filename: string } | null {
  for (const directory of identityDirectories(paths, deps)) {
    const filename = identityFilename(directory, paths, deps, brokerName);
    const identity = readBrokerIdentityFile(filename, paths, deps, brokerName);
    if (identity) return { identity, filename };
  }
  return null;
}

/** The file holding the record for `brokerName`, falling back to where a new record would be written. */
export function locateBrokerIdentityFile(
  paths: CoreProjectPaths,
  deps: IdentityDependencies,
  brokerName: string
): string {
  return (
    findBrokerIdentityRecord(paths, deps, brokerName)?.filename ?? brokerIdentityPath(paths, deps, brokerName)
  );
}

export function readBrokerIdentity(
  paths: CoreProjectPaths,
  deps: IdentityDependencies,
  brokerName = path.basename(paths.projectRoot) || 'project'
): BrokerProcessIdentity | null {
  return findBrokerIdentityRecord(paths, deps, brokerName)?.identity ?? null;
}

function readBrokerIdentityFile(
  filename: string,
  paths: CoreProjectPaths,
  deps: IdentityDependencies,
  brokerName: string
): BrokerProcessIdentity | null {
  try {
    const value = JSON.parse(deps.fs.readFileSync(filename, 'utf-8')) as BrokerProcessIdentity;
    if (
      !value ||
      value.version !== 1 ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      value.pid === deps.pid ||
      value.stateDirectory !== stateDirectory(paths, deps) ||
      typeof value.brokerName !== 'string' ||
      !value.brokerName.trim() ||
      value.brokerName !== brokerName ||
      typeof value.startedAt !== 'string' ||
      normalizedStart(value.startedAt) !== value.startedAt ||
      !value.lock ||
      !path.isAbsolute(value.lock.path) ||
      ![value.lock.device, value.lock.inode, value.lock.ctimeNs, value.lock.mtimeNs].every(
        (field) => typeof field === 'string' && /^[1-9]\d*$/.test(field)
      ) ||
      typeof value.executable !== 'string' ||
      !/^0x[0-9a-f]+:[1-9]\d*(,0x[0-9a-f]+:[1-9]\d*)*$/.test(value.executable)
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

export function readBrokerIdentities(
  paths: CoreProjectPaths,
  deps: IdentityDependencies
): BrokerProcessIdentity[] | null {
  const records: BrokerProcessIdentity[] = [];
  const seen = new Set<string>();
  for (const directory of identityDirectories(paths, deps)) {
    let filenames: string[];
    try {
      filenames = deps.fs.readdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      return null;
    }
    try {
      const prefix = identityPrefix(paths, deps);
      for (const filename of filenames) {
        if (!filename.startsWith(prefix)) continue;
        if (!new RegExp(`^${prefix}-[a-f0-9]{64}\\.json$`).test(filename)) return null;
        const filepath = path.join(directory, filename);
        const raw = JSON.parse(deps.fs.readFileSync(filepath, 'utf-8'));
        if (typeof raw?.brokerName !== 'string') return null;
        const identity = readBrokerIdentityFile(filepath, paths, deps, raw.brokerName);
        if (!identity || identityFilename(directory, paths, deps, identity.brokerName) !== filepath)
          return null;
        // The state-dir record shadows a legacy record for the same broker name.
        if (seen.has(identity.brokerName)) continue;
        seen.add(identity.brokerName);
        records.push(identity);
      }
    } catch {
      // A listed record disappearing is an uncertain snapshot, not legacy state.
      return null;
    }
  }
  return records;
}

export async function persistBrokerIdentity(
  paths: CoreProjectPaths,
  pid: number,
  brokerName: string,
  deps: IdentityDependencies
): Promise<BrokerProcessIdentity | undefined> {
  const identity = await readBrokerProcessIdentity(pid, deps);
  if (!identity) return;
  const lock = await readHeldRuntimeLock(paths, pid, brokerName, deps);
  if (!lock) return;
  const confirmed = await readBrokerProcessIdentity(pid, deps);
  if (
    !confirmed ||
    confirmed.startedAt !== identity.startedAt ||
    confirmed.executable !== identity.executable
  )
    return;
  const filename = brokerIdentityPath(paths, deps, brokerName);
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
  const record = {
    version: 1,
    pid,
    stateDirectory: stateDirectory(paths, deps),
    brokerName,
    ...identity,
    lock,
  } satisfies BrokerProcessIdentity;
  try {
    deps.fs.mkdirSync(path.dirname(filename), { recursive: true });
    deps.fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, 'utf-8');
    deps.fs.renameSync(temporary, filename);
    removeSupersededIdentities(paths, filename, brokerName, deps);
    return record;
  } catch {
    // A failed write never grants fallback ownership of an unrecorded process.
  } finally {
    try {
      deps.fs.unlinkSync(temporary);
    } catch {
      /* Already renamed or unavailable. */
    }
  }
}

/**
 * The new record proves this launch holds the broker lock, so any record for
 * the same state dir and name in an older location describes a dead launch.
 * Left in place it would resurface once the new record is removed and keep
 * cleanup from deleting the stopped broker's connection file.
 */
function removeSupersededIdentities(
  paths: CoreProjectPaths,
  current: string,
  brokerName: string,
  deps: IdentityDependencies
): void {
  for (const directory of identityDirectories(paths, deps)) {
    const filename = identityFilename(directory, paths, deps, brokerName);
    if (filename === current) continue;
    try {
      deps.fs.unlinkSync(filename);
    } catch {
      /* Absent or unavailable. */
    }
  }
}

export async function matchesBrokerIdentity(
  identity: BrokerProcessIdentity,
  paths: CoreProjectPaths,
  deps: IdentityDependencies
): Promise<boolean> {
  // Persisted authorization can be revoked while shutdown waits or OS probes
  // run. A cached snapshot alone must never authorize another signal.
  const recorded = () => readBrokerIdentity(paths, deps, identity.brokerName);
  if (JSON.stringify(recorded()) !== JSON.stringify(identity)) return false;
  const current = await readBrokerProcessIdentity(identity.pid, deps);
  if (!current || current.startedAt !== identity.startedAt || current.executable !== identity.executable)
    return false;
  const lock = await readHeldRuntimeLock(paths, identity.pid, identity.brokerName, deps);
  return (
    lock !== null &&
    JSON.stringify(lock) === JSON.stringify(identity.lock) &&
    JSON.stringify(recorded()) === JSON.stringify(identity)
  );
}

/** A second-resolution ps birth alone cannot distinguish a rapid restart.
 * The broker truncates its runtime lock on every launch; nanosecond metadata
 * binds this record to that launch even when PID, binary, and birth second match.
 * Verify the OS open descriptor as well as the path so a replaced lock proves no ownership. */
async function readHeldRuntimeLock(
  paths: CoreProjectPaths,
  pid: number,
  brokerName: string,
  deps: IdentityDependencies
): Promise<BrokerProcessIdentity['lock'] | null> {
  try {
    if (!deps.fs.statSync || !deps.fs.realpathSync) return null;
    const lockPath = deps.fs.realpathSync(
      path.join(paths.dataDir, `broker-${brokerName.replace(/[^\p{Alphabetic}\p{Number}-]/gu, '-')}.lock`)
    );
    const snapshot = () => {
      const stat = deps.fs.statSync!(lockPath, { bigint: true });
      return {
        path: lockPath,
        device: stat.dev.toString(),
        inode: stat.ino.toString(),
        ctimeNs: stat.ctimeNs.toString(),
        mtimeNs: stat.mtimeNs.toString(),
      };
    };
    const before = snapshot();
    const fields = (await deps.execCommand(`lsof -nP -a -p ${pid} -FfnDi`)).stdout.trim().split('\n');
    if (fields.shift() !== `p${pid}`) return null;
    let descriptor: Record<string, string> = {};
    const descriptors: Record<string, string>[] = [];
    for (const field of fields) {
      if (field.startsWith('f')) {
        descriptor = {};
        descriptors.push(descriptor);
      }
      if (descriptor[field[0]] !== undefined) return null;
      descriptor[field[0]] = field.slice(1);
    }
    const matches = descriptors.filter(
      (entry) =>
        /^\d+$/.test(entry.f ?? '') &&
        entry.n === lockPath &&
        /^0x[0-9a-f]+$/i.test(entry.D ?? '') &&
        BigInt(entry.D).toString() === before.device &&
        entry.i === before.inode
    );
    if (matches.length !== 1 || JSON.stringify(snapshot()) !== JSON.stringify(before)) return null;
    return before;
  } catch {
    return null;
  }
}

/** Call only after observing exit of the matched process. Keep replacements. */
export function removeBrokerIdentity(
  paths: CoreProjectPaths,
  identity: BrokerProcessIdentity,
  deps: IdentityDependencies
): void {
  // Remove every location holding this exact record so a legacy copy cannot
  // outlive the process it describes.
  for (const directory of identityDirectories(paths, deps)) {
    const filename = identityFilename(directory, paths, deps, identity.brokerName);
    const current = readBrokerIdentityFile(filename, paths, deps, identity.brokerName);
    if (!current || JSON.stringify(current) !== JSON.stringify(identity)) continue;
    try {
      deps.fs.unlinkSync(filename);
    } catch {
      /* Best effort. */
    }
  }
}
