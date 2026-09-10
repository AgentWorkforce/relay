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

function stateDirectory(paths: CoreProjectPaths, deps?: IdentityDependencies): string {
  try {
    return (deps?.fs.realpathSync ?? fs.realpathSync)(paths.dataDir);
  } catch {
    return path.resolve(paths.dataDir);
  }
}

function identityPrefix(paths: CoreProjectPaths, deps?: IdentityDependencies): string {
  const scope = createHash('sha256').update(stateDirectory(paths, deps)).digest('hex');
  return `broker-identity-${scope}`;
}

export function brokerIdentityPath(
  paths: CoreProjectPaths,
  deps?: IdentityDependencies,
  brokerName = path.basename(paths.projectRoot) || 'project'
): string {
  const name = createHash('sha256').update(brokerName).digest('hex');
  return path.join(
    paths.projectRoot,
    '.agentworkforce',
    'relay',
    `${identityPrefix(paths, deps)}-${name}.json`
  );
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
    const details = (await deps.execCommand(`lsof -nP -a -p ${pid} -d txt -FDi`)).stdout;
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

export function readBrokerIdentity(
  paths: CoreProjectPaths,
  deps: IdentityDependencies,
  brokerName = path.basename(paths.projectRoot) || 'project'
): BrokerProcessIdentity | null {
  try {
    const value = JSON.parse(
      deps.fs.readFileSync(brokerIdentityPath(paths, deps, brokerName), 'utf-8')
    ) as BrokerProcessIdentity;
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
  const directory = path.join(paths.projectRoot, '.agentworkforce', 'relay');
  let filenames: string[];
  try {
    filenames = deps.fs.readdirSync(directory);
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? [] : null;
  }
  try {
    const prefix = identityPrefix(paths, deps);
    const records: BrokerProcessIdentity[] = [];
    for (const filename of filenames) {
      if (!filename.startsWith(prefix)) continue;
      if (!new RegExp(`^${prefix}-[a-f0-9]{64}\\.json$`).test(filename)) return null;
      const raw = JSON.parse(deps.fs.readFileSync(path.join(directory, filename), 'utf-8'));
      if (typeof raw?.brokerName !== 'string') return null;
      const identity = readBrokerIdentity(paths, deps, raw.brokerName);
      if (
        !identity ||
        brokerIdentityPath(paths, deps, identity.brokerName) !== path.join(directory, filename)
      )
        return null;
      records.push(identity);
    }
    return records;
  } catch {
    // A listed record disappearing is an uncertain snapshot, not legacy state.
    return null;
  }
}

export async function persistBrokerIdentity(
  paths: CoreProjectPaths,
  pid: number,
  brokerName: string,
  deps: IdentityDependencies
): Promise<void> {
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
  try {
    deps.fs.mkdirSync(path.dirname(filename), { recursive: true });
    deps.fs.writeFileSync(
      temporary,
      `${JSON.stringify({ version: 1, pid, stateDirectory: stateDirectory(paths, deps), brokerName, ...identity, lock } satisfies BrokerProcessIdentity)}\n`,
      'utf-8'
    );
    deps.fs.renameSync(temporary, filename);
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

export async function matchesBrokerIdentity(
  identity: BrokerProcessIdentity,
  paths: CoreProjectPaths,
  deps: IdentityDependencies
): Promise<boolean> {
  const current = await readBrokerProcessIdentity(identity.pid, deps);
  if (!current || current.startedAt !== identity.startedAt || current.executable !== identity.executable)
    return false;
  const lock = await readHeldRuntimeLock(paths, identity.pid, identity.brokerName, deps);
  return lock !== null && JSON.stringify(lock) === JSON.stringify(identity.lock);
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
  const current = readBrokerIdentity(paths, deps, identity.brokerName);
  if (!current || JSON.stringify(current) !== JSON.stringify(identity)) return;
  try {
    deps.fs.unlinkSync(brokerIdentityPath(paths, deps, identity.brokerName));
  } catch {
    /* Best effort. */
  }
}
