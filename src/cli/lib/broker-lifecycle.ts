import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRelayClient } from '@agent-relay/sdk';
import { track } from '@agent-relay/telemetry';

import type { CoreDependencies, CoreProjectPaths, CoreRelay, SpawnedProcess } from '../commands/core.js';
import { buildBundledRelaycastMcpCommand } from './relaycast-mcp-command.js';
import { errorClassName } from './telemetry-helpers.js';

type UpOptions = {
  dashboard?: boolean;
  port?: string;
  spawn?: boolean;
  background?: boolean;
  foreground?: boolean;
  verbose?: boolean;
  dashboardPath?: string;
  reuseExistingBroker?: boolean;
  workspaceKey?: string;
  stateDir?: string;
};

type DownOptions = {
  force?: boolean;
  all?: boolean;
  timeout?: string;
  stateDir?: string;
};

const MAX_API_PORT_ATTEMPTS = 25;
const MAX_DASHBOARD_PORT_ATTEMPTS = 25;
const MAX_PORT = 65535;

/** The broker writes this file with URL, port, API key, and PID. */
const CONNECTION_FILENAME = 'connection.json';
const STATUS_POLL_INTERVAL_MS = 500;
const DETACHED_START_READY_TIMEOUT_MS = 10_000;

export interface BrokerConnection {
  url: string;
  port: number;
  api_key: string;
  pid: number;
}

