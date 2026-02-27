#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';
import { config as dotenvConfig } from 'dotenv';

import { checkForUpdatesInBackground } from '@agent-relay/utils';
import { initTelemetry, track } from '@agent-relay/telemetry';

import { registerAgentManagementCommands } from './commands/agent-management.js';
import { registerMessagingCommands } from './commands/messaging.js';
import { registerCloudCommands } from './commands/cloud.js';
import { registerMonitoringCommands } from './commands/monitoring.js';
import { registerAuthCommands } from './commands/auth.js';
import { registerSetupCommands } from './commands/setup.js';
import { registerCoreCommands } from './commands/core.js';
import { registerConnectCommands } from './commands/connect.js';
import { registerSwarmCommands } from './commands/swarm.js';

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

export function createProgram(): Command {
  const program = new Command();

  program
    .name('agent-relay')
    .description('Agent-to-agent messaging')
    .version(VERSION, '-V, --version', 'Output the version number');

  registerCoreCommands(program);
  registerConnectCommands(program);
  registerAgentManagementCommands(program);
  registerMessagingCommands(program);
  registerCloudCommands(program);
  registerMonitoringCommands(program);
  registerAuthCommands(program);
  registerSetupCommands(program);
  registerSwarmCommands(program);

  return program;
}

export function runCli(argv: string[] = process.argv): Command {
  maybeInitUpdateAndTelemetry(VERSION, argv);
  const program = createProgram();
  program.parse(argv);
  return program;
}

function isEntrypoint(): boolean {
  const invocationPath = process.argv[1];
  if (!invocationPath) {
    return false;
  }
  try {
    return fs.realpathSync(invocationPath) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(invocationPath) === fileURLToPath(import.meta.url);
  }
}

if (isEntrypoint()) {
  runCli();
}
