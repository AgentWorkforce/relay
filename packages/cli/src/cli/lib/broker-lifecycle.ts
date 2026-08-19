import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HarnessDriverClient } from '@agent-relay/harness-driver';
import { startServeNode, type FleetNodeDefinition, type RunningNode } from '@agent-relay/fleet';
import { createLogger } from '@agent-relay/utils';
import { redactCredentialValues } from '@agent-relay/cloud/redact';

import type { CoreDependencies, CoreProjectPaths, CoreRelay, SpawnedProcess } from '../commands/core.js';
import { track } from '../telemetry/index.js';
import { buildBundledAgentRelayMcpCommand, isBundledBunEntrypointPath } from './agent-relay-mcp-command.js';
import { errorClassName } from './telemetry-helpers.js';
import { runSignalHandler } from './exit.js';
import { createTriggerSyncClient, resolveNodeCapacityHarnesses } from './fleet-sidecar.js';
import {
  discoverNodeConfigPath,
  discoverPythonNodeConfigPath,
  loadNodeDefinition,
} from './node-definition-loader.js';
import {
  describeNodeDefinitionViaNode,
  descriptorCapacitySource,
  startNodeJsNodeProvider,
  type NodeDefinitionDescriptor,
  type RunningNodeProviderChild,
} from './node-provider-child.js';
import { describeError } from './describe-error.js';
import { maskSecret } from './redact.js';
import { startReflexCapture, type RunningReflexCapture } from './reflex-capture.js';
import {
  readProjectWorkspaceSession,
  resolveWorkspaceSelection,
  writeProjectWorkspaceKey,
  type ProjectWorkspaceSession,
  type WorkspaceSelection,
} from './project-workspace-key.js';

type UpOptions = {
  spawn?: boolean;
  background?: boolean;
  /** Internal marker set only on the detached child re-exec. */
  backgroundChild?: boolean;
  verbose?: boolean;
  workspaceKey?: string;
  stateDir?: string;
  brokerName?: string;
  config?: string;
  /**
   * Opt-in to auto-discovering an `agent-relay.*` node definition in the
   * project root. Only `node up` sets this — the deprecated `local up` alias
   * (and any other legacy caller) must keep its pre-`node` behavior of never
   * touching such files.
   */
  discoverConfig?: boolean;
  /** Registered node name override (e.g. from a persisted Cloud enrollment). */
  nodeName?: string;
  /** Write structured node logs (capabilities, action invocations) to this file. */
  logFile?: string;
  /** Log verbosity floor: debug | info | warn | error. Defaults to info. */
  logLevel?: string;
  /** Emit logs as JSON lines instead of human-readable text. */
  logJson?: boolean;
};

type DownOptions = {
  force?: boolean;
  all?: boolean;
  timeout?: string;
  stateDir?: string;
};

const MAX_API_PORT_ATTEMPTS = 25;
const MAX_PORT = 65535;
const DEFAULT_BROKER_BASE_PORT = 3888;

/** The broker writes this file with URL, port, API key, and PID. */
const CONNECTION_FILENAME = 'connection.json';
const BACKGROUND_START_ERROR_FILENAME = 'background-start-error.log';
export const WORKSPACE_BINDING_SOURCE_ENV = 'AGENT_RELAY_WORKSPACE_SOURCE';
const NODE_REPO_PATHS_ENV = 'AGENT_RELAY_NODE_REPO_PATHS';
const STATUS_POLL_INTERVAL_MS = 500;
const DETACHED_START_READY_TIMEOUT_MS = 10_000;
const NODE_DELIVERY_READY_TIMEOUT_MS = 10_000;
// Bounded wait for the broker's background-minted node token to surface on
// `/api/session` when serving a capability definition without an explicit
// RELAY_NODE_TOKEN.
const NODE_TOKEN_WAIT_MS = 15_000;

export type WorkspaceBindingSource = WorkspaceSelection['source'] | 'created' | 'multi-workspace';

export interface BrokerConnection {
  url: string;
  port: number;
  api_key: string;
  pid: number;
  /** Non-secret provenance recorded by the CLI after the broker handshake. */
  workspace_source?: WorkspaceBindingSource;
}

type BrokerStatusDetails = {
  status: Awaited<ReturnType<HarnessDriverClient['getStatus']>>;
  session: Awaited<ReturnType<HarnessDriverClient['getSession']>> | null;
};

type EnrolledNodeExpectation = {
  nodeId: string;
  nodeName?: string;
};

type NodeDeliveryStatus = {
  tokenPresent: boolean;
  connected: boolean;
};

type BrokerReadiness =
  | {
      state: 'running';
      conn: BrokerConnection;
      statusDetails?: BrokerStatusDetails | null;
    }
  | {
      state: 'starting';
      conn: BrokerConnection;
    }
  | {
      state: 'stopped';
    };

type BrokerConnectionReader = {
  readFileSync: (filePath: string, encoding: BufferEncoding) => string;
};

function parseBrokerConnection(raw: string): BrokerConnection | null {
  try {
    const conn = JSON.parse(raw);
    if (
      typeof conn.url === 'string' &&
      typeof conn.port === 'number' &&
      typeof conn.api_key === 'string' &&
      typeof conn.pid === 'number' &&
      conn.pid > 0
    ) {
      return conn as BrokerConnection;
    }
    return null;
  } catch {
    return null;
  }
}

function readBrokerConnectionFromFs(
  fileSystem: BrokerConnectionReader,
  dataDir: string
): BrokerConnection | null {
  const connPath = path.join(dataDir, CONNECTION_FILENAME);
  try {
    const raw = fileSystem.readFileSync(connPath, 'utf-8');
    return parseBrokerConnection(raw);
  } catch {
    return null;
  }
}

/**
 * Read the broker's connection.json file from the data directory.
 * Returns null if the file doesn't exist or is invalid.
 */
export function readBrokerConnection(dataDir: string): BrokerConnection | null {
  return readBrokerConnectionFromFs(fs, dataDir);
}

function toErrorMessage(err: unknown): string {
  return describeError(err);
}

/** Emit a `[verbose]`-prefixed step marker via `deps.log` when `--verbose` is set. */
function vlog(deps: CoreDependencies, verbose: boolean | undefined, message: string): void {
  if (verbose) {
    deps.log(`[verbose] ${message}`);
  }
}

/** True when any log flag (or `--verbose`) opts the node into structured logging. */
function nodeLoggingEnabled(options: UpOptions): boolean {
  return Boolean(options.logFile || options.logLevel || options.logJson || options.verbose);
}

/**
 * Translate the `--log-*` (and `--verbose`) flags into the `AGENT_RELAY_LOG_*`
 * environment the shared `createLogger` reads. `--verbose` alone raises the
 * floor to DEBUG so per-capability registration lines surface; an explicit
 * `--log-level` always wins. Called before the fleet sidecar starts.
 */
function applyNodeLogEnv(options: UpOptions, deps: CoreDependencies): void {
  if (options.logFile) {
    deps.env.AGENT_RELAY_LOG_FILE = options.logFile;
  }
  const level = options.logLevel ?? (options.verbose ? 'debug' : undefined);
  if (level) {
    deps.env.AGENT_RELAY_LOG_LEVEL = level.toUpperCase();
  }
  if (options.logJson) {
    deps.env.AGENT_RELAY_LOG_JSON = '1';
  }
}

/**
 * Keep background Reflex maintenance out of the broker's normal startup
 * output.  When a node log file is configured, preserve those diagnostics in
 * the same structured log stream as the other long-running node work; when
 * `--verbose` is requested, surface them to the interactive terminal too.
 */
function createReflexDiagnosticLog(options: UpOptions, deps: CoreDependencies): (message: string) => void {
  const logger = options.logFile ? createLogger('reflex') : undefined;

  return (message) => {
    if (options.verbose) {
      vlog(deps, true, message);
    }
    if (!logger) return;

    // The logger already scopes lines with [reflex]; drop the message's own
    // prefix so the file does not read "[reflex] [reflex] ...".
    const unscoped = message.startsWith('[reflex] ') ? message.slice('[reflex] '.length) : message;
    if (message.startsWith('[reflex] cloud sync failed:')) {
      logger.warn(unscoped);
    } else {
      logger.info(unscoped);
    }
  };
}

