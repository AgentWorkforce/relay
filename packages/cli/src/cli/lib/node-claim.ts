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
 *
 * Neither phase depends on a process surviving long enough to record anything:
 * the reservation also opens a hold descriptor that the broker child inherits
 * across `fork` ({@link nodeClaimHoldPath}), so a supervisor killed anywhere
 * between the spawn and the broker's first write still leaves a claim the
 * kernel answers for.
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
   * Absolute path of the executable this start resolved to run as its broker,
   * and that file's `<device>:<inode>` at the moment it was recorded.
   *
   * This is what a later start compares a live process against when it has to
   * decide whether that process is the broker holding the node id. The broker
   * binary is operator-selectable (`AGENT_RELAY_BIN` / `BROKER_BINARY_PATH`)
   * and a supported deployment may run it under any filename, so looking for
   * `agent-relay` in a command line ruled exactly such a broker OUT — the
   * "node id free" verdict that evicts a live broker's delivery socket. Both
   * are best effort; see {@link classifyHolderProcess} for what their absence
   * means.
   */
  broker_binary?: string;
  broker_executable?: string;
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
   * successful exclusive creation of `<node>.<generation>.json`.
   *
   * A number is issued at most once for the life of the stem: releasing leaves
   * a tombstone rather than removing the file, so `max(generation)` never
   * decreases and no suspended start can wake up and re-create a number that
   * has since been handed to somebody else. See {@link acquireNodeClaim} and
   * {@link NodeClaimTombstone}.
   */
  generation?: number;
  /**
   * Unique per acquisition. A claim is only ever rewritten or removed by the
   * acquisition that created it, and this is how that is proven.
   */
  owner_token?: string;
}

/**
 * What a released generation leaves behind in place of its claim.
 *
 * Deleting the record outright made generation numbers reusable: once the last
 * file for a node id was gone the next start began again at generation 1, and a
 * start that had been suspended since before the release could then re-create a
 * number that had already been handed out — winning the node id from a live
 * successor and pruning that successor's file from its own stale scan. The
 * tombstone is what keeps `max(generation)` monotonic for the lifetime of the
 * stem: {@link releaseNodeClaim} never removes the last file, so the number can
 * never be issued twice. It is not a claim ({@link isNodeClaim} rejects it), so
 * it reads as "node id free" and is pruned by the next acquisition, which has
 * already created a strictly higher generation.
 */
