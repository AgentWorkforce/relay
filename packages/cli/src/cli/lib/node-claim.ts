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

/** Filename the broker writes its API endpoint and pid into, inside its state dir. */
const BROKER_CONNECTION_FILENAME = 'connection.json';

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
 * in place, so ownership is never dropped in between.
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
   * keeps it held: a supervisor that dies after its broker registered must not
   * leave that broker unprotected, and a broker that dies before its supervisor
   * has finished shutting down must not open the node id up while the socket is
   * still being torn down.
   */
  supervisor_pid?: number;
  supervisor_started_at?: string;
  /** `reserved` until a verified broker process owns the state dir. */
  status?: 'reserved' | 'active';
  claimed_at: string;
  /**
   * Sequence number encoded in this claim's filename. Ownership IS the
   * successful exclusive creation of `<node>.<generation>.json`: generations
   * only ever increase, so taking a node id over never means deleting somebody
   * else's file. See {@link acquireNodeClaim}.
   */
  generation?: number;
  /**
   * Unique per acquisition. A claim is only ever rewritten or removed by the
   * acquisition that created it, and this is how that is proven.
   */
  owner_token?: string;
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
   * Shell runner used to read a pid's birth time and command line. Every CLI
   * command passes its `CoreDependencies.execCommand`; without one the pid-reuse
   * check is skipped and a live pid simply reads as held. This module imports no
   * child_process itself so a claim check can be made from commands that mock
   * that module.
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
 * Thrown when ownership could not be established because other starts kept
 * winning the exclusive create.
 *
 * Each attempt is a handful of syscalls, so exhausting them means a pathological
 * amount of contention on one node id. Ownership cannot be established in that
 * state, and starting anyway is exactly the double registration this module
 * exists to prevent.
 */
export class NodeClaimContentionError extends Error {
  constructor(
    public readonly nodeId: string,
    public readonly claimsDir: string,
    cause?: unknown
  ) {
    super(
      `could not take ownership of node ${nodeId}: other agent-relay starts kept winning the claim in ${claimsDir}. ` +
        'Retry, or run `agent-relay node down` on the state dir that should keep the node.',
      { cause }
    );
    this.name = 'NodeClaimContentionError';
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

/* ------------------------------------------------------------------ *
 * Claim files and generations
 * ------------------------------------------------------------------ */

/** Zero padding, so claim generations sort lexically as well as numerically. */
const GENERATION_DIGITS = 6;
/** Matches `<stem>.<generation>.json` for any node. */
const CLAIM_FILENAME_PATTERN = new RegExp(`^(.+)\\.(\\d{${GENERATION_DIGITS},})\\.json$`);

/** Directory holding the claim files for every node id served on this machine. */
export function nodeClaimsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(relayHome(env), 'node-claims');
}

/**
 * Filename stem for a node id's claims. Node ids are engine-issued
 * (`node_<digits>`), but the stem is sanitized anyway so a hand-edited
 * enrollment store cannot write outside the claims directory. Readers verify
 * `node_id` from the file contents, so a sanitized collision is reported as a
 * conflict rather than silently overwriting another node's claim.
 */
function nodeClaimStem(nodeId: string): string {
  return (
    nodeId
      .trim()
      .replace(/[^\w.-]/g, '-')
      .slice(0, 96) || 'unnamed'
  );
}

/**
 * Path of one generation of a node id's claim.
 *
 * Every write this module makes is the exclusive creation of a NEW generation,
 * never an overwrite of an existing one — that is what makes takeover safe
 * without a lock file (see {@link acquireNodeClaim}).
 */
export function nodeClaimPath(nodeId: string, env: NodeJS.ProcessEnv = process.env, generation = 1): string {
  const suffix = String(generation).padStart(GENERATION_DIGITS, '0');
  return path.join(nodeClaimsDir(env), `${nodeClaimStem(nodeId)}.${suffix}.json`);
}

/** Resolve a state dir to its canonical path so two spellings compare equal. */
export function normalizeClaimStateDir(stateDir: string): string {
  try {
    return fs.realpathSync(stateDir);
  } catch {
    return path.resolve(stateDir);
  }
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalPositiveInteger(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) > 0);
}