type ErrorWithCode = { code?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function readNodeDeliveryStatus(status: unknown): NodeDeliveryStatus | null {
  if (!isRecord(status)) {
    return null;
  }
  const snake = isRecord(status.node_delivery) ? status.node_delivery : null;
  const tokenPresent = typeof snake?.token_present === 'boolean' ? snake.token_present : false;
  const connected =
    typeof status.node_connected === 'boolean'
      ? status.node_connected
      : typeof snake?.connected === 'boolean'
        ? snake.connected
        : false;
  return { tokenPresent, connected };
}

function nodeDeliveryReady(status: unknown): boolean {
  const delivery = readNodeDeliveryStatus(status);
  return Boolean(delivery?.tokenPresent && delivery.connected);
}

function formatNodeDeliveryStatus(status: unknown): string {
  const delivery = readNodeDeliveryStatus(status);
  if (!delivery) {
    return 'unknown';
  }
  if (!delivery.tokenPresent) {
    return 'DOWN (no node token)';
  }
  return delivery.connected ? 'CONNECTED' : 'DOWN (node websocket disconnected)';
}

function errorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const code = (err as ErrorWithCode).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Extract a human-meaningful detail string from an error, walking `err.cause`.
 *
 * The broker-start specialization of {@link describeError}: it starts from the
 * shared description and appends the cause chain's detail and error codes.
 *
 * Node's native `fetch()` throws `TypeError: fetch failed` for any network
 * problem and stuffs the real reason (ECONNREFUSED, ENOTFOUND, AbortError,
 * UND_ERR_CONNECT_TIMEOUT, …) into `err.cause`. Without unwrapping, every
 * outbound HTTP failure looks identical to the user.
 *
 * Exported for testing.
 */
export function describeErrorWithCause(err: unknown): string {
  const top = toErrorMessage(err);
  if (!(err instanceof Error) || !err.cause) return top;

  // Walk the cause chain and collect the deepest message + any error codes.
  const codes: string[] = [];
  let detail: string | undefined;
  let cursor: unknown = err.cause;
  let depth = 0;
  while (cursor && depth < 5) {
    const code = errorCode(cursor);
    if (code && !codes.includes(code)) codes.push(code);
    if (cursor instanceof Error && cursor.message) {
      detail = cursor.message;
    }
    cursor = cursor instanceof Error ? cursor.cause : undefined;
    depth += 1;
  }

  const parts = [top];
  if (detail && detail !== top) parts.push(detail);
  if (codes.length > 0) parts.push(`[${codes.join(', ')}]`);
  return redactCredentialValues(parts.join(' — '));
}

/**
 * Pick the best `error_class` for telemetry. Prefer a network-style code from
 * `err.cause` (ECONNREFUSED etc.) over the generic constructor name (TypeError)
 * — a code is more actionable in PostHog and matches the schema's example
 * values for `BrokerStartFailedEvent.error_class`.
 *
 * Exported for testing.
 */
export function classifyBrokerStartError(err: unknown): string {
  let cursor: unknown = err;
  let depth = 0;
  while (cursor && depth < 5) {
    const code = errorCode(cursor);
    if (code) return code;
    cursor = cursor instanceof Error ? cursor.cause : undefined;
    depth += 1;
  }
  return errorClassName(err) ?? 'Error';
}

/** Exported for testing. */
export function classifyBrokerStartStage(_err: unknown, message: string): string {
  if (isBrokerAlreadyRunningError(message)) return 'already_running';
  // Node's native fetch() throws "fetch failed"; the CLI's Bun-compiled
  // binaries throw Bun's own connect-failure text instead ("Unable to
  // connect. Is the computer able to access the url?"). Recognize both so
  // the shipped binary doesn't misclassify every connect failure as generic
  // 'startup'.
  if (/fetch failed/i.test(message) || /unable to connect/i.test(message)) return 'connect';
  if (/Broker did not report API port/i.test(message)) return 'spawn';
  if (/Broker process exited with code/i.test(message)) return 'spawn';
  if (/ENOENT/i.test(message) && /broker/i.test(message)) return 'resolve_binary';
  return 'startup';
}

/**
 * Render the same "Failed to start broker" diagnostic + telemetry the
 * `runUpCommand` catch block has always used. Extracted so the process-level
 * crash guard (below) can report an unhandled rejection/exception the exact
 * same way as an ordinary caught startup failure.
 */
function reportBrokerStartFailure(
  err: unknown,
  deps: CoreDependencies,
  paths: CoreProjectPaths,
  options: UpOptions
): void {
  const message = toErrorMessage(err);
  const stage = classifyBrokerStartStage(err, message);
  track('broker_start_failed', {
    stage,
    error_class: classifyBrokerStartError(err),
  });
  const detailedMessage = describeErrorWithCause(err);
  recordBackgroundStartError(detailedMessage, paths.dataDir, options.backgroundChild === true, deps);
  if (isBrokerAlreadyRunningError(message)) {
    reportAlreadyRunningError(message, paths.dataDir, deps);
  } else {
    deps.error(`Failed to start broker: ${detailedMessage}`);
  }
}

/**
 * `runUpCommand`'s startup try/catch only sees rejections it actually
 * `await`s. Anything that rejects off to the side — a fire-and-forget
 * background task inside a capability provider, an addon's internal promise
 * chain, etc. — crashes the process via Node's bare default
 * uncaughtException/unhandledRejection handler instead, which prints no
 * "Failed to start broker" line and never records `broker_start_failed`
 * telemetry. Observed in the wild as a `node up` that printed "Broker
 * started." and then died with nothing further logged.
 *
 * This guard is armed for the lifetime of the foreground startup + hold-open
 * phase so that class of crash gets the same diagnostic + telemetry + cleanup
 * treatment as an ordinary caught failure, instead of vanishing into Node's
 * default handler. `dispose()` must be called (via `finally`) so the
 * listeners don't outlive this command invocation.
 */
function installStartupCrashGuard(
  deps: CoreDependencies,
  paths: CoreProjectPaths,
  options: UpOptions,
  shutdownOnce: () => Promise<void>
): { dispose: () => void; markHandled: () => void } {
  let handled = false;
  const handleCrash = (err: unknown): void => {
    if (handled) return;
    handled = true;
    // `deps.exit(1)` throws `CliExit` (see `defaultExit`) rather than really
    // exiting. Run this body through `runSignalHandler` -- the same wrapper
    // `deps.onSignal` uses -- so that throw becomes a real, telemetry-flushed
    // `process.exit`. Without it, the throw rejects this detached body with
    // no awaiter; the `unhandledRejection` it produces hits `handleCrash`
    // again, sees `handled` already true, and is silently dropped, leaving
    // `runUpCommand` stuck in `holdOpen` instead of exiting.
    runSignalHandler(async () => {
      await shutdownOnce().catch(() => undefined);
      reportBrokerStartFailure(err, deps, paths, options);
      deps.exit(1);
    });
  };
  process.on('uncaughtException', handleCrash);
  process.on('unhandledRejection', handleCrash);
  return {
    dispose: () => {
      process.off('uncaughtException', handleCrash);
      process.off('unhandledRejection', handleCrash);
    },
    // Called from the normal catch block so a straggler process-level event
    // for the same failure can't fire a second, duplicate report after this
    // function has already handled it and moved on.
    markHandled: () => {
      handled = true;
    },
  };
}

async function resolveApiPortWithFallback(
  startApiPort: number,
  maxAttempts: number,
  deps: CoreDependencies
): Promise<number> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidatePort = startApiPort + attempt;
    if (candidatePort > MAX_PORT) {
      break;
    }
    const inUse = await deps.isPortInUse(candidatePort);
    if (!inUse) {
      if (attempt > 0) {
        deps.warn(`API port ${startApiPort} is already in use; trying ${candidatePort}`);
      }
      return candidatePort;
    }
  }

  throw new Error(`Failed to find an available API port near ${startApiPort}.`);
}

/**
 * The broker base port. `AGENT_RELAY_BROKER_PORT` overrides the default so
 * multiple brokers can run side by side. A value of `0` asks the OS to assign
 * the API port atomically during broker bind, which avoids probe-then-bind
 * races in concurrent test stacks.
 */
