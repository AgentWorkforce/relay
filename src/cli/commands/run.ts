/**
 * `agent-relay run -n NAME CLI [args...] [--mode view|drive|relay] [--ephemeral]`
 * — composition verb.
 *
 * `run` is `new` immediately followed by the matching session verb. It
 * exists so the common "spawn this agent and watch it" case is one
 * command instead of two, and so the legacy `agent-relay -n NAME CLI`
 * shorthand from before issue #864 has somewhere clean to alias to
 * (silent, byte-equivalent — see `bootstrap.ts`).
 *
 * Default `--mode` is `drive` — the safer queue-and-flush default for
 * the spawn-and-watch case. `--mode relay` matches today's
 * shared-stdin-races behaviour; the `-n` silent alias uses that.
 *
 * `--ephemeral` registers a teardown that calls `DELETE /api/spawned/{name}`
 * on client exit (clean detach, SIGINT, SIGTERM, abnormal WS close).
 * Without it the agent survives detach — the post-#864 default. The
 * `-n` silent alias enables `--ephemeral` to preserve today's
 * close-terminal-kills-agent lifetime.
 *
 * This module exports both:
 *   - `runSpawnAndAttach()`     — the one helper that both the `run`
 *                                  verb action and the verbless `-n`
 *                                  alias dispatcher in `bootstrap.ts`
 *                                  call. Keeping a single entry point
 *                                  is how we guarantee the alias is
 *                                  byte-equivalent: there is literally
 *                                  one code path.
 *   - `registerRunActionExtensions()` — slots the new spawn-mode flags
 *                                  onto the existing `run <file>`
 *                                  workflow-runner command in
 *                                  `setup.ts` and overrides its action
 *                                  to dispatch.
 */

import WebSocket from 'ws';

import { Command } from 'commander';

import {
  captureAndRenderSnapshot,
  type AttachSnapshotConnection,
  type AttachSnapshotDeps,
} from '../lib/attach.js';
import {
  defaultStateDir,
  readConnectionFileFromDisk,
  resolveBrokerConnection,
  type BrokerConnection,
} from '../lib/broker-connection.js';
import { defaultExit, runSignalHandler } from '../lib/exit.js';

import { spawnAgent, type NewDependencies, type SpawnRequestBody } from './new.js';
import { releaseAgent } from './rm.js';
import {
  runDriveSession,
  type DriveDependencies,
  type DriveStdin,
  type DriveTerminal,
  type DriveWebSocket,
} from './drive.js';
import { runRelaySession, type RelayDependencies } from './relay.js';
import { runViewSession, type ViewDependencies, type ViewWebSocket } from './view.js';

export type RunMode = 'view' | 'drive' | 'relay';

/** Options the composition layer understands. */
export interface SpawnAndAttachOptions {
  name: string;
  cli: string;
  args?: string[];
  mode?: RunMode;
  ephemeral?: boolean;

  // Spawn body extras
  task?: string;
  channels?: string;
  cwd?: string;
  team?: string;
  model?: string;

  // Connection
  brokerUrl?: string;
  apiKey?: string;
  stateDir?: string;
}

