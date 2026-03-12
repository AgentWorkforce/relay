#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';
import { config as dotenvConfig } from 'dotenv';

import { checkForUpdatesInBackground } from '@agent-relay/utils';
import { initTelemetry, track } from '@agent-relay/telemetry';

import { registerCoreCommands } from './commands/core.js';

dotenvConfig({ quiet: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findPackageJson(startDir: string): string {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    dir = path.dirname(dir);
  }

  throw new Error('Could not find package.json');
}

function resolveCliVersion(): string {
  const envVersion = process.env.AGENT_RELAY_VERSION;
  if (envVersion) {
    return envVersion;
  }

  try {
    const packageJsonPath = findPackageJson(__dirname);
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
      version?: string;
    };
    return packageJson.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export const VERSION = resolveCliVersion();

const interactiveCommands = new Set([
  'up',
  'start',
  'down',
  'status',
  'version',
  '--version',
  '-V',
  '--help',
  '-h',
  'telemetry',
]);

function maybeInitUpdateAndTelemetry(version: string, argv: string[]): void {
  const commandName = argv[2];
  if (!commandName || !interactiveCommands.has(commandName)) {
    return;
  }

  checkForUpdatesInBackground(version);

  if (commandName === 'telemetry') {
    return;
  }

  initTelemetry({ showNotice: true });
  if (!commandName.startsWith('-')) {
    track('cli_command_run', { command_name: commandName });
  }
}

/**
 * Map of command names to the module that registers them.
 * Core commands (up, down, start, status, etc.) are eagerly loaded.
 * Secondary modules are lazy-imported only when their command is invoked.
 */
const LAZY_COMMAND_MAP: Record<string, { path: string; register: string }> = {
  spawn: { path: './commands/agent-management.js', register: 'registerAgentManagementCommands' },
  'broker-spawn': { path: './commands/agent-management.js', register: 'registerAgentManagementCommands' },
  agents: { path: './commands/agent-management.js', register: 'registerAgentManagementCommands' },
  who: { path: './commands/agent-management.js', register: 'registerAgentManagementCommands' },
  'agents:logs': { path: './commands/agent-management.js', register: 'registerAgentManagementCommands' },
  release: { path: './commands/agent-management.js', register: 'registerAgentManagementCommands' },
  'set-model': { path: './commands/agent-management.js', register: 'registerAgentManagementCommands' },
  'agents:kill': { path: './commands/agent-management.js', register: 'registerAgentManagementCommands' },
  send: { path: './commands/messaging.js', register: 'registerMessagingCommands' },
  read: { path: './commands/messaging.js', register: 'registerMessagingCommands' },
  history: { path: './commands/messaging.js', register: 'registerMessagingCommands' },
  inbox: { path: './commands/messaging.js', register: 'registerMessagingCommands' },
  cloud: { path: './commands/cloud.js', register: 'registerCloudCommands' },
  metrics: { path: './commands/monitoring.js', register: 'registerMonitoringCommands' },
  health: { path: './commands/monitoring.js', register: 'registerMonitoringCommands' },
  profile: { path: './commands/monitoring.js', register: 'registerMonitoringCommands' },
  auth: { path: './commands/auth.js', register: 'registerAuthCommands' },
  init: { path: './commands/setup.js', register: 'registerSetupCommands' },
  setup: { path: './commands/setup.js', register: 'registerSetupCommands' },
  telemetry: { path: './commands/setup.js', register: 'registerSetupCommands' },
  run: { path: './commands/setup.js', register: 'registerSetupCommands' },
  swarm: { path: './commands/swarm.js', register: 'registerSwarmCommands' },
  connect: { path: './commands/connect.js', register: 'registerConnectCommands' },
};

export async function createProgram(argv: string[]): Promise<Command> {
  const program = new Command();

  program
    .name('agent-relay')
    .description('Agent-to-agent messaging')
    .version(VERSION, '-V, --version', 'Output the version number');

  // Core commands (up, down, status) are always needed — register eagerly.
  registerCoreCommands(program);

  // Lazy-load only the secondary command module needed for the current invocation.
  const commandName = argv[2];
  const lazyModule = commandName ? LAZY_COMMAND_MAP[commandName] : undefined;
  if (lazyModule) {
    const imported = await import(lazyModule.path);
    const fn = imported[lazyModule.register] as (p: Command) => void;
    fn(program);
  } else if (commandName === '--help' || commandName === '-h' || !commandName) {
    // For help output, load all command modules so the full help text is shown.
    const [agentMgmt, messaging, cloud, monitoring, auth, setup, swarm, connect] = await Promise.all([
      import('./commands/agent-management.js'),
      import('./commands/messaging.js'),
      import('./commands/cloud.js'),
      import('./commands/monitoring.js'),
      import('./commands/auth.js'),
      import('./commands/setup.js'),
      import('./commands/swarm.js'),
      import('./commands/connect.js'),
    ]);
    agentMgmt.registerAgentManagementCommands(program);
    messaging.registerMessagingCommands(program);
    cloud.registerCloudCommands(program);
    monitoring.registerMonitoringCommands(program);
    auth.registerAuthCommands(program);
    setup.registerSetupCommands(program);
    swarm.registerSwarmCommands(program);
    connect.registerConnectCommands(program);
  }

  return program;
}

export async function runCli(argv: string[] = process.argv): Promise<Command> {
  maybeInitUpdateAndTelemetry(VERSION, argv);
  const program = await createProgram(argv);
  program.parse(argv);
  return program;
}
