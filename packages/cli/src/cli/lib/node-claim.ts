import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The machine-global Relay home that holds `fleet-enrollments.json`.
 *
 * Deliberately not imported from `@agent-relay/cloud`: that barrel pulls the
 * Cloud SSH runtime, and a claim check must stay a couple of syscalls that any
 * command can make. `node-claim.test.ts` pins this to the enrollment store's
 * own directory so the two cannot drift apart.
 */
function relayHome(env: NodeJS.ProcessEnv): string {
  return env.AGENT_RELAY_HOME ?? path.join(os.homedir(), '.agentworkforce/relay');
}

/**
 * Machine-local record of which live broker serves an enrolled node id.
 *
 * The Fleet enrollment store (`~/.agentworkforce/relay/fleet-enrollments.json`)
 * is machine-global and NOT scoped to a broker state dir, so two `node up`
 * invocations in different projects — or with different `--state-dir` values —
 * happily adopt the same node id. The second registration takes over that
 * node's Cloud delivery socket and the first broker stops receiving messages
 * with no error on either side. This claim is the machine-local mutual
 * exclusion the enrollment store does not provide.
 *
 * Ownership moves through two phases. A supervising CLI first *reserves* the
 * node id (`status: 'reserved'`, `pid` = the CLI's own) BEFORE it spawns
 * anything, because the broker queues `node.register` during its own
 * initialization — any claim written after the spawn is written after the
 * delivery socket could already have moved. Once a verified broker process
 * exists the reservation is *adopted* (`status: 'active'`, `pid` = the broker's)
 * under the same interprocess lock, so ownership is never dropped in between.
 */
export interface NodeClaim {
  version: 1;
  node_id: string;
  /**
   * PID that owns the node id: the supervising CLI while the claim is
   * `reserved`, the broker process holding the node-control socket once it is
   * `active`.
   */
  pid: number;
  /** Resolved broker state directory (`--state-dir`, or the project default). */
  state_dir: string;
  /** Broker HTTP API port, for pointing an operator at the live process. */
  api_port?: number;
  /** Registered broker/node name, when the start resolved one. */
  broker_name?: string;
  /**
   * `ps -o lstart` of `pid` at claim time. A PID alone cannot survive a reboot
   * or wraparound: without this, an unrelated process that inherits the number
   * would read as a live claim forever.
   */
  process_started_at?: string;
  /**
   * PID of the CLI supervising the broker, recorded from the reservation
   * onward. After adoption the claim names both, and either one being alive
   * keeps it held: a supervisor that dies between spawn and verification must
   * not leave a registered broker unprotected, and a broker that dies before
   * its supervisor has finished shutting down must not open the node id up
   * while the socket is still being torn down.
   */
  supervisor_pid?: number;
  supervisor_started_at?: string;
  /** `reserved` until a verified broker process owns the state dir. */
  status?: 'reserved' | 'active';
  claimed_at: string;
}

/** Whether a node id is free to serve, held by a live broker, or left behind. */
export type NodeClaimState =
  /** No claim file, or one that cannot be trusted to describe a live broker. */
  | { state: 'unclaimed' }
  /** A live local broker serves this node id; adopting it would evict its socket. */
  | { state: 'held'; claim: NodeClaim; reason: string }
  /** A claim file survives a broker that no longer runs; safe to take over. */
  | { state: 'stale'; claim: NodeClaim; reason: string };

export interface NodeClaimDependencies {
  /** Process environment, for the `AGENT_RELAY_HOME` override. */
  env?: NodeJS.ProcessEnv;
  /** Signal sender used for liveness probes. Defaults to `process.kill`. */
  killProcess?: (pid: number, signal?: NodeJS.Signals | number) => void;
  /**
   * Shell runner used to read a pid's birth time. Every CLI command passes its
   * `CoreDependencies.execCommand`; without one the pid-reuse check is skipped
   * and a live pid simply reads as held. This module imports no child_process
   * itself so a claim check can be made from commands that mock that module.
   */
  execCommand?: (command: string) => Promise<{ stdout: string; stderr: string }>;
}

