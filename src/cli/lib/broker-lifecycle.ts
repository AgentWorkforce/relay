import path from 'node:path';

import type { CoreDependencies, CoreProjectPaths, CoreRelay, SpawnedProcess } from '../commands/core.js';

type UpOptions = {
  dashboard?: boolean;
  port?: string;
  spawn?: boolean;
  background?: boolean;
  verbose?: boolean;
};

type DownOptions = {
  force?: boolean;
  all?: boolean;
  timeout?: string;
};

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

function cleanupBrokerPidIfStopped(brokerPidPath: string, deps: CoreDependencies): void {
  const pid = readPidFile(brokerPidPath, deps);
  if (pid === null || !isProcessRunning(pid, deps)) {
    safeUnlink(brokerPidPath, deps);
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
  const brokerPidPath = path.join(paths.dataDir, 'broker.pid');
  const runtimePath = path.join(paths.dataDir, 'runtime.json');
  const relaySockPath = path.join(paths.dataDir, 'relay.sock');

  safeUnlink(brokerPidPath, deps);
  safeUnlink(relaySockPath, deps);
  safeUnlink(runtimePath, deps);

  try {
    for (const file of deps.fs.readdirSync(paths.dataDir)) {
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

function resolveDashboardStaticDir(dashboardBinary: string | null, deps: CoreDependencies): string | null {
  const explicitStaticDir = deps.env.RELAY_DASHBOARD_STATIC_DIR ?? deps.env.STATIC_DIR;
  if (explicitStaticDir && explicitStaticDir.trim()) {
    return explicitStaticDir;
  }

  if (!dashboardBinary) {
    return null;
  }

  if (dashboardBinary.endsWith('.js') || dashboardBinary.endsWith('.ts')) {
    const inferredStaticDir = path.resolve(path.dirname(dashboardBinary), '..', 'out');
    if (deps.fs.existsSync(inferredStaticDir)) {
      return inferredStaticDir;
    }
  }

  return null;
}

function resolveDashboardRelayUrl(deps: CoreDependencies): string {
  const explicitRelayUrl = deps.env.RELAY_DASHBOARD_RELAY_URL;
  if (explicitRelayUrl && explicitRelayUrl.trim()) {
    return explicitRelayUrl.trim();
  }

  return 'http://localhost:3889';
}

function getDashboardSpawnEnv(deps: CoreDependencies): NodeJS.ProcessEnv {
  return { ...deps.env };
}

function getDashboardSpawnArgs(
  paths: CoreProjectPaths,
  port: number,
  dashboardBinary: string | null,
  deps: CoreDependencies
): string[] {
  const args = ['--port', String(port), '--data-dir', paths.dataDir];
  args.push('--relay-url', resolveDashboardRelayUrl(deps));
  const staticDir = resolveDashboardStaticDir(dashboardBinary, deps);
  if (staticDir) {
    args.push('--static-dir', staticDir);
  }
  return args;
}

function startDashboard(paths: CoreProjectPaths, port: number, deps: CoreDependencies): SpawnedProcess {
  const dashboardBinary = deps.findDashboardBinary();
  const args = getDashboardSpawnArgs(paths, port, dashboardBinary, deps);

  const spawnOpts = {
    stdio: ['ignore', 'pipe', 'pipe'] as unknown,
    env: getDashboardSpawnEnv(deps),
  };

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
    stderr?: { on?: (event: string, cb: (chunk: Buffer) => void) => void };
    on?: (event: string, cb: (...args: unknown[]) => void) => void;
  };
  let stderrBuf = '';
  childAny.stderr?.on?.('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString();
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

async function shutdownUpResources(
  relay: CoreRelay,
  dashboardProcess: SpawnedProcess | undefined,
  brokerPidPath: string,
  deps: CoreDependencies
): Promise<void> {
  if (dashboardProcess && !dashboardProcess.killed) {
    try {
      dashboardProcess.kill('SIGTERM');
    } catch {
      // Best-effort cleanup.
    }
  }

  await relay.shutdown().catch(() => undefined);
  cleanupBrokerPidIfStopped(brokerPidPath, deps);
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
  const brokerPidPath = path.join(paths.dataDir, 'broker.pid');
  const wantsDashboard = options.dashboard !== false;
  const dashboardPort = Number.parseInt(options.port ?? '3888', 10) || 3888;

  deps.fs.mkdirSync(paths.dataDir, { recursive: true });
  const existingPid = readPidFile(brokerPidPath, deps);
  if (existingPid !== null) {
    if (isProcessRunning(existingPid, deps)) {
      deps.error(`Broker already running for this project (pid: ${existingPid}).`);
      deps.error('Run `agent-relay status` to inspect it, then `agent-relay down` to stop it.');
      deps.exit(1);
      return;
    }
    safeUnlink(brokerPidPath, deps);
  }

  const apiPort = wantsDashboard ? 3889 : 0;
  const relay = deps.createRelay(paths.projectRoot, apiPort);

  let dashboardProcess: SpawnedProcess | undefined;
  let shuttingDown = false;
  let sigintCount = 0;
  let shutdownPromise: Promise<void> | undefined;
  const shutdownOnce = async (): Promise<void> => {
    if (!shutdownPromise) {
      shuttingDown = true;
      shutdownPromise = shutdownUpResources(relay, dashboardProcess, brokerPidPath, deps);
    }
    await shutdownPromise;
  };
  try {
    deps.log(`Project: ${paths.projectRoot}`);
    deps.log('Mode: broker (stdio)');
    await relay.getStatus();
    deps.log('Broker started.');

    // Forward broker stderr to console when --verbose is set
    if (options.verbose) {
      relay.onBrokerStderr?.((line: string) => {
        deps.error(`[broker] ${line}`);
      });
    }

    if (wantsDashboard) {
      dashboardProcess = startDashboard(paths, dashboardPort, deps);
      deps.log(`Dashboard: http://localhost:${dashboardPort}`);

      // Verify the dashboard is actually reachable (non-blocking)
      waitForDashboard(dashboardPort, dashboardProcess, deps, () => shuttingDown).catch(() => {});
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
    if (withCode.code === 'EADDRINUSE') {
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
  const brokerPidPath = path.join(paths.dataDir, 'broker.pid');
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

  if (!deps.fs.existsSync(brokerPidPath)) {
    if (options.force) {
      cleanupBrokerFiles(paths, deps);
      deps.log('Cleaned up (was not running)');
    } else {
      deps.log('Not running');
    }
    return;
  }

  const pidRaw = deps.fs.readFileSync(brokerPidPath, 'utf-8').trim();
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
  const brokerPidPath = path.join(paths.dataDir, 'broker.pid');

  let running = false;
  let brokerPid: number | undefined;

  if (deps.fs.existsSync(brokerPidPath)) {
    const pidRaw = deps.fs.readFileSync(brokerPidPath, 'utf-8').trim();
    const pid = Number.parseInt(pidRaw, 10);
    if (!Number.isNaN(pid) && pid > 0) {
      brokerPid = pid;
      running = isProcessRunning(pid, deps);
      if (!running) {
        safeUnlink(brokerPidPath, deps);
      }
    } else {
      safeUnlink(brokerPidPath, deps);
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
