import fs from 'node:fs';
import path from 'node:path';
import { HarnessDriverClient } from '@agent-relay/harness-driver';

import type {
  CoreDependencies,
  CoreProjectPaths,
  CoreRelay,
  CoreTeamsConfig,
  SpawnedProcess,
} from '../commands/core.js';
import { track } from '../telemetry/index.js';
import { buildBundledAgentRelayMcpCommand } from './agent-relay-mcp-command.js';
import { errorClassName } from './telemetry-helpers.js';
import {
  createImplicitLocalFleetNode,
  fleetStatusPath,
  startFleetSidecar,
  type RunningFleetSidecar,
} from './fleet-sidecar.js';

type UpOptions = {
  spawn?: boolean;
  background?: boolean;
  verbose?: boolean;
  workspaceKey?: string;
  stateDir?: string;
  brokerName?: string;
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
const STATUS_POLL_INTERVAL_MS = 500;
const DETACHED_START_READY_TIMEOUT_MS = 10_000;
const NODE_DELIVERY_READY_TIMEOUT_MS = 10_000;

export interface BrokerConnection {
  url: string;
  port: number;
  api_key: string;
  pid: number;
}

type BrokerStatusDetails = {
  status: Awaited<ReturnType<HarnessDriverClient['getStatus']>>;
  session: Awaited<ReturnType<HarnessDriverClient['getSession']>> | null;
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
  return err instanceof Error ? err.message : String(err);
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
 * Node's native `fetch()` throws `TypeError: fetch failed` for any network
 * problem and stuffs the real reason (ECONNREFUSED, ENOTFOUND, AbortError,
 * UND_ERR_CONNECT_TIMEOUT, …) into `err.cause`. Without unwrapping, every
 * outbound HTTP failure looks identical to the user.
 *
 * Exported for testing.
 */
export function describeError(err: unknown): string {
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
  return parts.join(' — ');
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
  if (/fetch failed/i.test(message)) return 'connect';
  if (/Broker did not report API port/i.test(message)) return 'spawn';
  if (/Broker process exited with code/i.test(message)) return 'spawn';
  if (/ENOENT/i.test(message) && /broker/i.test(message)) return 'resolve_binary';
  return 'startup';
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
 * multiple brokers can run side by side (e.g. in tests); the broker HTTP API
 * binds near `basePort + 1` with fallback scanning.
 */
export function resolveBrokerBasePort(deps: Pick<CoreDependencies, 'env'>): number {
  const raw = Number.parseInt(deps.env.AGENT_RELAY_BROKER_PORT ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BROKER_BASE_PORT;
}

export async function startBrokerWithPortFallback(
  paths: CoreProjectPaths,
  basePort: number,
  deps: CoreDependencies,
  brokerName?: string
): Promise<{ relay: CoreRelay; apiPort: number }> {
  // Resolve a free API port BEFORE spawning the broker.  This avoids
  // spawning (and flocking) multiple --persist brokers during retry,
  // which caused stale-flock "already running" errors.
  const startApiPort = basePort + 1;
  const apiPort = await resolveApiPortWithFallback(startApiPort, MAX_API_PORT_ATTEMPTS, deps);

  const candidate = await deps.createRelay(paths.projectRoot, apiPort, brokerName);

  await candidate.getStatus();
  return { relay: candidate, apiPort };
}

function startImplicitLocalFleetSidecar(
  paths: CoreProjectPaths,
  relay: CoreRelay,
  options: UpOptions,
  deps: CoreDependencies,
  teamsConfig: CoreTeamsConfig | null = deps.loadTeamsConfig(paths.projectRoot)
): RunningFleetSidecar | undefined {
  if (deps.env.AGENT_RELAY_DISABLE_IMPLICIT_FLEET_NODE === '1') {
    return undefined;
  }
  const conn = readBrokerConnectionFromFs(deps.fs, paths.dataDir);
  if (!conn) {
    deps.warn('Fleet local node skipped: broker connection file was not available.');
    return undefined;
  }
  // The implicit local fleet node is best-effort: it lets this broker advertise
  // itself as a fleet node, but the broker is already up and usable without it.
  // Never let a sidecar setup failure abort `up`.
  try {
    const node = createImplicitLocalFleetNode({
      paths,
      teamsConfig,
      name: options.brokerName ?? (path.basename(paths.projectRoot) || 'local-node'),
    });
    return startFleetSidecar({
      definition: node,
      connection: { url: conn.url, apiKey: conn.api_key },
      workspaceKey: relay.workspaceKey,
      statusPath: fleetStatusPath(paths),
      reconnect: true,
      warn: (message) => deps.warn(message),
    });
  } catch (err) {
    deps.warn(`Fleet local node skipped: ${toErrorMessage(err)}`);
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
  const args = cliUserArgs(deps).filter((arg) => !matchesCliOption(arg, '--background'));
  if (options.stateDir && !hasCliOption(args, '--state-dir')) {
    args.push('--state-dir', path.resolve(options.stateDir));
  }
  if (options.workspaceKey && !hasCliOption(args, '--workspace-key')) {
    args.push('--workspace-key', options.workspaceKey);
  }
  if (options.brokerName && !hasCliOption(args, '--broker-name')) {
    args.push('--broker-name', options.brokerName);
  }
  if (options.verbose === true && !args.includes('--verbose')) {
    args.push('--verbose');
  }
  return args;
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

function isBundledBunExecutableEntrypoint(deps: CoreDependencies): boolean {
  // Bun --compile exposes argv[1] as a virtual path for the embedded executable.
  return deps.argv[0] === 'bun' && deps.cliScript.startsWith('/$bunfs/root/');
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
  requireApi: boolean
): Promise<BrokerReadiness> {
  const deadline = deps.now() + waitMs;
  let latest = await checkBrokerReadiness(paths, deps, requireApi);

  while (latest.state !== 'running' && waitMs > 0 && deps.now() < deadline) {
    await deps.sleep(Math.min(STATUS_POLL_INTERVAL_MS, Math.max(0, deadline - deps.now())));
    latest = await checkBrokerReadiness(paths, deps, requireApi);
  }

  return latest;
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
export async function runUpCommand(options: UpOptions, deps: CoreDependencies): Promise<void> {
  ensureBundledAgentRelayMcpCommand(deps);

  const paths = deps.getProjectPaths();
  // --state-dir overrides where the broker writes state / connection files
  if (options.stateDir) {
    const resolved = path.resolve(options.stateDir);
    paths.dataDir = resolved;
    deps.env.AGENT_RELAY_STATE_DIR = resolved;
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
      deps.error(`Failed to start broker in background: ${describeError(err)}`);
      deps.exit(1);
      return;
    }
    child.unref?.();
    const readiness = await waitForBrokerReadiness(paths, deps, DETACHED_START_READY_TIMEOUT_MS, true);
    if (readiness.state !== 'running') {
      const pid = readiness.state === 'starting' ? readiness.conn.pid : child.pid;
      deps.error(
        pid
          ? `Broker background start did not become ready within ${DETACHED_START_READY_TIMEOUT_MS / 1000}s (pid: ${pid}).`
          : `Broker background start did not become ready within ${DETACHED_START_READY_TIMEOUT_MS / 1000}s.`
      );
      if (readiness.state === 'starting') {
        deps.error('Broker process is running, but the API did not become ready.');
      }
      deps.error(
        'Run `agent-relay status --wait-for=10` for details, or `agent-relay down --force` to clean up.'
      );
      const cleanupPids = new Set<number>();
      if (typeof child.pid === 'number' && child.pid > 0) {
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
    deps.log('Broker started.');
    deps.log(`Broker PID: ${readiness.conn.pid}`);
    deps.log('Stop with: agent-relay down');
    deps.exit(0);
    return;
  }

  const basePort = resolveBrokerBasePort(deps);
  deps.fs.mkdirSync(paths.dataDir, { recursive: true });
  const existingPid = readBrokerPid(paths.dataDir, deps);

  let relay: CoreRelay | null = null;
  let fleetSidecar: RunningFleetSidecar | undefined;
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
          await fleetSidecar?.stop();
          await shutdownUpResources(relay, paths.dataDir, deps);
        })();
      }
    }
    await shutdownPromise;
  };
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

    // If a workspace key was explicitly provided, inject it into the environment
    // for both current tools and older compatibility paths.
    if (options.workspaceKey) {
      deps.env.RELAY_WORKSPACE_KEY = options.workspaceKey;
      deps.env.RELAY_API_KEY = options.workspaceKey;
    }

    // Kill any orphaned broker processes for this project that lost their PID
    // files (e.g. user deleted .agentworkforce/relay/ while broker was running).
    await killOrphanedBrokerProcesses(paths.projectRoot, deps);

    const started = await startBrokerWithPortFallback(paths, basePort, deps, options.brokerName);
    relay = started.relay;

    deps.log(`Relay API: http://localhost:${started.apiPort}`);
    deps.log(`Project: ${paths.projectRoot}`);
    deps.log('Mode: broker (stdio)');
    deps.log(`Workspace Key: ${relay.workspaceKey ?? 'unknown'}`);
    deps.log('Broker started.');

    const teamsConfig = deps.loadTeamsConfig(paths.projectRoot);
    fleetSidecar = startImplicitLocalFleetSidecar(paths, relay, options, deps, teamsConfig);
    const shouldSpawn =
      options.spawn === true ? true : options.spawn === false ? false : Boolean(teamsConfig?.autoSpawn);

    if (shouldSpawn && teamsConfig && teamsConfig.agents.length > 0) {
      const delivery = await waitForNodeDelivery(relay, deps);
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
      await shutdownOnce();
      deps.exit(0);
    });

    await deps.holdOpen();
  } catch (err: unknown) {
    await shutdownOnce();
    const message = toErrorMessage(err);
    const stage = classifyBrokerStartStage(err, message);
    track('broker_start_failed', {
      stage,
      error_class: classifyBrokerStartError(err),
    });
    if (isBrokerAlreadyRunningError(message)) {
      reportAlreadyRunningError(message, paths.dataDir, deps);
    } else {
      deps.error(`Failed to start broker: ${describeError(err)}`);
    }
    deps.exit(1);
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
    if (session?.workspace_key) {
      deps.log(`Workspace Key: ${session.workspace_key}`);
      deps.log(`Observer: https://agentrelay.com/observer?key=${session.workspace_key}`);
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