export interface AcquireNodeClaimInput extends NodeClaimDependencies {
  nodeId: string;
  /** PID that will own the node id (the supervising CLI, for a reservation). */
  pid: number;
  stateDir: string;
  apiPort?: number;
  brokerName?: string;
  /** Take the node over from a live broker instead of refusing. */
  force?: boolean;
  /** `reserved` (pre-spawn) or `active` (a verified broker owns the state dir). */
  status?: 'reserved' | 'active';
  /** Supervising CLI pid, when it differs from the owning `pid`. */
  supervisorPid?: number;
}

/** Thrown when a live local broker already serves the requested node id. */
export class NodeClaimConflictError extends Error {
  constructor(
    public readonly nodeId: string,
    public readonly claim: NodeClaim
  ) {
    super(
      `node ${nodeId} is already served by a live local broker (pid ${claim.pid}, state dir ${claim.state_dir}). ` +
        'Stop it with `agent-relay node down --state-dir <dir>`, serve a different enrolled node, or re-run with --force.'
    );
    this.name = 'NodeClaimConflictError';
  }
}

/**
 * Thrown when the per-node interprocess lock could not be taken.
 *
 * The lock is held for a handful of syscalls and is broken automatically once
 * its owner is provably gone, so a timeout means a live process is wedged
 * holding it. Ownership cannot be established in that state, and starting
 * anyway is exactly the double-registration this module exists to prevent.
 */
export class NodeClaimLockError extends Error {
  constructor(
    public readonly nodeId: string,
    public readonly lockPath: string,
    cause?: unknown
  ) {
    super(
      `could not take the ownership lock for node ${nodeId} (${lockPath}). ` +
        'Another agent-relay process is holding it; retry, or remove the lock file if no relay process is running.',
      { cause }
    );
    this.name = 'NodeClaimLockError';
  }
}

/**
 * Directory the broker caches minted node tokens in, mirroring the Rust
 * `dirs::data_local_dir()/agent-relay/node-tokens`. Both candidates are
 * returned because `dirs` uses `$XDG_DATA_HOME` on Linux and
 * `~/Library/Application Support` on macOS; probing both keeps this check
 * erring toward "a token exists", which errs toward guarding the node id.
 */
function nodeTokenCacheDirs(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME ?? os.homedir();
  const candidates = [
    env.XDG_DATA_HOME ? path.join(env.XDG_DATA_HOME, 'agent-relay', 'node-tokens') : undefined,
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'agent-relay', 'node-tokens')
      : path.join(home, '.local', 'share', 'agent-relay', 'node-tokens'),
  ];
  return candidates.filter((value): value is string => value !== undefined);
}

/**
 * Filename stem the broker caches a node token under. Mirrors
 * `sanitize_node_id_for_filename` in `crates/broker/src/node_control.rs`: keep
 * ASCII alphanumerics, `-` and `_`; everything else becomes `_`.
 */
function sanitizeNodeIdForTokenFilename(nodeId: string): string {
  const sanitized = nodeId.replace(/[^A-Za-z0-9_-]/g, '_');
  return sanitized.length > 0 ? sanitized : 'node';
}

/** Every path the broker might read a cached token for `nodeId` from. */
export function nodeTokenCachePaths(nodeId: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const file = `${sanitizeNodeIdForTokenFilename(nodeId)}.json`;
  return nodeTokenCacheDirs(env).map((dir) => path.join(dir, file));
}

/**
 * Whether the broker can authenticate as `nodeId` from its on-disk token cache
 * alone.
 *
 * `resolve_cached_node_token` (crates/broker/src/runtime/init.rs) falls back to
 * this cache when `RELAY_NODE_TOKEN` is unset, so a start carrying only
 * `RELAY_NODE_ID` can still register — and evict — that node. The workspace and
 * engine scoping the broker also applies is deliberately NOT re-checked here:
 * the CLI cannot know which workspace the broker will resolve until after it
 * has started, and guarding a node id the broker turns out not to register is
 * recoverable (`--force`, a different enrollment) while missing one is the
 * silent delivery outage this module exists to prevent.
 */