type BrokerStatusDetails = {
  status: Awaited<ReturnType<AgentRelayClient['getStatus']>>;
  session: Awaited<ReturnType<AgentRelayClient['getSession']>>;
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
export function classifyBrokerStartStage(err: unknown, message: string, wantsDashboard: boolean): string {
  if (errorCode(err) === 'EADDRINUSE' && wantsDashboard) return 'dashboard_port';
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

async function startBrokerWithPortFallback(
  paths: CoreProjectPaths,
  dashboardPort: number,
  deps: CoreDependencies
): Promise<{ relay: CoreRelay; apiPort: number }> {
  // Resolve a free API port BEFORE spawning the broker.  This avoids
  // spawning (and flocking) multiple --persist brokers during retry,
  // which caused stale-flock "already running" errors.
  const startApiPort = dashboardPort + 1;
  const apiPort = await resolveApiPortWithFallback(startApiPort, MAX_API_PORT_ATTEMPTS, deps);

  const candidate = await deps.createRelay(paths.projectRoot, apiPort);

  await candidate.getStatus();
  return { relay: candidate, apiPort };
}

async function resolveDashboardPortWithFallback(
  dashboardPort: number,
  dashboardPortCandidates: number,
  deps: CoreDependencies
): Promise<number> {
  for (let attempt = 0; attempt < dashboardPortCandidates; attempt += 1) {
    const candidatePort = dashboardPort + attempt;
    const inUse = await deps.isPortInUse(candidatePort);
    if (!inUse) {
      if (attempt > 0) {
        deps.warn(`Dashboard port ${dashboardPort} is already in use; trying ${candidatePort}`);
      }
      return candidatePort;
    }
  }

  throw new Error(`Failed to find an available dashboard port near ${dashboardPort}.`);
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function commandHasBrokerName(command: string, brokerName: string): boolean {
  const escapedName = escapeRegExp(brokerName);
  return new RegExp(`(?:^|\\s)--name(?:\\s+|=)${escapedName}(?:\\s|$)`).test(command);
}

async function killOrphanedBrokerProcesses(projectRoot: string, deps: CoreDependencies): Promise<void> {
  try {
    const brokerName = path.basename(projectRoot) || 'project';
    let candidates: ProcessInfo[] = [];
    try {
      const byName = await deps.execCommand('ps aux');
      candidates = byName.stdout
        .split('\n')
        .map(parsePsAuxLine)
        .filter((process): process is ProcessInfo => process !== null)
        .filter((process) => isBrokerExecutableCommand(process.command))
        .filter((process) => commandHasBrokerName(process.command, brokerName));
    } catch {
      // Expected if ps is unavailable; fall through to no matches.
    }
    if (candidates.length === 0) {
      try {
        const byPath = await deps.execCommand('ps aux');
        candidates = byPath.stdout
          .split('\n')
          .map(parsePsAuxLine)
          .filter((process): process is ProcessInfo => process !== null)
          .filter((process) => isBrokerExecutableCommand(process.command))
          .filter((process) => process.command.includes(projectRoot));
      } catch {
        // Expected if ps is unavailable; fall through to no matches.
      }
    }
    for (const { pid } of candidates) {
      if (pid === deps.pid) {
        continue;
      }
      deps.warn(`Killing orphaned broker process (pid: ${pid})`);
      try {
        deps.killProcess(pid, 'SIGTERM');
      } catch {
        // Process may have already exited.
      }
    }
    // Give killed processes a moment to exit.
    if (candidates.length > 0) {
      await deps.sleep(300);
    }
  } catch {
    // Best-effort orphan cleanup.
  }
}

function ensureBundledRelaycastMcpCommand(deps: CoreDependencies): void {
  if (deps.env.RELAYCAST_MCP_COMMAND?.trim()) {
    return;
  }

  const command = buildBundledRelaycastMcpCommand(deps.execPath, deps.cliScript, deps.fs.existsSync);
  if (command) {
    deps.env.RELAYCAST_MCP_COMMAND = command;
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
  const args = cliUserArgs(deps).filter(
    (arg) => !['--background', '--foreground'].some((name) => matchesCliOption(arg, name))
  );
  if (options.dashboard === false && !args.includes('--no-dashboard')) {
    args.push('--no-dashboard');
  }
  if (options.stateDir && !hasCliOption(args, '--state-dir')) {
    args.push('--state-dir', path.resolve(options.stateDir));
  }
  if (options.workspaceKey && !hasCliOption(args, '--workspace-key')) {
    args.push('--workspace-key', options.workspaceKey);
  }
  if (options.verbose === true && !args.includes('--verbose')) {
    args.push('--verbose');
  }
  if (options.dashboard === false && !args.includes('--foreground')) {
    args.push('--foreground');
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

function pickDashboardStaticDir(candidates: string[], deps: CoreDependencies): string | null {
  const existingCandidates = Array.from(new Set(candidates)).filter((candidate) =>
    deps.fs.existsSync(candidate)
  );
  if (existingCandidates.length === 0) {
    return null;
  }

  const pageMarkerPriority = [
    ['metrics.html', path.join('metrics', 'index.html')],
    ['app.html'],
    ['index.html'],
  ];

  for (const markerGroup of pageMarkerPriority) {
    const withMarker = existingCandidates.find((candidate) =>
      markerGroup.some((marker) => deps.fs.existsSync(path.join(candidate, marker)))
    );
    if (withMarker) {
      return withMarker;
    }
  }

  return existingCandidates[0];
}

function resolveDashboardStaticDir(dashboardBinary: string | null, deps: CoreDependencies): string | null {
  const explicitStaticDir = deps.env.RELAY_DASHBOARD_STATIC_DIR ?? deps.env.STATIC_DIR;
  if (explicitStaticDir && explicitStaticDir.trim()) {
    return explicitStaticDir;
  }

  if (!dashboardBinary) {
    return null;
  }

  if (dashboardBinary.endsWith('.js') || dashboardBinary.endsWith('.ts')) {
    const dashboardServerOutDir = path.resolve(path.dirname(dashboardBinary), '..', 'out');
    const siblingDashboardOutDir = path.resolve(
      path.dirname(dashboardBinary),
      '..',
      '..',
      'dashboard',
      'out'
    );
    return pickDashboardStaticDir([dashboardServerOutDir, siblingDashboardOutDir], deps);
  }

  const homeDir = deps.env.HOME || deps.env.USERPROFILE || '';
  if (!homeDir) {
    return null;
  }

  // Standalone installs download UI assets to ~/.relay/dashboard/out.
  const standaloneDashboardOutDir = path.join(homeDir, '.relay', 'dashboard', 'out');
  const legacyDashboardOutDir = path.join(homeDir, '.agent-relay', 'dashboard', 'out');
  return pickDashboardStaticDir([standaloneDashboardOutDir, legacyDashboardOutDir], deps);
}

function normalizeLocalhostRelayUrl(relayUrl: string): string {
  try {
    const parsed = new URL(relayUrl);
    if (parsed.hostname === 'localhost') {
      parsed.hostname = '127.0.0.1';
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return relayUrl;
  }
}

function getDefaultDashboardRelayUrl(apiPort: number): string {
  return normalizeLocalhostRelayUrl(`http://localhost:${apiPort}`);
}

function resolveDashboardRelayUrl(apiPort: number, deps: CoreDependencies): string {
  const explicitRelayUrl = deps.env.RELAY_DASHBOARD_RELAY_URL;
  if (explicitRelayUrl && explicitRelayUrl.trim()) {
    return normalizeLocalhostRelayUrl(explicitRelayUrl.trim());
  }

  return getDefaultDashboardRelayUrl(apiPort);
}

function isDebugLikeLoggingEnabled(deps: CoreDependencies): boolean {
  const rawLevel = String(deps.env.RUST_LOG ?? '').toLowerCase();
  return rawLevel.includes('debug') || rawLevel.includes('trace');
}

function getDashboardSpawnEnv(
  deps: CoreDependencies,
  relayUrl: string,
  enableVerboseLogging: boolean,
  relayApiKey?: string,
  brokerApiKey?: string
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...deps.env,
    RELAY_URL: relayUrl,
    VERBOSE: enableVerboseLogging || deps.env.VERBOSE === 'true' ? 'true' : deps.env.VERBOSE,
  };
  // Pass the workspace API key so the dashboard can make Relaycast API calls
  // (e.g. posting thread replies) without requiring a relaycast.json file.
  if (relayApiKey && !env.RELAY_API_KEY) {
    env.RELAY_API_KEY = relayApiKey;
  }
  // Pass the broker API key so the dashboard can authenticate with the
  // broker's HTTP API (e.g. /api/spawn, /api/spawned).
  if (brokerApiKey) {
    env.RELAY_BROKER_API_KEY = brokerApiKey;
  }
  return env;
}

function getDashboardSpawnArgs(
  paths: CoreProjectPaths,
  port: number,
  apiPort: number,
  dashboardBinary: string | null,
  relayUrl: string,
  enableVerboseLogging: boolean,
  deps: CoreDependencies
): string[] {
  const args = ['--port', String(port), '--data-dir', paths.dataDir];
  args.push('--relay-url', relayUrl);
  const staticDir = resolveDashboardStaticDir(dashboardBinary, deps);
  if (staticDir) {
    args.push('--static-dir', staticDir);
  }
  if (enableVerboseLogging) {
    args.push('--verbose');
  }
  return args;
}

function normalizeDashboardPath(rawDashboardPath: string | undefined): string | undefined {
  const trimmed = rawDashboardPath?.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('/')) {
    return trimmed;
  }
  return `/${trimmed}`;
}

interface DashboardStartupProcess extends SpawnedProcess {
  stdout?: {
    on?: (event: string, cb: (chunk: Buffer) => void) => void;
    removeListener?: (event: string, cb: (...args: unknown[]) => void) => void;
    off?: (event: string, cb: (...args: unknown[]) => void) => void;
  };
  stderr?: {
    on?: (event: string, cb: (chunk: Buffer) => void) => void;
    removeListener?: (event: string, cb: (...args: unknown[]) => void) => void;
    off?: (event: string, cb: (...args: unknown[]) => void) => void;
  };
}

function startDashboard(
  paths: CoreProjectPaths,
  port: number,
  apiPort: number,
  deps: CoreDependencies,
  enableVerboseLogging: boolean,
  dashboardBinaryOverride?: string | null,
  relayApiKey?: string,
  brokerApiKey?: string
): DashboardStartupProcess {
  const dashboardBinary =
    dashboardBinaryOverride === undefined ? deps.findDashboardBinary() : dashboardBinaryOverride;
  const relayUrl = resolveDashboardRelayUrl(apiPort, deps);
  const shouldEnableVerbose = enableVerboseLogging || isDebugLikeLoggingEnabled(deps);
  const args = getDashboardSpawnArgs(
    paths,
    port,
    apiPort,
    dashboardBinary,
    relayUrl,
    shouldEnableVerbose,
    deps
  );
  const launchTarget = dashboardBinary
    ? dashboardBinary.endsWith('.js')
      ? `node ${dashboardBinary}`
      : dashboardBinary
    : 'npx --yes @agent-relay/dashboard-server@latest';

  const spawnOpts = {
    stdio: ['ignore', 'pipe', 'pipe'] as unknown,
    env: getDashboardSpawnEnv(deps, relayUrl, shouldEnableVerbose, relayApiKey, brokerApiKey),
  };
  if (shouldEnableVerbose) {
    deps.log(`[dashboard] Starting: ${launchTarget} ${args.join(' ')}`);
  }

  let child: SpawnedProcess;
  if (dashboardBinary) {
    // If the binary is a .js file (local dev), run it with node
    if (dashboardBinary.endsWith('.js')) {
      child = deps.spawnProcess('node', [dashboardBinary, ...args], spawnOpts);
    } else {
      child = deps.spawnProcess(dashboardBinary, args, spawnOpts);
    }
  } else {
    child = deps.spawnProcess('npx', ['--yes', '@agent-relay/dashboard-server@latest', ...args], spawnOpts);
  }

  // Capture stderr for error reporting
  const childAny = child as unknown as {
    stdout?: { on?: (event: string, cb: (chunk: Buffer) => void) => void };
    stderr?: { on?: (event: string, cb: (chunk: Buffer) => void) => void };
    on?: (event: string, cb: (...args: unknown[]) => void) => void;
  };
  let stderrBuf = '';

  const logChunk = (chunk: Buffer, logger: (line: string) => void, prefix: string) => {
    if (!shouldEnableVerbose) {
      return;
    }
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) {
        logger(`[dashboard] ${prefix}: ${trimmed}`);
      }
    }
  };

  childAny.stdout?.on?.('data', (chunk: Buffer) => {
    logChunk(chunk, deps.log, 'stdout');
  });
  childAny.stderr?.on?.('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString();
    logChunk(chunk, deps.warn, 'stderr');
  });

  // Report early crashes
  childAny.on?.('exit', (...exitArgs: unknown[]) => {
    const code = exitArgs[0] as number | null;
    const signal = exitArgs[1] as string | null;
    if (code !== null && code !== 0) {
      deps.error(`Dashboard process exited with code ${code}`);
      if (stderrBuf.trim()) {
        deps.error(stderrBuf.trim().split('\n').slice(-5).join('\n'));
      }
    } else if (signal && signal !== 'SIGINT' && signal !== 'SIGTERM') {
      deps.error(`Dashboard process killed by signal ${signal}`);
    }
  });

  return child;
}

async function resolveStartedDashboardPort(
  process: DashboardStartupProcess,
  preferredPort: number,
  deps: CoreDependencies
): Promise<number | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const processAny = process as DashboardStartupProcess & {
      on?: (event: string, cb: (...args: unknown[]) => void) => void;
      off?: (event: string, cb: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, cb: (...args: unknown[]) => void) => void;
    };
    const detach = () => {
      process.stdout?.off?.('data', extractPort);
      process.stdout?.removeListener?.('data', extractPort);
      process.stderr?.off?.('data', extractPort);
      process.stderr?.removeListener?.('data', extractPort);
      processAny.off?.('exit', handleExit);
      processAny.removeListener?.('exit', handleExit);
      clearTimeout(timer);
    };
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      detach();
      deps.warn(`Dashboard did not report its bound port quickly; assuming requested port ${preferredPort}`);
      resolve(preferredPort);
    }, 3000);

    const finalize = (port: number) => {
      if (resolved) return;
      resolved = true;
      detach();
      resolve(port);
    };
    const handleExit = (...exitArgs: unknown[]) => {
      const code = exitArgs[0] as number | null;
      const signal = exitArgs[1] as string | null;
      if (resolved) {
        return;
      }
      resolved = true;
      detach();
      if (code !== null && code !== 0) {
        deps.warn(`Dashboard exited before reporting its port (code: ${code}).`);
      } else if (signal && signal !== 'SIGINT' && signal !== 'SIGTERM') {
        deps.warn(`Dashboard exited before reporting its port (signal: ${signal}).`);
      } else {
        deps.warn('Dashboard exited before reporting its bound port.');
      }
      resolve(null);
    };

    const extractPort = (...chunkArgs: unknown[]) => {
      const firstChunk = chunkArgs[0];
      if (!firstChunk) {
        return;
      }

      const chunk = Buffer.isBuffer(firstChunk)
        ? firstChunk
        : typeof firstChunk === 'string'
          ? Buffer.from(firstChunk)
          : Buffer.from(JSON.stringify(firstChunk));

      const match = chunk.toString().match(/Server running at http:\/\/localhost:(\d+)/i);
      if (!match?.[1]) {
        return;
      }
      const parsed = Number.parseInt(match[1], 10);
      if (!Number.isNaN(parsed)) {
        finalize(parsed);
      }
    };

    process.stdout?.on?.('data', extractPort);
    process.stderr?.on?.('data', extractPort);
    processAny.on?.('exit', handleExit);
  });
}

