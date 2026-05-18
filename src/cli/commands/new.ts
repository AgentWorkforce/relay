/**
 * `agent-relay new NAME CLI [args...] [--attach [--mode …] [--ephemeral]]`
 * — spawn verb with optional session attach.
 *
 * Name is the first positional argument, matching every other verb in
 * this taxonomy (`drive Alice`, `view Alice`, `relay Alice`, `rm Alice`).
 *
 * Without `--attach`, this is spawn-only: POST `/api/spawn` and exit.
 * The agent keeps running headless under the broker; the user attaches
 * later with `view` / `drive` / `relay`.
 *
 * With `--attach`, the command composes spawn + a session verb in one
 * shot. Defaults to `--mode drive` (the safer queue-and-flush default
 * for the spawn-and-watch case). `--ephemeral` registers a teardown
 * that calls `DELETE /api/spawned/{name}` on client exit (clean
 * detach, SIGINT, SIGTERM, abnormal WS close) so the agent dies with
 * the terminal — useful for ad-hoc experiments.
 *
 * The composition uses `runSpawnAndAttach` from
 * `src/cli/lib/spawn-and-attach.ts`. That same helper is what the
 * verbless `-n` alias dispatcher in `bootstrap.ts` calls — single code
 * path, byte-equivalent alias.
 *
 * The longer-form `spawn` command in `agent-management.ts` layers broker
 * autostart and more flags on top of the same SDK client; `new` is the
 * lighter "I already have a broker, just spawn this" entry point.
 */

import { Command } from 'commander';

import {
  defaultStateDir,
  readConnectionFileFromDisk,
  resolveBrokerConnection,
  type BrokerConnection,
} from '../lib/broker-connection.js';
import { defaultExit } from '../lib/exit.js';
import { createBrokerClient, mapBrokerSdkFailure } from '../lib/sdk-client.js';
import {
  buildDefaultAttachChildDeps,
  buildSpawnAndAttachDeps,
  runSpawnAndAttach,
  type AttachChildDependencies,
  type AttachMode,
} from '../lib/spawn-and-attach.js';

type ExitFn = (code: number) => never;

export interface NewDependencies {
  readConnectionFile: (stateDir: string) => unknown;
  getDefaultStateDir: () => string;
  env: NodeJS.ProcessEnv;
  fetch: typeof globalThis.fetch;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}

function withDefaults(overrides: Partial<NewDependencies> = {}): NewDependencies {
  return {
    readConnectionFile: readConnectionFileFromDisk,
    getDefaultStateDir: defaultStateDir,
    env: process.env,
    fetch: (input, init) => fetch(input, init),
    log: (...args: unknown[]) => console.log(...args),
    error: (...args: unknown[]) => console.error(...args),
    exit: defaultExit,
    ...overrides,
  };
}

/** Body shape for `POST /api/spawn`. Mirrors the Rust broker's `listen_api_spawn`. */
export interface SpawnRequestBody {
  name: string;
  cli: string;
  args?: string[];
  task?: string;
  channels?: string[];
  cwd?: string;
  team?: string;
  model?: string;
}

/** Outcome of `spawnAgent` — used by `new` and by the spawn-and-attach helper. */
export interface SpawnResult {
  ok: boolean;
  status: number;
  message?: string;
  /** The parsed `{ name }` etc. body the broker returned, when it returned one. */
  body?: Record<string, unknown>;
}

/**
 * Spawn through the SDK client against the resolved broker. Exported so
 * the spawn-and-attach helper (and any other caller) can use the same
 * transport / error mapping.
 */
export async function spawnAgent(
  connection: BrokerConnection,
  body: SpawnRequestBody,
  fetchFn: typeof globalThis.fetch
): Promise<SpawnResult> {
  try {
    const parsed = (await createBrokerClient(connection, fetchFn).spawnPty(body)) as unknown as Record<
      string,
      unknown
    >;
    return { ok: true, status: 200, body: parsed };
  } catch (err: unknown) {
    const failure = mapBrokerSdkFailure(err);
    return { ok: false, status: failure.status, message: failure.message };
  }
}

/** Options the `new` command accepts on the CLI. */
export interface NewOptions {
  brokerUrl?: string;
  apiKey?: string;
  stateDir?: string;
  task?: string;
  channels?: string;
  cwd?: string;
  team?: string;
  model?: string;
  // --attach extras
  attach?: boolean;
  mode?: string;
  ephemeral?: boolean;
}

/**
 * Run the headless-spawn path. Used when `--attach` is NOT set.
 * Resolves with the exit code the CLI should propagate.
 *
 * `name` and `cli` are positional commander arguments — both required,
 * commander surfaces the missing-argument error before we run.
 */