export function hasCachedNodeToken(nodeId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  for (const file of nodeTokenCachePaths(nodeId, env)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
      if (typeof parsed !== 'object' || parsed === null) continue;
      const record = parsed as Record<string, unknown>;
      if (record.node_id !== nodeId) continue;
      if (typeof record.token === 'string' && record.token.trim().length > 0) return true;
    } catch {
      // No cache here (or an unreadable one); try the next candidate.
    }
  }
  return false;
}

/**
 * The enrolled node id a start will register as, or `undefined` when it will
 * mint its own identity.
 *
 * `RELAY_NODE_ID` is sent verbatim in `node.register`, so it is the identity
 * that can evict another broker — but only if the broker can authenticate as
 * it. The broker resolves that credential from `RELAY_NODE_TOKEN` first and
 * then from its per-node token cache, so both sources have to be considered
 * here: guarding only the env token left a start with a cached token free to
 * walk past a live claim and take the node's delivery socket.
 */
export function enrolledNodeIdForClaim(env: NodeJS.ProcessEnv): string | undefined {
  const nodeId = env.RELAY_NODE_ID?.trim();
  if (!nodeId) {
    return undefined;
  }
  if (env.RELAY_NODE_TOKEN?.trim()) {
    return nodeId;
  }
  return hasCachedNodeToken(nodeId, env) ? nodeId : undefined;
}

/** Directory holding one claim file per enrolled node id served on this machine. */
export function nodeClaimsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(relayHome(env), 'node-claims');
}

/**
 * Filename for a node id's claim. Node ids are engine-issued (`node_<digits>`),
 * but the filename is sanitized anyway so a hand-edited enrollment store cannot
 * write outside the claims directory. Readers verify `node_id` from the file
 * contents, so a sanitized collision is reported as a conflict rather than
 * silently overwriting another node's claim.
 */
export function nodeClaimPath(nodeId: string, env: NodeJS.ProcessEnv = process.env): string {
  const safe =
    nodeId
      .trim()
      .replace(/[^\w.-]/g, '-')
      .slice(0, 96) || 'unnamed';
  return path.join(nodeClaimsDir(env), `${safe}.json`);
}

