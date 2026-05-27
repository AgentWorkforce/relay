import readline from 'node:readline';
import { spawn as spawnProcess } from 'node:child_process';
import { Command } from 'commander';
import { getProjectPaths } from '@agent-relay/config';
import { readBrokerConnection } from '../lib/broker-lifecycle.js';
import { enableTelemetry, disableTelemetry, getStatus, isDisabledByEnv, track } from '@agent-relay/telemetry';
import { defaultExit } from '../lib/exit.js';

type ExitFn = (code: number) => never;
type RunInitOptions = {
  yes?: boolean;
  skipBroker?: boolean;
};

export interface SetupDependencies {
  runInit: (options: RunInitOptions) => Promise<void>;
  runTelemetry: (action?: string) => Promise<void> | void;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}
interface SetupIo {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}
function withDefaults(overrides: Partial<SetupDependencies> = {}): SetupDependencies {
  const log = overrides.log ?? ((...args: unknown[]) => console.log(...args));
  const error = overrides.error ?? ((...args: unknown[]) => console.error(...args));
  const exit = overrides.exit ?? defaultExit;
  const io: SetupIo = { log, error, exit };
  return {
    runInit: overrides.runInit ?? ((options: RunInitOptions) => runInitDefault(options, io)),
    runTelemetry: overrides.runTelemetry ?? ((action?: string) => runTelemetryDefault(action, io)),
    log,
    error,
    exit,
    ...overrides,
  };
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
  const yesFlag = Boolean(options.yes);
  const skipBrokerFlag = Boolean(options.skipBroker);
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
    track('setup_init', {
      is_cloud: true,
      broker_was_running: false,
      user_started_broker: false,
      yes_flag: yesFlag,
      skip_broker: skipBrokerFlag,
    });
    return;
  }
  io.log('  ℹ  Detected: Local environment');
  io.log('');
  const paths = getProjectPaths();
  let brokerRunning = false;
  const conn = readBrokerConnection(paths.dataDir);
  if (conn && conn.pid > 0) {
    try {
      process.kill(conn.pid, 0);
      brokerRunning = true;
    } catch {
      // Process dead — stale connection file
    }
  }
  const brokerWasRunning = brokerRunning;
  let userStartedBroker = false;
  if (brokerRunning) {
    io.log('  ✓  Broker is already running');
  } else {
    io.log('  ○  Broker is not running');
  }
  io.log('');
  const skipBrokerStartup = options.skipBroker ?? false;
  if (!brokerRunning && !skipBrokerStartup) {
    io.log('  ┌─ Start the Relay Broker ──────────────────────────────────┐');
    io.log('  │                                                          │');
    io.log('  │  The broker manages agent connections and message        │');
    io.log('  │  routing. It runs in the background.                     │');
    io.log('  │                                                          │');
    io.log('  └──────────────────────────────────────────────────────────┘');
    io.log('');
    const shouldStartBroker = await prompt('  Start the relay broker now?');
    if (shouldStartBroker) {
      io.log('');
      io.log('  Starting broker...');
      const brokerProcess = spawnProcess(process.execPath, [process.argv[1], 'driver', 'up', '--background'], {
        detached: true,
        stdio: 'ignore',
      });
      brokerProcess.unref();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      io.log('  ✓  Broker started in background');
      io.log('');
      brokerRunning = true;
      userStartedBroker = true;
    }
  }
  io.log('  ╭─────────────────────────────────────────────────────────╮');
  io.log('  │                    Setup Complete!                      │');
  io.log('  ╰─────────────────────────────────────────────────────────╯');
  io.log('');
  if (brokerRunning) {
    io.log('  Status:');
    io.log('    ✓  Broker running');
    io.log('');
  }
  io.log('  Quick Start:');
  io.log('');
  io.log('    1. Open Claude Code (or Cursor)');
  io.log('');
  io.log('    2. The relay tools are ready! Try asking Claude:');
  io.log('       "Use mcp__relaycast__list_agents to see online agents"');
  io.log('');
  io.log('    3. Spawn a worker agent:');
  io.log('       "Spawn a worker named TestRunner to run the tests"');
  io.log('');
  io.log('  Commands:');
  io.log('    agent-relay driver up        Start the optional driver harness with dashboard');
  io.log('    agent-relay driver status    Check driver harness status');
  io.log('    agent-relay who       List online agents');
  io.log('');
  io.log('  Dashboard: http://localhost:3888 (when broker is running)');
  io.log('');
  track('setup_init', {
    is_cloud: false,
    broker_was_running: brokerWasRunning,
    user_started_broker: userStartedBroker,
    yes_flag: yesFlag,
    skip_broker: skipBrokerFlag,
  });
}
function runTelemetryDefault(action: string | undefined, io: SetupIo): void {
  if (action === 'enable') {
    if (isDisabledByEnv()) {
      io.log('Cannot enable: AGENT_RELAY_TELEMETRY_DISABLED or DO_NOT_TRACK is set');
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
    io.log('(Disabled via AGENT_RELAY_TELEMETRY_DISABLED or DO_NOT_TRACK environment variable)');
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
  io.log('Learn more: https://agentrelay.com/telemetry');
}
export function registerSetupCommands(program: Command, overrides: Partial<SetupDependencies> = {}): void {
  const deps = withDefaults(overrides);
  if (program.name() !== 'relay' && !program.commands.some((command) => command.name() === 'init')) {
    program
      .command('init', { hidden: true })
      .description('First-time setup wizard - start broker')
      .option('-y, --yes', 'Accept all defaults (non-interactive)')
      .option('--skip-broker', 'Skip broker startup prompt')
      .addHelpText('after', '\nBREAKING CHANGE: daemon options were removed. Use broker terminology only.')
      .action(async (options: RunInitOptions) => {
        await deps.runInit(options);
      });
  }
  program
    .command('setup', { hidden: true })
    .description('Alias for "init" - first-time setup wizard')
    .option('-y, --yes', 'Accept all defaults')
    .option('--skip-broker', 'Skip broker startup')
    .addHelpText('after', '\nBREAKING CHANGE: daemon options were removed. Use broker terminology only.')
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
}
