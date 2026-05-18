/**
 * Shared spawn-and-attach helper for issue #864.
 *
 * Two entry points compose `new` + a session verb:
 *
 *   1. `agent-relay new -n NAME CLI --attach [--mode …] [--ephemeral]`
 *      — the explicit, flag-driven path.
 *   2. `agent-relay -n NAME CLI [args...]` — the silent backward-compat
 *      alias for the pre-#864 shorthand, hardcoded to
 *      `--mode relay --ephemeral`.
 *
 * Both call `runSpawnAndAttach()` here. Keeping a single code path is
 * what makes the alias byte-equivalent: there is literally one function
 * that does the work, and the only difference between the two entry
 * points is which `SpawnAndAttachOptions` they construct.
 *
 * This module lives in `src/cli/lib/` (not `src/cli/commands/`) because
 * it's a helper consumed by multiple commands (`new --attach` action)
 * and the bootstrap-layer alias dispatcher, not a verb registration in
 * its own right.
 */

import WebSocket from 'ws';

import {
  captureAndRenderSnapshot,
  type AttachSnapshotConnection,
  type AttachSnapshotDeps,
} from './attach.js';
import {
  defaultStateDir,
  readConnectionFileFromDisk,
  resolveBrokerConnection,
  type BrokerConnection,
} from './broker-connection.js';
import { defaultExit, runSignalHandler } from './exit.js';

import { spawnAgent, type NewDependencies, type SpawnRequestBody } from '../commands/new.js';
import { releaseAgent } from '../commands/rm.js';
import {
  runDriveSession,
  type DriveDependencies,
  type DriveStdin,
  type DriveTerminal,
  type DriveWebSocket,
} from '../commands/drive.js';
import { runRelaySession, type RelayDependencies } from '../commands/relay.js';
import { runViewSession, type ViewDependencies, type ViewWebSocket } from '../commands/view.js';

export type AttachMode = 'view' | 'drive' | 'relay';

/** Options the composition layer understands. */
export interface SpawnAndAttachOptions {
  name: string;
  cli: string;
  args?: string[];
  mode?: AttachMode;
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
export interface SpawnAndAttachDependencies {
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

/** Bundle of child-module deps used by the production default factory. */
export interface AttachChildDependencies {
  newDeps: NewDependencies;
  driveDeps: DriveDependencies;
  relayDeps: RelayDependencies;
  viewDeps: ViewDependencies;
}

/**
 * Build the default child-module deps (`new` / `drive` / `relay` /
 * `view`) using the production defaults — global `fetch`, real
 * WebSocket, real signal registration, real stdin/stdout. Exported so
 * bootstrap-layer callers can wire production defaults without
 * re-encoding every detail.
 */
export function buildDefaultAttachChildDeps(): AttachChildDependencies {
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

/**
 * Build the full `SpawnAndAttachDependencies` bundle from the child
 * deps. Exposed so callers that already have child deps (e.g. tests)
 * can opt into the default `releaseAgent` / `onSignal` wiring without
 * re-implementing it.
 */
export function buildSpawnAndAttachDeps(
  childDeps: AttachChildDependencies = buildDefaultAttachChildDeps()
): SpawnAndAttachDependencies {
  return {
    newDeps: childDeps.newDeps,
    driveDeps: childDeps.driveDeps,
    relayDeps: childDeps.relayDeps,
    viewDeps: childDeps.viewDeps,
    releaseAgent: (conn, name, fetchFn) => releaseAgent(conn, name, fetchFn),
    onSignal: childDeps.driveDeps.onSignal,
    log: childDeps.driveDeps.log,
    error: childDeps.driveDeps.error,
  };
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
 * Spawn an agent and immediately attach to it via the chosen session
 * verb. Single code path for both `new -n NAME CLI --attach …` and the
 * verbless `-n NAME CLI` alias.
 *
 * Returns the exit code the CLI should propagate.
 */
export async function runSpawnAndAttach(
  options: SpawnAndAttachOptions,
  deps: SpawnAndAttachDependencies
): Promise<number> {
  const name = options.name?.trim();
  if (!name) {
    deps.error('Error: agent name is required (use -n NAME)');
    return 1;
  }
  const cli = options.cli?.trim();
  if (!cli) {
    deps.error(`Error: CLI is required, e.g. \`agent-relay new -n ${name} claude --attach\``);
    return 1;
  }
  const mode: AttachMode = options.mode ?? 'drive';
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
    buildSpawnBody({ ...options, name, cli }),
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
  const fireEphemeralRelease = async (): Promise<void> => {
    try {
      const result = await deps.releaseAgent(connection, name, deps.newDeps.fetch);
      if (!result.ok && result.status !== 404) {
        deps.log(
          `[attach] ephemeral release of '${name}' returned ${result.status}: ${result.message ?? 'unknown'}`
        );
      }
    } catch (err: unknown) {
      // Never let teardown noise drown out whatever the user is trying to read.
      const message = err instanceof Error ? err.message : String(err);
      deps.log(`[attach] ephemeral release of '${name}' threw: ${message}`);
    }
  };
  if (options.ephemeral) {
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
    // additive — `fireEphemeralRelease` is idempotent (broker returns
    // 404 the second time, which we swallow).
    if (options.ephemeral) {
      await fireEphemeralRelease();
    }
  }

  return attachCode;
}

/**
 * Tiny standalone entry point for the verbless `-n NAME CLI` silent
 * alias dispatcher in `bootstrap.ts`. Hands off to
 * `runSpawnAndAttach` with the post-#864 alias preset
 * (`--mode relay`, `--ephemeral`).
 */
export async function runVerblessAliasDispatch(
  parsedArgs: { name: string; cli: string; args: string[] },
  childDeps: AttachChildDependencies = buildDefaultAttachChildDeps()
): Promise<number> {
  return runSpawnAndAttach(
    {
      name: parsedArgs.name,
      cli: parsedArgs.cli,
      args: parsedArgs.args,
      mode: 'relay',
      ephemeral: true,
    },
    buildSpawnAndAttachDeps(childDeps)
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
 *   - any of the registered subcommand names ('view', 'drive', etc.)
 *     appears as the first non-flag token, even after `-n`
 *   - `-h`/`--help`/`-V`/`--version` present
 *   - `-n` without a CLI positional
 *
 * Exported for unit testing alongside the byte-equivalence test that
 * proves the alias parse matches `new -n NAME CLI --attach --mode relay --ephemeral`.
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