/** Lock guarding every read-modify-write of one node id's claim file. */
export function nodeClaimLockPath(nodeId: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${nodeClaimPath(nodeId, env)}.lock`;
}

/** Resolve a state dir to its canonical path so two spellings compare equal. */
export function normalizeClaimStateDir(stateDir: string): string {
  try {
    return fs.realpathSync(stateDir);
  } catch {
    return path.resolve(stateDir);
  }
}

function hasValidOptionalClaimFields(record: Record<string, unknown>): boolean {
  return (
    (record.api_port === undefined || Number.isSafeInteger(record.api_port)) &&
    (record.broker_name === undefined || typeof record.broker_name === 'string') &&
    (record.process_started_at === undefined || typeof record.process_started_at === 'string') &&
    (record.supervisor_started_at === undefined || typeof record.supervisor_started_at === 'string') &&
    (record.supervisor_pid === undefined ||
      (Number.isSafeInteger(record.supervisor_pid) && (record.supervisor_pid as number) > 0)) &&
    (record.status === undefined || record.status === 'reserved' || record.status === 'active')
  );
}

function isNodeClaim(value: unknown): value is NodeClaim {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.node_id === 'string' &&
    record.node_id.trim().length > 0 &&
    Number.isSafeInteger(record.pid) &&
    (record.pid as number) > 0 &&
    typeof record.state_dir === 'string' &&
    record.state_dir.length > 0 &&
    typeof record.claimed_at === 'string' &&
    hasValidOptionalClaimFields(record)
  );
}

/**
 * Read a claim file. A missing, unreadable, or malformed file reads as `null`:
 * an unparseable claim is no evidence of a live broker, and treating it as one
 * would brick every later `node up` for that node id.
 */
export function readNodeClaim(nodeId: string, env: NodeJS.ProcessEnv = process.env): NodeClaim | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(nodeClaimPath(nodeId, env), 'utf-8')) as unknown;
    return isNodeClaim(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Every readable claim on this machine, newest first. */
export function listNodeClaims(env: NodeJS.ProcessEnv = process.env): NodeClaim[] {
  let filenames: string[];
  try {
    filenames = fs.readdirSync(nodeClaimsDir(env));
  } catch {
    return [];
  }
  const claims: NodeClaim[] = [];
  for (const filename of filenames) {
    if (!filename.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(nodeClaimsDir(env), filename), 'utf-8')) as unknown;
      if (isNodeClaim(parsed)) claims.push(parsed);
    } catch {
      // A torn or foreign file in this directory proves nothing; skip it.
    }
  }
  return claims.sort((left, right) => right.claimed_at.localeCompare(left.claimed_at));
}

function isProcessAlive(pid: number, deps: NodeClaimDependencies): boolean {
  const kill =
    deps.killProcess ??
    ((target: number, signal?: NodeJS.Signals | number) => {
      process.kill(target, signal);
    });
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    // Permission denial proves the process exists and is not ours to inspect;
    // that must read as live, never as a free node id.
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * `ps` birth time for a pid, or `null` when it cannot be read. Mirrors the
 * command `broker-process-identity` uses so both agree on the format.
 */
async function readProcessStartedAt(pid: number, deps: NodeClaimDependencies): Promise<string | null> {
  const execCommand = deps.execCommand;
  if (!execCommand) {
    return null;
  }
  try {
    const { stdout } = await execCommand(`LC_ALL=C TZ=UTC ps -p ${pid} -o lstart=`);
    const normalized = stdout.trim().replace(/\s+/g, ' ');
    return normalized.length > 0 ? normalized : null;
  } catch {
    return null;
  }
}

/**
 * Whether `pid` is still the process that was recorded with `startedAt`.
 * A pid that is gone, or one whose birth time moved (the number was recycled),
 * no longer holds anything.
 */
async function isRecordedProcessAlive(
  pid: number,
  startedAt: string | undefined,
  deps: NodeClaimDependencies
): Promise<{ alive: boolean; reason: string }> {
  if (!isProcessAlive(pid, deps)) {
    return { alive: false, reason: `pid ${pid} is no longer running` };
  }
  if (startedAt) {
    const current = await readProcessStartedAt(pid, deps);
    if (current && current !== startedAt) {
      return { alive: false, reason: `pid ${pid} was recycled by a process started ${current}` };
    }
  }
  return { alive: true, reason: `pid ${pid} is running` };
}

/** The owning pid plus, when the claim records one, its supervising CLI. */
function claimProcesses(claim: NodeClaim): { pid: number; startedAt?: string; role: string }[] {
  const processes = [
    {
      pid: claim.pid,
      startedAt: claim.process_started_at,
      role: claim.status === 'reserved' ? 'supervisor' : 'broker',
    },
  ];
  if (claim.supervisor_pid !== undefined && claim.supervisor_pid !== claim.pid) {
    processes.push({
      pid: claim.supervisor_pid,
      startedAt: claim.supervisor_started_at,
      role: 'supervisor',
    });
  }
  return processes;
}

/**
 * Classify a claim for `nodeId` without taking the lock — this is the read-only
 * view used by preflight guards and diagnostics.
 *
 * A claim is retired only when every process it names is provably gone: the pid
 * no longer exists, or its birth time no longer matches the one recorded (the
 * number was recycled). Everything else — including a `ps` we cannot run —
 * reads as held, because refusing is recoverable (`--force`, `node down`) while
 * a wrong "free" verdict silently cuts delivery to a live broker.
 */
export async function inspectNodeClaim(
  nodeId: string,
  deps: NodeClaimDependencies = {}
): Promise<NodeClaimState> {
  const env = deps.env ?? process.env;
  const claim = readNodeClaim(nodeId, env);
  if (!claim) {
    return { state: 'unclaimed' };
  }
  if (claim.node_id.trim() !== nodeId.trim()) {
    // Sanitized filenames can collide. Report it instead of overwriting the
    // other node's claim, which would leave that broker unguarded.
    return {
      state: 'held',
      claim,
      reason: `claim file ${nodeClaimPath(nodeId, env)} records node ${claim.node_id}`,
    };
  }
  const reasons: string[] = [];
  for (const candidate of claimProcesses(claim)) {
    const status = await isRecordedProcessAlive(candidate.pid, candidate.startedAt, deps);
    if (status.alive) {
      return { state: 'held', claim, reason: `${candidate.role} ${status.reason}` };
    }
    reasons.push(`${candidate.role} ${status.reason}`);
  }
  return { state: 'stale', claim, reason: reasons.join('; ') };
}

/** Live claims on this machine, for locating a broker across state dirs. */
export async function listHeldNodeClaims(deps: NodeClaimDependencies = {}): Promise<NodeClaim[]> {
  const env = deps.env ?? process.env;
  const held: NodeClaim[] = [];
  for (const claim of listNodeClaims(env)) {
    const status = await inspectNodeClaim(claim.node_id, deps);
    if (status.state === 'held' && status.claim.pid === claim.pid) {
      held.push(claim);
    }
  }
  return held;
}

/* ------------------------------------------------------------------ *
 * Interprocess lock
 * ------------------------------------------------------------------ */

/** How long to keep retrying before giving up on the lock. */
const CLAIM_LOCK_TIMEOUT_MS = 10_000;
/** Backoff between retries. The critical section is a few syscalls long. */
const CLAIM_LOCK_POLL_MS = 15;
/**
 * A lock is only broken once its owner is provably gone AND the lock is older
 * than this. The age requirement means a lock that was just created can never
 * be caught in another process's break, whatever that process read earlier.
 */
const CLAIM_LOCK_BREAK_AFTER_MS = 5_000;

interface NodeClaimLockRecord {
  pid: number;
  process_started_at?: string;
  acquired_at: string;
  /** Unique per acquisition, so a lock is only ever released by its owner. */
  token: string;
}

function readLockRecord(lockPath: string): NodeClaimLockRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) return null;
    if (typeof record.token !== 'string' || typeof record.acquired_at !== 'string') return null;
    return record as unknown as NodeClaimLockRecord;
  } catch {
    return null;
  }
}

function lockFileAgeMs(lockPath: string, record: NodeClaimLockRecord | null): number {
  const acquiredAt = record ? Date.parse(record.acquired_at) : Number.NaN;
  if (Number.isFinite(acquiredAt)) {
    return Date.now() - acquiredAt;
  }
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Recover a lock whose holder crashed.
 *
 * Both conditions must hold: the recorded pid is provably gone (or the record
 * is unreadable), and the lock is older than `CLAIM_LOCK_BREAK_AFTER_MS`. The
 * record is re-read immediately before the unlink and must be byte-identical,
 * so a lock that was replaced in the meantime — by the process that already
 * broke it — is left alone. A live holder therefore can never be broken: it
 * fails the liveness test on every pass.
 */
async function breakStaleLock(lockPath: string, deps: NodeClaimDependencies): Promise<void> {
  const before = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf-8') : null;
  if (before === null) return;
  const record = readLockRecord(lockPath);
  if (lockFileAgeMs(lockPath, record) < CLAIM_LOCK_BREAK_AFTER_MS) return;
  if (record) {
    const owner = await isRecordedProcessAlive(record.pid, record.process_started_at, deps);
    if (owner.alive) return;
  }
  try {
    // Re-read under the same name: if anything replaced the lock while we were
    // probing its owner, that replacement is a different (live) acquisition.
    if (fs.readFileSync(lockPath, 'utf-8') !== before) return;
    fs.unlinkSync(lockPath);
  } catch {
    // Someone else broke it first, or we cannot; the retry loop handles both.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Serialize every read-modify-write of one node id's claim across processes.
 *
 * Exclusion comes from `open(O_CREAT|O_EXCL)`, which is atomic on every
 * filesystem this CLI supports. Crash recovery comes from `breakStaleLock`.
 * Holding this lock is what makes "inspect, then decide, then write" a single
 * indivisible step — without it two starts both observe an absent or stale
 * claim and both write, which is the double registration the claim exists to
 * prevent.
 */
async function withNodeClaimLock<T>(
  nodeId: string,
  deps: NodeClaimDependencies,
  run: () => Promise<T>
): Promise<T> {
  const env = deps.env ?? process.env;
  const lockPath = nodeClaimLockPath(nodeId, env);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const startedAt = await readProcessStartedAt(process.pid, deps);
  const record: NodeClaimLockRecord = {
    pid: process.pid,
    ...(startedAt ? { process_started_at: startedAt } : {}),
    acquired_at: new Date().toISOString(),
    token: crypto.randomUUID(),
  };
  const body = JSON.stringify(record);
  const deadline = Date.now() + CLAIM_LOCK_TIMEOUT_MS;
  let lastError: unknown;
  let acquired = false;
  while (!acquired) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, body);
      } finally {
        fs.closeSync(fd);
      }
      acquired = true;
      break;
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        throw new NodeClaimLockError(nodeId, lockPath, error);
      }
    }
    await breakStaleLock(lockPath, deps);
    if (Date.now() >= deadline) {
      throw new NodeClaimLockError(nodeId, lockPath, lastError);
    }
    await sleep(CLAIM_LOCK_POLL_MS);
  }
  try {
    return await run();
  } finally {
    try {
      // Only drop a lock that is still ours: if it was broken and retaken we
      // would otherwise unlink the new holder's lock.
      if (fs.readFileSync(lockPath, 'utf-8') === body) fs.unlinkSync(lockPath);
    } catch {
      // Already gone.
    }
  }
}

/* ------------------------------------------------------------------ *
 * Acquire / adopt / release
 * ------------------------------------------------------------------ */

function writeClaimFile(claim: NodeClaim, env: NodeJS.ProcessEnv): void {
  const file = nodeClaimPath(claim.node_id, env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(claim, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Already renamed into place.
    }
  }
}

/**
 * Record ownership of `nodeId`, refusing if a live local broker already holds
 * it.
 *
 * The inspection and the write happen under the node's interprocess lock, so
 * two concurrent starts are serialized: whichever takes the lock second sees
 * the first's claim and loses. Without that lock both could observe the same
 * absent-or-stale claim and both rename their own file into place.
 *
 * Callers reserve with `status: 'reserved'` and their own pid BEFORE spawning a
 * broker, then hand ownership to the verified broker with {@link adoptNodeClaim}.
 *
 * @throws NodeClaimConflictError when a live local broker holds the node id and
 * `force` was not requested.
 * @throws NodeClaimLockError when exclusion could not be established.
 */
export async function acquireNodeClaim(input: AcquireNodeClaimInput): Promise<NodeClaim> {
  const env = input.env ?? process.env;
  const deps: NodeClaimDependencies = { ...input, env };
  return withNodeClaimLock(input.nodeId, deps, async () => {
    const status = await inspectNodeClaim(input.nodeId, deps);
    if (status.state === 'held' && status.claim.pid !== input.pid && !input.force) {
      throw new NodeClaimConflictError(input.nodeId, status.claim);
    }
    const startedAt = await readProcessStartedAt(input.pid, deps);
    const supervisorPid = input.supervisorPid ?? input.pid;
    const supervisorStartedAt =
      supervisorPid === input.pid ? startedAt : await readProcessStartedAt(supervisorPid, deps);
    const claim: NodeClaim = {
      version: 1,
      node_id: input.nodeId.trim(),
      pid: input.pid,
      state_dir: normalizeClaimStateDir(input.stateDir),
      ...(input.apiPort !== undefined ? { api_port: input.apiPort } : {}),
      ...(input.brokerName ? { broker_name: input.brokerName } : {}),
      ...(startedAt ? { process_started_at: startedAt } : {}),
      supervisor_pid: supervisorPid,
      ...(supervisorStartedAt ? { supervisor_started_at: supervisorStartedAt } : {}),
      status: input.status ?? 'active',
      claimed_at: new Date().toISOString(),
    };
    writeClaimFile(claim, env);
    return claim;
  });
}

/**
 * Hand a reservation to the verified broker process that now owns the state
 * dir, under the same lock that guards acquisition.
 *
 * The update is conditional: if the claim no longer names the reservation
 * (another start took the node over with `--force`, or an operator removed it)
 * the caller has already lost the node id and must not overwrite the winner.
 *
 * @throws NodeClaimConflictError when the reservation is gone.
 */
export async function adoptNodeClaim(input: {
  reservation: NodeClaim;
  /** PID of the verified broker process holding the node-control socket. */
  pid: number;
  apiPort?: number;
  brokerName?: string;
  env?: NodeJS.ProcessEnv;
  killProcess?: NodeClaimDependencies['killProcess'];
  execCommand?: NodeClaimDependencies['execCommand'];
}): Promise<NodeClaim> {
  const env = input.env ?? process.env;
  const deps: NodeClaimDependencies = { ...input, env };
  const { reservation } = input;
  return withNodeClaimLock(reservation.node_id, deps, async () => {
    const current = readNodeClaim(reservation.node_id, env);
    if (
      !current ||
      current.node_id !== reservation.node_id ||
      current.pid !== reservation.pid ||
      current.state_dir !== reservation.state_dir
    ) {
      throw new NodeClaimConflictError(reservation.node_id, current ?? reservation);
    }
    const startedAt = await readProcessStartedAt(input.pid, deps);
    const claim: NodeClaim = {
      ...reservation,
      pid: input.pid,
      ...(input.apiPort !== undefined ? { api_port: input.apiPort } : {}),
      ...(input.brokerName ? { broker_name: input.brokerName } : {}),
      ...(startedAt ? { process_started_at: startedAt } : {}),
      supervisor_pid: reservation.pid,
      ...(reservation.process_started_at ? { supervisor_started_at: reservation.process_started_at } : {}),
      status: 'active',
    };
    if (!startedAt) delete claim.process_started_at;
    writeClaimFile(claim, env);
    return claim;
  });
}

/**
 * Drop a claim this broker owns.
 *
 * The read and the unlink happen under the node's interprocess lock, so the
 * "still names me" check cannot be invalidated between them. Without the lock a
 * replacement claim written in that window was deleted by the supervisor it had
 * just replaced, leaving the new broker unguarded.
 */
export async function releaseNodeClaim(
  claim: NodeClaim,
  env: NodeJS.ProcessEnv = process.env,
  deps: NodeClaimDependencies = {}
): Promise<boolean> {
  const scoped: NodeClaimDependencies = { ...deps, env };
  try {
    return await withNodeClaimLock(claim.node_id, scoped, async () => {
      const current = readNodeClaim(claim.node_id, env);
      if (
        !current ||
        current.node_id !== claim.node_id ||
        current.pid !== claim.pid ||
        current.state_dir !== claim.state_dir
      ) {
        return false;
      }
      try {
        fs.unlinkSync(nodeClaimPath(claim.node_id, env));
        return true;
      } catch {
        return false;
      }
    });
  } catch (error) {
    if (error instanceof NodeClaimLockError) {
      // Leaving a claim behind is recoverable — its pids are dead, so it reads
      // as stale. Deleting one we could not prove is ours is not.
      return false;
    }
    throw error;
  }
}

/**
 * Release every claim held by a broker pid in a state dir. `node down` stops a
 * broker it did not start, so it cannot name the node id the claim was written
 * for — the pid and state dir it verified are what it has.
 */
export async function releaseNodeClaimsForBroker(input: {
  pid: number;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  killProcess?: NodeClaimDependencies['killProcess'];
  execCommand?: NodeClaimDependencies['execCommand'];
}): Promise<NodeClaim[]> {
  const env = input.env ?? process.env;
  const stateDir = normalizeClaimStateDir(input.stateDir);
  const released: NodeClaim[] = [];
  for (const claim of listNodeClaims(env)) {
    if (claim.pid !== input.pid || claim.state_dir !== stateDir) continue;
    if (await releaseNodeClaim(claim, env, input)) {
      released.push(claim);
    }
  }
  return released;
}

/** One-line description of the broker holding a claim, for operator output. */
export function describeNodeClaimHolder(claim: NodeClaim): string {
  const parts = [`pid ${claim.pid}`, `state dir ${claim.state_dir}`];
  if (claim.api_port !== undefined) parts.push(`API port ${claim.api_port}`);
  if (claim.broker_name) parts.push(`broker name ${claim.broker_name}`);
  if (claim.status === 'reserved') parts.push('starting up');
  return parts.join(', ');
}
