#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';
import { config as dotenvConfig } from 'dotenv';

import { checkForUpdatesInBackground } from '@agent-relay/utils';
import {
  cloudIdentityEnv,
  readStoredIdentitySync,
  IDENTITY_ENV_KEYS,
  type CloudIdentity,
} from '@agent-relay/cloud/identity';
import {
  ORCHESTRATOR_HARNESS_ENV,
  detectOrchestratorHarness,
  getDistinctId,
  initTelemetry,
  isEnabled as isTelemetryEnabled,
  shutdown as shutdownTelemetry,
  track,
} from './telemetry/index.js';

import { ensureWebSocketGlobal } from './lib/ensure-websocket.js';
import { assertSupportedNodeVersion } from './lib/node-version.js';
import { CliExit } from './lib/exit.js';
import { errorClassName } from './lib/telemetry-helpers.js';
import { registerSetupCommands } from './commands/setup.js';
import { registerCoreCommands, registerCoreMaintenance } from './commands/core.js';
import { registerNodeCommands } from './commands/node.js';
import { registerStatusCommand } from './commands/status.js';
import { registerLocalAgentCommands } from './commands/local-agent.js';
import { registerLocalWorkflowCommands } from './commands/local-workflow.js';
import { registerCloudCommands } from './commands/cloud.js';
import { registerReflexCommands } from './commands/reflex.js';
import { registerWorkspaceCommands } from './commands/workspace.js';
import { registerAgentCommands } from './commands/agent.js';
import { registerChannelCommands } from './commands/channel.js';
import { registerMessageCommands } from './commands/message.js';
import { registerIntegrationCommands } from './commands/integration.js';
import { registerCapabilitiesCommands } from './commands/capabilities.js';
import { registerFleetCommands } from './commands/fleet.js';
import { registerSkillsCommands } from './commands/skills.js';

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

const AGENT_RELAY_DISTINCT_ID_ENV = 'AGENT_RELAY_DISTINCT_ID';
const TELEMETRY_CLIENT_ENV = 'AGENT_RELAY_TELEMETRY_CLIENT';

function hasConfiguredTelemetryKey(): boolean {
  return Boolean(process.env.POSTHOG_API_KEY?.trim() || process.env.AGENT_RELAY_POSTHOG_KEY?.trim());
}

function resolveProgramName(argv: string[] = process.argv): string {
  const invocationPath = String(argv[1] ?? '').trim();
  if (!invocationPath) {
    return 'agent-relay';
  }

  const commandName = path.basename(invocationPath).trim().toLowerCase();
  return commandName === 'relay' ? 'relay' : 'agent-relay';
}

/**
 * Export the resolved CLI + SDK versions on the current process env so that
 * any child process we spawn (the Rust broker, etc.)
 * inherits them and can attach them as common telemetry properties without
 * having to re-resolve `package.json`s on its own.
 *
 * We only set these if they're not already present — so a parent caller that
 * has set its own values (e.g. in tests or in nested CLI invocations) wins.
 */
/**
 * Read the identity recorded at `agent-relay cloud login` and publish it on
 * `process.env` so the broker, spawned agents, and the relaycast SDK all
 * attribute their telemetry to the same user and org — without any of them
 * needing to know where the identity file lives or how to call cloud.
 *
 * Env wins over the file (a parent process may already have published a
 * different identity), and a missing identity is the normal not-logged-in case.
 */