function hasValidOptionalClaimFields(record: Record<string, unknown>): boolean {
  return (
    (record.api_port === undefined || Number.isSafeInteger(record.api_port)) &&
    isOptionalString(record.broker_name) &&
    isOptionalString(record.process_started_at) &&
    isOptionalString(record.supervisor_started_at) &&
    isOptionalString(record.owner_token) &&
    isOptionalPositiveInteger(record.supervisor_pid) &&
    isOptionalPositiveInteger(record.generation) &&
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

function readClaimFile(file: string): NodeClaim | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    return isNodeClaim(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

interface ClaimGeneration {
  generation: number;
  file: string;
  /** `null` for a file that is not a readable claim record. */
  claim: NodeClaim | null;
}

/**
 * Every generation file present for `nodeId`, ascending.
 *
 * Unreadable files are kept in the list with a `null` claim: they must still
 * raise the next generation number (or an exclusive create would collide with
 * them forever) even though they are no evidence of a live broker.
 */
function readClaimGenerations(nodeId: string, env: NodeJS.ProcessEnv): ClaimGeneration[] {
  const dir = nodeClaimsDir(env);
  const stem = nodeClaimStem(nodeId);
  let filenames: string[];
  try {
    filenames = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const generations: ClaimGeneration[] = [];
  for (const filename of filenames) {
    const match = CLAIM_FILENAME_PATTERN.exec(filename);
    if (!match || match[1] !== stem) continue;
    const file = path.join(dir, filename);
    generations.push({ generation: Number.parseInt(match[2], 10), file, claim: readClaimFile(file) });
  }
  return generations.sort((left, right) => left.generation - right.generation);
}

/** The generation that currently owns the node id: the highest readable one. */
function currentGeneration(generations: ClaimGeneration[]): ClaimGeneration | undefined {
  for (let index = generations.length - 1; index >= 0; index -= 1) {
    if (generations[index].claim) return generations[index];
  }
  return undefined;
}

function highestGenerationNumber(generations: ClaimGeneration[]): number {
  return generations.length === 0 ? 0 : generations[generations.length - 1].generation;
}

/**
 * The claim that currently owns `nodeId`, or `null`.
 *
 * A missing, unreadable, or malformed file reads as `null`: an unparseable
 * claim is no evidence of a live broker, and treating it as one would brick
 * every later `node up` for that node id.
 */
export function readNodeClaim(nodeId: string, env: NodeJS.ProcessEnv = process.env): NodeClaim | null {
  return currentGeneration(readClaimGenerations(nodeId, env))?.claim ?? null;
}

/** The current claim for every node id on this machine, newest first. */
export function listNodeClaims(env: NodeJS.ProcessEnv = process.env): NodeClaim[] {
  const dir = nodeClaimsDir(env);
  let filenames: string[];
  try {
    filenames = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const newestByStem = new Map<string, { generation: number; claim: NodeClaim }>();
  for (const filename of filenames) {
    const match = CLAIM_FILENAME_PATTERN.exec(filename);
    if (!match) continue;
    const claim = readClaimFile(path.join(dir, filename));
    if (!claim) continue;
    const generation = Number.parseInt(match[2], 10);
    const seen = newestByStem.get(match[1]);
    if (!seen || seen.generation < generation) {
      newestByStem.set(match[1], { generation, claim });
    }
  }
  return [...newestByStem.values()]
    .map((entry) => entry.claim)
    .sort((left, right) => right.claimed_at.localeCompare(left.claimed_at));
}

/* ------------------------------------------------------------------ *
 * Liveness
 * ------------------------------------------------------------------ */

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

/** Pid recorded in `<state dir>/connection.json`, which the broker writes itself. */
function readStateDirBrokerPid(stateDir: string): number | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(stateDir, BROKER_CONNECTION_FILENAME), 'utf-8')
    ) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const pid = (parsed as Record<string, unknown>).pid;
    return Number.isSafeInteger(pid) && (pid as number) > 0 ? (pid as number) : null;
  } catch {
    return null;
  }
}

/**
 * Whether `pid` looks like an agent-relay broker rather than an unrelated
 * process that inherited the number.
 *
 * Reads as "yes" whenever `ps` cannot be consulted: this only ever decides
 * whether to KEEP guarding a node id, and a spurious refusal is recoverable
 * (`--force`) while a wrong "free" verdict is the silent delivery outage.
 */
async function looksLikeBrokerProcess(
  pid: number,
  stateDir: string,
  deps: NodeClaimDependencies
): Promise<boolean> {
  const execCommand = deps.execCommand;
  if (!execCommand) return true;
  try {
    const { stdout } = await execCommand(`LC_ALL=C ps -p ${pid} -o args=`);
    const args = stdout.trim();
    if (!args) return false;
    return args.includes('agent-relay') || args.includes('relay-broker') || args.includes(stateDir);
  } catch {
    return true;
  }
}

/**
 * A live broker serving `stateDir`, discovered from the connection file the
 * broker writes itself.
 *
 * This is the ownership evidence that survives the supervising CLI. The Rust
 * broker writes `<state dir>/connection.json` (with its own pid) as soon as its
 * API listener binds — BEFORE `connect_relay` and before `node.register` is
 * queued (crates/broker/src/runtime/init.rs) — so a broker that was orphaned by
 * a SIGKILLed supervisor before the CLI could record its pid is still
 * discoverable by every other start on the machine. Without it, such an orphan
 * reads as "nobody home" and the next `node up` evicts its delivery socket.
 */
export async function findLiveStateDirBroker(
  stateDir: string,
  deps: NodeClaimDependencies = {}
): Promise<{ pid: number; startedAt?: string } | null> {
  const pid = readStateDirBrokerPid(stateDir);
  if (pid === null || !isProcessAlive(pid, deps)) {
    return null;
  }
  if (!(await looksLikeBrokerProcess(pid, stateDir, deps))) {
    return null;
  }
  const startedAt = await readProcessStartedAt(pid, deps);
  return { pid, ...(startedAt ? { startedAt } : {}) };
}

/**
 * Classify a claim for `nodeId` — the read-only view used by preflight guards
 * and diagnostics.
 *
 * A claim is retired only when every process it names is provably gone (the pid
 * no longer exists, or its birth time no longer matches the one recorded) AND
 * no live broker occupies its state dir. Everything else — including a `ps` we
 * cannot run — reads as held, because refusing is recoverable (`--force`,
 * `node down`) while a wrong "free" verdict silently cuts delivery to a live
 * broker.
 */
export async function inspectNodeClaim(
  nodeId: string,
  deps: NodeClaimDependencies = {}
): Promise<NodeClaimState> {
  const env = deps.env ?? process.env;
  const generations = readClaimGenerations(nodeId, env);
  const claim = currentGeneration(generations)?.claim ?? null;
  if (!claim) {
    return { state: 'unclaimed' };
  }
  return classifyNodeClaim(nodeId, claim, env, deps);
}

async function classifyNodeClaim(
  nodeId: string,
  claim: NodeClaim,
  env: NodeJS.ProcessEnv,
  deps: NodeClaimDependencies
): Promise<NodeClaimState> {
  if (claim.node_id.trim() !== nodeId.trim()) {
    // Sanitized filenames can collide. Report it instead of overwriting the
    // other node's claim, which would leave that broker unguarded.
    return {
      state: 'held',
      claim,
      reason: `claim file ${nodeClaimPath(nodeId, env, claim.generation ?? 1)} records node ${claim.node_id}`,
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
  // Every recorded pid is gone, but a broker this claim started can have
  // outlived them: the supervisor may have been SIGKILLed between the spawn and
  // the moment it could record the broker's pid. The broker's own connection
  // file is the ownership record that survives that.
  const orphan = await findLiveStateDirBroker(claim.state_dir, deps);
  if (orphan) {
    return {
      state: 'held',
      claim: {
        ...claim,
        pid: orphan.pid,
        ...(orphan.startedAt ? { process_started_at: orphan.startedAt } : {}),
        supervisor_pid: undefined,
        status: 'active',
      },
      reason:
        `${reasons.join('; ')}, but broker pid ${orphan.pid} recorded in ` +
        `${path.join(claim.state_dir, BROKER_CONNECTION_FILENAME)} is still running`,
    };
  }
  return { state: 'stale', claim, reason: reasons.join('; ') };
}

/** Live claims on this machine, for locating a broker across state dirs. */
export async function listHeldNodeClaims(deps: NodeClaimDependencies = {}): Promise<NodeClaim[]> {
  const env = deps.env ?? process.env;
  const held: NodeClaim[] = [];
  for (const claim of listNodeClaims(env)) {
    const status = await classifyNodeClaim(claim.node_id, claim, env, deps);
    if (status.state === 'held') {
      held.push(status.claim);
    }
  }
  return held;
}

/* ------------------------------------------------------------------ *
 * Acquire / adopt / release
 * ------------------------------------------------------------------ */

/**
 * How many generations to try before giving up. Each attempt only loses to a
 * start that genuinely won the node id, so more than a couple means the machine
 * is starting brokers for one node id in a tight loop.
 */
const CLAIM_ACQUIRE_ATTEMPTS = 8;

/**
 * Create a claim file that does not exist yet, with its full contents already
 * in place.
 *
 * The record is written to a private temp file and hard-linked into its
 * generation path: `link(2)` fails with `EEXIST` rather than clobbering, so the
 * create is both exclusive AND atomic. A reader can therefore never observe a
 * half-written claim — which matters, because a torn read of a live broker's
 * claim would read as "node id free".
 *
 * @returns False when that generation already exists.
 */
function createClaimGeneration(file: string, claim: NodeClaim): boolean {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(claim, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.linkSync(temporary, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') return false;
    throw error;
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Already gone; the hard link (if any) keeps the contents alive.
    }
  }
}

function safeUnlinkClaim(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // Already gone, or not ours to remove.
  }
}

async function buildClaim(
  input: AcquireNodeClaimInput,
  generation: number,
  deps: NodeClaimDependencies
): Promise<NodeClaim> {
  const startedAt = await readProcessStartedAt(input.pid, deps);
  const supervisorPid = input.supervisorPid ?? input.pid;
  const supervisorStartedAt =
    supervisorPid === input.pid ? startedAt : await readProcessStartedAt(supervisorPid, deps);
  return {
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
    generation,
    owner_token: crypto.randomUUID(),
  };
}

/**
 * Record ownership of `nodeId`, refusing if a live local broker already holds
 * it.
 *
 * Ownership IS the exclusive creation of the next generation file. Generations
 * only increase and each one is created exactly once, so taking a node id over
 * never involves deleting a file another process might have replaced in the
 * meantime — the failure mode that makes "validate the holder, then remove its
 * record, then write ours" unsafe no matter how the validation is fenced.
 *
 * Two starts that both observe the same stale claim therefore cannot both win:
 * one creates generation N+1, the other collides (`EEXIST`) and re-reads, now
 * seeing the winner's live claim. A start that created its generation while a
 * third one was creating a higher one loses the confirm step below, removes its
 * own file and refuses. Exactly one — the highest generation — survives.
 *
 * Callers reserve with `status: 'reserved'` and their own pid BEFORE spawning a
 * broker, then hand ownership to the verified broker with {@link adoptNodeClaim}.
 *
 * @throws NodeClaimConflictError when a live local broker holds the node id and
 * `force` was not requested.
 * @throws NodeClaimContentionError when no generation could be won at all.
 */
export async function acquireNodeClaim(input: AcquireNodeClaimInput): Promise<NodeClaim> {
  const env = input.env ?? process.env;
  const deps: NodeClaimDependencies = { ...input, env };
  const nodeId = input.nodeId.trim();
  for (let attempt = 0; attempt < CLAIM_ACQUIRE_ATTEMPTS; attempt += 1) {
    const generations = readClaimGenerations(nodeId, env);
    const current = currentGeneration(generations)?.claim;
    if (current && current.pid !== input.pid && !input.force) {
      const status = await classifyNodeClaim(nodeId, current, env, deps);
      if (status.state === 'held') {
        throw new NodeClaimConflictError(nodeId, status.claim);
      }
    }
    const generation = highestGenerationNumber(generations) + 1;
    const file = nodeClaimPath(nodeId, env, generation);
    const claim = await buildClaim(input, generation, deps);
    if (!createClaimGeneration(file, claim)) {
      // Another start took this generation between the scan and the create.
      // Re-read: its claim is what decides whether we may continue at all.
      continue;
    }
    const winner = currentGeneration(readClaimGenerations(nodeId, env));
    if (winner && winner.generation > generation) {
      // A start that read our generation as free-to-take created a higher one.
      // It owns the node id now; drop ours so two files cannot both read live.
      safeUnlinkClaim(file);
      throw new NodeClaimConflictError(nodeId, winner.claim ?? claim);
    }
    for (const superseded of generations) {
      safeUnlinkClaim(superseded.file);
    }
    return claim;
  }
  throw new NodeClaimContentionError(nodeId, nodeClaimsDir(env));
}

function isSameAcquisition(current: NodeClaim | null, claim: NodeClaim): boolean {
  if (!current) return false;
  if (claim.owner_token) return current.owner_token === claim.owner_token;
  // Claims written before this process (or by hand) carry no token; fall back
  // to the identity the record does have.
  return (
    current.node_id === claim.node_id && current.pid === claim.pid && current.state_dir === claim.state_dir
  );
}

/**
 * Hand a reservation to the verified broker process that now owns the state
 * dir.
 *
 * Only the acquisition that created a generation ever rewrites it, so this is a
 * conflict-free in-place update — but it is still conditional on that
 * generation still being the highest: a `--force` takeover that landed while
 * this broker was starting has already won the node id, and continuing would
 * put two brokers back on one delivery socket. Losing here fails startup, which
 * tears this broker down.
 *
 * @throws NodeClaimConflictError when the reservation no longer owns the node id.
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
  const generation = reservation.generation ?? 1;
  const file = nodeClaimPath(reservation.node_id, env, generation);
  const before = readClaimGenerations(reservation.node_id, env);
  if (highestGenerationNumber(before) > generation || !isSameAcquisition(readClaimFile(file), reservation)) {
    throw new NodeClaimConflictError(reservation.node_id, currentGeneration(before)?.claim ?? reservation);
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
  // Atomic replace of OUR generation only: readers see the reservation or the
  // adopted record, never a partial write, and never another start's file.
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(claim, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  const after = readClaimGenerations(reservation.node_id, env);
  if (highestGenerationNumber(after) > generation) {
    // A takeover landed during the write. It owns the node id; give ours up
    // rather than leaving a second live-looking record behind.
    safeUnlinkClaim(file);
    throw new NodeClaimConflictError(reservation.node_id, currentGeneration(after)?.claim ?? claim);
  }
  return claim;
}

/**
 * Drop a claim this start owns.
 *
 * Only the acquisition that created a generation ever removes it, and the
 * generation path is unique to that acquisition, so no other process's claim
 * can be deleted here. The read and the unlink are adjacent syscalls with no
 * await in between.
 */
export async function releaseNodeClaim(
  claim: NodeClaim,
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  const file = nodeClaimPath(claim.node_id, env, claim.generation ?? 1);
  if (!isSameAcquisition(readClaimFile(file), claim)) {
    return false;
  }
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Release the claims a broker pid held in a state dir. `node down` stops a
 * broker it did not start, so it cannot name the node id the claim was written
 * for — the pid and state dir it verified are what it has.
 *
 * A claim for that state dir whose every recorded pid is already dead is
 * released too: that is the orphan left by a supervisor that was killed before
 * it could record its broker's pid, and `down` has just proven the state dir's
 * broker is gone.
 */
export async function releaseNodeClaimsForBroker(input: {
  pid: number;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  killProcess?: NodeClaimDependencies['killProcess'];
  execCommand?: NodeClaimDependencies['execCommand'];
}): Promise<NodeClaim[]> {
  const env = input.env ?? process.env;
  const deps: NodeClaimDependencies = { ...input, env };
  const stateDir = normalizeClaimStateDir(input.stateDir);
  const released: NodeClaim[] = [];
  for (const claim of listNodeClaims(env)) {
    if (claim.state_dir !== stateDir) continue;
    const namesThisBroker = claim.pid === input.pid || claim.supervisor_pid === input.pid;
    if (!namesThisBroker) {
      const status = await classifyNodeClaim(claim.node_id, claim, env, deps);
      if (status.state !== 'stale') continue;
    }
    if (await releaseNodeClaim(claim, env)) {
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
