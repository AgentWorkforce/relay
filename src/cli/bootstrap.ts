#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';
import { config as dotenvConfig } from 'dotenv';

import { checkForUpdatesInBackground } from '@agent-relay/utils';
import { initTelemetry, shutdown as shutdownTelemetry, track } from '@agent-relay/telemetry';

import { registerAgentManagementCommands } from './commands/agent-management.js';
import { registerMessagingCommands } from './commands/messaging.js';
import { registerCloudCommands } from './commands/cloud.js';
import { registerMonitoringCommands } from './commands/monitoring.js';
import { registerAuthCommands } from './commands/auth.js';
import { registerSetupCommands } from './commands/setup.js';
import { registerCoreCommands } from './commands/core.js';
import { registerSwarmCommands } from './commands/swarm.js';
import { registerConnectCommands } from './commands/connect.js';
import { registerOnCommands } from './commands/on.js';

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

/**
 * Best-effort resolution of the bundled `@agent-relay/sdk` version for
 * telemetry `sdk_version` tagging. Returns undefined if the SDK isn't
 * resolvable — telemetry must never throw.
 */
function resolveSdkVersion(): string | undefined {
  try {
    const nodeRequire = createRequire(import.meta.url);
    const pkgPath = nodeRequire.resolve('@agent-relay/sdk/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}

export const SDK_VERSION = resolveSdkVersion();

/**
 * Export the resolved CLI + SDK versions on the current process env so that
 * any child process we spawn (the Rust broker, the dashboard server, etc.)
 * inherits them and can attach them as common telemetry properties without
 * having to re-resolve `package.json`s on its own.
 *
 * We only set these if they're not already present — so a parent caller that
 * has set its own values (e.g. in tests or in nested CLI invocations) wins.
 */
function propagateVersionsToChildren(): void {
  if (!process.env.AGENT_RELAY_CLI_VERSION) {
    process.env.AGENT_RELAY_CLI_VERSION = VERSION;
  }
  if (SDK_VERSION && !process.env.AGENT_RELAY_SDK_VERSION) {
    process.env.AGENT_RELAY_SDK_VERSION = SDK_VERSION;
  }
}

// Commands that should skip the update check / first-run-notice entirely.
// `telemetry` is here so enable/disable/status never triggers PostHog init on
// the very run that's toggling the preference.
const TELEMETRY_MANAGEMENT_COMMANDS = new Set(['telemetry']);

// Commands for which we run the background update-check. Keep this narrow to
// the interactive / long-lived commands — we don't want short-lived programmatic
// invocations (spawn, send, etc.) to hit the npm registry on every call.
const UPDATE_CHECK_COMMANDS = new Set([
  'up',
  'start',
  'down',
  'status',
  'version',
  '--version',
  '-V',
  '--help',
  '-h',
]);

function detectCi(): boolean {
  const env = process.env;
  if (env.CI && env.CI !== 'false' && env.CI !== '0') return true;
  return Boolean(
    env.GITHUB_ACTIONS ||
      env.GITLAB_CI ||
      env.BUILDKITE ||
      env.CIRCLECI ||
      env.TRAVIS ||
      env.JENKINS_URL ||
      env.TEAMCITY_VERSION
  );
}

function getCommandPath(cmd: Command): string {
  const parts: string[] = [];
  let current: Command | null | undefined = cmd;
  while (current) {
    const parent = current.parent as Command | null | undefined;
    if (!parent) break;
    parts.unshift(current.name());
    current = parent;
  }
  return parts.join(' ');
}

function getExplicitlySetFlags(cmd: Command): string[] {
  const out: string[] = [];
  const opts = cmd.opts();
  for (const key of Object.keys(opts)) {
    try {
      // `getOptionValueSource` is available on modern Commander and returns
      // 'cli' when the user passed the flag on the command line (vs defaults).
      const source = cmd.getOptionValueSource(key);
      if (source === 'cli') {
        out.push(key);
      }
    } catch {
      // Older Commander — skip; we'd rather drop the flag list than crash telemetry.
    }
  }
  return out.sort();
}

function errorClassName(err: unknown): string {
  if (err instanceof Error) return err.constructor.name;
  if (err && typeof err === 'object') {
    const ctor = (err as { constructor?: { name?: string } }).constructor;
    return ctor?.name || 'Object';
  }
  return typeof err;
}

/**
 * Per-run telemetry context captured at preAction and consumed at completion.
 * We only ever track the currently-running command — commander fires preAction
 * once per action-chain, and we don't support nested CLI invocations in-process.
 */
interface CommandContext {
  name: string;
  startedAt: number;
  completed: boolean;
}

let currentCommand: CommandContext | null = null;

function installTelemetryHooks(program: Command): void {
  program.hook('preAction', (_thisCommand, actionCommand) => {
    const commandPath = getCommandPath(actionCommand);
    const flags = getExplicitlySetFlags(actionCommand);

    currentCommand = {
      name: commandPath,
      startedAt: Date.now(),
      completed: false,
    };

    track('cli_command_run', {
      command_name: commandPath,
      flags_used: flags,
      is_tty: Boolean(process.stdout.isTTY),
      is_ci: detectCi(),
    });
  });

  program.hook('postAction', (_thisCommand, _actionCommand) => {
    if (!currentCommand || currentCommand.completed) return;
    const ctx = currentCommand;
    ctx.completed = true;
    track('cli_command_complete', {
      command_name: ctx.name,
      success: true,
      duration_ms: Date.now() - ctx.startedAt,
    });
  });
}

/**
 * Ensure a terminal `cli_command_complete` fires even when a command calls
 * `process.exit(code)` mid-flight (common on the error path). `beforeExit`
 * wouldn't help — hard exits skip it — so we hook `exit` synchronously and
 * queue the event into PostHog's in-memory buffer. The subsequent shutdown()
 * flush is best-effort on hard exits; for orderly exits we also register a
 * `beforeExit` that awaits the flush.
 */
function installExitHooks(): void {
  process.on('exit', (code) => {
    if (currentCommand && !currentCommand.completed) {
      const ctx = currentCommand;
      ctx.completed = true;
      track('cli_command_complete', {
        command_name: ctx.name,
        success: code === 0,
        duration_ms: Date.now() - ctx.startedAt,
        exit_code: code,
      });
    }
  });

  process.on('beforeExit', () => {
    // Kick off flush; we can't await inside beforeExit without re-entering the
    // event loop, but shutdown() itself is promise-returning. The outer
    // runCli() awaits shutdown on the normal path, so this is a safety net for
    // edge cases (e.g. a command whose action returns without going through
    // our runCli try/finally).
    void shutdownTelemetry().catch(() => undefined);
  });
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name('agent-relay')
    .description('Agent-to-agent messaging')
    .version(VERSION, '-V, --version', 'Output the version number');

  registerCoreCommands(program);
  registerAgentManagementCommands(program);
  registerMessagingCommands(program);
  registerCloudCommands(program);
  registerMonitoringCommands(program);
  registerAuthCommands(program);
  registerSetupCommands(program);
  registerSwarmCommands(program);
  registerOnCommands(program);
  registerConnectCommands(program);

  return program;
}

function maybeRunUpdateCheck(version: string, argv: string[]): void {
  const commandName = argv[2];
  if (!commandName || !UPDATE_CHECK_COMMANDS.has(commandName)) return;
  checkForUpdatesInBackground(version);
}

function shouldSkipTelemetryInit(argv: string[]): boolean {
  const commandName = argv[2];
  return Boolean(commandName && TELEMETRY_MANAGEMENT_COMMANDS.has(commandName));
}

export async function runCli(argv: string[] = process.argv): Promise<Command> {
  maybeRunUpdateCheck(VERSION, argv);
  propagateVersionsToChildren();

  if (!shouldSkipTelemetryInit(argv)) {
    initTelemetry({
      showNotice: true,
      cliVersion: VERSION,
      sdkVersion: SDK_VERSION,
    });
  }

  const program = createProgram();
  installTelemetryHooks(program);
  installExitHooks();

  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (currentCommand && !currentCommand.completed) {
      const ctx = currentCommand;
      ctx.completed = true;
      track('cli_command_complete', {
        command_name: ctx.name,
        success: false,
        duration_ms: Date.now() - ctx.startedAt,
        error_class: errorClassName(err),
      });
    }
    try {
      await shutdownTelemetry();
    } catch {
      // Never let telemetry shutdown mask the real error.
    }
    throw err;
  }

  try {
    await shutdownTelemetry();
  } catch {
    // Ignore — the command succeeded.
  }

  return program;
}