export async function runNew(
  name: string | undefined,
  cli: string | undefined,
  args: string[],
  options: NewOptions,
  deps: NewDependencies
): Promise<number> {
  const trimmedName = name?.trim();
  if (!trimmedName) {
    deps.error('Error: agent name is required (first positional argument)');
    return 1;
  }
  if (!cli || !cli.trim()) {
    deps.error(`Error: CLI is required, e.g. \`agent-relay new ${trimmedName} claude\``);
    return 1;
  }

  const connection = resolveBrokerConnection(options, deps);
  if (!connection) {
    deps.error(
      'Error: could not locate broker connection. Pass --broker-url, set RELAY_BROKER_URL, ' +
        'or run from a directory containing .agent-relay/connection.json.'
    );
    return 1;
  }

  const channels =
    options.channels
      ?.split(',')
      .map((channel) => channel.trim())
      .filter((channel) => channel.length > 0) ?? undefined;

  const body: SpawnRequestBody = {
    name: trimmedName,
    cli: cli.trim(),
    ...(args.length > 0 ? { args } : {}),
    ...(options.task !== undefined ? { task: options.task } : {}),
    ...(channels && channels.length > 0 ? { channels } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.team !== undefined ? { team: options.team } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
  };

  const result = await spawnAgent(connection, body, deps.fetch);
  if (!result.ok) {
    deps.error(`Error: could not spawn '${trimmedName}': ${result.message ?? 'unknown error'}`);
    return 1;
  }

  deps.log(`Spawned agent: ${trimmedName}`);
  deps.log(`  -> attach with: agent-relay drive ${trimmedName} (or view / relay)`);
  return 0;
}

/**
 * Run the spawn-and-attach path. Used when `--attach` IS set.
 * Validates `--mode` / `--ephemeral` and hands off to the shared
 * `runSpawnAndAttach` helper. Resolves with the exit code the CLI
 * should propagate.
 *
 * Separate function (rather than baking the branch into the action
 * closure) so it can be tested in isolation and so the failure modes
 * stay legible.
 */
export async function runNewWithAttach(
  name: string | undefined,
  cli: string | undefined,
  args: string[],
  options: NewOptions,
  childDeps: AttachChildDependencies
): Promise<number> {
  const mode = (options.mode ?? 'drive') as AttachMode;
  return runSpawnAndAttach(
    {
      name: name ?? '',
      cli: cli ?? '',
      args,
      mode,
      ephemeral: options.ephemeral === true,
      task: options.task,
      channels: options.channels,
      cwd: options.cwd,
      team: options.team,
      model: options.model,
      brokerUrl: options.brokerUrl,
      apiKey: options.apiKey,
      stateDir: options.stateDir,
    },
    buildSpawnAndAttachDeps(childDeps)
  );
}

/**
 * Register `agent-relay new NAME CLI [args...]` on the supplied
 * commander program. Name and CLI are positional, matching every other
 * verb in the attach-style taxonomy (`drive`, `view`, `relay`, `rm`).
 * When `--attach` is set, the action composes spawn + session via
 * `runSpawnAndAttach`; otherwise it's spawn-only.
 *
 * `attachChildDeps` is the bundle of child-module deps used in
 * `--attach` mode; tests pass a stub bundle here while production
 * lets `buildDefaultAttachChildDeps()` provide the real ones.
 */
export function registerNewCommands(
  program: Command,
  overrides: Partial<NewDependencies> = {},
  attachChildDeps?: AttachChildDependencies
): void {
  const deps = withDefaults(overrides);

  program
    .command('new')
    .description(
      'Spawn a new agent under the broker. Headless by default; pass --attach to immediately open a session.'
    )
    .argument('<name>', 'Agent name')
    .argument('<cli>', 'CLI to spawn (claude, codex, gemini, opencode, aider, …)')
    .argument('[args...]', 'Extra positional arguments passed through to the spawned CLI')
    .option('--task <task>', 'Initial task description sent to the agent')
    .option('--channels <list>', 'Comma-separated list of channels for the agent to join')
    .option('--cwd <path>', "Working directory for the agent's process")
    .option('--team <team>', 'Team name for the agent')
    .option('--model <model>', 'Model override (e.g. opus, sonnet, gpt-4o)')
    .option('--attach', 'After spawning, immediately open a session (default mode: drive)')
    .option(
      '--mode <mode>',
      'With --attach: session to open (view | drive | relay). Ignored without --attach.'
    )
    .option('--ephemeral', 'With --attach: release the agent on client exit. Ignored without --attach.')
    .option('--broker-url <url>', 'Broker base URL (overrides RELAY_BROKER_URL and connection.json)')
    .option('--api-key <key>', 'Broker API key (overrides RELAY_BROKER_API_KEY and connection.json)')
    .option('--state-dir <dir>', 'Directory containing connection.json (default: .agent-relay/)')
    .action(async (name: string, cli: string, args: string[], options: NewOptions) => {
      // --mode / --ephemeral only do anything with --attach. Warn (don't
      // error) when used without it so misuse is loud but recoverable.
      if (!options.attach) {
        if (options.mode !== undefined) {
          deps.error('[new] --mode is ignored without --attach');
        }
        if (options.ephemeral === true) {
          deps.error('[new] --ephemeral is ignored without --attach');
        }
        const code = await runNew(name, cli, args, options, deps);
        if (code !== 0) {
          deps.exit(code);
        }
        return;
      }
      // --attach: compose spawn + session via the shared helper.
      // Use injected child deps when present (tests), fall back to
      // the real WebSocket-backed implementation.
      const childDeps = attachChildDeps ?? buildDefaultAttachChildDeps();
      const code = await runNewWithAttach(name, cli, args, options, childDeps);
      if (code !== 0) {
        deps.exit(code);
      }
    });
}
