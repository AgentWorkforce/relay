import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CoreDependencies, CoreProjectPaths, SpawnedProcess } from '../commands/core.js';

export async function resolveDashboardPortWithFallback(
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

function getHomeDashboardRoot(deps: CoreDependencies): string {
  const homeDir = deps.env.HOME || deps.env.USERPROFILE || os.homedir();
  return path.join(homeDir, '.agentworkforce/relay', 'dashboard');
}

function getPriorDashboardRoot(deps: CoreDependencies): string | null {
  const homeDir = deps.env.HOME || deps.env.USERPROFILE || '';
  if (!homeDir) {
    return null;
  }
  return path.join(homeDir, '.relay', 'dashboard');
}

function getDashboardRootFromBinary(dashboardBinary: string | null, deps: CoreDependencies): string | null {
  if (!dashboardBinary || dashboardBinary.endsWith('.js') || dashboardBinary.endsWith('.ts')) {
    return null;
  }

  const binaryDir = path.dirname(dashboardBinary);
  if (path.basename(binaryDir) !== 'bin') {
    return null;
  }

  const homeDir = deps.env.HOME || deps.env.USERPROFILE || '';
  const resolvedBinaryDir = path.resolve(binaryDir);
  const ignoredBinDirs = [
    homeDir ? path.join(homeDir, '.local', 'bin') : null,
    path.join('/usr/local', 'bin'),
  ]
    .filter((candidate): candidate is string => Boolean(candidate))
    .map((candidate) => path.resolve(candidate));
  if (ignoredBinDirs.includes(resolvedBinaryDir)) {
    return null;
  }

  return path.join(path.dirname(binaryDir), 'dashboard');
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

  // Installs place UI assets under the install dir (~/.agentworkforce/relay/dashboard/out
  // by default, or next to a custom install's bin/ directory). ~/.relay/dashboard/out is
  // read as a fallback for installs predating that move.
  const installDashboardRoot = getDashboardRootFromBinary(dashboardBinary, deps);
  const priorDashboardRoot = getPriorDashboardRoot(deps);
  const candidates = [
    installDashboardRoot ? path.join(installDashboardRoot, 'out') : null,
    path.join(getHomeDashboardRoot(deps), 'out'),
    priorDashboardRoot ? path.join(priorDashboardRoot, 'out') : null,
  ].filter((candidate): candidate is string => Boolean(candidate));
  return pickDashboardStaticDir(candidates, deps);
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

export function getDefaultDashboardRelayUrl(apiPort: number): string {
  return normalizeLocalhostRelayUrl(`http://localhost:${apiPort}`);
}

export function resolveDashboardRelayUrl(apiPort: number, deps: CoreDependencies): string {
  const explicitRelayUrl = deps.env.RELAY_DASHBOARD_RELAY_URL;
  if (explicitRelayUrl && explicitRelayUrl.trim()) {
    return normalizeLocalhostRelayUrl(explicitRelayUrl.trim());
  }

  return getDefaultDashboardRelayUrl(apiPort);
}

export function isDebugLikeLoggingEnabled(deps: CoreDependencies): boolean {
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
  // Pass the workspace key so the dashboard can make Agent Relay calls
  // (e.g. posting thread replies) without requiring a relaycast.json file.
  if (relayApiKey) {
    if (!env.RELAY_WORKSPACE_KEY) {
      env.RELAY_WORKSPACE_KEY = relayApiKey;
    }
    if (!env.RELAY_API_KEY) {
      env.RELAY_API_KEY = relayApiKey;
    }
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

export function normalizeDashboardPath(rawDashboardPath: string | undefined): string | undefined {
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

  const targetDir = getDashboardRootFromBinary(dashboardBinary, deps) ?? getHomeDashboardRoot(deps);
  const assetsDir = path.join(targetDir, 'out');
  const versionFile = path.join(targetDir, '.version');

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

export async function startDashboardWithFallback(
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

export async function waitForDashboard(
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
