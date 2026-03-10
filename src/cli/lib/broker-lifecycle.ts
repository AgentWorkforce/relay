import path from 'node:path';

import type { CoreDependencies, CoreProjectPaths, CoreRelay, SpawnedProcess } from '../commands/core.js';

type UpOptions = {
  dashboard?: boolean;
  port?: string;
  spawn?: boolean;
  background?: boolean;
  verbose?: boolean;
  dashboardPath?: string;
  reuseExistingBroker?: boolean;
};

type DownOptions = {
  force?: boolean;
  all?: boolean;
  timeout?: string;
};

const MAX_API_PORT_ATTEMPTS = 25;
const MAX_DASHBOARD_PORT_ATTEMPTS = 25;
const MAX_PORT = 65535;

/**
 * Sanitise a broker name the same way the Rust broker does: keep alphanumeric
 * characters (including Unicode) and hyphens, replace everything else with `-`.
 * Rust uses `char::is_alphanumeric()` which includes Unicode letters/digits,
 * so we use the equivalent `\p{L}` (letters) and `\p{N}` (numbers) classes.
 */
function sanitizeBrokerName(name: string): string {
  return name.replace(/[^\p{L}\p{N}-]/gu, '-');
}

/**
 * Derive the broker-name-specific PID filename, matching the Rust broker's
 * per-broker-name convention (`broker-{safe_name}.pid`).
 */