/**
 * Check if the cached dashboard UI assets match the installed dashboard-server
 * binary version. If they are stale (or missing a version marker), re-download
 * the latest assets from the relay-dashboard GitHub release.
 */
async function refreshDashboardAssetsIfStale(
  dashboardBinary: string | null,
  deps: CoreDependencies
): Promise<void> {
  if (!dashboardBinary || dashboardBinary.endsWith('.js') || dashboardBinary.endsWith('.ts')) {
    // Dev mode or npx — skip
    return;
  }

  // Get installed binary version (async to avoid blocking event loop)
  let binaryVersion: string;
  try {
    const versionResult = await deps.execCommand(`${JSON.stringify(dashboardBinary)} --version`);
    binaryVersion = versionResult.stdout.trim();
  } catch {
    return; // Can't determine version — skip
  }

  if (!binaryVersion) {
    return;
  }

  const homeDir = deps.env.HOME || deps.env.USERPROFILE || os.homedir();
  const assetsDir = path.join(homeDir, '.relay', 'dashboard', 'out');
  const versionFile = path.join(homeDir, '.relay', 'dashboard', '.version');

  // Check if assets match the binary version
  try {
    const cachedVersion = deps.fs.readFileSync(versionFile, 'utf-8').trim();
    if (cachedVersion === binaryVersion) {
      return; // Up to date
    }
  } catch {
    // No version file — need to download if assets exist but are unversioned,
    // or if assets don't exist at all
    if (deps.fs.existsSync(assetsDir)) {
      // Assets exist but no version marker — they're from an old install
    } else {
      // No assets at all — need to download
    }
  }

  deps.log(`Updating dashboard UI assets (${binaryVersion})...`);

  const uiUrl =
    'https://github.com/AgentWorkforce/relay-dashboard/releases/latest/download/dashboard-ui.tar.gz';
  const targetDir = path.join(homeDir, '.relay', 'dashboard');
  let tempDir: string | undefined;
  let tempFile: string | undefined;

  try {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `dashboard-ui-${deps.pid}-`));
    tempFile = path.join(tempDir, 'dashboard-ui.tar.gz');
    // Download (async to avoid blocking event loop during network I/O)
    await deps.execCommand(
      `curl -fsSL --max-time 30 ${JSON.stringify(uiUrl)} -o ${JSON.stringify(tempFile)}`
    );

    // Verify it's a valid gzip
    const header = Buffer.alloc(2);
    const fd = fs.openSync(tempFile, 'r');
    fs.readSync(fd, header, 0, 2, 0);
    fs.closeSync(fd);
    if (header[0] !== 0x1f || header[1] !== 0x8b) {
      if (tempFile) deps.fs.unlinkSync(tempFile);
      return; // Not a valid gzip file
    }

    // Remove old assets and extract (async to avoid blocking event loop)
    deps.fs.rmSync(assetsDir, { recursive: true, force: true });
    deps.fs.mkdirSync(targetDir, { recursive: true });
    await deps.execCommand(`tar -xzf ${JSON.stringify(tempFile)} -C ${JSON.stringify(targetDir)}`);
    if (tempFile) deps.fs.unlinkSync(tempFile);

    // Write version marker only after confirming extraction succeeded
    if (deps.fs.existsSync(path.join(assetsDir, 'index.html'))) {
      deps.fs.writeFileSync(versionFile, binaryVersion);
      deps.log(`Dashboard UI assets updated to ${binaryVersion}`);
    } else {
      deps.warn('Dashboard UI extraction may be incomplete — skipping version marker');
    }
  } catch {
    // Best-effort — don't block startup
    try {
      if (tempFile) deps.fs.unlinkSync(tempFile);
    } catch {
      /* ignore */
    }
  } finally {
    try {
      if (tempDir) deps.fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

async function startDashboardWithFallback(
  paths: CoreProjectPaths,
  dashboardPort: number,
  apiPort: number,
  deps: CoreDependencies,
  enableVerboseLogging: boolean,
  relayApiKey?: string,
  brokerApiKey?: string
): Promise<{ process: SpawnedProcess; port: number | null }> {
  const preferredBinary = deps.findDashboardBinary();
  await refreshDashboardAssetsIfStale(preferredBinary, deps);
  let process = startDashboard(
    paths,
    dashboardPort,
    apiPort,
    deps,
    enableVerboseLogging,
    preferredBinary,
    relayApiKey,
    brokerApiKey
  );
  let port = await resolveStartedDashboardPort(process as DashboardStartupProcess, dashboardPort, deps);

  if (port === null && preferredBinary) {
    deps.warn('Retrying dashboard startup using npx @agent-relay/dashboard-server@latest');
    process = startDashboard(
      paths,
      dashboardPort,
      apiPort,
      deps,
      enableVerboseLogging,
      null,
      relayApiKey,
      brokerApiKey
    );
    port = await resolveStartedDashboardPort(process as DashboardStartupProcess, dashboardPort, deps);
  }

  return { process, port };
}

async function waitForDashboard(
  port: number,
  process: SpawnedProcess,
  deps: Pick<CoreDependencies, 'warn'>,
  isShuttingDown: () => boolean
): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (process.killed) {
      if (!isShuttingDown()) {
        deps.warn(`Warning: Dashboard process exited before becoming ready on port ${port}`);
      }
      return;
    }
    try {
      const resp = await fetch(`http://localhost:${port}/health`);
      if (resp.ok) return; // Dashboard is up
    } catch {
      // Not ready yet
    }
  }
  if (!isShuttingDown()) {
    deps.warn(`Warning: Dashboard not responding on port ${port} after 10s`);
  }
}