function propagateCloudIdentityToChildren(): void {
  // Inherited from a parent process: leave it exactly as-is.
  if (process.env[IDENTITY_ENV_KEYS.userId]) return;

  let identity: CloudIdentity | null = null;
  try {
    identity = readStoredIdentitySync();
  } catch {
    return;
  }
  if (!identity) return;

  for (const [key, value] of Object.entries(cloudIdentityEnv(identity))) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function propagateTelemetryContextToChildren(): string {
  const orchestratorHarness = detectOrchestratorHarness();

  // Must run before the distinct-id fallback below: a signed-in user id is a
  // better person key than the machine hash, and children should inherit it.
  propagateCloudIdentityToChildren();

  if (!process.env.AGENT_RELAY_CLI_VERSION) {
    process.env.AGENT_RELAY_CLI_VERSION = VERSION;
  }
  if (SDK_VERSION && !process.env.AGENT_RELAY_SDK_VERSION) {
    process.env.AGENT_RELAY_SDK_VERSION = SDK_VERSION;
  }
  if (!process.env[ORCHESTRATOR_HARNESS_ENV]) {
    process.env[ORCHESTRATOR_HARNESS_ENV] = orchestratorHarness;
  }
  if (!process.env[TELEMETRY_CLIENT_ENV]) {
    process.env[TELEMETRY_CLIENT_ENV] = 'agent-relay';
  }
  if (!process.env[AGENT_RELAY_DISTINCT_ID_ENV] && hasConfiguredTelemetryKey() && isTelemetryEnabled()) {
    // Signed-in runs are keyed by the cloud user id so CLI, broker, and
    // relaycast-server events all land on one PostHog person.
    process.env[AGENT_RELAY_DISTINCT_ID_ENV] =
      process.env[IDENTITY_ENV_KEYS.userId] || getDistinctId();
  }

  return orchestratorHarness;
}

// Commands that should skip the update check / first-run-notice entirely.
// `telemetry` is here so enable/disable/status never triggers PostHog init on
// the very run that's toggling the preference.
const TELEMETRY_MANAGEMENT_COMMANDS = new Set(['telemetry']);
const STDIO_SERVER_COMMANDS = new Set(['mcp']);

// Commands for which we run the background update-check. Keep this narrow to
// the interactive / long-lived commands — we don't want short-lived programmatic
// invocations (spawn, send, etc.) to hit the npm registry on every call.
const UPDATE_CHECK_COMMANDS = new Set(['node', 'local', 'version', '--version', '-V', '--help', '-h']);

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

/** One-shot guard so the deprecated `local` alias warns at most once per process. */
let localDeprecationWarned = false;

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
      // stdin, not stdout — this property exists to distinguish interactive
      // runs from scripted ones. `agent-relay local status > file.txt` still has
      // a TTY on stdin (human at the keyboard); `echo x | agent-relay send`
      // doesn't (piped input). stdout.isTTY would get both wrong.
      is_tty: Boolean(process.stdin.isTTY),
      is_ci: detectCi(),
    });
  });

  program.hook('postAction', (_thisCommand, _actionCommand) => {
    if (!currentCommand || currentCommand.completed) return;
    const ctx = currentCommand;
    ctx.completed = true;
    // Respect `process.exitCode` if a command set it without throwing. This is
    // the recommended pattern for signalling failure from an async action —
    // the action resolves (so postAction fires) but the process still exits
    // non-zero. Without this, we'd mislabel those runs as successful.
    const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
    track('cli_command_complete', {
      command_name: ctx.name,
      success: exitCode === 0,
      duration_ms: Date.now() - ctx.startedAt,
      ...(exitCode !== 0 ? { exit_code: exitCode } : {}),
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

export function createProgram(options: { name?: string } = {}): Command {
  const program = new Command();

  program
    .name(options.name ?? 'agent-relay')
    .description('Agent-to-agent messaging')
    .version(VERSION, '-V, --version', 'Output the version number');

  registerNodeCommands(program);

  // `local` is a hidden, deprecated alias of `node`. It keeps the pre-rename flat
  // surface (`local up|run|logs|sync`, `local agent …`) so existing scripts keep
  // working, and warns once per process on first use.
  const local = program.command('local', { hidden: true }).description('Deprecated alias of "node"');
  registerCoreCommands(local);
  registerLocalAgentCommands(local);
  registerLocalWorkflowCommands(local);
  local.hook('preAction', () => {
    if (localDeprecationWarned) {
      return;
    }
    localDeprecationWarned = true;
    process.stderr.write(
      "Warning: 'local' is deprecated and will be removed in a future major; use 'relay node ...' instead.\n"
    );
  });

  registerCoreMaintenance(program);
  registerFleetCommands(program);
  registerStatusCommand(program);
  registerSetupCommands(program);
  registerCloudCommands(program);
  registerReflexCommands(program);
  registerWorkspaceCommands(program);
  registerAgentCommands(program);
  registerChannelCommands(program);
  registerMessageCommands(program);
  registerIntegrationCommands(program);
  registerCapabilitiesCommands(program);
  registerSkillsCommands(program);

  program
    .command('mcp')
    .description('Run the Agent Relay MCP stdio server')
    .action(async () => {
      const mod = await import('./agent-relay-mcp.js');
      await mod.startAgentRelayMcpStdio(mod.optionsFromEnv());
    });

  return program;
}

function maybeRunUpdateCheck(version: string, argv: string[]): void {
  const commandName = argv[2];
  if (!commandName || !UPDATE_CHECK_COMMANDS.has(commandName)) return;
  checkForUpdatesInBackground(version);
}

function shouldSkipTelemetryInit(argv: string[]): boolean {
  const commandName = argv[2];
  return Boolean(
    commandName && (TELEMETRY_MANAGEMENT_COMMANDS.has(commandName) || STDIO_SERVER_COMMANDS.has(commandName))
  );
}

function isStdioServerCommand(argv: string[]): boolean {
  const commandName = argv[2];
  return Boolean(commandName && STDIO_SERVER_COMMANDS.has(commandName));
}

/**
 * Top-level verb names that the verbless `-n NAME CLI` silent alias
 * must NOT swallow. Built once from the program's leaf+group command
 * tree so we can't drift if a new verb is added without updating both
 * places.
 */
function collectTopLevelVerbs(program: Command): Set<string> {
  const verbs = new Set<string>();
  for (const command of program.commands) {
    verbs.add(command.name());
    for (const alias of command.aliases()) {
      verbs.add(alias);
    }
  }
  return verbs;
}

export async function runCli(argv: string[] = process.argv): Promise<Command> {
  assertSupportedNodeVersion();
  ensureWebSocketGlobal();
  maybeRunUpdateCheck(VERSION, argv);
  const orchestratorHarness = propagateTelemetryContextToChildren();

  if (!shouldSkipTelemetryInit(argv)) {
    initTelemetry({
      showNotice: true,
      cliVersion: VERSION,
      sdkVersion: SDK_VERSION,
      app: 'cli',
      surface: 'cli',
      orchestratorHarness,
    });
  }

  const program = createProgram({ name: resolveProgramName(argv) });
  installTelemetryHooks(program);
  installExitHooks();

  try {
    await program.parseAsync(argv);
  } catch (err) {
    // A `CliExit` thrown by a command's DI `exit()` is the sanctioned path
    // for "this command is done, exit with code N". It isn't a bug — it's
    // how we get telemetry to flush before `process.exit`.
    const isCliExit = err instanceof CliExit;

    if (currentCommand && !currentCommand.completed) {
      const ctx = currentCommand;
      ctx.completed = true;
      if (isCliExit) {
        track('cli_command_complete', {
          command_name: ctx.name,
          success: err.code === 0,
          duration_ms: Date.now() - ctx.startedAt,
          exit_code: err.code,
        });
      } else {
        const cls = errorClassName(err);
        track('cli_command_complete', {
          command_name: ctx.name,
          success: false,
          duration_ms: Date.now() - ctx.startedAt,
          ...(cls ? { error_class: cls } : {}),
        });
      }
    }

    try {
      await shutdownTelemetry();
    } catch {
      // Never let telemetry shutdown mask the real error.
    }

    if (isCliExit) {
      // Flush is done — now actually exit with the code the command asked for.
      process.exit(err.code);
    }
    throw err;
  }

  if (!isStdioServerCommand(argv)) {
    try {
      await shutdownTelemetry();
    } catch {
      // Ignore — the command succeeded.
    }
  }

  return program;
}
