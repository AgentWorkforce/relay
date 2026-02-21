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

function safeUnlink(filePath: string, deps: CoreDependencies): void {
  if (!deps.fs.existsSync(filePath)) return;
  try {
    deps.fs.unlinkSync(filePath);
  } catch {
    // Best-effort cleanup.
  }
}

function isProcessRunning(pid: number, deps: CoreDependencies): boolean {
  try {
    deps.killProcess(pid, 0);
    return true;
  } catch {
    return false;
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

function getDashboardSpawnArgs(paths: CoreProjectPaths, port: number): string[] {
  return [
    '--integrated',
    '--port',
    String(port),
    '--data-dir',
    paths.dataDir,
    '--team-dir',
    paths.teamDir,
    '--project-root',
    paths.projectRoot,
  ];
}

function startDashboard(paths: CoreProjectPaths, port: number, deps: CoreDependencies): SpawnedProcess {
  const dashboardBinary = deps.findDashboardBinary();
  const args = getDashboardSpawnArgs(paths, port);

  if (dashboardBinary) {
    return deps.spawnProcess(dashboardBinary, args, {
      stdio: 'ignore',
      env: deps.env,
    });
  }

  return deps.spawnProcess('npx', ['--yes', '@agent-relay/dashboard-server@2.0.83-beta.0', ...args], {
    stdio: 'ignore',
    env: deps.env,
  });
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
  safeUnlink(brokerPidPath, deps);
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
  const relay = deps.createRelay(paths.projectRoot);
  const brokerPidPath = path.join(paths.dataDir, 'broker.pid');
  const wantsDashboard = options.dashboard !== false;
  const dashboardPort = Number.parseInt(options.port ?? '3888', 10) || 3888;

  deps.fs.mkdirSync(paths.dataDir, { recursive: true });
  deps.fs.writeFileSync(brokerPidPath, String(deps.pid), 'utf-8');

  let dashboardProcess: SpawnedProcess | undefined;
  try {
    await relay.getStatus();
    deps.log(`Project: ${paths.projectRoot}`);
    deps.log('Mode: broker (stdio)');
    deps.log('Broker started.');

    if (wantsDashboard) {
      dashboardProcess = startDashboard(paths, dashboardPort, deps);
      deps.log(`Dashboard: http://localhost:${dashboardPort}`);
    }

    const teamsConfig = deps.loadTeamsConfig(paths.projectRoot);
    const shouldSpawn =
      options.spawn === true ? true : options.spawn === false ? false : Boolean(teamsConfig?.autoSpawn);

    if (shouldSpawn && teamsConfig && teamsConfig.agents.length > 0) {
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

    const shutdown = async () => {
      await shutdownUpResources(relay, dashboardProcess, brokerPidPath, deps);
    };

    deps.onSignal('SIGINT', async () => {
      deps.log('\nStopping...');
      await shutdown();
      deps.exit(0);
    });
    deps.onSignal('SIGTERM', async () => {
      await shutdown();
      deps.exit(0);
    });

    await deps.holdOpen();
  } catch (err: unknown) {
    await shutdownUpResources(relay, dashboardProcess, brokerPidPath, deps);
    const withCode = err as { code?: string };
    if (withCode.code === 'EADDRINUSE') {
      deps.error(`Dashboard port ${dashboardPort} is already in use.`);
    } else {
      deps.error(`Failed to start broker: ${toErrorMessage(err)}`);
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
