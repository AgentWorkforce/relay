/**
 * `agent-relay rm <name>` — release a spawned agent via the broker's
 * `DELETE /api/spawned/{name}` route.
 *
 * Trivial wrapper. Prints a one-line confirmation on success and a
 * one-line explanatory error on failure. Connection discovery uses the
 * shared `resolveBrokerConnection` helper so the same `--broker-url` /
 * `RELAY_BROKER_URL` / `connection.json` chain works as for `view` /
 * `drive` / `relay`.
 *
 * The longer-form `release` command in `agent-management.ts` layers
 * broker autostart on top of the same SDK client; `rm` is the lighter
 * "I already have a broker" entry point.
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

type ExitFn = (code: number) => never;

export interface RmDependencies {
  readConnectionFile: (stateDir: string) => unknown;
  getDefaultStateDir: () => string;
  env: NodeJS.ProcessEnv;
  fetch: typeof globalThis.fetch;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}

function withDefaults(overrides: Partial<RmDependencies> = {}): RmDependencies {
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

/** Outcome of `releaseAgent`. Useful for the `--ephemeral` teardown in `run`. */
export interface ReleaseResult {
  ok: boolean;
  status: number;
  message?: string;
}

/**
 * Release through the SDK client against the resolved broker. Returns a
 * structured outcome the caller can decide how to surface — `rm` prints
 * a one-liner, the `--ephemeral` teardown in `run` swallows failures
 * because the client is already on its way out.
 */
export async function releaseAgent(
  connection: BrokerConnection,
  agentName: string,
  fetchFn: typeof globalThis.fetch
): Promise<ReleaseResult> {
  try {
    await createBrokerClient(connection, fetchFn).release(agentName);
    return { ok: true, status: 200 };
  } catch (err: unknown) {
    const failure = mapBrokerSdkFailure(err);
    return { ok: false, status: failure.status, message: failure.message };
  }
}

/**
 * Run the `rm <name>` verb. Resolves with the exit code the CLI should
 * propagate. Pure — no signal handlers, no event loop hooks.
 */
export async function runRm(
  agentName: string,
  options: { brokerUrl?: string; apiKey?: string; stateDir?: string },
  deps: RmDependencies
): Promise<number> {
  // Normalize once so lookups, error messages, and the success log all
  // see the same trimmed name. Without this a stray space turns into a
  // 404 (broker registers names verbatim) and the error message echoes
  // the raw input, which makes debugging quoting issues painful.
  const name = agentName.trim();
  if (!name) {
    deps.error('Error: agent name is required');
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

  const result = await releaseAgent(connection, name, deps.fetch);
  if (!result.ok) {
    if (result.status === 404) {
      deps.error(`Error: no agent named '${name}'`);
    } else {
      deps.error(`Error: could not release '${name}': ${result.message ?? 'unknown error'}`);
    }
    return 1;
  }

  deps.log(`Released agent: ${name}`);
  return 0;
}

/** Register `agent-relay rm <name>` on the supplied commander program. */
export function registerRmCommands(program: Command, overrides: Partial<RmDependencies> = {}): void {
  const deps = withDefaults(overrides);

  program
    .command('rm')
    .description('Release a running agent via the broker (no terminal required)')
    .argument('<name>', 'Agent name to release')
    .option('--broker-url <url>', 'Broker base URL (overrides RELAY_BROKER_URL and connection.json)')
    .option('--api-key <key>', 'Broker API key (overrides RELAY_BROKER_API_KEY and connection.json)')
    .option('--state-dir <dir>', 'Directory containing connection.json (default: .agent-relay/)')
    .action(async (name: string, options: { brokerUrl?: string; apiKey?: string; stateDir?: string }) => {
      const code = await runRm(name, options, deps);
      if (code !== 0) {
        deps.exit(code);
      }
    });
}
