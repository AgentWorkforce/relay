/**
 * `agent-relay new -n NAME CLI [args...]` — spawn-only verb.
 *
 * Posts to the broker's `POST /api/spawn` route and exits. The agent
 * keeps running as a child of the broker; there's no terminal
 * attachment, no mode flip, no WS subscription. Use `view`, `drive`, or
 * `relay` to attach afterwards.
 *
 * Part of issue #864 sub-PR 4. The longer-form `spawn` command in
 * `agent-management.ts` does the same thing through the SDK client
 * (with broker autostart and many shadow/team/model flags); `new` is
 * the lighter "I already have a broker, just spawn this" entry point
 * that the `-n NAME CLI` silent alias and `run -n NAME CLI` compose on
 * top of.
 */

import { Command } from 'commander';

import {
  defaultStateDir,
  readConnectionFileFromDisk,
  resolveBrokerConnection,
  type BrokerConnection,
} from '../lib/broker-connection.js';
import { defaultExit } from '../lib/exit.js';

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

function authHeaders(connection: BrokerConnection): Record<string, string> {
  return connection.apiKey ? { 'X-API-Key': connection.apiKey } : {};
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

/** Outcome of `spawnAgent` — used by `new` and (via `run`) by the alias. */
export interface SpawnResult {
  ok: boolean;
  status: number;
  message?: string;
  /** The parsed `{ name }` etc. body the broker returned, when it returned one. */
  body?: Record<string, unknown>;
}

/**
 * POST `/api/spawn` against the broker. Exported so `run` (and the
 * silent `-n` alias) can call it directly without re-implementing the
 * fetch / error mapping.
 */
export async function spawnAgent(
  connection: BrokerConnection,
  body: SpawnRequestBody,
  fetchFn: typeof globalThis.fetch
): Promise<SpawnResult> {
  const url = `${connection.url}/api/spawn`;
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { ...authHeaders(connection), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let parsed: Record<string, unknown> | undefined;
    try {
      const json = (await res.json()) as unknown;
      if (json && typeof json === 'object' && !Array.isArray(json)) {
        parsed = json as Record<string, unknown>;
      }
    } catch {
      // empty / non-JSON body — fine
    }
    if (!res.ok) {
      const errMsg = parsed && typeof parsed.error === 'string' ? parsed.error : `HTTP ${res.status}`;
      return { ok: false, status: res.status, message: errMsg, body: parsed };
    }
    return { ok: true, status: res.status, body: parsed };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, message };
  }
}

/** Options the `new` command (and `run` composition) accept on the CLI. */
export interface NewOptions {
  name?: string;
  brokerUrl?: string;
  apiKey?: string;
  stateDir?: string;
  task?: string;
  channels?: string;
  cwd?: string;
  team?: string;
  model?: string;
}

/**
 * Run the `new` verb. Resolves with the exit code the CLI should
 * propagate. The CLI-positional `cli` arg + variadic `args` are passed
 * through to the broker's spawn route as `{ cli, args }`.
 */
export async function runNew(
  cli: string | undefined,
  args: string[],
  options: NewOptions,
  deps: NewDependencies
): Promise<number> {
  const name = options.name?.trim();
  if (!name) {
    deps.error('Error: agent name is required (use -n NAME)');
    return 1;
  }
  if (!cli || !cli.trim()) {
    deps.error(`Error: CLI is required, e.g. \`agent-relay new -n ${name} claude\``);
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
    name,
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
    deps.error(`Error: could not spawn '${name}': ${result.message ?? 'unknown error'}`);
    return 1;
  }

  deps.log(`Spawned agent: ${name}`);
  deps.log(`  -> attach with: agent-relay drive ${name} (or view / relay)`);
  return 0;
}

/** Register `agent-relay new -n NAME CLI [args...]` on the supplied commander program. */
export function registerNewCommands(program: Command, overrides: Partial<NewDependencies> = {}): void {
  const deps = withDefaults(overrides);

  program
    .command('new')
    .description('Spawn a new agent under the broker (headless — does not attach a terminal)')
    .argument('[cli]', 'CLI to spawn (claude, codex, gemini, opencode, aider, …)')
    .argument('[args...]', 'Extra positional arguments passed through to the spawned CLI')
    .requiredOption('-n, --name <name>', 'Agent name (required)')
    .option('--task <task>', 'Initial task description sent to the agent')
    .option('--channels <list>', 'Comma-separated list of channels for the agent to join')
    .option('--cwd <path>', "Working directory for the agent's process")
    .option('--team <team>', 'Team name for the agent')
    .option('--model <model>', 'Model override (e.g. opus, sonnet, gpt-4o)')
    .option('--broker-url <url>', 'Broker base URL (overrides RELAY_BROKER_URL and connection.json)')
    .option('--api-key <key>', 'Broker API key (overrides RELAY_BROKER_API_KEY and connection.json)')
    .option('--state-dir <dir>', 'Directory containing connection.json (default: .agent-relay/)')
    .action(async (cli: string | undefined, args: string[], options: NewOptions) => {
      const code = await runNew(cli, args, options, deps);
      if (code !== 0) {
        deps.exit(code);
      }
    });
}