/** Shared dependencies the composition needs. */
export interface RunDependencies {
  /** For the spawn step. */
  newDeps: NewDependencies;
  /** For `--mode drive` attach. */
  driveDeps: DriveDependencies;
  /** For `--mode relay` attach. */
  relayDeps: RelayDependencies;
  /** For `--mode view` attach. */
  viewDeps: ViewDependencies;
  /** Issue a release on ephemeral teardown. Default delegates to `rm.releaseAgent`. */
  releaseAgent: (
    connection: BrokerConnection,
    name: string,
    fetchFn: typeof globalThis.fetch
  ) => Promise<{ ok: boolean; status: number; message?: string }>;
  /** Signal registrar so the ephemeral teardown fires on SIGINT/SIGTERM. */
  onSignal: (signal: NodeJS.Signals, handler: () => void | Promise<void>) => void;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

function defaultRunDeps(
  newDeps: NewDependencies,
  driveDeps: DriveDependencies,
  relayDeps: RelayDependencies,
  viewDeps: ViewDependencies
): RunDependencies {
  return {
    newDeps,
    driveDeps,
    relayDeps,
    viewDeps,
    releaseAgent: (conn, name, fetchFn) => releaseAgent(conn, name, fetchFn),
    onSignal: driveDeps.onSignal,
    log: driveDeps.log,
    error: driveDeps.error,
  };
}

/**
 * Build the default child-module deps (`new` / `drive` / `relay` /
 * `view`) using the production defaults — global `fetch`, real
 * WebSocket, real signal registration, real stdin/stdout. Exported so
 * `bootstrap.ts` and the alias dispatcher can wire production defaults
 * without re-encoding every detail.
 */
export function buildDefaultRunExtensionDeps(): RunExtensionDependencies {
  const sharedConnectionDeps = {
    readConnectionFile: readConnectionFileFromDisk,
    getDefaultStateDir: defaultStateDir,
    env: process.env,
  };
  const sharedFetch: typeof globalThis.fetch = (input, init) => fetch(input, init);
  const sharedLog = (...args: unknown[]): void => console.error(...args);
  const sharedError = (...args: unknown[]): void => console.error(...args);
  const sharedExit = defaultExit;
  const sharedWriteChunk = (chunk: string): void => {
    process.stdout.write(chunk);
  };
  const sharedOnSignal = (signal: NodeJS.Signals, handler: () => void | Promise<void>): void => {
    process.on(signal, () => runSignalHandler(handler));
  };
  const sharedSnapshot = (
    connection: AttachSnapshotConnection,
    agentName: string,
    snapshotDeps: AttachSnapshotDeps
  ): ReturnType<typeof captureAndRenderSnapshot> =>
    captureAndRenderSnapshot(connection, agentName, snapshotDeps);

  const stdinHandle = process.stdin as unknown as DriveStdin;
  const terminalHandle: DriveTerminal = {
    getSize: () => {
      const stdout = process.stdout;
      if (!stdout.isTTY) return null;
      const rows = stdout.rows;
      const cols = stdout.columns;
      if (typeof rows !== 'number' || typeof cols !== 'number') return null;
      return { rows, cols };
    },
    onResize: (handler) => {
      process.stdout.on('resize', handler);
      return () => process.stdout.off('resize', handler);
    },
  };

  const newDeps: NewDependencies = {
    ...sharedConnectionDeps,
    fetch: sharedFetch,
    log: (...args) => console.log(...args),
    error: sharedError,
    exit: sharedExit,
  };

  const driveDeps: DriveDependencies = {
    ...sharedConnectionDeps,
    createWebSocket: (url, headers) => new WebSocket(url, { headers }) as DriveWebSocket,
    writeChunk: sharedWriteChunk,
    onSignal: sharedOnSignal,
    log: sharedLog,
    error: sharedError,
    exit: sharedExit,
    fetch: sharedFetch,
    captureAndRenderSnapshot: sharedSnapshot,
    stdin: stdinHandle,
    terminal: terminalHandle,
  };

  const relayDeps: RelayDependencies = {
    ...sharedConnectionDeps,
    createWebSocket: (url, headers) => new WebSocket(url, { headers }) as DriveWebSocket,
    writeChunk: sharedWriteChunk,
    onSignal: sharedOnSignal,
    log: sharedLog,
    error: sharedError,
    exit: sharedExit,
    fetch: sharedFetch,
    captureAndRenderSnapshot: sharedSnapshot,
    stdin: stdinHandle,
    terminal: terminalHandle,
  };

  const viewDeps: ViewDependencies = {
    ...sharedConnectionDeps,
    createWebSocket: (url, headers) => new WebSocket(url, { headers }) as ViewWebSocket,
    writeChunk: sharedWriteChunk,
    onSignal: sharedOnSignal,
    log: sharedLog,
    error: sharedError,
    exit: sharedExit,
    fetch: sharedFetch,
    captureAndRenderSnapshot: sharedSnapshot,
  };

  return { newDeps, driveDeps, relayDeps, viewDeps };
}

function buildSpawnBody(options: SpawnAndAttachOptions): SpawnRequestBody {
  const channels = options.channels
    ?.split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  return {
    name: options.name,
    cli: options.cli,
    ...(options.args && options.args.length > 0 ? { args: options.args } : {}),
    ...(options.task !== undefined ? { task: options.task } : {}),
    ...(channels && channels.length > 0 ? { channels } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.team !== undefined ? { team: options.team } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
  };
}

/**
 * Run the spawn-and-attach composition. Single code path for both
 * `agent-relay run -n NAME CLI ...` and the verbless `agent-relay -n NAME CLI`
 * silent alias — that's how we keep the alias byte-equivalent.
 *
 * Returns the exit code the CLI should propagate.
 */
export async function runSpawnAndAttach(
  options: SpawnAndAttachOptions,
  deps: RunDependencies
): Promise<number> {
  const name = options.name?.trim();
  if (!name) {
    deps.error('Error: agent name is required (use -n NAME)');
    return 1;
  }
  const cli = options.cli?.trim();
  if (!cli) {
    deps.error(`Error: CLI is required, e.g. \`agent-relay run -n ${name} claude\``);
    return 1;
  }
  const mode: RunMode = options.mode ?? 'drive';
  if (mode !== 'view' && mode !== 'drive' && mode !== 'relay') {
    deps.error(`Error: --mode must be one of view|drive|relay (got '${String(options.mode)}')`);
    return 1;
  }

  // Resolve the broker connection once. All three steps (spawn, attach,
  // ephemeral teardown) need it and we don't want the file/env to be
  // re-read between them.
  const connection = resolveBrokerConnection(options, deps.newDeps);
  if (!connection) {
    deps.error(
      'Error: could not locate broker connection. Pass --broker-url, set RELAY_BROKER_URL, ' +
        'or run from a directory containing .agent-relay/connection.json.'
    );
    return 1;
  }

  // Step 1: spawn.
  const spawnResult = await spawnAgent(
    connection,
    { ...buildSpawnBody({ ...options, name, cli }) },
    deps.newDeps.fetch
  );
  if (!spawnResult.ok) {
    deps.error(`Error: could not spawn '${name}': ${spawnResult.message ?? 'unknown error'}`);
    return 1;
  }
  deps.log(`Spawned agent: ${name}`);

  // Step 2: register --ephemeral teardown BEFORE attach. The attach
  // call blocks until detach, so signal handlers wired here are what
  // fire on Ctrl+C / SIGTERM mid-session. The handlers are idempotent
  // (best-effort releaseAgent → if it 404s, fine; the agent is gone).
  let ephemeralTriggered = false;
  const fireEphemeralRelease = async (): Promise<void> => {
    if (!ephemeralTriggered) return;
    try {
      const result = await deps.releaseAgent(connection, name, deps.newDeps.fetch);
      if (!result.ok && result.status !== 404) {
        deps.log(
          `[run] ephemeral release of '${name}' returned ${result.status}: ${result.message ?? 'unknown'}`
        );
      }
    } catch (err: unknown) {
      // Never let teardown noise drown out whatever the user is trying to read.
      const message = err instanceof Error ? err.message : String(err);
      deps.log(`[run] ephemeral release of '${name}' threw: ${message}`);
    }
  };
  if (options.ephemeral) {
    ephemeralTriggered = true;
    // Signal-based teardowns: in addition to the attach-runner's own
    // SIGINT handler (which detaches cleanly), we want the ephemeral
    // delete to also fire. The attach client closes the WS first and
    // then we follow up with the DELETE.
    deps.onSignal('SIGINT', () => fireEphemeralRelease());
    deps.onSignal('SIGTERM', () => fireEphemeralRelease());
  }

  // Step 3: attach via the chosen mode runner. Inherit the same
  // connection-resolution flags so the attach runner doesn't go re-read
  // disk and get a different answer.
  const attachOptions = {
    brokerUrl: connection.url,
    apiKey: connection.apiKey,
    // Intentionally NOT passing stateDir — once we have a resolved URL
    // we want the attach client to use it directly, not fall back to
    // disk on a transient flag-parsing accident.
  };

  let attachCode = 0;
  try {
    switch (mode) {
      case 'drive':
        attachCode = await runDriveSession(name, attachOptions, deps.driveDeps);
        break;
      case 'relay':
        attachCode = await runRelaySession(name, attachOptions, deps.relayDeps);
        break;
      case 'view':
        attachCode = await runViewSession(name, attachOptions, deps.viewDeps);
        break;
    }
  } finally {
    // Step 4: ephemeral teardown after clean detach. The attach runner
    // returned (clean or otherwise); release the agent so the client's
    // exit also ends the agent. Signal-path teardowns above are
    // additive — `fireEphemeralRelease` is idempotent.
    if (options.ephemeral) {
      await fireEphemeralRelease();
    }
  }

  return attachCode;
}

/** Bundle the deps needed by `registerRunActionExtensions` into one object. */
export interface RunExtensionDependencies {
  newDeps: NewDependencies;
  driveDeps: DriveDependencies;
  relayDeps: RelayDependencies;
  viewDeps: ViewDependencies;
}

/**
 * Slot the spawn-and-attach flags onto the existing `run <file>`
 * workflow-runner command from `setup.ts`. When `-n` is present in the
 * args, the action shortcuts to `runSpawnAndAttach`; otherwise it
 * delegates to the original workflow-runner action (which we capture
 * and re-invoke).
 *
 * This is the lowest-blast-radius way to share the `run` verb between
 * two different jobs — Commander only allows one command per name, and
 * we'd rather not break the existing `run <file>` muscle memory.
 *
 * Must be called AFTER `setup.ts`'s `registerSetupCommands(program)`
 * has registered the original `run`.
 */
export function registerRunActionExtensions(
  program: Command,
  extDeps: RunExtensionDependencies = buildDefaultRunExtensionDeps()
): void {
  const runCommand = program.commands.find((c) => c.name() === 'run');
  if (!runCommand) {
    // No existing `run` to extend — should never happen in production
    // (setup.ts always registers it) but is fine to silently no-op for
    // tests that build a minimal program.
    return;
  }

  // Capture the existing workflow-runner action so we can fall through
  // to it when `-n` is not provided. Commander stores the action on
  // `_actionHandler` (no public getter as of 12.x).
  const innerCommand = runCommand as unknown as {
    _actionHandler?: (...args: unknown[]) => void | Promise<void>;
  };
  const originalAction = innerCommand._actionHandler;

  // Make the original `<file>` positional optional so `-n NAME CLI`
  // works without complaint, and accept a trailing variadic for the
  // CLI's own args. Commander applies the new argument list verbatim,
  // so workflow callers still get their `file` as the first positional.
  // We do NOT remove the original required-ness in the help text on
  // purpose — describing both modes in a single help blurb is uglier
  // than describing them in the command description.
  runCommand.arguments('[file] [args...]');
  runCommand
    .option('-n, --name <name>', 'Agent name to spawn and attach (alias-mode; turns this into spawn+attach)')
    .option('--mode <mode>', 'Attach mode: view | drive | relay (default: drive)')
    .option('--ephemeral', 'Release the agent on client exit (default: agent survives detach)')
    .option('--task <task>', 'Initial task description for the spawned agent')
    .option('--channels <list>', 'Comma-separated channel list for the spawned agent')
    .option('--cwd <path>', "Working directory for the spawned agent's process")
    .option('--team <team>', 'Team name for the spawned agent')
    .option('--model <model>', 'Model override for the spawned agent (e.g. opus, sonnet)')
    .option('--broker-url <url>', 'Broker base URL (overrides RELAY_BROKER_URL and connection.json)')
    .option('--api-key <key>', 'Broker API key (overrides RELAY_BROKER_API_KEY and connection.json)')
    .option('--state-dir <dir>', 'Directory containing connection.json (default: .agent-relay/)');

  const deps = defaultRunDeps(extDeps.newDeps, extDeps.driveDeps, extDeps.relayDeps, extDeps.viewDeps);

  runCommand.action(async (...actionArgs: unknown[]) => {
    // commander invokes the action with (positional1, positional2, ..., options, command).
    // With `[file] [args...]` that's (file?, args[], options, command).
    const file = actionArgs[0] as string | undefined;
    const variadicArgs = (actionArgs[1] as string[] | undefined) ?? [];
    const opts = (actionArgs[2] as Record<string, unknown>) ?? {};
    const name = typeof opts.name === 'string' ? opts.name.trim() : '';

    if (name) {
      // Spawn-and-attach path. The first positional (`file`) is the
      // CLI; the variadic is the CLI's extra args.
      const cli = (file ?? '').trim();
      const code = await runSpawnAndAttach(
        {
          name,
          cli,
          args: variadicArgs,
          mode: typeof opts.mode === 'string' ? (opts.mode as RunMode) : undefined,
          ephemeral: opts.ephemeral === true,
          task: typeof opts.task === 'string' ? opts.task : undefined,
          channels: typeof opts.channels === 'string' ? opts.channels : undefined,
          cwd: typeof opts.cwd === 'string' ? opts.cwd : undefined,
          team: typeof opts.team === 'string' ? opts.team : undefined,
          model: typeof opts.model === 'string' ? opts.model : undefined,
          brokerUrl: typeof opts.brokerUrl === 'string' ? opts.brokerUrl : undefined,
          apiKey: typeof opts.apiKey === 'string' ? opts.apiKey : undefined,
          stateDir: typeof opts.stateDir === 'string' ? opts.stateDir : undefined,
        },
        deps
      );
      if (code !== 0) {
        extDeps.newDeps.exit(code);
      }
      return;
    }

    // Workflow-file path. Fall through to whatever `setup.ts`
    // originally registered. If the user typed `run` with no args at
    // all we let commander's own missing-required-argument check fire
    // via the original handler.
    if (!originalAction) {
      extDeps.newDeps.error('Error: run requires either -n NAME CLI ... or a workflow file');
      extDeps.newDeps.exit(1);
      return;
    }
    // Re-invoke the captured original handler. The original was
    // installed via `.action((file: string, options: RunWorkflowOptions) => …)`,
    // so commander's internal wrapper expects that arity; the wrapper
    // we're inside (this lambda) gets the same `actionArgs` so we can
    // simply forward.
    await originalAction.apply(runCommand, actionArgs);
  });
}

/**
 * Tiny standalone entry point for the verbless `-n NAME CLI` silent
 * alias dispatcher in `bootstrap.ts`. Just hands off to
 * `runSpawnAndAttach` with the post-#864 alias preset
 * (`--mode relay`, `--ephemeral`).
 */
export async function runVerblessAliasDispatch(
  parsedArgs: { name: string; cli: string; args: string[] },
  extDeps: RunExtensionDependencies = buildDefaultRunExtensionDeps()
): Promise<number> {
  const deps = defaultRunDeps(extDeps.newDeps, extDeps.driveDeps, extDeps.relayDeps, extDeps.viewDeps);
  return runSpawnAndAttach(
    {
      name: parsedArgs.name,
      cli: parsedArgs.cli,
      args: parsedArgs.args,
      mode: 'relay',
      ephemeral: true,
    },
    deps
  );
}

/**
 * Pre-parse `argv.slice(2)` to detect the legacy `-n NAME CLI [args...]`
 * shorthand from before issue #864. Returns the parsed shape when the
 * arguments unambiguously fit the alias, or `null` to let Commander
 * parse normally.
 *
 * Recognised forms (the same shapes today's `agent-relay -n` accepts):
 *
 *   agent-relay -n NAME CLI [args...]
 *   agent-relay --name NAME CLI [args...]
 *   agent-relay -nNAME CLI [args...]            (joined short flag)
 *   agent-relay --name=NAME CLI [args...]       (equals form)
 *
 * Rejected (returns null — fall through to Commander):
 *   - any of the registered subcommand names ('view', 'drive', etc.) appear
 *     as the first non-flag token, even after `-n`
 *   - `-h`/`--help`/`-V`/`--version` present
 *   - `-n` without a CLI positional
 *
 * Exported for unit testing alongside the byte-equivalence test that
 * proves the alias parse matches `run -n NAME CLI --mode relay --ephemeral`.
 */
export function parseVerblessAlias(
  args: string[],
  knownVerbs: ReadonlySet<string>
): { name: string; cli: string; args: string[] } | null {
  if (args.length === 0) return null;

  // Bail on help/version — let commander show its built-in output.
  for (const token of args) {
    if (token === '-h' || token === '--help' || token === '-V' || token === '--version') {
      return null;
    }
  }

  let name: string | null = null;
  let i = 0;
  while (i < args.length) {
    const token = args[i];
    if (token === '-n' || token === '--name') {
      if (i + 1 >= args.length) return null;
      name = args[i + 1];
      // Splice out the flag + value and restart from the same index.
      args = [...args.slice(0, i), ...args.slice(i + 2)];
      continue;
    }
    if (token.startsWith('-n') && token.length > 2 && !token.startsWith('--')) {
      name = token.slice(2);
      args = [...args.slice(0, i), ...args.slice(i + 1)];
      continue;
    }
    if (token.startsWith('--name=')) {
      name = token.slice('--name='.length);
      args = [...args.slice(0, i), ...args.slice(i + 1)];
      continue;
    }
    i += 1;
  }

  if (!name || name.trim() === '') return null;
  if (args.length === 0) return null;

  // The first remaining positional must NOT be one of the known verbs
  // — if it is, the user invoked e.g. `agent-relay -n foo drive bar`
  // which we can't sanely route. Let commander show the error.
  const cli = args[0];
  if (knownVerbs.has(cli)) return null;
  const rest = args.slice(1);

  return { name: name.trim(), cli, args: rest };
}
