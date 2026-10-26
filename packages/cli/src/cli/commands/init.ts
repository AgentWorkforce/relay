import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Command } from 'commander';
import { InvalidArgumentError } from 'commander';

import { boundOrigin, configuredOrigin, guardCredentialOrigin } from '../lib/relaycast-origin-binding.js';
import { runSdk, withSdkDefaults, type SdkCommandDeps } from '../lib/sdk-command.js';
import { persistWorkspaceSession } from '../lib/workspace-session.js';
import { readWorkspaceStore } from '../lib/workspace-store.js';

/** The Relaycast server `relay init` runs locally. Pinned so every machine runs the same server. */
export const LOCAL_ENGINE_PACKAGE = '@relaycast/engine@11.0.0';
const DEFAULT_LOCAL_PORT = 8787;
const HOSTED_ORIGIN = 'https://cast.agentrelay.com';
const START_TIMEOUT_MS = 120_000;

export interface InitCommandDependencies extends SdkCommandDeps {
  fetch: typeof fetch;
  /** Start the local engine detached; returns its pid. */
  startEngine: (input: { dataDir: string; port: number; logFile: string }) => number;
  isAlive: (pid: number) => boolean;
  stop: (pid: number) => void;
  sleep: (ms: number) => Promise<void>;
}

interface LocalServerState {
  pid: number;
  port: number;
  origin: string;
  engine: string;
}

function relayHome(): string {
  return process.env.AGENT_RELAY_HOME ?? path.join(os.homedir(), '.agentworkforce/relay');
}

function localDir(): string {
  return path.join(relayHome(), 'local');
}

function statePath(): string {
  return path.join(localDir(), 'server.json');
}

function readState(): LocalServerState | undefined {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8')) as LocalServerState;
  } catch {
    return undefined;
  }
}

