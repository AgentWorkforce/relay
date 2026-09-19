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
 */
export interface NodeClaim {
  version: 1;
  node_id: string;
  /** PID of the broker process holding the node-control socket. */
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
  /** PID of the broker process that will hold the node-control socket. */
  pid: number;
  stateDir: string;
  apiPort?: number;
  brokerName?: string;
  /** Take the node over from a live broker instead of refusing. */
  force?: boolean;
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
 * The enrolled node id a start will register as, or `undefined` when it will
 * mint its own identity.
 *
 * The node token is what authorizes registration under a stored node id, so a
 * bare `RELAY_NODE_ID` (or a project pin naming a node whose enrollment has gone
 * missing) can never take another broker's delivery socket and is not worth
 * claiming or guarding.
 */
export function enrolledNodeIdForClaim(env: NodeJS.ProcessEnv): string | undefined {
  return env.RELAY_NODE_TOKEN?.trim() ? env.RELAY_NODE_ID?.trim() || undefined : undefined;
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
    (record.process_started_at === undefined || typeof record.process_started_at === 'string')
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
 * Classify a claim for `nodeId`.
 *
 * Only two signals can retire a claim: the pid is gone, or the pid's birth time
 * no longer matches the one recorded (the number was recycled). Everything else
 * — including a `ps` we cannot run — reads as held, because refusing is
 * recoverable (`--force`, `node down`) while a wrong "free" verdict silently
 * cuts delivery to a live broker.
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
  if (!isProcessAlive(claim.pid, deps)) {
    return { state: 'stale', claim, reason: `pid ${claim.pid} is no longer running` };
  }
  if (claim.process_started_at) {
    const current = await readProcessStartedAt(claim.pid, deps);
    if (current && current !== claim.process_started_at) {
      return {
        state: 'stale',
        claim,
        reason: `pid ${claim.pid} was recycled by a process started ${current}`,
      };
    }
  }
  return { state: 'held', claim, reason: `pid ${claim.pid} is running` };
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

/**
 * Record this broker as the owner of `nodeId`.
 *
 * @throws NodeClaimConflictError when a live local broker already holds the
 * node id and `force` was not requested.
 */
export async function acquireNodeClaim(input: AcquireNodeClaimInput): Promise<NodeClaim> {
  const env = input.env ?? process.env;
  const status = await inspectNodeClaim(input.nodeId, input);
  if (status.state === 'held' && status.claim.pid !== input.pid && !input.force) {
    throw new NodeClaimConflictError(input.nodeId, status.claim);
  }
  const startedAt = await readProcessStartedAt(input.pid, input);
  const claim: NodeClaim = {
    version: 1,
    node_id: input.nodeId.trim(),
    pid: input.pid,
    state_dir: normalizeClaimStateDir(input.stateDir),
    ...(input.apiPort !== undefined ? { api_port: input.apiPort } : {}),
    ...(input.brokerName ? { broker_name: input.brokerName } : {}),
    ...(startedAt ? { process_started_at: startedAt } : {}),
    claimed_at: new Date().toISOString(),
  };
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
  return claim;
}

/**
 * Drop a claim this broker owns. Only removes a file that still names the same
 * node id, pid, and state dir, so a replacement broker's claim survives a late
 * shutdown from the process it replaced.
 */
export function releaseNodeClaim(claim: NodeClaim, env: NodeJS.ProcessEnv = process.env): boolean {
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
}

/**
 * Release every claim held by a broker pid in a state dir. `node down` stops a
 * broker it did not start, so it cannot name the node id the claim was written
 * for — the pid and state dir it verified are what it has.
 */
export function releaseNodeClaimsForBroker(input: {
  pid: number;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
}): NodeClaim[] {
  const env = input.env ?? process.env;
  const stateDir = normalizeClaimStateDir(input.stateDir);
  const released: NodeClaim[] = [];
  for (const claim of listNodeClaims(env)) {
    if (claim.pid === input.pid && claim.state_dir === stateDir && releaseNodeClaim(claim, env)) {
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
  return parts.join(', ');
}