interface NodeClaimTombstone {
  version: 1;
  released: true;
  node_id: string;
  generation: number;
  released_at: string;
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
  /**
   * Path of the executable this start will run as the broker, recorded so a
   * later start can recognise that process by executable identity rather than
   * by its filename. See {@link NodeClaim.broker_binary}.
   */
  brokerBinary?: string;
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
 * Thrown when the kernel-level ownership fence could not be established.
 *
 * The hold descriptor is what makes a claim survive its own supervisor, so a
 * start that cannot open one cannot honour the guarantee it is claiming under.
 * It refuses instead of spawning an unfenced broker.
 */
export class NodeClaimHoldError extends Error {
  constructor(
    public readonly nodeId: string,
    public readonly holdPath: string,
    cause?: unknown
  ) {
    super(
      `could not establish the ownership fence for node ${nodeId} at ${holdPath}: ` +
        `${cause instanceof Error ? cause.message : String(cause)}. ` +
        'Startup was stopped rather than run a broker that another start could silently take the node from. ' +
        'Ensure the claims directory is writable and has free space, then retry.',
      { cause }
    );
    this.name = 'NodeClaimHoldError';
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

/**
 * Sibling of a claim generation whose OPEN DESCRIPTORS are the ownership
 * evidence, held by the kernel rather than written by a process.
 *
 * `<stem>.<generation>.hold` is created and opened by the supervising CLI
 * BEFORE it spawns a broker, and the descriptor is inherited by the child
 * across `fork`. From the instant a broker child exists — long before it binds
 * its API, writes `connection.json` or queues `node.register` — some live
 * process holds this file open, and the kernel drops the last reference the
 * moment both of them die. That is what closes the window a supervisor
 * SIGKILLed between the spawn and the broker's first write used to leave: there
 * is no interval in which a competing start can see "dead supervisor, nothing
 * published" and conclude the node id is free while the orphan is on its way to
 * registering.
 *
 * Not matched by {@link CLAIM_FILENAME_PATTERN} (which requires `.json`), so it
 * never counts as a generation of its own.
 */
export function nodeClaimHoldPath(
  nodeId: string,
  env: NodeJS.ProcessEnv = process.env,
  generation = 1
): string {
  return `${nodeClaimPath(nodeId, env, generation).slice(0, -'.json'.length)}.hold`;
}

/** Single-quote a path for a shell command (`AGENT_RELAY_HOME` is operator input). */
function shellQuote(value: string): string {
  // Close the quoted run, emit an escaped quote, reopen: '  ->  '\''
  return `'${value.split("'").join("'\\''")}'`;
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
    isOptionalString(record.broker_binary) &&
    isOptionalString(record.broker_executable) &&
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
  // A tombstone occupies a generation number so it can never be reissued, but
  // it is evidence of nothing. Rejecting it here is what makes it read as an
  // unclaimed node id everywhere a claim is read.
  if (record.released === true) return false;
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

/** Exact bytes of a claim file, or `null` when it cannot be read at all. */
function readClaimBytes(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

function parseClaim(raw: string | null): NodeClaim | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isNodeClaim(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readClaimFile(file: string): NodeClaim | null {
  return parseClaim(readClaimBytes(file));
}

interface ClaimGeneration {
  generation: number;
  file: string;
  /** `null` for a file that is not a readable claim record. */
  claim: NodeClaim | null;
  /**
   * The bytes this scan saw. Re-read before the file is pruned, so a generation
   * is only ever removed while it still holds exactly what was classified.
   */
  raw: string | null;
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
    const raw = readClaimBytes(file);
    generations.push({ generation: Number.parseInt(match[2], 10), file, raw, claim: parseClaim(raw) });
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

/** What a claim knows about the executable its broker runs as. */
interface BrokerExecutableHint {
  /** Resolved broker state directory, which the broker carries in its argv. */
  stateDir: string;
  /** Absolute path of the broker executable, recorded at claim time. */
  binary?: string;
  /** `<device>:<inode>` of that executable, as `lsof -d txt` reports it. */
  object?: string;
}

function brokerExecutableHint(claim: NodeClaim): BrokerExecutableHint {
  return {
    stateDir: claim.state_dir,
    ...(claim.broker_binary ? { binary: claim.broker_binary } : {}),
    ...(claim.broker_executable ? { object: claim.broker_executable } : {}),
  };
}

/**
 * Identity of the executable file a claim's start was going to run, for the
 * record. `realpathSync` first so a claim written through a symlinked install
 * path still names the file a running broker maps.
 */
function describeBrokerExecutable(
  binary: string | undefined
): Pick<NodeClaim, 'broker_binary' | 'broker_executable'> {
  if (!binary) return {};
  try {
    const resolved = fs.realpathSync(binary);
    const stats = fs.statSync(resolved, { bigint: true });
    return {
      broker_binary: resolved,
      broker_executable: `0x${stats.dev.toString(16)}:${stats.ino.toString()}`,
    };
  } catch {
    // The path is still worth recording: a process running it is recognisable
    // by argv even when the file cannot be stat'ed from here.
    return path.isAbsolute(binary) ? { broker_binary: binary } : {};
  }
}

/**
 * What a live process that turned up holding a node id is.
 *
 * `unidentified` is NOT `unrelated`. It means the claim recorded nothing to
 * compare the process against — it was written by an older CLI, or by a start
 * that could not resolve its broker binary — so the process is neither
 * confirmed nor ruled out. The two call sites decide differently, because they
 * differ in what an unknown process is likely to be.
 */
type HolderVerdict = 'broker' | 'unrelated' | 'unidentified';

/**
 * The executable objects `pid` is running, as `<device>:<inode>` pairs, or
 * `null` when they cannot be read.
 *
 * `txt` mappings identify an executable by device and inode on both macOS and
 * Linux, which is the only handle on "what is this process running" that does
 * not go through a filename. Same command and same field encoding as
 * `readBrokerProcessIdentity` in `broker-process-identity.ts`, so the two agree
 * on what an executable's identity is.
 */
async function readExecutableObjects(pid: number, deps: NodeClaimDependencies): Promise<Set<string> | null> {
  const execCommand = deps.execCommand;
  if (!execCommand) return null;
  let stdout: string;
  try {
    ({ stdout } = await execCommand(`LC_ALL=C lsof -nP -a -p ${pid} -d txt -FfDi`));
  } catch {
    return null;
  }
  const fields = stdout.trim().split('\n');
  if (fields.shift() !== `p${pid}`) return null;
  const objects = new Set<string>();
  for (let index = 0; index < fields.length; index += 3) {
    const [descriptor, device, inode] = fields.slice(index, index + 3);
    if (descriptor !== 'ftxt' || !/^D0x[0-9a-f]+$/i.test(device ?? '') || !/^i[1-9]\d*$/.test(inode ?? '')) {
      return null;
    }
    objects.add(`${device.slice(1).toLowerCase()}:${inode.slice(1)}`);
  }
  return objects.size > 0 ? objects : null;
}

/**
 * Whether `pid` is the broker a claim names, an unrelated process that merely
 * inherited its descriptor or its pid number, or something this claim has no
 * way to tell apart.
 *
 * Executable identity decides it: the device and inode of the file the process
 * is running, against the broker executable the claim recorded. Command lines
 * are consulted only as further POSITIVE evidence and never to rule a process
 * out. `AGENT_RELAY_BIN` / `BROKER_BINARY_PATH` let a supported deployment run
 * the broker under any filename, and with the default state dir such a broker
 * carries neither `agent-relay` nor its state dir in argv — so the name test
 * that used to decide this classified a real, live broker as unrelated and
 * handed its node id to the next start.
 *
 * Anything that cannot be consulted — no runner, an `lsof` or `ps` that fails —
 * reads as `broker`: this only ever decides whether to KEEP guarding a node id,
 * and a spurious refusal is recoverable (`--force`, `node down`) while a wrong
 * "free" verdict is the silent delivery outage.
 */
async function classifyHolderProcess(
  pid: number,
  hint: BrokerExecutableHint,
  deps: NodeClaimDependencies
): Promise<HolderVerdict> {
  const execCommand = deps.execCommand;
  if (!execCommand) return 'broker';
  if (hint.object) {
    const objects = await readExecutableObjects(pid, deps);
    // Unreadable mappings are not a mismatch: the process may simply not be
    // ours to inspect.
    if (objects === null) return 'broker';
    if (objects.has(hint.object)) return 'broker';
  }
  let args: string;
  try {
    const { stdout } = await execCommand(`LC_ALL=C ps -p ${pid} -o args=`);
    args = stdout.trim();
  } catch {
    return 'broker';
  }
  // `ps` answered with nothing: the pid is gone, so it holds nothing.
  if (!args) return 'unrelated';
  if (hint.binary && (args === hint.binary || args.startsWith(`${hint.binary} `))) return 'broker';
  if (args.includes('agent-relay') || args.includes('relay-broker') || args.includes(hint.stateDir)) {
    return 'broker';
  }
  return hint.object || hint.binary ? 'unrelated' : 'unidentified';
}

/**
 * Whether any live process still holds this generation's hold file open.
 *
 * `lsof -t` answers from the kernel's open-file table, so this reports the
 * broker child a SIGKILLed supervisor left behind from the instant that child
 * exists — there is no publish step to wait for and nothing to go stale. The
 * exit status is read from an explicit marker rather than from the runner's
 * error shape: `lsof` exits 1 with no output when a file simply has no holders,
 * and that has to be told apart from an `lsof` that could not run at all.
 *
 * An `lsof` that cannot be consulted reads as HELD, matching the rest of this
 * module: `node up` already refuses to start without a usable `lsof` (it is how
 * broker process identity is verified), and a spurious refusal is recoverable
 * with `--force` or `node down` while a wrong "free" verdict is the silent
 * delivery outage the claim exists to prevent.
 *
 * Holders are classified by {@link classifyHolderProcess}, exactly as the
 * connection file's pid is. An inherited descriptor is not close-on-exec, so
 * anything the broker itself spawns inherits it too; a harness left running by
 * a SIGKILLed broker would otherwise pin the node id with no broker anywhere
 * near it. Only a holder positively identified as running some OTHER executable
 * is dropped: a holder the claim cannot classify at all stays a holder, because
 * nothing but a Relay start ever passes this descriptor on and a spurious
 * refusal is recoverable while a wrong "free" verdict is not.
 *
 * `selfPids` are dropped from the holder set: a start re-reading its own
 * reservation still has that generation's descriptor open, and its own
 * descriptor is not evidence that somebody else owns the node id.
 */
async function inspectClaimHold(
  claim: NodeClaim,
  env: NodeJS.ProcessEnv,
  deps: NodeClaimDependencies,
  selfPids?: ReadonlySet<number>
): Promise<{ held: boolean; reason: string; pids: number[] }> {
  const file = nodeClaimHoldPath(claim.node_id, env, claim.generation ?? 1);
  if (!fs.existsSync(file)) {
    return { held: false, reason: `no start holds ${file}`, pids: [] };
  }
  const execCommand = deps.execCommand;
  if (!execCommand) {
    return { held: true, reason: `open descriptors on ${file} could not be checked`, pids: [] };
  }
  let stdout: string;
  try {
    ({ stdout } = await execCommand(
      `LC_ALL=C lsof -t -- ${shellQuote(file)} 2>/dev/null; printf 'rc=%d' "$?"`
    ));
  } catch {
    return { held: true, reason: `open descriptors on ${file} could not be checked`, pids: [] };
  }
  const status = /rc=(\d+)/.exec(stdout);
  const pids = stdout
    .replace(/rc=\d+/, '')
    .split(/\s+/)
    .map((value) => value.trim())
    .filter((value) => /^\d+$/.test(value))
    .filter((value) => !selfPids?.has(Number(value)));
  const hint = brokerExecutableHint(claim);
  const brokers: string[] = [];
  for (const pid of pids) {
    if ((await classifyHolderProcess(Number(pid), hint, deps)) !== 'unrelated') brokers.push(pid);
  }
  if (brokers.length > 0) {
    return {
      held: true,
      reason: `pid ${brokers.join(', ')} still holds ${file} open`,
      pids: brokers.map(Number),
    };
  }
  if (pids.length > 0) {
    return {
      held: false,
      reason: `only unrelated processes (pid ${pids.join(', ')}) hold ${file} open`,
      pids: [],
    };
  }
  // `lsof` exits 1 for "no holders"; anything else means it could not answer.
  if (!status || (status[1] !== '0' && status[1] !== '1')) {
    return { held: true, reason: `open descriptors on ${file} could not be checked`, pids: [] };
  }
  return { held: false, reason: `no process holds ${file} open`, pids: [] };
}

/**
 * Whether anything other than `selfPids` still holds this claim's generation
 * fenced, for a caller deciding whether ownership may be dropped.
 *
 * A release has to consult this, not just the pids on the record. The record
 * names a broker only once a start got far enough to capture one: a spawn that
 * rejects before it returns a client — a handshake that never completed, a
 * SIGTERM the child outlived — leaves a broker child that no pid anywhere names,
 * and releasing on "no live pid recorded" tombstones the claim and unlinks the
 * hold file out from under a process that is still fenced by it. The next start
 * then reads the node id as free while that child can still register. The
 * descriptor is the one piece of evidence that exists from the instant the child
 * does, so it is what decides.
 *
 * Holders are filtered exactly as {@link inspectNodeClaim} filters them, so a
 * release never frees a node id that another start would still read as held.
 */
export async function inspectNodeClaimHold(
  claim: NodeClaim,
  deps: NodeClaimDependencies = {},
  selfPids?: ReadonlySet<number>
): Promise<{ held: boolean; reason: string; pids: number[] }> {
  return inspectClaimHold(claim, deps.env ?? process.env, deps, selfPids);
}

/**
 * Create and open this generation's hold file, handing the supervising CLI the
 * descriptor it passes to the broker child.
 *
 * Created exclusively (`wx`): only the acquisition that won the generation ever
 * creates it, so a concurrent start can never replace the inode a live child is
 * holding. Opened BEFORE the spawn, because a fence established after `fork`
 * would leave exactly the gap it exists to close.
 *
 * Failing to establish the hold is FATAL to the start, which is why this throws
 * rather than reporting a missing fence. Without the descriptor, a supervisor
 * killed between the fork and the broker's `connection.json` write leaves a
 * claim with only dead pids and no evidence at all — so the next start reads
 * the node id as free and evicts a broker that is about to register. Continuing
 * would mean spawning a broker under a guarantee that is not actually in force,
 * which is worse than not starting: the operator can see and fix a refusal.
 *
 * @throws NodeClaimHoldError when the hold could not be established. Any
 * partially created file and descriptor are cleaned up first, so a retry (or a
 * later start, on the next generation) is not blocked by this one's debris.
 */
export function openNodeClaimHold(claim: NodeClaim, env: NodeJS.ProcessEnv = process.env): number {
  const generation = claim.generation ?? 1;
  const file = nodeClaimHoldPath(claim.node_id, env, generation);
  let fd: number | undefined;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fd = fs.openSync(file, 'wx', 0o600);
    // Contents are operator-facing only; the evidence is the open descriptor.
    fs.writeSync(
      fd,
      `${JSON.stringify({ node_id: claim.node_id, generation, supervisor_pid: claim.pid, state_dir: claim.state_dir }, null, 2)}\n`
    );
    return fd;
  } catch (error) {
    // Drop our reference before unlinking: an fd we opened and then abandoned
    // would keep answering `lsof` for as long as this process lives, pinning a
    // node id behind a fence nothing is actually being fenced by.
    closeNodeClaimHold(fd);
    if (fd !== undefined) safeUnlinkClaim(file);
    throw new NodeClaimHoldError(claim.node_id, file, error);
  }
}

/** Drop this process's reference to a hold file. Other holders keep it alive. */
export function closeNodeClaimHold(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    fs.closeSync(fd);
  } catch {
    // Already closed, or never ours.
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
  deps: NodeClaimDependencies = {},
  /** What the claim for this state dir knows about its broker executable. */
  hint: { binary?: string; object?: string } = {}
): Promise<{ pid: number; startedAt?: string } | null> {
  const pid = readStateDirBrokerPid(stateDir);
  if (pid === null || !isProcessAlive(pid, deps)) {
    return null;
  }
  // Unlike the hold descriptor, this pid was read from a file and can have been
  // recycled by any process on the machine, with no relationship to Relay at
  // all. Only a positive identification keeps the node id guarded here.
  if ((await classifyHolderProcess(pid, { stateDir, ...hint }, deps)) !== 'broker') {
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

/**
 * Decide whether `claim` still names a live owner.
 *
 * `selfPids` names processes that ARE the caller. They are skipped as recorded
 * holders — a process cannot be a competing broker against itself — but they
 * suppress nothing else: the orphan fences below still run in full, because a
 * pid the caller happens to share (its own, or one recycled from the dead
 * supervisor this claim records) says nothing about the broker that supervisor
 * may have left registered.
 */
async function classifyNodeClaim(
  nodeId: string,
  claim: NodeClaim,
  env: NodeJS.ProcessEnv,
  deps: NodeClaimDependencies,
  selfPids?: ReadonlySet<number>
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
    if (selfPids?.has(candidate.pid)) {
      reasons.push(`${candidate.role} pid ${candidate.pid} is this start itself`);
      continue;
    }
    const status = await isRecordedProcessAlive(candidate.pid, candidate.startedAt, deps);
    if (status.alive) {
      return { state: 'held', claim, reason: `${candidate.role} ${status.reason}` };
    }
    reasons.push(`${candidate.role} ${status.reason}`);
  }
  // Every recorded pid is gone, but a broker this claim started can have
  // outlived them: the supervisor may have been SIGKILLed between the spawn and
  // the moment it could record the broker's pid.
  //
  // The hold descriptor is checked FIRST because it is the only evidence that
  // exists for the whole life of that orphan. A broker child inherits it across
  // `fork`, so it answers even while the child is still paused before binding
  // its API — the window in which `connection.json` does not exist yet and the
  // old "dead supervisor, nothing published" reading let a second broker start.
  const hold = await inspectClaimHold(claim, env, deps, selfPids);
  if (hold.held) {
    return {
      state: 'held',
      // Report the pid that is actually holding the node, not the supervisor
      // the record still names — that one is what was just proven dead, and an
      // operator told to stop it would be chasing a process that is gone.
      claim: {
        ...claim,
        ...(hold.pids[0] !== undefined ? { pid: hold.pids[0] } : {}),
        supervisor_pid: undefined,
      },
      reason: `${reasons.join('; ')}, but ${hold.reason}`,
    };
  }
  // Then the broker's own connection file, which survives a supervisor that
  // died after its child had published but before it could record the pid.
  const orphan = await findLiveStateDirBroker(claim.state_dir, deps, {
    binary: claim.broker_binary,
    object: claim.broker_executable,
  });
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

/** Replace a claim file in place, atomically, so no reader sees a partial write. */
function writeClaimRecordAtomically(file: string, record: NodeClaim | NodeClaimTombstone): void {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function safeUnlinkClaim(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // Already gone, or not ours to remove.
  }
}

/**
 * Remove a generation this acquisition has superseded, and its hold file.
 *
 * Only removed while the file still holds the exact bytes the scan classified.
 * Generation numbers are never reissued (see {@link NodeClaimTombstone}), so a
 * path cannot come back as somebody else's claim — but the scan that chose
 * these files happened before an `await`, and pruning by path alone is what
 * deleted a live successor's record when a number COULD be reissued. Comparing
 * the bytes makes the check local instead of resting on that invariant.
 */
function pruneSupersededGeneration(entry: ClaimGeneration, nodeId: string, env: NodeJS.ProcessEnv): void {
  if (readClaimBytes(entry.file) !== entry.raw) {
    return;
  }
  safeUnlinkClaim(entry.file);
  safeUnlinkClaim(nodeClaimHoldPath(nodeId, env, entry.generation));
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
    ...describeBrokerExecutable(input.brokerBinary),
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
 * only increase and each one is created exactly once — for the whole life of
 * the stem, not just while a claim is live: {@link releaseNodeClaim} leaves a
 * tombstone in place of the record it drops, so the highest number on disk
 * never falls back. Taking a node id over therefore never involves deleting a
 * file another process might have replaced in the meantime — the failure mode
 * that makes "validate the holder, then remove its record, then write ours"
 * unsafe no matter how the validation is fenced.
 *
 * Without that, a start suspended between the scan and the create could wake up
 * after a complete release-and-reacquire cycle, re-create a number that had
 * been reissued to a live successor, pass the higher-generation check because
 * its own file was the highest again, and then prune that successor's claim
 * from its own stale scan. Both would stay alive with one of them recorded —
 * exactly the double registration this module exists to prevent.
 *
 * Two starts that both observe the same stale claim therefore cannot both win:
 * one creates generation N+1, the other collides (`EEXIST`) and re-reads, now
 * seeing the winner's live claim. A start that created its generation while a
 * third one was creating a higher one loses the confirm step below, removes its
 * own file and refuses. Exactly one — the highest generation NUMBER ever issued
 * for the stem, live claim or spent tombstone — can own the node id, which is
 * the invariant the post-create check below enforces.
 *
 * Callers reserve with `status: 'reserved'` and their own pid BEFORE spawning a
 * broker, open the generation's hold descriptor with {@link openNodeClaimHold}
 * so the child inherits it, and then hand ownership to the verified broker with
 * {@link adoptNodeClaim}.
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
    if (current && !input.force) {
      // Our own pid is never evidence that somebody else holds the node id, so
      // a start may re-take a claim that records it. That exemption is scoped
      // to the pid AS A RECORDED HOLDER and nothing more: the fence still runs.
      //
      // Exempting the whole check on pid equality (as this once did) was
      // unsound, because a pid is not an identity. A supervisor that died
      // leaving a registered broker behind records a pid the OS is free to
      // reissue, and the next start to be handed that number would have walked
      // straight past the orphan its own claim was pointing at.
      const status = await classifyNodeClaim(nodeId, current, env, deps, new Set([input.pid]));
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
    const after = readClaimGenerations(nodeId, env);
    if (highestGenerationNumber(after) > generation) {
      // Somebody else has already been ISSUED a higher generation number, so
      // this one cannot be the owner — whatever that higher file holds now.
      //
      // The test is the highest NUMBER on disk and not the highest live claim:
      // a spent generation is a file too. A start suspended since before a
      // release cycle could otherwise wake up, re-create a low number in the
      // gap the cycle's pruning left, see only tombstones above it and declare
      // itself the owner — while the start that had already read those
      // tombstones goes on to create `max + 1`. Neither one's prune list names
      // the other (each scanned before the other's file existed), so both stay
      // live and both spawn. Only the record with the highest number ever
      // issued can own the node id.
      safeUnlinkClaim(file);
      const winner = currentGeneration(after);
      if (winner && winner.generation > generation) {
        // A live claim above ours: that start legitimately won the node id.
        throw new NodeClaimConflictError(nodeId, winner.claim ?? claim);
      }
      // Only spent or unreadable generations sit above ours, so the node id
      // itself is free — this number just is not ours to hold. Re-scan and take
      // one above the highest file on disk instead.
      continue;
    }
    for (const superseded of generations) {
      pruneSupersededGeneration(superseded, nodeId, env);
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
  writeClaimRecordAtomically(file, claim);
  const after = readClaimGenerations(reservation.node_id, env);
  if (highestGenerationNumber(after) > generation) {
    // A takeover landed during the write. It owns the node id; give ours up
    // rather than leaving a second live-looking record behind.
    safeUnlinkClaim(file);
    safeUnlinkClaim(nodeClaimHoldPath(reservation.node_id, env, generation));
    throw new NodeClaimConflictError(reservation.node_id, currentGeneration(after)?.claim ?? claim);
  }
  return claim;
}

/**
 * Drop a claim this start owns, leaving its generation number spent.
 *
 * The record is REPLACED by a tombstone rather than removed. Removing it made
 * the number reusable, and a suspended start could then re-create a generation
 * that had since been handed to somebody else: it would pass the
 * higher-generation check (its own file was the highest again) and prune the
 * successor's live claim from its own stale scan, leaving two brokers alive on
 * one node id with only one of them recorded. A tombstone keeps
 * `max(generation)` from ever decreasing, so no number is issued twice; it
 * parses as no claim at all, so the node id reads free immediately; and the
 * next acquisition prunes it, so at most one spent file per node id is ever on
 * disk.
 *
 * Only the acquisition that created a generation ever rewrites it, proven by
 * `owner_token`, and the read and the write are adjacent syscalls with no await
 * in between.
 */
export async function releaseNodeClaim(
  claim: NodeClaim,
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  const generation = claim.generation ?? 1;
  const file = nodeClaimPath(claim.node_id, env, generation);
  if (!isSameAcquisition(readClaimFile(file), claim)) {
    return false;
  }
  try {
    writeClaimRecordAtomically(file, {
      version: 1,
      released: true,
      node_id: claim.node_id,
      generation,
      released_at: new Date().toISOString(),
    });
  } catch {
    return false;
  }
  // The hold descriptor protected this generation only; both processes it
  // fenced are gone by the time a release is allowed to run.
  safeUnlinkClaim(nodeClaimHoldPath(claim.node_id, env, generation));
  return true;
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