async function discoverExistingBrokerApiPort(
  preferredApiPort: number,
  maxAttempts: number,
  deps: Pick<CoreDependencies, 'warn'>
): Promise<number> {
  const attempts = Math.max(1, maxAttempts);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const candidatePort = preferredApiPort + attempt;
    if (candidatePort > MAX_PORT) {
      return preferredApiPort;
    }
    try {
      const response = await fetch(`http://localhost:${candidatePort}/health`);
      if (response.ok) {
        if (attempt > 0) {
          deps.warn(`Detected existing broker API on port ${candidatePort}.`);
        }
        return candidatePort;
      }
    } catch {
      // Keep scanning.
    }
  }
  return preferredApiPort;
}

async function shutdownUpResources(
  relay: CoreRelay,
  dashboardProcess: SpawnedProcess | undefined,
  dataDir: string,
  deps: CoreDependencies,
  ownsBroker: boolean
): Promise<void> {
  if (dashboardProcess && !dashboardProcess.killed) {
    try {
      dashboardProcess.kill('SIGTERM');
    } catch {
      // Best-effort cleanup.
    }
  }

  await relay.shutdown().catch(() => undefined);
  if (ownsBroker) {
    safeUnlink(path.join(dataDir, CONNECTION_FILENAME), deps);
  }
}

