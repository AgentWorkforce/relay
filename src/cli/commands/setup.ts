import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync, spawn as spawnProcess } from 'node:child_process';
import { Command } from 'commander';
import { getProjectPaths } from '@agent-relay/config';
import {
  enableTelemetry,
  disableTelemetry,
  getStatus,
  isDisabledByEnv,
} from '@agent-relay/telemetry';
import { runWorkflow } from '@agent-relay/sdk/workflows';
import type { WorkflowEvent } from '@agent-relay/sdk/workflows';
type ExitFn = (code: number) => never;
type RunInitOptions = {
  yes?: boolean;
  skipDaemon?: boolean;
};
type RunWorkflowOptions = {
  workflow?: string;
};
type WorkflowRunResult = {
  status: string;
  error?: string;
};
export interface SetupDependencies {
  runInit: (options: RunInitOptions) => Promise<void>;
  runTelemetry: (action?: string) => Promise<void> | void;
  runYamlWorkflow: (
    filePath: string,
    options: { workflow?: string; onEvent: (event: WorkflowEvent) => void }
  ) => Promise<WorkflowRunResult>;
  runScriptWorkflow: (filePath: string) => void;
  runTrailCommand: (args: string[]) => Promise<void>;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}
interface SetupIo {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}
function defaultExit(code: number): never {
  process.exit(code);
}
function withDefaults(
  overrides: Partial<SetupDependencies> = {}
): SetupDependencies {
  const log = overrides.log ?? ((...args: unknown[]) => console.log(...args));
  const error = overrides.error ?? ((...args: unknown[]) => console.error(...args));
  const exit = overrides.exit ?? defaultExit;
  const io: SetupIo = { log, error, exit };
  return {
    runInit: overrides.runInit ?? ((options: RunInitOptions) => runInitDefault(options, io)),
    runTelemetry: overrides.runTelemetry ?? ((action?: string) => runTelemetryDefault(action, io)),
    runYamlWorkflow: runYamlWorkflowDefault,
    runScriptWorkflow: runScriptFile,
    runTrailCommand: overrides.runTrailCommand ?? ((args: string[]) => runTrailCommandDefault(args, io)),
    log,
    error,
    exit,
    ...overrides,
  };
}
function logWorkflowEvent(event: WorkflowEvent, log: (...args: unknown[]) => void): void {
  const prefix = event.type.startsWith('run:') ? '[run]' : '[step]';
  const name = 'stepName' in event ? `${event.stepName} ` : '';
  const status = event.type.split(':')[1];
  const detail = 'error' in event ? `: ${event.error}` : '';
  log(`${prefix} ${name}${status}${detail}`);
}
async function runYamlWorkflowDefault(
  filePath: string,
  options: { workflow?: string; onEvent: (event: WorkflowEvent) => void }
): Promise<WorkflowRunResult> {
  return await runWorkflow(filePath, options);
}
function runScriptFile(filePath: string): void {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  const ext = path.extname(resolved).toLowerCase();
  if (ext === '.ts' || ext === '.tsx') {
    const runners = ['tsx', 'ts-node'];
    for (const runner of runners) {
      try {
        execFileSync(runner, [resolved], { stdio: 'inherit' });
        return;
      } catch (err: any) {
        if (err?.code !== 'ENOENT') {
          throw err;
        }
      }
    }
    execFileSync('npx', ['tsx', resolved], { stdio: 'inherit' });
    return;
  }
  if (ext === '.py') {
    const runners = ['python3', 'python'];
    for (const runner of runners) {
      try {
        execFileSync(runner, [resolved], { stdio: 'inherit' });
        return;
      } catch (err: any) {
        if (err?.code !== 'ENOENT') {
          throw err;
        }
      }
    }
    throw new Error('Python not found. Install Python 3.10+ to run .py workflow files.');
  }
  throw new Error(`Unsupported file type: ${ext}. Use .yaml, .yml, .ts, or .py`);
}
async function runTrailCommandDefault(args: string[], io: SetupIo): Promise<void> {
  const { getPrimaryTrajectoriesDir, ensureTrajectoriesDir } = await import('@agent-relay/config/trajectory-config');
  const paths = getProjectPaths();
  const trailCheck = spawnProcess('which', ['trail'], { stdio: 'pipe' });
  const trailExists = await new Promise<boolean>((resolve) => {
    trailCheck.on('close', (code) => resolve(code === 0));
    trailCheck.on('error', () => resolve(false));
  });
  if (!trailExists) {
    io.error('trail CLI not found. Install with: npm install -g agent-trajectories');
    io.log('');
    io.log('The trail CLI provides trajectory tracking for agent work:');
    io.log('  trail start "<task>"         Start tracking a new trajectory');
    io.log('  trail status                 Show current trajectory status');
    io.log('  trail phase <phase>          Transition to PDERO phase');
    io.log('  trail decision "<choice>"    Record a decision');
    io.log('  trail complete               Complete the trajectory');
    io.log('  trail list                   List all trajectories');
    io.log('');
    io.log('PDERO phases: plan, design, execute, review, observe');
    io.exit(1);
  }
  const trajectoriesDir = getPrimaryTrajectoriesDir(paths.projectRoot);
  ensureTrajectoriesDir(paths.projectRoot);
  const trailProc = spawnProcess('trail', args, {
    cwd: paths.projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      TRAJECTORIES_PROJECT: paths.projectId,
      TRAJECTORIES_DATA_DIR: trajectoriesDir,
    },
  });
  trailProc.on('close', (code) => {
    io.exit(code ?? 0);
  });
  trailProc.on('error', (err) => {
    io.error(`Failed to run trail: ${err.message}`);
    io.exit(1);
  });
}
async function runInitDefault(options: RunInitOptions, io: SetupIo): Promise<void> {
  const prompt = async (question: string, defaultYes = true): Promise<boolean> => {
    if (options.yes) return true;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const suffix = defaultYes ? '[Y/n]' : '[y/N]';
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${question} ${suffix} `, resolve);
    });
    rl.close();
    const normalized = answer.toLowerCase().trim();
    if (!normalized) return defaultYes;
    return normalized === 'y' || normalized === 'yes';
  };
  io.log('');
  io.log('  ╭─────────────────────────────────────╮');
  io.log('  │                                     │');
  io.log('  │   🚀 Agent Relay - First Time Setup │');
  io.log('  │                                     │');
  io.log('  │   Real-time AI agent communication  │');
  io.log('  │                                     │');
  io.log('  ╰─────────────────────────────────────╯');
  io.log('');
  const isCloud = !!process.env.WORKSPACE_ID;
  if (isCloud) {
    io.log('  ℹ  Detected: Cloud workspace');
    io.log('     MCP tools are pre-configured in cloud environments.');
    io.log('');
    return;
  }
  io.log('  ℹ  Detected: Local environment');
  io.log('');
  const paths = getProjectPaths();
  const brokerPidPath = path.join(paths.dataDir, 'broker.pid');
  let daemonRunning = false;
  if (fs.existsSync(brokerPidPath)) {
    const brokerPid = Number(fs.readFileSync(brokerPidPath, 'utf-8').trim());
    try {
      process.kill(brokerPid, 0);
      daemonRunning = true;
    } catch {
      try {
        fs.unlinkSync(brokerPidPath);
      } catch {
        // ignore
      }
    }
  }
  if (daemonRunning) {
    io.log('  ✓  Broker is already running');
  } else {
    io.log('  ○  Broker is not running');
  }
  io.log('');
  if (!daemonRunning && !options.skipDaemon) {
    io.log('  ┌─ Start the Relay Broker ──────────────────────────────────┐');
    io.log('  │                                                          │');
    io.log('  │  The broker manages agent connections and message        │');
    io.log('  │  routing. It runs in the background.                     │');
    io.log('  │                                                          │');
    io.log('  └──────────────────────────────────────────────────────────┘');
    io.log('');
    const shouldStartDaemon = await prompt('  Start the relay broker now?');
    if (shouldStartDaemon) {
      io.log('');
      io.log('  Starting broker...');
      const daemonProcess = spawnProcess(process.execPath, [process.argv[1], 'up', '--background'], {
        detached: true,
        stdio: 'ignore',
      });
      daemonProcess.unref();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      io.log('  ✓  Broker started in background');
      io.log('');
      daemonRunning = true;
    }
  }
  io.log('  ╭─────────────────────────────────────────────────────────╮');
  io.log('  │                    Setup Complete!                      │');
  io.log('  ╰─────────────────────────────────────────────────────────╯');
  io.log('');
  if (daemonRunning) {
    io.log('  Status:');
    io.log('    ✓  Broker running');
    io.log('');
  }
  io.log('  Quick Start:');
  io.log('');
  io.log('    1. Open Claude Code (or Cursor)');
  io.log('');
  io.log('    2. The relay tools are ready! Try asking Claude:');
  io.log('       "Use relay_who to see online agents"');
  io.log('');
  io.log('    3. Spawn a worker agent:');
  io.log('       "Spawn a worker named TestRunner to run the tests"');
  io.log('');
  io.log('  Commands:');
  io.log('    agent-relay up        Start broker with dashboard');
  io.log('    agent-relay status    Check broker status');
  io.log('    agent-relay who       List online agents');
  io.log('');
  io.log('  Dashboard: http://localhost:3888 (when broker is running)');
  io.log('');
}
function runTelemetryDefault(action: string | undefined, io: SetupIo): void {
  if (action === 'enable') {
    if (isDisabledByEnv()) {
      io.log('Cannot enable: AGENT_RELAY_TELEMETRY_DISABLED is set');
      io.log('Remove the environment variable to enable telemetry.');
      return;
    }
    enableTelemetry();
    io.log('Telemetry enabled');
    io.log('Anonymous usage data will be collected to improve Agent Relay.');
    return;
  }
  if (action === 'disable') {
    disableTelemetry();
    io.log('Telemetry disabled');
    io.log('No usage data will be collected.');
    return;
  }
  const status = getStatus();
  io.log('Telemetry Status');
  io.log('================');
  io.log(`Enabled: ${status.enabled ? 'Yes' : 'No'}`);
  if (status.disabledByEnv) {
    io.log('(Disabled via AGENT_RELAY_TELEMETRY_DISABLED environment variable)');
  }
  io.log(`Anonymous ID: ${status.anonymousId}`);
  if (status.notifiedAt) {
    io.log(`First run notice shown: ${new Date(status.notifiedAt).toLocaleString()}`);
  }
  io.log('');
  io.log('Commands:');
  io.log('  agent-relay telemetry enable   - Opt in to telemetry');
  io.log('  agent-relay telemetry disable  - Opt out of telemetry');
  io.log('');
  io.log('Learn more: https://agent-relay.com/telemetry');
}
export function registerSetupCommands(
  program: Command,
  overrides: Partial<SetupDependencies> = {}
): void {
  const deps = withDefaults(overrides);
  program
    .command('init')
    .description('First-time setup wizard - start broker')
    .option('-y, --yes', 'Accept all defaults (non-interactive)')
    .option('--skip-daemon', 'Skip broker startup prompt')
    .action(async (options: RunInitOptions) => {
      await deps.runInit(options);
    });
  program
    .command('setup')
    .description('Alias for "init" - first-time setup wizard')
    .option('-y, --yes', 'Accept all defaults')
    .option('--skip-daemon', 'Skip broker startup')
    .action(async (options: RunInitOptions) => {
      await deps.runInit(options);
    });
  program
    .command('telemetry')
    .description('Manage anonymous telemetry (enable/disable/status)')
    .argument('[action]', 'Action: enable, disable, or status (default: status)')
    .action(async (action?: string) => {
      await deps.runTelemetry(action);
    });
  program
    .command('run')
    .description('Run a workflow file (YAML, TypeScript, or Python)')
    .argument('<file>', 'Path to workflow file (.yaml, .yml, .ts, or .py)')
    .option('-w, --workflow <name>', 'Run a specific workflow by name (default: first, YAML only)')
    .action(async (filePath: string, options: RunWorkflowOptions) => {
      try {
        const ext = path.extname(filePath).toLowerCase();
        if (ext === '.yaml' || ext === '.yml') {
          deps.log(`Running workflow from ${filePath}...`);
          const result = await deps.runYamlWorkflow(filePath, {
            workflow: options.workflow,
            onEvent: (event: WorkflowEvent) => logWorkflowEvent(event, deps.log),
          });
          if (result.status === 'completed') {
            deps.log('\nWorkflow completed successfully.');
          } else {
            deps.error(`\nWorkflow ${result.status}${result.error ? `: ${result.error}` : ''}`);
            deps.exit(1);
          }
          return;
        }
        if (ext === '.ts' || ext === '.tsx' || ext === '.py') {
          deps.log(`Running workflow script ${filePath}...`);
          deps.runScriptWorkflow(filePath);
          return;
        }
        deps.error(`Unsupported file type: ${ext}. Use .yaml, .yml, .ts, or .py`);
        deps.exit(1);
      } catch (err: any) {
        deps.error(`Error: ${err.message}`);
        deps.exit(1);
      }
    });
  program
    .command('trail')
    .description('Trajectory tracking commands (proxies to trail CLI)')
    .argument('[args...]', 'Arguments to pass to trail CLI')
    .allowUnknownOption()
    .action(async (args: string[] = []) => {
      await deps.runTrailCommand(args);
    });
}