export function brokerPidFilename(projectRoot: string): string {
  const brokerName = path.basename(projectRoot) || 'project';
  return `broker-${sanitizeBrokerName(brokerName)}.pid`;
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  wantsDashboard: boolean,
  deps: CoreDependencies,
  verbose: boolean
): Promise<{ relay: CoreRelay; apiPort: number }> {
  // Resolve a free API port BEFORE spawning the broker.  This avoids
  // spawning (and flocking) multiple --persist brokers during retry,
  // which caused stale-flock "already running" errors.
  const startApiPort = dashboardPort + 1;
  const apiPort = await resolveApiPortWithFallback(startApiPort, MAX_API_PORT_ATTEMPTS, deps);

  const candidate = deps.createRelay(paths.projectRoot, apiPort);
  candidate.onBrokerStderr?.((line: string) => {
    if (verbose) {
      deps.error(`[broker] ${line}`);
    }
  });

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

function reportAlreadyRunningError(message: string, brokerPidPath: string, deps: CoreDependencies): void {
  const pid = readPidFile(brokerPidPath, deps);
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

function readPidFile(pidPath: string, deps: CoreDependencies): number | null {
  if (!deps.fs.existsSync(pidPath)) {
    return null;
  }

  const raw = deps.fs.readFileSync(pidPath, 'utf-8').trim();
  const pid = Number.parseInt(raw, 10);
  if (Number.isNaN(pid) || pid <= 0) {
    return null;
  }

  return pid;
}

function isProcessRunning(pid: number, deps: CoreDependencies): boolean {
  try {
    deps.killProcess(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killOrphanedBrokerProcesses(projectRoot: string, deps: CoreDependencies): Promise<void> {
  try {
    const shellQuote = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";
    const brokerName = path.basename(projectRoot) || 'project';
    let stdout = '';
    try {
      const byName = await deps.execCommand(
        `ps aux | grep '[a]gent-relay-broker' | grep -F ${shellQuote('--name ' + brokerName)}`
      );
      stdout = byName.stdout;
    } catch {
      // Name filter may not match older process invocations; try legacy path-based filter.
    }
    if (!stdout.trim()) {
      try {
        const byPath = await deps.execCommand(
          `ps aux | grep '[a]gent-relay-broker' | grep -F ${shellQuote(projectRoot)}`
        );
        stdout = byPath.stdout;
      } catch {
        // Expected when no orphaned processes are matched by either strategy.
      }
    }
    const lines = stdout.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const pid = Number.parseInt(parts[1], 10);
      if (!Number.isNaN(pid) && pid > 0 && pid !== deps.pid) {
        deps.warn(`Killing orphaned broker process (pid: ${pid})`);
        try {
          deps.killProcess(pid, 'SIGTERM');
        } catch {
          // Process may have already exited.
        }
      }
    }
    // Give killed processes a moment to exit.
    if (lines.length > 0) {
      await deps.sleep(300);
    }
  } catch {
    // grep returns exit code 1 when no matches found — this is expected.
  }
}

function cleanupBrokerPidIfStopped(brokerPidPath: string, deps: CoreDependencies): void {
  const pid = readPidFile(brokerPidPath, deps);
  if (pid === null || !isProcessRunning(pid, deps)) {
    safeUnlink(brokerPidPath, deps);
  }
}

function writeBrokerPid(brokerPidPath: string, pid: number, deps: CoreDependencies): void {
  try {
    deps.fs.writeFileSync(brokerPidPath, `${pid}\n`, 'utf-8');
  } catch {
    // Best-effort write. Down/status fall back to runtime probes when missing.
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
  const brokerPidPath = path.join(paths.dataDir, brokerPidFilename(paths.projectRoot));
  const legacyBrokerPidPath = path.join(paths.dataDir, 'broker.pid');
  const runtimePath = path.join(paths.dataDir, 'runtime.json');
  const relaySockPath = path.join(paths.dataDir, 'relay.sock');

  safeUnlink(brokerPidPath, deps);
  safeUnlink(legacyBrokerPidPath, deps);
  safeUnlink(relaySockPath, deps);
  safeUnlink(runtimePath, deps);

  // Clean up per-broker-name lock and pid files
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
  relayApiKey?: string
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
  relayApiKey?: string
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
    env: getDashboardSpawnEnv(deps, relayUrl, shouldEnableVerbose, relayApiKey),
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

async function startDashboardWithFallback(
  paths: CoreProjectPaths,
  dashboardPort: number,
  apiPort: number,
  deps: CoreDependencies,
  enableVerboseLogging: boolean,
  relayApiKey?: string
): Promise<{ process: SpawnedProcess; port: number | null }> {
  const preferredBinary = deps.findDashboardBinary();
  let process = startDashboard(
    paths,
    dashboardPort,
    apiPort,
    deps,
    enableVerboseLogging,
    preferredBinary,
    relayApiKey
  );
  let port = await resolveStartedDashboardPort(
    process as DashboardStartupProcess,
    dashboardPort,
    deps
  );

  if (port === null && preferredBinary) {
    deps.warn('Retrying dashboard startup using npx @agent-relay/dashboard-server@latest');
    process = startDashboard(paths, dashboardPort, apiPort, deps, enableVerboseLogging, null, relayApiKey);
    port = await resolveStartedDashboardPort(
      process as DashboardStartupProcess,
      dashboardPort,
      deps
    );
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
  brokerPidPath: string,
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
    safeUnlink(brokerPidPath, deps);
  }
}

// eslint-disable-next-line complexity
export async function runUpCommand(options: UpOptions, deps: CoreDependencies): Promise<void> {
  if (options.background) {
    const args = deps.argv.slice(2).filter((arg) => arg !== '--background');
    const child = deps.spawnProcess(deps.execPath, [deps.cliScript, ...args], {
      detached: true,
      stdio: 'ignore',
      env: deps.env,
    });
    child.unref?.();
    deps.log(`Broker started in background (pid: ${child.pid ?? 'unknown'})`);
    deps.log('Stop with: agent-relay down');
    deps.exit(0);
    return;
  }

  const paths = deps.getProjectPaths();
  const brokerPidPath = path.join(paths.dataDir, brokerPidFilename(paths.projectRoot));
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
  // Check per-broker-name PID first, fall back to legacy broker.pid
  let existingPid = readPidFile(brokerPidPath, deps);
  if (existingPid === null) {
    const legacyPidPath = path.join(paths.dataDir, 'broker.pid');
    existingPid = readPidFile(legacyPidPath, deps);
    if (existingPid !== null && !isProcessRunning(existingPid, deps)) {
      safeUnlink(legacyPidPath, deps);
    } else if (existingPid !== null) {
      // Migrate legacy PID to new per-broker-name path so down/status can find it
      writeBrokerPid(brokerPidPath, existingPid, deps);
      safeUnlink(legacyPidPath, deps);
    }
  }
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
        shutdownPromise = shutdownUpResources(relay, dashboardProcess, brokerPidPath, deps, ownsBroker);
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
        const reusableRelay = deps.createRelay(paths.projectRoot, apiPort);
        try {
          await reusableRelay.getStatus();
        } catch {
          await reusableRelay.shutdown().catch(() => undefined);
          deps.warn(
            `Broker already running for this project (pid: ${existingPid}), but API port ${apiPort} is not responding.`
          );
          deps.warn('Treating this as stale broker state and starting a fresh broker.');
          safeUnlink(brokerPidPath, deps);
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
          deps.log('Broker already running for this project; reusing existing broker.');

          if (wantsDashboard) {
            const dashboardStart = await startDashboardWithFallback(
              paths,
              dashboardPort,
              apiPort,
              deps,
              dashboardVerbose,
              relay?.workspaceKey
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

      safeUnlink(brokerPidPath, deps);
      existingPid = null;
    }

    // Kill any orphaned broker processes for this project that lost their PID
    // files (e.g. user deleted .agent-relay/ while broker was running).
    await killOrphanedBrokerProcesses(paths.projectRoot, deps);

    const started = await startBrokerWithPortFallback(
      paths,
      dashboardPort,
      wantsDashboard,
      deps,
      Boolean(options.verbose) || isDebugLikeLoggingEnabled(deps)
    );
    relay = started.relay;
    apiPort = started.apiPort;
    writeBrokerPid(brokerPidPath, relay.brokerPid ?? deps.pid, deps);
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
    deps.log('Broker started.');

    if (wantsDashboard) {
      const dashboardStart = await startDashboardWithFallback(
        paths,
        dashboardPort,
        apiPort,
        deps,
        dashboardVerbose,
        relay?.workspaceKey
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
    const withCode = err as { code?: string };
    const message = toErrorMessage(err);
    if (withCode.code === 'EADDRINUSE' && wantsDashboard) {
      deps.error(`Dashboard port ${dashboardPort} is already in use.`);
    } else if (isBrokerAlreadyRunningError(message)) {
      reportAlreadyRunningError(message, brokerPidPath, deps);
    } else {
      deps.error(`Failed to start broker: ${message}`);
    }
    deps.exit(1);
  }
}

// eslint-disable-next-line complexity, max-depth
export async function runDownCommand(options: DownOptions, deps: CoreDependencies): Promise<void> {
  const paths = deps.getProjectPaths();
  const brokerPidPath = path.join(paths.dataDir, brokerPidFilename(paths.projectRoot));
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

  // Check per-broker-name PID file first, then fall back to legacy broker.pid
  const legacyBrokerPidPath = path.join(paths.dataDir, 'broker.pid');
  let activePidPath = brokerPidPath;
  if (!deps.fs.existsSync(brokerPidPath) && deps.fs.existsSync(legacyBrokerPidPath)) {
    activePidPath = legacyBrokerPidPath;
  }

  if (!deps.fs.existsSync(activePidPath)) {
    if (options.force) {
      // Also kill any orphaned broker processes that lost their PID files
      await killOrphanedBrokerProcesses(paths.projectRoot, deps);
      cleanupBrokerFiles(paths, deps);
      deps.log('Cleaned up (was not running)');
    } else {
      deps.log('Not running');
    }
    return;
  }

  const pidRaw = deps.fs.readFileSync(activePidPath, 'utf-8').trim();
  const pid = Number.parseInt(pidRaw, 10);
  if (Number.isNaN(pid) || pid <= 0) {
    cleanupBrokerFiles(paths, deps);
    deps.log('Cleaned up stale state (invalid pid file)');
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

export async function runStatusCommand(deps: CoreDependencies): Promise<void> {
  const paths = deps.getProjectPaths();
  const brokerPidPath = path.join(paths.dataDir, brokerPidFilename(paths.projectRoot));

  let running = false;
  let brokerPid: number | undefined;

  // Check the per-broker-name PID file first, then fall back to legacy broker.pid
  const legacyBrokerPidPath = path.join(paths.dataDir, 'broker.pid');
  const pidPaths = [brokerPidPath];
  if (legacyBrokerPidPath !== brokerPidPath) {
    pidPaths.push(legacyBrokerPidPath);
  }

  for (const candidatePidPath of pidPaths) {
    if (!deps.fs.existsSync(candidatePidPath)) {
      continue;
    }
    const pidRaw = deps.fs.readFileSync(candidatePidPath, 'utf-8').trim();
    const pid = Number.parseInt(pidRaw, 10);
    if (!Number.isNaN(pid) && pid > 0) {
      if (isProcessRunning(pid, deps)) {
        brokerPid = pid;
        running = true;
        break;
      }
      safeUnlink(candidatePidPath, deps);
    } else {
      safeUnlink(candidatePidPath, deps);
    }
  }

  if (!running) {
    deps.log('Status: STOPPED');
    return;
  }

  deps.log('Status: RUNNING');
  deps.log('Mode: broker (stdio)');
  deps.log(`PID: ${brokerPid}`);
  deps.log(`Project: ${paths.projectRoot}`);

  const relay = deps.createRelay(paths.projectRoot);
  try {
    const status = await relay.getStatus();
    if (typeof status.agent_count === 'number') {
      deps.log(`Agents: ${status.agent_count}`);
    }
    if (typeof status.pending_delivery_count === 'number' && status.pending_delivery_count > 0) {
      deps.log(`Pending deliveries: ${status.pending_delivery_count}`);
    }
  } catch {
    // PID-based status is enough when broker query fails.
  } finally {
    await relay.shutdown().catch(() => undefined);
  }
}