// eslint-disable-next-line complexity
export async function runUpCommand(options: UpOptions, deps: CoreDependencies): Promise<void> {
  ensureBundledRelaycastMcpCommand(deps);

  const paths = deps.getProjectPaths();
  // --state-dir overrides where the broker writes state / connection files
  if (options.stateDir) {
    const resolved = path.resolve(options.stateDir);
    paths.dataDir = resolved;
    deps.env.AGENT_RELAY_STATE_DIR = resolved;
  }

  if (options.background || (options.dashboard === false && !options.foreground)) {
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
      deps.exit(1);
      return;
    }
    deps.log('Broker started.');
    deps.log(`Broker PID: ${readiness.conn.pid}`);
    deps.log('Stop with: agent-relay down');
    deps.exit(0);
    return;
  }

  const wantsDashboard = options.dashboard !== false;
  const requestedDashboardPort = Number.parseInt(options.port ?? '3888', 10) || 3888;
  const shouldReuseExistingBroker = options.reuseExistingBroker === true;
  const dashboardPort = wantsDashboard
    ? await resolveDashboardPortWithFallback(requestedDashboardPort, MAX_DASHBOARD_PORT_ATTEMPTS, deps)
    : requestedDashboardPort;
  if (wantsDashboard && dashboardPort !== requestedDashboardPort) {
    deps.warn(
      `Requested dashboard port ${requestedDashboardPort} is already in use; active dashboard will run on ${dashboardPort}.`
    );
  }

  deps.fs.mkdirSync(paths.dataDir, { recursive: true });
  let existingPid = readBrokerPid(paths.dataDir, deps);
  let ownsBroker = true;

  let relay: CoreRelay | null = null;
  let apiPort = dashboardPort + 1;
  let dashboardProcess: SpawnedProcess | undefined;
  const dashboardVerbose = Boolean(options.verbose) || isDebugLikeLoggingEnabled(deps);
  let shuttingDown = false;
  let sigintCount = 0;
  let shutdownPromise: Promise<void> | undefined;
  const shutdownOnce = async (): Promise<void> => {
    if (!shutdownPromise) {
      shuttingDown = true;
      if (relay === null) {
        shutdownPromise = Promise.resolve();
      } else {
        shutdownPromise = shutdownUpResources(relay, dashboardProcess, paths.dataDir, deps, ownsBroker);
      }
    }
    await shutdownPromise;
  };
  try {
    if (existingPid !== null) {
      if (isProcessRunning(existingPid, deps)) {
        if (!shouldReuseExistingBroker || !wantsDashboard) {
          deps.error(`Broker already running for this project (pid: ${existingPid}).`);
          deps.error('Run `agent-relay status` to inspect it, then `agent-relay down` to stop it.');
          deps.exit(1);
          return;
        }

        apiPort = await discoverExistingBrokerApiPort(Math.max(1, apiPort), MAX_API_PORT_ATTEMPTS, deps);
        const reusableRelay = await deps.createRelay(paths.projectRoot, apiPort);
        try {
          await reusableRelay.getStatus();
        } catch {
          await reusableRelay.shutdown().catch(() => undefined);
          deps.warn(
            `Broker already running for this project (pid: ${existingPid}), but API port ${apiPort} is not responding.`
          );
          deps.warn('Treating this as stale broker state and starting a fresh broker.');
          safeUnlink(path.join(paths.dataDir, CONNECTION_FILENAME), deps);
          existingPid = null;
        }

        if (existingPid === null) {
          // fallthrough and start a fresh broker
        } else {
          relay = reusableRelay;
          ownsBroker = false;
          const dashboardRelayUrl = resolveDashboardRelayUrl(apiPort, deps);
          const expectedRelayUrl = getDefaultDashboardRelayUrl(apiPort);
          if (
            deps.env.RELAY_DASHBOARD_RELAY_URL &&
            deps.env.RELAY_DASHBOARD_RELAY_URL.trim() !== '' &&
            deps.env.RELAY_DASHBOARD_RELAY_URL.trim() !== expectedRelayUrl
          ) {
            deps.warn(
              `RELAY_DASHBOARD_RELAY_URL is set to ${deps.env.RELAY_DASHBOARD_RELAY_URL.trim()}, ` +
                `but this session computed ${expectedRelayUrl}.`
            );
          }
          deps.log(`Relay API: ${dashboardRelayUrl}`);
          if (dashboardVerbose) {
            deps.log(`[dashboard] relay target resolved from config: ${dashboardRelayUrl}`);
          }
          deps.log(`Project: ${paths.projectRoot}`);
          deps.log('Mode: broker (stdio)');
          deps.log(`Workspace Key: ${relay.workspaceKey ?? 'unknown'}`);
          deps.log('Broker already running for this project; reusing existing broker.');

          if (wantsDashboard) {
            const brokerConn = readBrokerConnectionFromFs(deps.fs, paths.dataDir);
            const dashboardStart = await startDashboardWithFallback(
              paths,
              dashboardPort,
              apiPort,
              deps,
              dashboardVerbose,
              relay?.workspaceKey,
              brokerConn?.api_key
            );
            dashboardProcess = dashboardStart.process;
            const startedDashboardPort = dashboardStart.port;
            if (startedDashboardPort === null) {
              deps.warn('Dashboard failed to start. Check dashboard error logs above.');
            } else {
              if (startedDashboardPort !== dashboardPort) {
                deps.warn(
                  `Dashboard port ${dashboardPort} was already in use, so dashboard started on ${startedDashboardPort}`
                );
              }
              const dashboardPath = normalizeDashboardPath(options.dashboardPath);
              const dashboardUrl = dashboardPath
                ? `http://localhost:${startedDashboardPort}${dashboardPath}`
                : `http://localhost:${startedDashboardPort}`;
              deps.log(`Dashboard: ${dashboardUrl}`);

              waitForDashboard(startedDashboardPort, dashboardProcess, deps, () => shuttingDown).catch(
                () => {}
              );
            }
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
          return;
        }
      }

      safeUnlink(path.join(paths.dataDir, CONNECTION_FILENAME), deps);
      existingPid = null;
    }

    // If a workspace key was explicitly provided, inject it into the environment
    // so the Rust broker picks it up via RELAY_API_KEY.
    if (options.workspaceKey) {
      deps.env.RELAY_API_KEY = options.workspaceKey;
    }

    // Kill any orphaned broker processes for this project that lost their PID
    // files (e.g. user deleted .agent-relay/ while broker was running).
    await killOrphanedBrokerProcesses(paths.projectRoot, deps);

    const started = await startBrokerWithPortFallback(paths, dashboardPort, deps);
    relay = started.relay;
    apiPort = started.apiPort;
    const dashboardRelayUrl = resolveDashboardRelayUrl(apiPort, deps);
    const expectedRelayUrl = getDefaultDashboardRelayUrl(apiPort);
    if (
      deps.env.RELAY_DASHBOARD_RELAY_URL &&
      deps.env.RELAY_DASHBOARD_RELAY_URL.trim() !== '' &&
      deps.env.RELAY_DASHBOARD_RELAY_URL.trim() !== expectedRelayUrl
    ) {
      deps.warn(
        `RELAY_DASHBOARD_RELAY_URL is set to ${deps.env.RELAY_DASHBOARD_RELAY_URL.trim()}, ` +
          `but this session computed ${expectedRelayUrl}.`
      );
    }
    deps.log(`Relay API: ${dashboardRelayUrl}`);
    if (dashboardVerbose) {
      deps.log(`[dashboard] relay target resolved from config: ${dashboardRelayUrl}`);
    }

    deps.log(`Project: ${paths.projectRoot}`);
    deps.log('Mode: broker (stdio)');
    deps.log(`Workspace Key: ${relay.workspaceKey ?? 'unknown'}`);
    deps.log('Broker started.');

    if (wantsDashboard) {
      const brokerConn = readBrokerConnectionFromFs(deps.fs, paths.dataDir);
      const dashboardStart = await startDashboardWithFallback(
        paths,
        dashboardPort,
        apiPort,
        deps,
        dashboardVerbose,
        relay?.workspaceKey,
        brokerConn?.api_key
      );
      dashboardProcess = dashboardStart.process;
      const startedDashboardPort = dashboardStart.port;
      if (startedDashboardPort === null) {
        deps.warn('Dashboard failed to start. Check dashboard error logs above.');
      } else {
        if (startedDashboardPort !== dashboardPort) {
          deps.warn(
            `Dashboard port ${dashboardPort} was already in use, so dashboard started on ${startedDashboardPort}`
          );
        }
        const dashboardPath = normalizeDashboardPath(options.dashboardPath);
        const dashboardUrl = dashboardPath
          ? `http://localhost:${startedDashboardPort}${dashboardPath}`
          : `http://localhost:${startedDashboardPort}`;
        deps.log(`Dashboard: ${dashboardUrl}`);

        // Verify the dashboard is actually reachable (non-blocking)
        waitForDashboard(startedDashboardPort, dashboardProcess, deps, () => shuttingDown).catch(() => {});
      }
    }

    const teamsConfig = deps.loadTeamsConfig(paths.projectRoot);
    const shouldSpawn =
      options.spawn === true ? true : options.spawn === false ? false : Boolean(teamsConfig?.autoSpawn);

    if (shouldSpawn && teamsConfig && teamsConfig.agents.length > 0) {
      if (wantsDashboard) {
        deps.warn('Warning: auto-spawn from teams.json is skipped when dashboard mode manages the broker');
      } else {
        for (const agent of teamsConfig.agents) {
          await relay.spawn({
            name: agent.name,
            cli: agent.cli,
            channels: ['general'],
            task: agent.task ?? '',
            team: teamsConfig.team,
          });
        }
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
    const stage = classifyBrokerStartStage(err, message, wantsDashboard);
    track('broker_start_failed', {
      stage,
      error_class: classifyBrokerStartError(err),
    });
    if (errorCode(err) === 'EADDRINUSE' && wantsDashboard) {
      deps.error(`Dashboard port ${dashboardPort} is already in use.`);
    } else if (isBrokerAlreadyRunningError(message)) {
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
      await killOrphanedBrokerProcesses(paths.projectRoot, deps);
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
  const waitSeconds = Number.parseFloat(options?.waitFor ?? '0');
  const waitMs = Number.isFinite(waitSeconds) && waitSeconds > 0 ? waitSeconds * 1000 : 0;

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
    if (session.workspace_key) {
      deps.log(`Workspace Key: ${session.workspace_key}`);
      deps.log(`Observer: https://agentrelay.com/observer?key=${session.workspace_key}`);
    }
  }
}

async function readBrokerStatusDetails(conn: BrokerConnection): Promise<BrokerStatusDetails | null> {
  const client = new AgentRelayClient({ baseUrl: conn.url, apiKey: conn.api_key });
  try {
    const status = await client.getStatus();
    const session = await client.getSession();
    return { status, session };
  } catch {
    return null;
  } finally {
    client.disconnect();
  }
}
