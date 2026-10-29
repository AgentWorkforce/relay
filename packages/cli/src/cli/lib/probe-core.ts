/**
 * The Agent Relay core (`agent-relay-probe`): the per-user daemon that finds
 * the coding-agent sessions running on this machine and injects Relay
 * messages into them through each tool's own route (Claude Code's session
 * inbox, Codex hooks and queue, the OpenCode and Pi plugins, Devin hooks,
 * Grok's leader socket). `relay init` installs it from a `probe-v<version>`
 * GitHub release of this repository, runs it in the background, and turns on
 * the core's delivery settings for the agent tools the person picked.
 *
 * One core runs per machine: the desktop app's, or one a previous
 * `relay init` started. A running core is always attached to, never doubled.
 * Its bridge is JSON-RPC 2.0 over NDJSON on `~/.agentworkforce/desktop/core.sock`
 * (`AGENT_RELAY_CORE_SOCKET` moves it; on Windows a named pipe derived from
 * that path), see crates/probe/docs/relay-core.md.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import type { ToolId } from './agent-tools-mcp.js';
import type { EnginePlatform } from './relaycast-engine-install.js';

/** The core `relay init` installs. Pinned so every machine runs the same core. */
export const PROBE_VERSION = '15.0.0';
/** Release tags of the core; distinct from the CLI's `v*` tags. */
export const PROBE_TAG_PREFIX = 'probe-v';
const RELEASE_BASE = 'https://github.com/AgentWorkforce/relay/releases/download';
/** The bridge version this client speaks (`crates/probe/src/relay/protocol.rs`). */
export const BRIDGE_VERSION = 2;
/** Moves the core's bridge socket, for the core and its clients alike. */
export const CORE_SOCKET_ENV = 'AGENT_RELAY_CORE_SOCKET';
/** How long a started core gets to answer on its socket. */
export const CORE_START_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 15_000;

/**
 * The release asset of the core for a platform, or undefined when none is published.
 * @param version - Core version, e.g. `15.0.0`
 * @param target - Platform, architecture and libc
 * @returns e.g. `agent-relay-probe-15.0.0-linux-x64`
 */
export function probeAssetName(version: string, target: EnginePlatform): string | undefined {
  const arch = target.arch === 'x64' || target.arch === 'arm64' ? target.arch : undefined;
  if (!arch) return undefined;
  switch (target.platform) {
    case 'darwin':
      return `agent-relay-probe-${version}-darwin-${arch}`;
    case 'linux':
      // Built against glibc; there is no musl build.
      return target.musl ? undefined : `agent-relay-probe-${version}-linux-${arch}`;
    case 'win32':
      return arch === 'x64' ? `agent-relay-probe-${version}-windows-x64.exe` : undefined;
    default:
      return undefined;
  }
}

/**
 * Where a release asset of the core downloads from.
 * @param version - Core version
 * @param asset - Asset name from {@link probeAssetName}
 * @returns The GitHub release download URL; the checksum is at `<url>.sha256`
 */
export function probeAssetUrl(version: string, asset: string): string {
  return `${RELEASE_BASE}/${PROBE_TAG_PREFIX}${version}/${asset}`;
}

/**
 * The core's bridge socket, resolved as the core resolves it: an absolute
 * `AGENT_RELAY_CORE_SOCKET`, a relative one beside the default, else
 * `<home>/.agentworkforce/desktop/core.sock`.
 * @param env - Environment to read the override from
 * @param home - The user's home directory
 * @returns Absolute socket path
 */
export function coreSocketPath(env: NodeJS.ProcessEnv, home: string): string {
  const fallback = path.join(home, '.agentworkforce', 'desktop', 'core.sock');
  const configured = env[CORE_SOCKET_ENV]?.trim();
  if (!configured) return fallback;
  return path.isAbsolute(configured) ? configured : path.join(path.dirname(fallback), configured);
}

/**
 * The Windows named pipe the core serves for a socket path
 * (`relay::transport::pipe_name`).
 * @param socket - The socket path
 * @returns `\\.\pipe\agent-relay-<16 hex>`
 */
export function pipeName(socket: string): string {
  let key = socket.replace(/\//g, '\\').toLowerCase();
  if (key.startsWith('\\\\?\\')) key = key.slice(4);
  while (key.length > 1 && key.endsWith('\\')) key = key.slice(0, -1);
  const hex = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16);
  return `\\\\.\\pipe\\agent-relay-${hex}`;
}

/** A failure the core reported, with its message. */
export class CoreCallError extends Error {}

/** A connection to the core's bridge. */
export interface CoreClient {
  /** Calls one bridge method and returns its result. */
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  close(): void;
}

/**
 * Refuse a socket whose directory another user could have planted it in: it
 * must be this user's, and writable by no one else (the core creates it 0700).
 */