export function resolveBrokerBasePort(deps: Pick<CoreDependencies, 'env'>): number {
  const raw = Number.parseInt(deps.env.AGENT_RELAY_BROKER_PORT ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_BROKER_BASE_PORT;
}

/** Bounded attempts for {@link getBrokerStatusWithRetry}'s post-handshake status check. */
const STATUS_CHECK_MAX_ATTEMPTS = 4;
/** Fixed delay between status-check retries, in ms. */
const STATUS_CHECK_RETRY_DELAY_MS = 300;

/**
 * `candidate.getStatus()` is the first request made against a broker that
 * just finished a successful handshake -- `HarnessDriverClient.spawn()`'s own
 * `getSession()` poll already confirmed the broker was reachable moments
 * earlier. Under load, the broker can be transiently preempted between that
 * handshake and this immediate follow-up request, surfacing as a bare
 * connect failure (Node's `TypeError: fetch failed` / Bun's "Unable to
 * connect. Is the computer able to access the url?"), which previously had
 * zero tolerance: one bad request and the whole `up` was reported failed
 * even though the broker was (and remained) healthy.
 *
 * A handful of short, fixed-delay retries absorb that hiccup. This mirrors
 * the *spirit* of the 503-retry loop `HarnessDriverClient.spawn()` runs
 * during the handshake, not its duration -- that loop waits out a possibly
 * slow cold start; this one is only smoothing a momentary preemption right
 * after a broker we already know is up, so the total budget is much
 * shorter (under 1s across all retries).
 *
 * Exported for testing.
 */
export async function getBrokerStatusWithRetry(
  candidate: Pick<CoreRelay, 'getStatus'>,
  deps: CoreDependencies,
  verbose?: boolean
): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= STATUS_CHECK_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await candidate.getStatus();
    } catch (err) {
      lastError = err;
      const isConnectFailure = classifyBrokerStartStage(err, toErrorMessage(err)) === 'connect';
      if (!isConnectFailure || attempt >= STATUS_CHECK_MAX_ATTEMPTS) break;
      vlog(
        deps,
        verbose,
        `Broker status check failed (attempt ${attempt}/${STATUS_CHECK_MAX_ATTEMPTS}), retrying in ${STATUS_CHECK_RETRY_DELAY_MS}ms...`
      );
      await deps.sleep(STATUS_CHECK_RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

export async function startBrokerWithPortFallback(
  paths: CoreProjectPaths,
  basePort: number,
  deps: CoreDependencies,
  brokerName?: string,
  verbose?: boolean,
  /**
   * Invoked as soon as the broker child process has been spawned and its
   * client handle exists, well before the handshake/status-check retries
   * below resolve. Lets the caller wire up cleanup (e.g. a SIGTERM handler)
   * against the real process immediately, instead of only after this whole
   * function returns -- a signal arriving during the status check would
   * otherwise find no handle to shut down and leak the broker child.
   */
  onCandidateReady?: (candidate: CoreRelay) => void
): Promise<{ relay: CoreRelay; apiPort: number }> {
  if (basePort === 0) {
    vlog(deps, verbose, 'Asking the OS to assign the broker API port...');
    const candidate = await deps.createRelay(paths.projectRoot, 0, brokerName, verbose);
    onCandidateReady?.(candidate);
    try {
      await getBrokerStatusWithRetry(candidate, deps, verbose);
      if (!candidate.apiPort) {
        throw new Error('Broker started without reporting its OS-assigned API port.');
      }
    } catch (startupError) {
      try {
        await candidate.shutdown();
      } catch (cleanupError) {
        throw new AggregateError(
          [startupError, cleanupError],
          'Broker startup validation failed and cleanup also failed.',
          { cause: startupError }
        );
      }
      throw startupError;
    }
    vlog(deps, verbose, `API port assigned: ${candidate.apiPort}`);
    return { relay: candidate, apiPort: candidate.apiPort };
  }

  // Resolve a free API port BEFORE spawning the broker.  This avoids
  // spawning (and flocking) multiple --persist brokers during retry,
  // which caused stale-flock "already running" errors.
  const startApiPort = basePort + 1;
  vlog(deps, verbose, `Resolving a free API port starting near ${startApiPort}...`);
  const apiPort = await resolveApiPortWithFallback(startApiPort, MAX_API_PORT_ATTEMPTS, deps);
  vlog(deps, verbose, `API port resolved: ${apiPort}`);

  vlog(deps, verbose, 'Creating broker client (spawns broker process, waits for handshake)...');
  const candidate = await deps.createRelay(paths.projectRoot, apiPort, brokerName, verbose);
  onCandidateReady?.(candidate);
  vlog(deps, verbose, 'Broker client created. Checking broker status...');

  try {
    await getBrokerStatusWithRetry(candidate, deps, verbose);
  } catch (startupError) {
    try {
      await candidate.shutdown();
    } catch (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        'Broker startup validation failed and cleanup also failed.',
        { cause: startupError }
      );
    }
    throw startupError;
  }
  vlog(deps, verbose, 'Broker status check passed.');
  return { relay: candidate, apiPort };
}

/** A handle to stop the capability providers started alongside the broker. */
export interface RunningNodeProviders {
  /** Rejects when a supervised provider exits before broker shutdown. */
  done?: Promise<void>;
  stop(): Promise<void>;
}

export interface BrokerNodeIdentity {
  nodeId: string;
  nodeName: string;
  nodeToken?: string;
}

interface SessionSnapshot {
  node_id?: string;
  node_name?: string;
  node_token?: string;
}

/** Reject if `promise` doesn't settle within `ms`, clearing the timer on settle. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('session read exceeded token-wait budget')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Resolve the broker's node identity from repeated `/api/session` reads.
 *
 * The broker publishes its node id as soon as the workspace handshake completes,
 * but mints the node token off the API-readiness path (in the background), so a
 * freshly started broker can report `node_id` before `node_token`. When
 * `awaitTokenMs` is set, poll until the token appears (or the budget elapses) so
 * a provider that needs the broker-minted token isn't skipped over a startup
 * race. A transient session-read error yields the best identity seen so far
 * (identity without token), or `null` if no `node_id` was ever read.
 */
export async function resolveNodeIdentityFromSession(
  getSession: () => Promise<SessionSnapshot>,
  options: { awaitTokenMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<BrokerNodeIdentity | null> {
  const awaitTokenMs = options.awaitTokenMs ?? 0;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + awaitTokenMs;
  let identity: BrokerNodeIdentity | null = null;
  for (;;) {
    let session: SessionSnapshot;
    try {
      // Bound each read to the remaining token-wait budget so a single stalled
      // `/api/session` can't hold startup past `awaitTokenMs` (the transport's
      // own request timeout is far longer). The non-await path issues one read
      // and doesn't need the bound.
      session =
        awaitTokenMs > 0
          ? await withTimeout(getSession(), Math.max(0, deadline - Date.now()))
          : await getSession();
    } catch {
      return identity;
    }
    if (!session.node_id) return identity;
    identity = {
      nodeId: session.node_id,
      nodeName: session.node_name ?? session.node_id,
      ...(session.node_token ? { nodeToken: session.node_token } : {}),
    };
    if (session.node_token || awaitTokenMs <= 0 || Date.now() >= deadline) {
      return identity;
    }
    await sleep(250);
  }
}

/**
 * Read the node id/name the broker registered as, from its HTTP session. The
 * capability providers attach to this same node so they share its identity.
 */
async function readBrokerNodeIdentity(
  conn: BrokerConnection,
  options: { awaitTokenMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<BrokerNodeIdentity | null> {
  const client = new HarnessDriverClient({ baseUrl: conn.url, apiKey: conn.api_key });
  try {
    return await resolveNodeIdentityFromSession(() => client.getSession(), options);
  } finally {
    client.disconnect();
  }
}

/**
 * Serve the project's capability definitions as node providers connected
 * directly to the engine, alongside the broker provider: an `agent-relay.{ts,…}`
 * definition via {@link startServeNode}, and an `agent-relay.py` script spawned
 * as a supervised `python` child with the node token in its env. When no
 * definition exists, nothing is served — the broker's capacity already brings
 * the node online. Best-effort: a provider setup failure never aborts `up`.
 */
async function startNodeCapabilityProviders(
  paths: CoreProjectPaths,
  relay: CoreRelay,
  options: UpOptions,
  deps: CoreDependencies,
  nodePlan: NodeDefinitionPlan | undefined
): Promise<RunningNodeProviders | undefined> {
  // Definition discovery is opt-in (`node up` only), matching the TS config scan.
  const pythonConfig =
    options.discoverConfig === true ? discoverPythonNodeConfigPath(paths.projectRoot) : undefined;
  if (!nodePlan && !pythonConfig) {
    return undefined;
  }

  const conn = readBrokerConnectionFromFs(deps.fs, paths.dataDir);
  if (!conn) {
    deps.warn('Capability providers skipped: broker connection file was not available.');
    return undefined;
  }
  const baseUrl = deps.env.RELAY_BASE_URL?.trim();
  // Serving a definition needs the node token. When no explicit RELAY_NODE_TOKEN
  // is set we rely on the broker's background-minted token, which can lag its
  // node id by a Relaycast round-trip — wait a bounded window for it rather than
  // racing the mint and skipping the provider.
  const awaitTokenMs = deps.env.RELAY_NODE_TOKEN?.trim() ? 0 : NODE_TOKEN_WAIT_MS;
  const identity = await readBrokerNodeIdentity(conn, { awaitTokenMs });
  if (!identity) {
    deps.warn('Capability providers skipped: the broker did not report its node id yet.');
    return undefined;
  }
  // The broker mints its own node token when RELAY_NODE_TOKEN is unset (local,
  // un-enrolled); all providers on the node share that token, so fall back to
  // the one it reports on its session rather than requiring pre-enrollment.
  const nodeToken = deps.env.RELAY_NODE_TOKEN?.trim() || identity.nodeToken;
  if (!nodeToken) {
    deps.warn('Capability providers skipped: no node token available from the broker or environment.');
    return undefined;
  }

  const served: RunningNode[] = [];
  let pythonChild: SpawnedProcess | undefined;
  let nodeJsChild: RunningNodeProviderChild | undefined;

  if (nodePlan?.mode === 'in-process') {
    const nodeDefinition = nodePlan.definition;
    try {
      const workspaceKey = relay.workspaceKey;
      served.push(
        startServeNode({
          definition: nodeDefinition,
          connection: {
            ...(baseUrl ? { baseUrl } : {}),
            nodeToken,
            nodeId: identity.nodeId,
          },
          nameOverride: options.nodeName ?? identity.nodeName,
          // The served definition attaches as its own provider, distinct from the
          // broker ("broker") on the same node.
          providerName: nodeDefinition.name,
          ...(workspaceKey ? { triggers: createTriggerSyncClient({ workspaceKey, baseUrl }) } : {}),
          reconnect: true,
          // With any --log-* flag (or --verbose), surface the node's full lifecycle
          // — capabilities registered, every action invoked/completed — through the
          // shared logger, which honors AGENT_RELAY_LOG_FILE/_LEVEL/_JSON. Without a
          // flag, keep the prior behavior: the registration summary via log, warnings
          // via warn.
          ...(nodeLoggingEnabled(options)
            ? { logger: createLogger('fleet') }
            : { warn: (message) => deps.warn(message), log: (message) => deps.log(message) }),
        })
      );
    } catch (err) {
      deps.warn(`Capability provider skipped: ${toErrorMessage(err)}`);
    }
  }

  if (nodePlan?.mode === 'child-node') {
    nodeJsChild = await startNodeJsNodeProvider(
      nodePlan.configPath,
      {
        nodeToken,
        baseUrl,
        nodeId: identity.nodeId,
        nodeName: options.nodeName ?? identity.nodeName,
        ...(relay.workspaceKey ? { workspaceKey: relay.workspaceKey } : {}),
      },
      deps
    );
  }

  if (pythonConfig) {
    pythonChild = startPythonNodeProvider(
      pythonConfig,
      {
        nodeToken,
        baseUrl,
        nodeId: identity.nodeId,
        // Prefer the enrolled/override name so a Cloud-enrolled py provider
        // registers under the same name as the TS provider, not the broker default.
        nodeName: options.nodeName ?? identity.nodeName,
      },
      deps
    );
  }

  if (served.length === 0 && !pythonChild && !nodeJsChild) {
    return undefined;
  }

  return {
    ...(nodeJsChild ? { done: nodeJsChild.done } : {}),
    stop: async () => {
      await Promise.all([...served.map((node) => node.stop().catch(() => undefined)), nodeJsChild?.stop()]);
      if (pythonChild?.pid) {
        try {
          deps.killProcess(pythonChild.pid, 'SIGTERM');
        } catch {
          // Already exited.
        }
      }
    },
  };
}

/**
 * Spawn `python agent-relay.py` as a supervised child with the node credentials
 * in its environment. The child connects to the engine on its own via the SDK's
 * `NodeProvider.from_enrollment()`.
 */
function startPythonNodeProvider(
  configPath: string,
  credentials: { nodeToken: string; baseUrl?: string; nodeId: string; nodeName: string },
  deps: CoreDependencies
): SpawnedProcess | undefined {
  const python = deps.env.AGENT_RELAY_PYTHON?.trim() || 'python3';
  const env: NodeJS.ProcessEnv = {
    ...deps.env,
    RELAY_NODE_TOKEN: credentials.nodeToken,
    RELAY_NODE_ID: credentials.nodeId,
    RELAY_NODE_NAME: credentials.nodeName,
    ...(credentials.baseUrl ? { RELAY_BASE_URL: credentials.baseUrl } : {}),
  };
  try {
    const child = deps.spawnProcess(python, [configPath], { stdio: 'inherit', env });
    deps.log(
      `Serving Python node provider: ${python} ${path.basename(configPath)} (pid: ${child.pid ?? 'unknown'}).`
    );
    return child;
  } catch (err) {
    deps.warn(`Python node provider skipped: ${toErrorMessage(err)}`);
    return undefined;
  }
}

function isBrokerAlreadyRunningError(message: string): boolean {
  return /another broker instance is already running in this directory/i.test(message);
}

function extractBrokerLockDir(message: string): string | null {
  const match = message.match(/another broker instance is already running in this directory \(([^)]+)\)/i);
  return match?.[1] ?? null;
}

function reportAlreadyRunningError(message: string, dataDir: string, deps: CoreDependencies): void {
  const pid = readBrokerPid(dataDir, deps);
  if (pid !== null && isProcessRunning(pid, deps)) {
    deps.error(`Broker already running for this project (pid: ${pid}).`);
  } else {
    const lockDir = extractBrokerLockDir(message);
    if (lockDir) {
      deps.error(`Broker already running for this project (lock: ${lockDir}).`);
    } else {
      deps.error('Broker already running for this project.');
    }
  }

  deps.error('Run `agent-relay status` to inspect it, then `agent-relay down` to stop it.');
  deps.error('If it still fails, run `agent-relay down --force` to clear stale runtime files.');
}

function safeUnlink(filePath: string, deps: CoreDependencies): void {
  if (!deps.fs.existsSync(filePath)) return;
  try {
    deps.fs.unlinkSync(filePath);
  } catch {
    // Best-effort cleanup.
  }
}

function workspaceBindingSource(value: string | undefined): WorkspaceBindingSource | undefined {
  return value === 'flag' ||
    value === 'env' ||
    value === 'project' ||
    value === 'store' ||
    value === 'created' ||
    value === 'multi-workspace'
    ? value
    : undefined;
}

function workspaceBindingSourceLabel(source: WorkspaceBindingSource): string {
  switch (source) {
    case 'flag':
      return 'command-line flag (--workspace-key / --wk)';
    case 'env':
      return 'environment (RELAY_WORKSPACE_KEY > AGENT_RELAY_WORKSPACE_KEY > RELAY_API_KEY)';
    case 'project':
      return 'repository pin (.agentworkforce/relay/workspace-key.json)';
    case 'store':
      return 'machine-global active workspace (~/.agentworkforce/relay/workspaces.json)';
    case 'created':
      return 'created (no configured workspace resolved)';
    case 'multi-workspace':
      return 'multi-workspace session ($RELAY_WORKSPACES_JSON)';
  }
}

/** True when `RELAY_WORKSPACES_JSON` carries at least one membership. The broker's
 * `startup_session_set_with_options` checks this env var before any single
 * workspace key (flag, env, repository pin, or machine-global store), so the
 * CLI's precedence ladder must defer to it for provenance too — otherwise
 * `node up` / `node status` can report a source the broker never used. */
function usesMultiWorkspaceEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.RELAY_WORKSPACES_JSON?.trim());
}

function writeBrokerBindingSource(
  dataDir: string,
  source: WorkspaceBindingSource,
  deps: CoreDependencies
): void {
  const connectionPath = path.join(dataDir, CONNECTION_FILENAME);
  const connection = readBrokerConnectionFromFs(deps.fs, dataDir);
  if (!connection) return;
  // Every CLI invocation resolves the broker through this file, so a
  // concurrent writer must never observe a partial or clobbered write.
  // Write to a private tmp file and rename it into place, which is atomic
  // on the same filesystem.
  const tmpPath = `${connectionPath}.tmp-${process.pid}-${randomUUID()}`;
  deps.fs.writeFileSync(
    tmpPath,
    `${JSON.stringify({ ...connection, workspace_source: source }, null, 2)}\n`,
    'utf-8'
  );
  deps.fs.renameSync(tmpPath, connectionPath);
}

function backgroundStartErrorPath(dataDir: string): string {
  return path.join(dataDir, BACKGROUND_START_ERROR_FILENAME);
}

function readBackgroundStartError(dataDir: string, deps: CoreDependencies): string | undefined {
  try {
    return deps.fs.readFileSync(backgroundStartErrorPath(dataDir), 'utf-8').trim() || undefined;
  } catch {
    return undefined;
  }
}

function recordBackgroundStartError(
  message: string,
  dataDir: string,
  isDetachedChild: boolean,
  deps: CoreDependencies
): void {
  if (!isDetachedChild) return;
  try {
    // Never trust a project-loaded environment variable as a filesystem path.
    // Detached startup owns one fixed diagnostic file inside its resolved
    // broker state directory; foreground failures do not write it at all.
    deps.fs.writeFileSync(backgroundStartErrorPath(dataDir), `${message}\n`, 'utf-8');
  } catch {
    // Diagnostics must never replace the original startup error.
  }
}

function readBrokerPid(dataDir: string, _deps: CoreDependencies): number | null {
  const conn = readBrokerConnectionFromFs(_deps.fs, dataDir);
  return conn?.pid ?? null;
}

function isProcessRunning(pid: number, deps: CoreDependencies): boolean {
  try {
    deps.killProcess(pid, 0);
    return true;
  } catch {
    return false;
  }
}

type ProcessInfo = {
  pid: number;
  command: string;
};

function parsePsAuxLine(line: string): ProcessInfo | null {
  const fields = line.trim().split(/\s+/);
  if (fields.length < 11 || fields[0] === 'USER') {
    return null;
  }
  const pid = Number.parseInt(fields[1], 10);
  if (Number.isNaN(pid) || pid <= 0) {
    return null;
  }
  return {
    pid,
    command: fields.slice(10).join(' '),
  };
}

function commandExecutableBasename(command: string): string {
  const executable = command.trim().split(/\s+/)[0] ?? '';
  return path.basename(executable.replace(/^["']|["']$/g, ''));
}

function isBrokerExecutableCommand(command: string): boolean {
  const basename = commandExecutableBasename(command);
  return basename === 'agent-relay-broker' || basename.startsWith('agent-relay-broker-');
}

function isAttachedBrokerCliCommand(command: string): boolean {
  if (command.includes('agent-relay-mcp')) {
    return false;
  }
  // The attached `up` process holds the broker. Skip the transient
  // `up --background` launcher, which exits as soon as the child is ready.
  if (!/(?:^|\s)up(?:\s|$)/.test(command) || /(?:^|\s)--background(?:\s|=|$)/.test(command)) {
    return false;
  }
  return /(?:^|\s)(?:\S*agent-relay(?:\.js)?|\S*agent-relay-[^\s]+)(?:\s|$)/.test(command);
}

function isBrokerProcessCommand(command: string): boolean {
  return isBrokerExecutableCommand(command) || isAttachedBrokerCliCommand(command);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function commandHasBrokerName(command: string, brokerName: string): boolean {
  const escapedName = escapeRegExp(brokerName);
  return new RegExp(`(?:^|\\s)--name(?:\\s+|=)${escapedName}(?:\\s|$)`).test(command);
}

function commandHasProjectRoot(command: string, projectRoot: string): boolean {
  const escapedRoot = escapeRegExp(path.resolve(projectRoot));
  return new RegExp(`(?:^|\\s|=|["'])${escapedRoot}(?:$|\\s|["']|${escapeRegExp(path.sep)})`).test(command);
}

async function processCwdMatchesProjectRoot(
  processInfo: ProcessInfo,
  projectRoot: string,
  deps: CoreDependencies
): Promise<boolean> {
  try {
    const cwdDetails = await deps.execCommand(`lsof -nP -a -p ${processInfo.pid} -d cwd -Fn`);
    return cwdDetails.stdout
      .split('\n')
      .filter((line) => line.startsWith('n'))
      .some((line) => path.resolve(line.slice(1)) === projectRoot);
  } catch {
    return false;
  }
}

async function terminateProcess(pid: number, deps: CoreDependencies, force: boolean): Promise<boolean> {
  try {
    deps.killProcess(pid, 'SIGTERM');
  } catch {
    return false;
  }

  const exited = await waitForProcessExit(pid, force ? 500 : 300, deps);
  if (exited || !force) {
    return exited;
  }

  try {
    deps.killProcess(pid, 'SIGKILL');
  } catch {
    return false;
  }
  return waitForProcessExit(pid, 500, deps);
}

async function killOrphanedBrokerProcesses(
  projectRoot: string,
  deps: CoreDependencies,
  options?: { force?: boolean }
): Promise<{ matchedCount: number; killedCount: number }> {
  let matchedCount = 0;
  let killedCount = 0;
  try {
    const resolvedProjectRoot = path.resolve(projectRoot);
    const brokerName = path.basename(resolvedProjectRoot) || 'project';
    const candidates: ProcessInfo[] = [];
    try {
      const processList = await deps.execCommand('ps aux');
      const relayProcesses = processList.stdout
        .split('\n')
        .map(parsePsAuxLine)
        .filter((process): process is ProcessInfo => process !== null)
        .filter((process) => isBrokerProcessCommand(process.command));

      const matchedPids = new Set<number>();
      for (const processInfo of relayProcesses) {
        if (commandHasProjectRoot(processInfo.command, resolvedProjectRoot)) {
          candidates.push(processInfo);
          matchedPids.add(processInfo.pid);
        }
      }

      for (const processInfo of relayProcesses) {
        if (matchedPids.has(processInfo.pid)) {
          continue;
        }
        const cwdMatches = await processCwdMatchesProjectRoot(processInfo, resolvedProjectRoot, deps);
        if (!cwdMatches) continue;
        if (
          isBrokerExecutableCommand(processInfo.command) &&
          !commandHasBrokerName(processInfo.command, brokerName)
        ) {
          continue;
        }
        candidates.push(processInfo);
        matchedPids.add(processInfo.pid);
      }
    } catch {
      // Expected if ps is unavailable; fall through to no matches.
    }
    for (const { pid } of candidates) {
      if (pid === deps.pid) {
        continue;
      }
      matchedCount += 1;
      deps.warn(`Killing orphaned broker process (pid: ${pid})`);
      const killed = await terminateProcess(pid, deps, options?.force === true);
      if (killed) {
        killedCount += 1;
      } else if (options?.force === true) {
        deps.warn(`Broker orphan process may still be running (pid: ${pid})`);
      }
    }
  } catch {
    // Best-effort orphan cleanup.
  }
  return { matchedCount, killedCount };
}

function ensureBundledAgentRelayMcpCommand(deps: CoreDependencies): void {
  if (deps.env.AGENT_RELAY_MCP_COMMAND?.trim()) {
    return;
  }

  const command = buildBundledAgentRelayMcpCommand(deps.execPath, deps.cliScript, deps.fs.existsSync);
  if (command) {
    deps.env.AGENT_RELAY_MCP_COMMAND = command;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number, deps: CoreDependencies): Promise<boolean> {
  const startedAt = deps.now();
  while (deps.now() - startedAt < timeoutMs) {
    if (!isProcessRunning(pid, deps)) {
      return true;
    }
    await deps.sleep(100);
  }
  return false;
}

async function recoverHalfStartedBroker(
  paths: CoreProjectPaths,
  deps: CoreDependencies
): Promise<'running' | 'recovered' | 'clear' | 'blocked'> {
  deps.fs.mkdirSync(paths.dataDir, { recursive: true });
  const readiness = await waitForBrokerReadiness(paths, deps, 0, true);
  if (readiness.state === 'running') {
    return 'running';
  }

  if (readiness.state === 'starting') {
    deps.warn(
      `Broker process is running but the API is not ready; killing half-started broker (pid: ${readiness.conn.pid}).`
    );
    const stopped = await terminateProcess(readiness.conn.pid, deps, true);
    if (!stopped) {
      deps.error(
        `Failed to stop half-started broker process (pid: ${readiness.conn.pid}). ` +
          'Run `agent-relay down --force` to retry cleanup, or remove `.agentworkforce/relay/` after stopping the process.'
      );
      return 'blocked';
    }
    cleanupBrokerFiles(paths, deps);
    return 'recovered';
  }

  const orphanCleanup = await killOrphanedBrokerProcesses(paths.projectRoot, deps, { force: true });
  if (orphanCleanup.matchedCount > 0) {
    if (orphanCleanup.killedCount < orphanCleanup.matchedCount) {
      deps.error(
        'Failed to stop all half-started broker processes. ' +
          'Run `agent-relay down --force` to retry cleanup, or remove `.agentworkforce/relay/` after stopping the processes.'
      );
      return 'blocked';
    }
    cleanupBrokerFiles(paths, deps);
    return 'recovered';
  }

  cleanupBrokerFiles(paths, deps);
  return 'clear';
}

function cleanupBrokerFiles(paths: CoreProjectPaths, deps: CoreDependencies): void {
  const runtimePath = path.join(paths.dataDir, 'runtime.json');
  const relaySockPath = path.join(paths.dataDir, 'relay.sock');

  safeUnlink(path.join(paths.dataDir, CONNECTION_FILENAME), deps);
  safeUnlink(relaySockPath, deps);
  safeUnlink(runtimePath, deps);
  safeUnlink(backgroundStartErrorPath(paths.dataDir), deps);

  // Clean up lock files and legacy pid files
  try {
    for (const file of deps.fs.readdirSync(paths.dataDir)) {
      if (file.startsWith('broker-') && (file.endsWith('.lock') || file.endsWith('.pid'))) {
        safeUnlink(path.join(paths.dataDir, file), deps);
        continue;
      }
      if (!file.startsWith('mcp-identity-')) {
        continue;
      }
      const pidMatch = file.match(/^mcp-identity-(\d+)/);
      if (!pidMatch) {
        continue;
      }
      const pid = Number.parseInt(pidMatch[1], 10);
      if (!isProcessRunning(pid, deps)) {
        safeUnlink(path.join(paths.dataDir, file), deps);
      }
    }
  } catch {
    // Ignore read errors while cleaning up.
  }
}

function childUpArgsForDetachedStart(options: UpOptions, deps: CoreDependencies): string[] {
  // The workspace key travels to the detached child via env only (set on
  // deps.env before the spawn): strip every argv spelling so the daemon's
  // command line never carries it into `ps` output.
  const args = stripCliOptionsWithValue(
    cliUserArgs(deps).filter((arg) => !matchesCliOption(arg, '--background')),
    ['--workspace-key', '--wk']
  );
  if (options.stateDir && !hasCliOption(args, '--state-dir')) {
    args.push('--state-dir', path.resolve(options.stateDir));
  }
  if (options.brokerName && !hasCliOption(args, '--broker-name')) {
    args.push('--broker-name', options.brokerName);
  }
  if (options.verbose === true && !args.includes('--verbose')) {
    args.push('--verbose');
  }
  if (!args.includes('--background-child')) {
    args.push('--background-child');
  }
  return args;
}

/** Drop each named option and, for the space-separated form, its value token. */
function stripCliOptionsWithValue(args: string[], names: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (names.includes(arg)) {
      i++;
      continue;
    }
    if (names.some((name) => arg.startsWith(`${name}=`))) {
      continue;
    }
    result.push(arg);
  }
  return result;
}

function cliUserArgs(deps: CoreDependencies): string[] {
  return hasEntrypointArgvSlot(deps) ? deps.argv.slice(2) : deps.argv.slice(1);
}

function detachedCliInvocation(deps: CoreDependencies, args: string[]): { command: string; args: string[] } {
  if (shouldReexecThroughScript(deps)) {
    return { command: deps.execPath, args: [deps.cliScript, ...args] };
  }
  return { command: deps.execPath, args };
}

function hasEntrypointArgvSlot(deps: CoreDependencies): boolean {
  return isBundledBunExecutableEntrypoint(deps) || isCliScriptEntrypoint(deps);
}

function shouldReexecThroughScript(deps: CoreDependencies): boolean {
  return isCliScriptEntrypoint(deps) && !sameCliPath(deps.execPath, deps.cliScript);
}

function isCliScriptEntrypoint(deps: CoreDependencies): boolean {
  const cliScript = deps.cliScript.trim();
  if (!cliScript) {
    return false;
  }
  if (isBundledBunExecutableEntrypoint(deps)) {
    return false;
  }
  if (sameCliPath(deps.execPath, cliScript)) {
    return true;
  }
  return (
    path.isAbsolute(cliScript) ||
    cliScript.includes('/') ||
    cliScript.includes('\\') ||
    /\.[cm]?js$/i.test(cliScript)
  );
}

export function isBundledBunExecutableEntrypoint(deps: CoreDependencies): boolean {
  return deps.argv[0] === 'bun' && isBundledBunEntrypointPath(deps.cliScript);
}

function sameCliPath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function hasCliOption(args: string[], name: string): boolean {
  return args.some((arg) => matchesCliOption(arg, name));
}

function matchesCliOption(arg: string, name: string): boolean {
  return arg === name || arg.startsWith(`${name}=`);
}

async function checkBrokerReadiness(
  paths: CoreProjectPaths,
  deps: CoreDependencies,
  requireApi: boolean
): Promise<BrokerReadiness> {
  const conn = readBrokerConnectionFromFs(deps.fs, paths.dataDir);
  if (!conn || conn.pid <= 0) {
    return { state: 'stopped' };
  }
  if (!isProcessRunning(conn.pid, deps)) {
    safeUnlink(path.join(paths.dataDir, CONNECTION_FILENAME), deps);
    return { state: 'stopped' };
  }
  if (!requireApi) {
    return { state: 'running', conn };
  }

  const statusDetails = await readBrokerStatusDetails(conn);
  if (statusDetails) {
    return { state: 'running', conn, statusDetails };
  }
  return { state: 'starting', conn };
}

async function waitForBrokerReadiness(
  paths: CoreProjectPaths,
  deps: CoreDependencies,
  waitMs: number,
  requireApi: boolean,
  verbose?: boolean,
  stopWhenPidExits?: number
): Promise<BrokerReadiness> {
  const deadline = deps.now() + waitMs;
  let latest = await checkBrokerReadiness(paths, deps, requireApi);
  vlog(deps, verbose, `Broker readiness: ${latest.state}`);

  while (latest.state !== 'running' && waitMs > 0 && deps.now() < deadline) {
    if (stopWhenPidExits && !isProcessRunning(stopWhenPidExits, deps)) {
      return latest;
    }
    await deps.sleep(Math.min(STATUS_POLL_INTERVAL_MS, Math.max(0, deadline - deps.now())));
    const previousState = latest.state;
    latest = await checkBrokerReadiness(paths, deps, requireApi);
    if (latest.state !== previousState) {
      vlog(deps, verbose, `Broker readiness: ${latest.state}`);
    }
  }

  return latest;
}

async function waitForEnrolledNodeReadiness(
  conn: BrokerConnection,
  deps: CoreDependencies,
  expected: EnrolledNodeExpectation,
  initialDetails?: BrokerStatusDetails | null
): Promise<{ ready: boolean; reason?: string }> {
  const deadline = deps.now() + DETACHED_START_READY_TIMEOUT_MS;
  let details = initialDetails ?? null;

  for (;;) {
    details ??= await readBrokerStatusDetails(conn);
    const actualNodeId = details?.session?.node_id?.trim();
    const actualNodeName = details?.session?.node_name?.trim();
    if (actualNodeId && actualNodeId !== expected.nodeId) {
      return {
        ready: false,
        reason: `Cloud enrollment identity mismatch: expected node id "${expected.nodeId}", got "${actualNodeId}".`,
      };
    }
    if (expected.nodeName && actualNodeName && actualNodeName !== expected.nodeName) {
      return {
        ready: false,
        reason: `Cloud enrollment identity mismatch: expected node name "${expected.nodeName}", got "${actualNodeName}".`,
      };
    }
    if (
      actualNodeId === expected.nodeId &&
      (!expected.nodeName || actualNodeName === expected.nodeName) &&
      nodeDeliveryReady(details?.status)
    ) {
      return { ready: true };
    }
    if (deps.now() >= deadline) {
      return {
        ready: false,
        reason:
          `Cloud enrollment for node "${expected.nodeName ?? expected.nodeId}" did not become ready. ` +
          `Node delivery: ${formatNodeDeliveryStatus(details?.status)}`,
      };
    }
    await deps.sleep(Math.min(STATUS_POLL_INTERVAL_MS, Math.max(0, deadline - deps.now())));
    details = null;
  }
}

export async function waitForNodeDelivery(
  relay: CoreRelay,
  deps: CoreDependencies,
  waitMs = NODE_DELIVERY_READY_TIMEOUT_MS
): Promise<{ ready: boolean; status: unknown }> {
  const deadline = deps.now() + waitMs;
  let latest: unknown = null;

  while (true) {
    try {
      latest = await relay.getStatus();
    } catch {
      latest = null;
    }
    if (nodeDeliveryReady(latest)) {
      return { ready: true, status: latest };
    }
    if (waitMs <= 0 || deps.now() >= deadline) {
      return { ready: false, status: latest };
    }
    await deps.sleep(Math.min(STATUS_POLL_INTERVAL_MS, Math.max(0, deadline - deps.now())));
  }
}

async function shutdownUpResources(relay: CoreRelay, dataDir: string, deps: CoreDependencies): Promise<void> {
  await relay.shutdown().catch(() => undefined);
  safeUnlink(path.join(dataDir, CONNECTION_FILENAME), deps);
}

// eslint-disable-next-line complexity
/**
 * Resolve the node definition `up` should serve, if any.
 *
 * A discovered (or explicit --config) node definition takes over from the
 * implicit teams.json-derived node. Discovery is opt-in (`node up` only): the
 * deprecated `local up` alias never scanned for agent-relay.* files and must
 * not start importing arbitrary modules from the project root. An explicit
 * --config resolves against the invocation cwd and fails hard; implicit
 * discovery scans the project root and merely warns on a file that doesn't
 * load as defineNode(...) — a stray agent-relay.ts must not brick startup.
 * When the implicit fleet node is disabled the sidecar never starts, so
 * loading a config would be pointless — skip it entirely.
 */
async function resolveNodeDefinitionForUp(
  paths: CoreProjectPaths,
  options: UpOptions,
  deps: CoreDependencies
): Promise<NodeDefinitionPlan | undefined> {
  const fleetNodeDisabled = deps.env.AGENT_RELAY_DISABLE_IMPLICIT_FLEET_NODE === '1';
  if (fleetNodeDisabled || (!options.config && options.discoverConfig !== true)) {
    return undefined;
  }
  const explicitConfig = options.config ? path.resolve(process.cwd(), options.config) : undefined;
  const configPath = discoverNodeConfigPath(paths.projectRoot, explicitConfig);
  if (!configPath) {
    return undefined;
  }
  vlog(deps, options.verbose, `Loading fleet node definition from ${configPath}...`);
  if (explicitConfig) {
    return loadNodeDefinitionPlan(configPath, deps);
  }
  try {
    return await loadNodeDefinitionPlan(configPath, deps);
  } catch (err) {
    deps.warn(
      `Ignoring discovered node config ${configPath}: ${toErrorMessage(err)}. ` +
        'Serving the implicit local node instead; pass --config to fail hard on this file.'
    );
    return undefined;
  }
}

/**
 * How a discovered JS/TS node definition will be served.
 *
 * Under Node the definition is imported and served in-process, unchanged. Under
 * a `bun build --compile` binary it cannot be imported at all — the compiled
 * runtime fails to resolve a bare specifier out of the user's `node_modules`
 * whenever the package's entry lives in a subdirectory (`dist/`), i.e. every
 * TypeScript-built package, and the failure is transitive through the user's
 * whole dependency graph — so the CLI only learns its descriptor (via a
 * `--describe` child) and hands the file to a child `node` process to serve,
 * exactly as `agent-relay.py` is handed to `python3`.
 */
type NodeDefinitionPlan =
  | { mode: 'in-process'; definition: FleetNodeDefinition }
  | { mode: 'child-node'; configPath: string; descriptor: NodeDefinitionDescriptor };

/**
 * Decide how to serve `configPath` and gather what the broker needs before it
 * starts (capacity, and a hard failure on a bad explicit --config).
 * @param configPath - Absolute path to the node definition file.
 * @param deps - Core dependencies.
 */
export async function loadNodeDefinitionPlan(
  configPath: string,
  deps: CoreDependencies
): Promise<NodeDefinitionPlan> {
  if (!isBundledBunExecutableEntrypoint(deps)) {
    return { mode: 'in-process', definition: await loadNodeDefinition(configPath) };
  }
  const descriptor = await describeNodeDefinitionViaNode(configPath, deps);
  return { mode: 'child-node', configPath, descriptor };
}

/** The capability names a plan contributes to the broker's advertised capacity. */
function planCapacitySource(
  plan: NodeDefinitionPlan | undefined
): { capabilities: Readonly<Record<string, unknown>> } | undefined {
  if (!plan) {
    return undefined;
  }
  return plan.mode === 'in-process' ? plan.definition : descriptorCapacitySource(plan.descriptor);
}

/** Read the node-private repository map from either definition execution mode. */
function planRepoPaths(plan: NodeDefinitionPlan | undefined): Readonly<Record<string, string>> | undefined {
  if (!plan) {
    return undefined;
  }
  const source = plan.mode === 'in-process' ? plan.definition : plan.descriptor;
  return (source as { repoPaths?: Readonly<Record<string, string>> }).repoPaths;
}

/**
 * Expose one local-only serialized map while the native broker process starts.
 * The child captures its environment at spawn; restoring the CLI environment
 * immediately afterward prevents the private paths from reaching capability
 * provider children or unrelated processes started later.
 */
function applyNodeRepoPathsEnv(
  env: NodeJS.ProcessEnv,
  repoPaths: Readonly<Record<string, string>> | undefined
): () => void {
  if (repoPaths === undefined) {
    return () => undefined;
  }
  const previous = env[NODE_REPO_PATHS_ENV];
  const sorted = Object.fromEntries(
    Object.entries(repoPaths).sort(([left], [right]) => left.localeCompare(right))
  );
  env[NODE_REPO_PATHS_ENV] = JSON.stringify(sorted);
  return () => {
    if (previous === undefined) {
      delete env[NODE_REPO_PATHS_ENV];
    } else {
      env[NODE_REPO_PATHS_ENV] = previous;
    }
  };
}

/**
 * Apply the resolved workspace to the environment the broker (and any detached
 * child) inherits, and report which source won. Returns the pinned project
 * session when the repository pin supplied the selection.
 */
function applyWorkspaceSelection(
  selection: WorkspaceSelection | undefined,
  deps: CoreDependencies,
  projectDataDir: string
): ProjectWorkspaceSession | undefined {
  if (!selection) {
    deps.log(
      'Workspace: none selected (no --workspace-key, no RELAY_WORKSPACE_KEY, no repository pin, ' +
        'no active workspace in the machine-global store). A new workspace will be created.'
    );
    return undefined;
  }

  deps.log(`Workspace source: ${describeWorkspaceSource(selection.source)} (${selection.origin})`);
  // Normalize every winning source to the primary env var inherited by the
  // broker and any detached child. Keep a caller-supplied RELAY_API_KEY intact
  // when an explicit flag or environment variable won.
  deps.env.RELAY_WORKSPACE_KEY = selection.key;
  if (selection.source === 'project' || selection.source === 'store') {
    deps.env.RELAY_API_KEY = selection.key;
  }
  if (selection.source !== 'project') {
    return undefined;
  }

  const pinned = readProjectWorkspaceSession(projectDataDir, deps.fs);
  if (pinned?.enrolledNodeId) {
    deps.env.AGENT_RELAY_ENROLLED_NODE_ID = pinned.enrolledNodeId;
  }
  return pinned;
}

/** Human-readable name for a precedence-ladder step, for the startup line. */
function describeWorkspaceSource(source: WorkspaceSelection['source']): string {
  switch (source) {
    case 'flag':
      return 'command-line flag';
    case 'env':
      return 'environment';
    case 'project':
      return 'repository pin';
    case 'store':
      return 'machine-global active workspace';
  }
}

/**
 * Preserve the original source across `--background` re-exec. The detached
 * child sees the normalized RELAY_WORKSPACE_KEY as an env selection, so this
 * marker carries only provenance; it never participates in resolution.
 */
function recordWorkspaceBindingSource(
  selection: WorkspaceSelection | undefined,
  deps: CoreDependencies,
  overrideSource?: WorkspaceBindingSource
): WorkspaceBindingSource {
  const inheritedSource = workspaceBindingSource(deps.env[WORKSPACE_BINDING_SOURCE_ENV]);
  const source: WorkspaceBindingSource =
    overrideSource ??
    (selection?.source === 'env' && inheritedSource ? inheritedSource : (selection?.source ?? 'created'));
  deps.env[WORKSPACE_BINDING_SOURCE_ENV] = source;
  return source;
}

export async function runUpCommand(options: UpOptions, deps: CoreDependencies): Promise<void> {
  ensureBundledAgentRelayMcpCommand(deps);

  const paths = deps.getProjectPaths();
  // The stable, default project data dir (`.agentworkforce/relay/`) captured
  // BEFORE any --state-dir override below. SDK-backed commands resolve the
  // recorded workspace key from this default location (they don't accept
  // --state-dir), so the key must be persisted here even when broker state is
  // redirected elsewhere.
  const projectWorkspaceKeyDataDir = paths.dataDir;
  // The broker's startup_session_set_with_options() checks RELAY_WORKSPACES_JSON
  // before any single workspace key, so a flag/env/pin/store resolution here
  // would report provenance the broker never actually used.
  const joinsMultiWorkspaceSession = usesMultiWorkspaceEnv(deps.env);
  const workspaceSelection = joinsMultiWorkspaceSession
    ? undefined
    : resolveWorkspaceSelection({
        workspaceKey: options.workspaceKey,
        env: deps.env,
        projectDataDir: projectWorkspaceKeyDataDir,
        fileSystem: deps.fs,
      });
  const workspaceBindingSource = recordWorkspaceBindingSource(
    workspaceSelection,
    deps,
    joinsMultiWorkspaceSession ? 'multi-workspace' : undefined
  );
  const resumedProjectSession = joinsMultiWorkspaceSession
    ? undefined
    : applyWorkspaceSelection(workspaceSelection, deps, projectWorkspaceKeyDataDir);
  if (joinsMultiWorkspaceSession) {
    deps.log(`Workspace source: ${workspaceBindingSourceLabel('multi-workspace')}`);
  }
  // --state-dir overrides where the broker writes state / connection files
  if (options.stateDir) {
    const resolved = path.resolve(options.stateDir);
    paths.dataDir = resolved;
    deps.env.AGENT_RELAY_STATE_DIR = resolved;
  }

  // If a workspace key was explicitly provided, inject it into the environment
  // for both current tools and older compatibility paths. This must happen
  // before the --background spawn: the detached child inherits deps.env, and
  // env is the key's only channel — it never rides on argv, where `ps` would
  // expose it for the daemon's whole lifetime.
  if (options.workspaceKey) {
    deps.env.RELAY_WORKSPACE_KEY = options.workspaceKey;
    deps.env.RELAY_API_KEY = options.workspaceKey;
  }

  if (options.background) {
    const preflight = await recoverHalfStartedBroker(paths, deps);
    if (preflight === 'running') {
      const pid = readBrokerPid(paths.dataDir, deps);
      deps.error(
        pid
          ? `Broker already running for this project (pid: ${pid}).`
          : 'Broker already running for this project.'
      );
      deps.error('Run `agent-relay status` to inspect it, then `agent-relay down` to stop it.');
      deps.exit(1);
      return;
    }
    if (preflight === 'blocked') {
      deps.exit(1);
      return;
    }

    const startErrorPath = backgroundStartErrorPath(paths.dataDir);
    safeUnlink(startErrorPath, deps);
    const args = childUpArgsForDetachedStart(options, deps);
    const invocation = detachedCliInvocation(deps, args);
    let child: SpawnedProcess;
    try {
      child = deps.spawnProcess(invocation.command, invocation.args, {
        detached: true,
        stdio: 'ignore',
        env: deps.env,
      });
    } catch (err: unknown) {
      deps.error(`Failed to start broker in background: ${describeErrorWithCause(err)}`);
      deps.exit(1);
      return;
    }
    child.unref?.();
    vlog(
      deps,
      options.verbose,
      `Spawned detached broker child (pid: ${child.pid ?? 'unknown'}), waiting for readiness...`
    );
    const readiness = await waitForBrokerReadiness(
      paths,
      deps,
      DETACHED_START_READY_TIMEOUT_MS,
      true,
      options.verbose,
      child.pid
    );
    if (readiness.state !== 'running') {
      const pid = readiness.state === 'starting' ? readiness.conn.pid : child.pid;
      const childExited =
        typeof child.pid === 'number' && child.pid > 0 && !isProcessRunning(child.pid, deps);
      if (childExited) {
        deps.error(`Broker background child exited before becoming ready (pid: ${child.pid}).`);
      } else {
        deps.error(
          pid
            ? `Broker background start did not become ready within ${DETACHED_START_READY_TIMEOUT_MS / 1000}s (pid: ${pid}).`
            : `Broker background start did not become ready within ${DETACHED_START_READY_TIMEOUT_MS / 1000}s.`
        );
      }
      if (readiness.state === 'starting') {
        deps.error('Broker process is running, but the API did not become ready.');
      }
      const detachedError = readBackgroundStartError(paths.dataDir, deps);
      if (detachedError) {
        deps.error(`Detached broker error: ${detachedError}`);
      } else if (childExited) {
        deps.error('Retry without --background to see the broker startup error.');
      }
      deps.error(
        'Run `agent-relay status --wait-for=10` for details, or `agent-relay down --force` to clean up.'
      );
      const cleanupPids = new Set<number>();
      if (typeof child.pid === 'number' && child.pid > 0 && isProcessRunning(child.pid, deps)) {
        cleanupPids.add(child.pid);
      }
      if (readiness.state === 'starting') {
        cleanupPids.add(readiness.conn.pid);
      }
      for (const cleanupPid of cleanupPids) {
        deps.warn(`Cleaning up failed broker start (pid: ${cleanupPid})`);
        const stopped = await terminateProcess(cleanupPid, deps, true);
        if (!stopped) {
          deps.error(
            `Failed to stop half-started broker process (pid: ${cleanupPid}). ` +
              'Run `agent-relay down --force` to retry cleanup, or remove `.agentworkforce/relay/` after stopping the process.'
          );
        }
      }
      cleanupBrokerFiles(paths, deps);
      deps.exit(1);
      return;
    }
    const enrolledNodeToken = deps.env.RELAY_NODE_TOKEN?.trim();
    const enrolledNodeId = enrolledNodeToken ? deps.env.RELAY_NODE_ID?.trim() : undefined;
    let enrollmentFailureReason: string | undefined;
    if (enrolledNodeToken && !enrolledNodeId) {
      enrollmentFailureReason =
        'Cloud enrollment credentials are incomplete: RELAY_NODE_ID is required when RELAY_NODE_TOKEN is set.';
    } else if (enrolledNodeId) {
      const enrolledReadiness = await waitForEnrolledNodeReadiness(
        readiness.conn,
        deps,
        {
          nodeId: enrolledNodeId,
          ...(options.brokerName?.trim() ? { nodeName: options.brokerName.trim() } : {}),
        },
        readiness.statusDetails
      );
      if (!enrolledReadiness.ready) {
        enrollmentFailureReason = enrolledReadiness.reason ?? 'Cloud enrollment did not become ready.';
      }
    }
    if (enrollmentFailureReason) {
      deps.error(enrollmentFailureReason);
      const cleanupPids = new Set<number>();
      if (typeof child.pid === 'number' && child.pid > 0) {
        cleanupPids.add(child.pid);
      }
      cleanupPids.add(readiness.conn.pid);
      let allStopped = true;
      for (const cleanupPid of cleanupPids) {
        deps.warn(`Cleaning up failed broker start (pid: ${cleanupPid})`);
        const stopped = await terminateProcess(cleanupPid, deps, true);
        if (!stopped) {
          allStopped = false;
          deps.error(
            `Failed to stop broker process after Cloud enrollment startup failed (pid: ${cleanupPid}). ` +
              'Run `agent-relay down --force` to retry cleanup.'
          );
        }
      }
      if (allStopped) {
        cleanupBrokerFiles(paths, deps);
      }
      deps.exit(1);
      return;
    }
    deps.log('Broker started.');
    deps.log(`Broker PID: ${readiness.conn.pid}`);
    deps.log('Stop with: agent-relay down');
    safeUnlink(startErrorPath, deps);
    deps.exit(0);
    return;
  }

  const basePort = resolveBrokerBasePort(deps);
  deps.fs.mkdirSync(paths.dataDir, { recursive: true });
  const existingPid = readBrokerPid(paths.dataDir, deps);

  let relay: CoreRelay | null = null;
  let nodeProviders: RunningNodeProviders | undefined;
  let reflexCapture: RunningReflexCapture | undefined;
  let shuttingDown = false;
  let sigintCount = 0;
  let shutdownPromise: Promise<void> | undefined;
  const shutdownOnce = async (): Promise<void> => {
    if (!shutdownPromise) {
      shuttingDown = true;
      if (relay === null) {
        shutdownPromise = Promise.resolve();
      } else {
        shutdownPromise = (async () => {
          await reflexCapture?.stop();
          await nodeProviders?.stop();
          await shutdownUpResources(relay, paths.dataDir, deps);
        })();
      }
    }
    await shutdownPromise;
  };
  const crashGuard = installStartupCrashGuard(deps, paths, options, shutdownOnce);
  // Registered before any async startup work (broker spawn, capability
  // providers, Reflex capture, node delivery wait) so a signal arriving
  // during that window gets the same graceful, logged shutdown as one that
  // arrives later during hold-open. Previously these were registered just
  // before hold-open — a SIGTERM in that earlier window hit Node's bare
  // default disposition (silent immediate termination) instead, which is
  // indistinguishable from a genuine crash when observed from outside.
  deps.onSignal('SIGINT', async () => {
    sigintCount += 1;
    if (shuttingDown) {
      if (sigintCount >= 2) {
        deps.warn('Force exiting...');
        deps.exit(130);
      }
      return;
    }
    deps.log('\nStopping...');
    await shutdownOnce();
    deps.exit(0);
  });
  deps.onSignal('SIGTERM', async () => {
    if (shuttingDown) {
      return;
    }
    deps.log('\nStopping (SIGTERM)...');
    await shutdownOnce();
    deps.exit(0);
  });
  try {
    if (existingPid !== null) {
      if (isProcessRunning(existingPid, deps)) {
        deps.error(`Broker already running for this project (pid: ${existingPid}).`);
        deps.error('Run `agent-relay status` to inspect it, then `agent-relay down` to stop it.');
        deps.exit(1);
        return;
      }
      safeUnlink(path.join(paths.dataDir, CONNECTION_FILENAME), deps);
    }

    // Point the shared logger at a file / level / format before the fleet
    // sidecar (which reads this env when it builds its logger) starts.
    applyNodeLogEnv(options, deps);

    // Resolved BEFORE the broker starts so an explicit bad --config fails
    // fast instead of tearing down a broker that just came up.
    const nodePlan = await resolveNodeDefinitionForUp(paths, options, deps);
    const teamsConfig = deps.loadTeamsConfig(paths.projectRoot);

    // The broker advertises spawn:<harness> capacity for this set. A pre-set
    // AGENT_RELAY_NODE_HARNESSES is the operator's authoritative declaration of the
    // node's real capacity and is used verbatim; otherwise the CLI computes it from
    // the project's runnable harnesses (built-in defaults plus teams.json clis and
    // any spawn:<harness> definitions) and passes it to the broker before it registers.
    deps.env.AGENT_RELAY_NODE_HARNESSES = resolveNodeCapacityHarnesses(
      deps.env.AGENT_RELAY_NODE_HARNESSES,
      teamsConfig,
      planCapacitySource(nodePlan)
    );
    // Kill any orphaned broker processes for this project that lost their PID
    // files (e.g. user deleted .agentworkforce/relay/ while broker was running).
    vlog(deps, options.verbose, 'Checking for orphaned broker processes...');
    await killOrphanedBrokerProcesses(paths.projectRoot, deps);

    const restoreRepoPathsEnv = applyNodeRepoPathsEnv(deps.env, planRepoPaths(nodePlan));
    let started: Awaited<ReturnType<typeof startBrokerWithPortFallback>>;
    try {
      started = await startBrokerWithPortFallback(
        paths,
        basePort,
        deps,
        options.brokerName,
        options.verbose,
        // Assign `relay` as soon as the broker child process exists, not only
        // once the handshake/status-check retries above also succeed. A
        // SIGTERM/SIGINT arriving during that check window otherwise finds
        // `relay` still null, so `shutdownOnce()` no-ops and leaks the broker
        // child instead of shutting it down.
        (candidate) => {
          relay = candidate;
        }
      ).catch((err: unknown) => {
        // On failure, `startBrokerWithPortFallback` has already shut down any
        // candidate it created before rethrowing. Clear the early handle too
        // so the outer catch's `shutdownOnce()` does not call `shutdown()` a
        // second time on it.
        relay = null;
        throw err;
      });
    } finally {
      restoreRepoPathsEnv();
    }
    relay = started.relay;

    try {
      writeBrokerBindingSource(paths.dataDir, workspaceBindingSource, deps);
    } catch {
      // Provenance is diagnostic metadata; a broker that came up stays up.
    }
    safeUnlink(backgroundStartErrorPath(paths.dataDir), deps);

    deps.log(`Relay API: http://localhost:${started.apiPort}`);
    deps.log(`Project: ${paths.projectRoot}`);
    deps.log('Mode: broker (stdio)');
    deps.log(`Workspace Key: ${relay.workspaceKey ? maskSecret(relay.workspaceKey) : 'unknown'}`);
    // Minting must be observable: without this line "created a workspace" and
    // "joined the pinned workspace" print identically.
    const joinedWorkspaceId = relay.workspaceId ?? 'unknown';
    // The multi-workspace session always joins a configured membership; it
    // never mints a new workspace the way an unresolved single key does.
    if (workspaceSelection || joinsMultiWorkspaceSession) {
      deps.log(`Workspace: joined ${joinedWorkspaceId}`);
    } else {
      deps.log(`Workspace: created new workspace ${joinedWorkspaceId}`);
      deps.log(
        'Pin a workspace for this repository with `agent-relay up --workspace-key <key>`, ' +
          'or select one machine-wide with `agent-relay workspace switch <name>`.'
      );
    }
    deps.log('Broker started.');

    // Record the workspace this broker joined (explicitly passed or auto-minted)
    // in the DEFAULT project data dir (not any --state-dir override), so later
    // SDK commands in this CWD resolve it instead of the machine-global active
    // workspace. Persistence must never abort startup, so a write failure is
    // swallowed.
    try {
      writeProjectWorkspaceKey(projectWorkspaceKeyDataDir, relay.workspaceKey ?? undefined, {
        enrolledNodeId: deps.env.AGENT_RELAY_ENROLLED_NODE_ID ?? resumedProjectSession?.enrolledNodeId,
        // Recording the resolved workspace id lets the NEXT start detect a
        // conflicting source (a stored enrollment in another workspace) before
        // the broker comes up, instead of after agents land in the wrong place.
        workspaceId: relay.workspaceId ?? resumedProjectSession?.workspaceId,
      });
    } catch {
      // best-effort: a broker that came up should stay up even if the key file
      // can't be written (read-only dir, etc.).
    }

    vlog(deps, options.verbose, 'Starting node capability providers (if any)...');
    nodeProviders = await startNodeCapabilityProviders(paths, relay, options, deps, nodePlan);
    // When Reflex is enabled, periodically sync + push local session history to
    // relayhistory-cloud in-process via the ai-hist-native addon (no subprocess).
    // No-op when disabled or the addon isn't available.
    reflexCapture = startReflexCapture({ log: createReflexDiagnosticLog(options, deps) });
    const shouldSpawn =
      options.spawn === true ? true : options.spawn === false ? false : Boolean(teamsConfig?.autoSpawn);

    if (shouldSpawn && teamsConfig && teamsConfig.agents.length > 0) {
      vlog(deps, options.verbose, 'Waiting for broker node delivery (/v1/node/ws) before auto-spawning...');
      // Node delivery can't connect until the broker mints its node token, which
      // now happens in the background after `Broker started.`. Budget for that
      // mint window plus the connect so a slow mint doesn't abort auto-spawn.
      const delivery = await waitForNodeDelivery(
        relay,
        deps,
        NODE_TOKEN_WAIT_MS + NODE_DELIVERY_READY_TIMEOUT_MS
      );
      if (!delivery.ready) {
        deps.error('Refusing to auto-spawn agents because broker node delivery is not connected.');
        deps.error(`Node delivery: ${formatNodeDeliveryStatus(delivery.status)}`);
        deps.error(
          'Realtime injection depends on /v1/node/ws. Check broker logs for create_node/node token errors, then retry `agent-relay up --spawn`.'
        );
        await shutdownOnce();
        deps.exit(1);
        return;
      }
      for (const agent of teamsConfig.agents) {
        vlog(deps, options.verbose, `Spawning agent '${agent.name}' (cli: ${agent.cli})...`);
        await relay.spawn({
          name: agent.name,
          cli: agent.cli,
          channels: ['general'],
          task: agent.task ?? '',
          team: teamsConfig.team,
        });
      }
    } else if (options.spawn === true && !teamsConfig) {
      deps.warn('Warning: --spawn specified but no teams.json found');
    }

    const holdOpen = deps.holdOpen();
    if (nodeProviders?.done) {
      await Promise.race([holdOpen, nodeProviders.done]);
    } else {
      await holdOpen;
    }
  } catch (err: unknown) {
    // A rejection from cleanup must not swallow the original startup
    // failure -- without this, `deps.exit(1)` below would never run and the
    // startup error would go unreported.
    try {
      await shutdownOnce();
    } catch (cleanupError) {
      deps.warn(`Failed to clean up after broker startup failure: ${describeErrorWithCause(cleanupError)}`);
    }
    // A straggler process-level crash event for this same failure must not
    // also fire and duplicate the report below. Marked here -- after
    // cleanup, right before reporting -- rather than at catch-entry, so an
    // unrelated crash during the shutdownOnce() cleanup above is not
    // silently swallowed by this guard too.
    crashGuard.markHandled();
    reportBrokerStartFailure(err, deps, paths, options);
    deps.exit(1);
  } finally {
    crashGuard.dispose();
  }
}

// eslint-disable-next-line complexity, max-depth
export async function runDownCommand(options: DownOptions, deps: CoreDependencies): Promise<void> {
  const paths = deps.getProjectPaths();
  if (options.stateDir) {
    paths.dataDir = path.resolve(options.stateDir);
  }
  const timeout = Number.parseInt(options.timeout ?? '5000', 10) || 5000;

  if (options.all) {
    deps.log('Stopping all agent-relay processes...');
    try {
      const { stdout } = await deps.execCommand('ps aux');
      const pids: number[] = [];

      for (const line of stdout.split('\n')) {
        if (!line.includes('agent-relay') || !line.includes(' up') || line.includes('agent-relay-mcp')) {
          continue;
        }

        const fields = line.trim().split(/\s+/);
        const pid = Number.parseInt(fields[1], 10);
        if (!Number.isNaN(pid) && pid > 0 && pid !== deps.pid) {
          pids.push(pid);
        }
      }

      for (const pid of pids) {
        try {
          deps.killProcess(pid, 'SIGTERM');
        } catch {
          // Ignore dead pids.
        }
      }

      if (options.force) {
        await deps.sleep(2000);
        for (const pid of pids) {
          // eslint-disable-next-line max-depth
          if (isProcessRunning(pid, deps)) {
            // eslint-disable-next-line max-depth
            try {
              deps.killProcess(pid, 'SIGKILL');
            } catch {
              // Ignore dead pids.
            }
          }
        }
      }
    } catch (err: unknown) {
      deps.error(`Error finding processes: ${toErrorMessage(err)}`);
    }

    cleanupBrokerFiles(paths, deps);
    deps.log('Done');
    return;
  }

  const conn = readBrokerConnectionFromFs(deps.fs, paths.dataDir);
  if (!conn) {
    if (options.force) {
      await killOrphanedBrokerProcesses(paths.projectRoot, deps, { force: true });
      cleanupBrokerFiles(paths, deps);
      deps.log('Cleaned up (was not running)');
    } else {
      deps.log('Not running');
    }
    return;
  }

  const pid = conn.pid;
  if (!pid || pid <= 0) {
    cleanupBrokerFiles(paths, deps);
    deps.log('Cleaned up stale state (invalid connection file)');
    return;
  }

  if (!isProcessRunning(pid, deps)) {
    cleanupBrokerFiles(paths, deps);
    deps.log('Cleaned up stale state (process was not running)');
    return;
  }

  try {
    deps.log(`Stopping broker (pid: ${pid})...`);
    deps.killProcess(pid, 'SIGTERM');

    const exited = await waitForProcessExit(pid, timeout, deps);
    if (!exited) {
      // eslint-disable-next-line max-depth
      if (options.force) {
        deps.log('Graceful shutdown timed out, forcing...');
        // eslint-disable-next-line max-depth
        try {
          deps.killProcess(pid, 'SIGKILL');
          await waitForProcessExit(pid, 2000, deps);
        } catch {
          // Ignore kill errors.
        }
      } else {
        deps.log(`Graceful shutdown timed out after ${timeout}ms. Use --force to kill.`);
        return;
      }
    }

    cleanupBrokerFiles(paths, deps);
    deps.log('Stopped');
  } catch (err: unknown) {
    const withCode = err as { code?: string };
    if (withCode.code === 'ESRCH') {
      cleanupBrokerFiles(paths, deps);
      deps.log('Cleaned up stale state');
      return;
    }
    deps.error(`Error stopping broker: ${toErrorMessage(err)}`);
  }
}

export async function runStatusCommand(
  deps: CoreDependencies,
  options?: { stateDir?: string; waitFor?: string }
): Promise<void> {
  const paths = deps.getProjectPaths();
  if (options?.stateDir) {
    paths.dataDir = path.resolve(options.stateDir);
  }
  const waitMs = parseWaitForMs(options?.waitFor, deps);
  if (waitMs === null) {
    return;
  }

  const readiness = await waitForBrokerReadiness(paths, deps, waitMs, waitMs > 0);
  if (readiness.state === 'stopped') {
    deps.log('Status: STOPPED');
    if (waitMs > 0) {
      deps.exit(1);
    }
    return;
  }

  if (readiness.state === 'starting') {
    deps.log('Status: STARTING');
    deps.log('Mode: broker (stdio)');
    deps.log(`PID: ${readiness.conn.pid}`);
    deps.log(`Project: ${paths.projectRoot}`);
    deps.warn('Broker process is running, but the API did not become ready before timeout.');
    deps.exit(1);
    return;
  }

  deps.log('Status: RUNNING');
  deps.log('Mode: broker (stdio)');
  deps.log(`PID: ${readiness.conn.pid}`);
  deps.log(`Project: ${paths.projectRoot}`);
  const source = workspaceBindingSource(readiness.conn.workspace_source);
  deps.log(
    source
      ? `Workspace source: ${workspaceBindingSourceLabel(source)}`
      : 'Workspace source: unknown (startup provenance was not recorded)'
  );

  // Query the running broker for additional status info
  const statusDetails =
    readiness.statusDetails ?? (waitMs > 0 ? null : await readBrokerStatusDetails(readiness.conn));
  if (statusDetails) {
    const { status, session } = statusDetails;
    if (typeof status.agent_count === 'number') {
      deps.log(`Agents: ${status.agent_count}`);
    }
    if (typeof status.pending_delivery_count === 'number' && status.pending_delivery_count > 0) {
      deps.log(`Pending deliveries: ${status.pending_delivery_count}`);
    }
    deps.log(`Node delivery: ${formatNodeDeliveryStatus(status)}`);
    if (session?.node_id) {
      deps.log(`Node: ${session.node_name?.trim() || session.node_id} (${session.node_id})`);
    }
    if (session?.workspace_key) {
      deps.log(`Workspace Key: ${maskSecret(session.workspace_key)}`);
    }
  }
}

function parseWaitForMs(rawValue: string | undefined, deps: CoreDependencies): number | null {
  const rawWaitFor = rawValue?.trim();
  if (rawWaitFor !== undefined && !/^\d+(?:\.\d+)?$/.test(rawWaitFor)) {
    deps.error('--wait-for must be a non-negative number of seconds.');
    deps.exit(1);
    return null;
  }
  const waitSeconds = rawWaitFor === undefined ? 0 : Number.parseFloat(rawWaitFor);
  return waitSeconds > 0 ? waitSeconds * 1000 : 0;
}

async function readBrokerStatusDetails(conn: BrokerConnection): Promise<BrokerStatusDetails | null> {
  const client = new HarnessDriverClient({ baseUrl: conn.url, apiKey: conn.api_key });
  try {
    const status = await client.getStatus();
    const session = await client.getSession().catch(() => null);
    return { status, session };
  } catch {
    return null;
  } finally {
    client.disconnect();
  }
}