function defaultStartEngine({ dataDir, port, logFile }: { dataDir: string; port: number; logFile: string }) {
  const log = fs.openSync(logFile, 'a', 0o600);
  const child = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['--yes', LOCAL_ENGINE_PACKAGE, '--db', path.join(dataDir, 'relaycast.db'), '--port', String(port)],
    { detached: true, stdio: ['ignore', log, log], env: process.env }
  );
  child.unref();
  fs.closeSync(log);
  if (child.pid === undefined) throw new Error('Could not start the local Relaycast server.');
  return child.pid;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultStop(pid: number): void {
  try {
    // The engine was started in its own process group; stop npx and the server together.
    process.kill(process.platform === 'win32' ? pid : -pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
}

export function withInitDefaults(overrides: Partial<InitCommandDependencies> = {}): InitCommandDependencies {
  return {
    ...withSdkDefaults(overrides),
    fetch: globalThis.fetch,
    startEngine: defaultStartEngine,
    isAlive: defaultIsAlive,
    stop: defaultStop,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...overrides,
  };
}

async function healthy(deps: InitCommandDependencies, origin: string): Promise<boolean> {
  try {
    const response = await deps.fetch(new URL('/health', origin), { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function logTail(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-8).join('\n');
  } catch {
    return '';
  }
}

async function ensureLocalServer(deps: InitCommandDependencies, port: number): Promise<string> {
  const existing = readState();
  if (existing && deps.isAlive(existing.pid) && (await healthy(deps, existing.origin))) {
    return existing.origin;
  }
  const origin = `http://127.0.0.1:${port}`;
  if (await healthy(deps, origin)) {
    throw new Error(
      `Something else is already serving on port ${port}. Stop it, or choose another port with --port.`
    );
  }
  fs.mkdirSync(localDir(), { recursive: true, mode: 0o700 });
  const logFile = path.join(localDir(), 'server.log');
  deps.log(`Starting a local Relaycast server on ${origin} (first start downloads it)…`);
  const pid = deps.startEngine({ dataDir: localDir(), port, logFile });
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await healthy(deps, origin)) {
      const state: LocalServerState = { pid, port, origin, engine: LOCAL_ENGINE_PACKAGE };
      fs.writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      return origin;
    }
    if (!deps.isAlive(pid)) break;
    await deps.sleep(500);
  }
  deps.stop(pid);
  const tail = logTail(logFile);
  throw new Error(
    `The local Relaycast server did not start. It needs Node.js 20, 22 or 24 with npm install scripts enabled.` +
      (tail ? `\nLast lines of ${logFile}:\n${tail}` : '')
  );
}

async function verifyWorkspace(deps: InitCommandDependencies, origin: string, key: string): Promise<void> {
  let response: Response;
  try {
    response = await deps.fetch(new URL('/v1/workspace', origin), {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const reason =
      error instanceof Error ? ((error.cause as Error | undefined)?.message ?? error.message) : '';
    throw new Error(
      `Could not reach ${origin}${reason ? ` (${reason})` : ''}. If your server uses a private certificate ` +
        `authority, set NODE_EXTRA_CA_CERTS to its certificate file.`,
      { cause: error }
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`${origin} rejected the workspace key.`);
  }
  if (!response.ok) throw new Error(`${origin} answered ${response.status} when checking the workspace.`);
}

function nextSteps(deps: InitCommandDependencies): void {
  deps.log('');
  deps.log('Next:');
  deps.log('  relay agent register alice');
  deps.log('  relay agent register bob');
  deps.log('  relay message dm send bob "hello" --as alice');
  deps.log('  relay message inbox check --as bob');
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new InvalidArgumentError('Expected a port.');
  return port;
}

export function registerInitCommand(
  program: Command,
  overrides: Partial<InitCommandDependencies> = {}
): void {
  const deps = withInitDefaults(overrides);
  program
    .command('init')
    .description(
      'Set up Relay: a private server on this machine (default), the hosted service (--hosted), or your own server (--url and --key)'
    )
    .option('--hosted', 'Use the hosted service so agents on other machines can join')
    .option('--url <url>', 'Your own Relaycast server')
    .option('--key <key>', 'Workspace key for your own server')
    .option('--name <name>', 'Workspace name to save this as')
    .option('--port <port>', 'Port for the local server', parsePort, DEFAULT_LOCAL_PORT)
    .option('--stop', 'Stop the local server started by relay init')
    .action(async (o: Record<string, unknown>) => {
      await runSdk(deps, async () => {
        if (o.stop) {
          const state = readState();
          if (!state || !deps.isAlive(state.pid)) {
            deps.log('No local Relay server is running.');
          } else {
            deps.stop(state.pid);
            deps.log(`Stopped the local Relay server on ${state.origin}. Its data is kept in ${localDir()}.`);
          }
          fs.rmSync(statePath(), { force: true });
          return;
        }

        const url = o.url as string | undefined;
        const key = o.key as string | undefined;
        if (Boolean(url) !== Boolean(key))
          throw new Error('Pass --url and --key together for your own server.');
        if (url && o.hosted) throw new Error('Choose either --hosted or --url/--key.');

        if (url && key) {
          const origin = configuredOrigin(url, '--url');
          if (!origin) throw new Error('--url is empty.');
          await verifyWorkspace(deps, origin, key);
          guardCredentialOrigin(key, url);
          const name = (o.name as string | undefined) ?? new URL(origin).hostname;
          persistWorkspaceSession({ name, workspaceKey: key });
          deps.log(`Connected to your server at ${origin} as workspace "${name}".`);
          deps.log('Your key is only ever sent to this server.');
          nextSteps(deps);
          return;
        }

        if (o.hosted) {
          const name = (o.name as string | undefined) ?? `relay-${os.hostname().split('.')[0]}`;
          const relay = await deps.createWorkspace(name, HOSTED_ORIGIN);
          if (!relay.workspaceKey) throw new Error('The hosted service did not return a workspace key.');
          persistWorkspaceSession({ name, workspaceKey: relay.workspaceKey });
          deps.log(`Created hosted workspace "${name}".`);
          deps.log('On another machine, join it with (treat this key like a password):');
          deps.log(`  relay workspace join ${name} ${relay.workspaceKey}`);
          nextSteps(deps);
          return;
        }

        const origin = await ensureLocalServer(deps, o.port as number);
        const name = (o.name as string | undefined) ?? 'local';
        // Re-running init keeps the same local workspace and its agents.
        const stored = readWorkspaceStore().workspaces[name]?.key;
        let workspaceKey = stored && boundOrigin(stored) === origin ? stored : undefined;
        if (workspaceKey) {
          await verifyWorkspace(deps, origin, workspaceKey).catch(() => {
            workspaceKey = undefined;
          });
        }
        if (!workspaceKey) {
          const relay = await deps.createWorkspace(name, origin);
          if (!relay.workspaceKey) throw new Error('The local server did not return a workspace key.');
          workspaceKey = relay.workspaceKey;
          guardCredentialOrigin(workspaceKey, origin);
        }
        persistWorkspaceSession({ name, workspaceKey });
        deps.log(`Relay is running on this machine (${origin}), workspace "${name}". No account needed.`);
        deps.log('To work with agents on other machines later, run: relay init --hosted');
        nextSteps(deps);
      });
    });
}