function trustedSocketDirectory(socket: string): void {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return;
  const directory = path.dirname(socket);
  const entry = fs.lstatSync(directory);
  const target = fs.statSync(directory);
  const uid = process.getuid();
  if (entry.uid !== uid || target.uid !== uid || !target.isDirectory() || (target.mode & 0o022) !== 0) {
    throw new Error(
      `${directory} must be a directory only you can write to; refusing the core socket in it.`
    );
  }
}

/**
 * Connect to the core at `socket` and greet it. Resolves undefined when
 * nothing is listening there.
 * @param socket - The core's bridge socket path
 * @param timeoutMs - Bound on connecting and on each call
 * @returns A client, or undefined when no core answers
 */
export async function connectCore(
  socket: string,
  timeoutMs = CALL_TIMEOUT_MS
): Promise<CoreClient | undefined> {
  if (process.platform !== 'win32') {
    if (!fs.existsSync(socket)) return undefined;
    trustedSocketDirectory(socket);
  }
  const address = process.platform === 'win32' ? pipeName(socket) : socket;
  const stream = await new Promise<net.Socket | undefined>((resolve) => {
    const s = net.createConnection(address);
    const timer = setTimeout(() => {
      s.destroy();
      resolve(undefined);
    }, timeoutMs);
    s.once('connect', () => {
      clearTimeout(timer);
      resolve(s);
    });
    s.once('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
  if (!stream) return undefined;

  let nextId = 1;
  let buffer = '';
  let closed = false;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const failAll = (error: Error) => {
    closed = true;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      let message: { id?: unknown; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      // Events arrive between responses; only ids answer calls.
      if (typeof message.id !== 'number') continue;
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error)
        waiter.reject(new CoreCallError(message.error.message ?? 'The core refused the request.'));
      else waiter.resolve(message.result ?? null);
    }
  });
  stream.on('error', (error) => failAll(error));
  stream.on('close', () => failAll(new CoreCallError('The Agent Relay core closed the connection.')));

  const client: CoreClient = {
    call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      if (closed) return Promise.reject(new CoreCallError('The Agent Relay core closed the connection.'));
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new CoreCallError(`The Agent Relay core did not answer ${method} in time.`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value as T);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        stream.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    close() {
      closed = true;
      stream.destroy();
    },
  };
  try {
    await client.call('hello', { bridge_version: BRIDGE_VERSION });
  } catch (error) {
    client.close();
    throw new Error(
      `A core answers at ${socket} but refused this client (${(error as Error).message}). ` +
        'Update the Agent Relay desktop app or the relay CLI so both speak the same bridge.',
      { cause: error }
    );
  }
  return client;
}

/** The part of the core's `status.get` that init reads. */
export interface CoreStatus {
  daemon: { pid: number; version: string; socket: string };
  workspace: {
    state: 'missing' | 'found';
    base_url?: string | null;
    workspace_id?: string | null;
    workspace_name?: string | null;
    verification?: 'pending' | 'verified' | 'rejected' | 'unreachable';
  };
}

/**
 * Start the core in the background, detached from this process, headless and
 * managed by the CLI (it keeps the desktop app's login entry and applies no
 * defaults of its own).
 * @returns The core's pid
 */
export function startCoreProcess({
  binary,
  socket,
  logFile,
}: {
  binary: string;
  socket: string;
  logFile: string;
}): number {
  const log = fs.openSync(logFile, 'a', 0o600);
  try {
    const child = spawn(binary, ['relay', 'serve', '--headless', '--cli-managed', '--socket', socket], {
      detached: true,
      stdio: ['ignore', log, log],
      env: process.env,
      windowsHide: true,
    });
    child.unref();
    if (child.pid === undefined) throw new Error('Could not start the Agent Relay core.');
    return child.pid;
  } finally {
    fs.closeSync(log);
  }
}

// ---------------------------------------------------------------------------
// What relay init turns on per agent tool

/** A core setting: written with `write`, read back as `read` in `settings.get`. */
interface CoreSetting {
  write: string;
  read: string;
}

const setting = (key: string, read = key): CoreSetting => ({ write: key, read });

/** Sessions of every supported tool join Relay on their own. */
export const AUTO_ACTIVATE = setting('auto_activate');

/** How the core injects into each tool, and the settings that turn it on. */
export const PROBE_DELIVERY: Record<ToolId, { settings: CoreSetting[]; route: string }> = {
  claude: {
    // `direct_delivery_default` sets crossSessionInbound to accept only when
    // the person has not chosen a value themselves.
    settings: [setting('direct_delivery_default', 'direct_delivery'), setting('claude_session_hook')],
    route:
      "Claude Code's session inbox (crossSessionInbound: accept in ~/.claude/settings.json) and a SessionStart hook there",
  },
  codex: {
    settings: [setting('codex_stop_hook')],
    route: "PostToolUse and Stop hooks in ~/.codex/hooks.json, and Codex's own queue between turns",
  },
  opencode: { settings: [setting('opencode_plugin')], route: 'the Agent Relay plugin for OpenCode' },
  grok: {
    settings: [setting('grok_leader')],
    route: "Grok's leader socket ([cli] use_leader in ~/.grok/config.toml)",
  },
  pi: { settings: [], route: 'the Agent Relay extension for Pi, which the core installs when it starts' },
  devin: {
    settings: [setting('devin_direct_delivery')],
    route: 'lifecycle hooks in ~/.config/devin/config.json',
  },
};

/** One tool's delivery after init asked the core for it. */
export interface DeliveryResult {
  id: ToolId;
  status: 'on' | 'failed' | 'held';
  route: string;
  message?: string;
}

/** What one `enableDelivery` did. */
export interface DeliveryOutcome {
  results: DeliveryResult[];
  /** Settings (by read key) that were off and that init turned on. */
  turnedOn: string[];
}

type SettingsValues = Record<string, unknown>;

/**
 * Turn on the core's delivery for each tool, and automatic activation. A
 * setting already on is left alone; only the ones turned on here are
 * reported in `turnedOn`, so `--uninstall` turns off exactly those.
 * @param client - A connected core
 * @param tools - The agent tools to deliver to
 * @returns Per-tool results and the settings turned on
 */
export async function enableDelivery(client: CoreClient, tools: ToolId[]): Promise<DeliveryOutcome> {
  let values = await client.call<SettingsValues>('settings.get');
  const turnedOn: string[] = [];
  const turnOn = async (s: CoreSetting): Promise<string | undefined> => {
    if (values[s.read] === true) return undefined;
    try {
      values = await client.call<SettingsValues>('settings.set', { [s.write]: true });
    } catch (error) {
      return (error as Error).message;
    }
    if (values[s.read] === true) {
      turnedOn.push(s.read);
      return undefined;
    }
    // A default that respects the person's own choice may stay off; see the Claude result.
    return s.write === s.read ? `the core did not turn on ${s.write}` : undefined;
  };

  const results: DeliveryResult[] = [];
  const activation = await turnOn(AUTO_ACTIVATE);
  for (const id of tools) {
    const { settings, route } = PROBE_DELIVERY[id];
    const failures: string[] = [];
    for (const s of settings) {
      const failure = await turnOn(s);
      if (failure) failures.push(failure);
    }
    if (activation) failures.unshift(`automatic activation: ${activation}`);
    if (failures.length > 0) {
      results.push({ id, status: 'failed', route, message: failures.join('; ') });
    } else if (id === 'claude' && values.direct_delivery !== true) {
      results.push({
        id,
        status: 'held',
        route,
        message:
          'Your Claude settings already choose how cross-session messages arrive (crossSessionInbound), ' +
          'so they were left as is; messages are held for your approval unless it is "accept".',
      });
    } else {
      results.push({ id, status: 'on', route });
    }
  }
  return { results, turnedOn };
}

/**
 * Turn off the settings `relay init` turned on.
 * @param client - A connected core
 * @param keys - Read keys recorded by {@link enableDelivery}
 * @returns The keys that could not be turned off, with why
 */
export async function disableDelivery(client: CoreClient, keys: string[]): Promise<string[]> {
  const failures: string[] = [];
  for (const key of keys) {
    try {
      await client.call('settings.set', { [key]: false });
    } catch (error) {
      failures.push(`${key}: ${(error as Error).message}`);
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// relay init's records

/** The core `relay init` started, so `--stop` stops only that one. */
export interface CoreState {
  pid: number;
  socket: string;
  binary: string;
  version?: string;
}

/**
 * The record of the core init started, if sane. A pid of 0 or 1 would make
 * a stop signal the CLI's own process group or every process the user owns.
 */
export function readCoreState(file: string): CoreState | undefined {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<CoreState>;
    if (typeof state.pid !== 'number' || !Number.isInteger(state.pid) || state.pid <= 1) return undefined;
    if (typeof state.socket !== 'string' || typeof state.binary !== 'string') return undefined;
    return state as CoreState;
  } catch {
    return undefined;
  }
}

/** Writes a small private JSON record. */
export function writePrivateJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/** The core settings init turned on, kept for `--uninstall`. */
export function readTurnedOn(file: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { turnedOn?: unknown };
    return Array.isArray(parsed.turnedOn)
      ? parsed.turnedOn.filter((key): key is string => typeof key === 'string')
      : [];
  } catch {
    return [];
  }
}
