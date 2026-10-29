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

import { execFileSync, spawn } from 'node:child_process';
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
 * Refuse a socket the core did not make for this user: the core binds it
 * 0600 and owned by the user it runs as. Node cannot read a Unix socket's
 * peer credentials, so the socket file's owner and mode stand in for them
 * (only its owner, or root, can make or chmod it in a directory only this
 * user can write to).
 */
function trustedSocketFile(socket: string): void {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return;
  const entry = fs.lstatSync(socket);
  if (!entry.isSocket() || entry.uid !== process.getuid() || (entry.mode & 0o077) !== 0) {
    throw new Error(
      `${socket} must be a socket only you can use (owned by you, mode 0600); refusing to speak to it.`
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
    trustedSocketFile(socket);
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
  let greeting: { bridge_version?: unknown; pid?: unknown } | null;
  try {
    greeting = await client.call('hello', { bridge_version: BRIDGE_VERSION });
  } catch (error) {
    client.close();
    throw new Error(
      `A core answers at ${socket} but refused this client (${(error as Error).message}). ` +
        'Update the Agent Relay desktop app or the relay CLI so both speak the same bridge.',
      { cause: error }
    );
  }
  // The core's greeting names its bridge and pid; anything else is not the core.
  if (typeof greeting?.bridge_version !== 'number' || typeof greeting.pid !== 'number') {
    client.close();
    throw new Error(`What answers at ${socket} is not an Agent Relay core; refusing to speak to it.`);
  }
  return client;
}

/** `agent-relay-probe --version` prints exactly this: clap's `<name> <version>`. */
const PROBE_VERSION_LINE = /^agent-relay-probe (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

/**
 * The version an `agent-relay-probe` binary reports for `--version`. Only
 * the core's own one-line answer counts, so another program that happens to
 * print a version is not taken for the core.
 * @param binary - Path to the binary
 * @returns e.g. `15.0.0`, or undefined when it is not the core or does not run
 */
export function readProbeVersion(binary: string): string | undefined {
  try {
    const out = execFileSync(binary, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return PROBE_VERSION_LINE.exec(out.trim())?.[1];
  } catch {
    return undefined;
  }
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
    // A failed spawn (EACCES, ENOENT, a missing interpreter) is also reported
    // as an 'error' event; without a listener it would crash the CLI.
    child.on('error', () => undefined);
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
  pi: {
    // A core relay init started installs the extension only through this setting.
    settings: [setting('pi_extension')],
    route: 'the Agent Relay extension in ~/.pi/agent/extensions',
  },
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
  /**
   * Settings init turned on for a failed tool that could not be turned off
   * again: the tool is still on the core's route, so it must not get MCP.
   */
  stuck?: string[];
}

/** What one `enableDelivery` did. */
export interface DeliveryOutcome {
  results: DeliveryResult[];
  /** Settings (by read key) that were off and that init turned on. */
  turnedOn: string[];
  /** Settings init had turned on (in this run or an earlier one) that this run turned off again. */
  turnedOff: string[];
}

type SettingsValues = Record<string, unknown>;

/**
 * The read keys of a tool's core settings.
 * @param id - The agent tool
 * @returns e.g. `['direct_delivery', 'claude_session_hook']` for Claude Code
 */
export function deliveryKeys(id: ToolId): string[] {
  return PROBE_DELIVERY[id].settings.map((s) => s.read);
}

/**
 * Turn on the core's delivery for each tool, then automatic activation. A
 * setting already on is left alone; only the ones turned on here are
 * reported in `turnedOn`, so `--uninstall` turns off exactly those.
 *
 * Each tool ends on one route. When one of a tool's settings fails, the rest
 * are not tried, and the ones init turned on for it (in this run, or in an
 * earlier one: `owned`) are turned off again, so the MCP fallback is its only
 * route. Automatic activation is turned on only once a tool is injected; when
 * none is and no tool an earlier run injected into is left, init's own
 * activation is turned off again.
 * @param client - A connected core
 * @param tools - The agent tools to deliver to
 * @param owned - Read keys an earlier `relay init` recorded as turned on
 * @returns Per-tool results, and the settings turned on and off
 */
export async function enableDelivery(
  client: CoreClient,
  tools: ToolId[],
  owned: string[] = []
): Promise<DeliveryOutcome> {
  let values = await client.call<SettingsValues>('settings.get');
  const turnedOn: string[] = [];
  const turnedOff: string[] = [];
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
  /** Turn off what init owns among `keys`; says which could not be. */
  const rollBack = async (keys: string[]): Promise<string[]> => {
    const stuck: string[] = [];
    for (const key of keys) {
      const ours = turnedOn.includes(key) || owned.includes(key);
      if (!ours || values[key] !== true) continue;
      try {
        values = await client.call<SettingsValues>('settings.set', { [key]: false });
      } catch (error) {
        stuck.push(`${key} stays on (${(error as Error).message})`);
        continue;
      }
      const index = turnedOn.indexOf(key);
      if (index >= 0) turnedOn.splice(index, 1);
      turnedOff.push(key);
    }
    return stuck;
  };

  const results: DeliveryResult[] = [];
  for (const id of tools) {
    const { settings, route } = PROBE_DELIVERY[id];
    let failure: string | undefined;
    for (const s of settings) {
      failure = await turnOn(s);
      if (failure) break;
    }
    if (failure) {
      const stuck = await rollBack(deliveryKeys(id));
      results.push({
        id,
        status: 'failed',
        route,
        message: [failure, ...stuck].join('; '),
        ...(stuck.length > 0 ? { stuck } : {}),
      });
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

  const injected = results.filter((r) => r.status !== 'failed');
  if (injected.length === 0) {
    // A tool an earlier run injected into still needs activation.
    const stillInjected = owned.some(
      (key) => key !== AUTO_ACTIVATE.read && values[key] === true && !turnedOff.includes(key)
    );
    if (!stillInjected) await rollBack([AUTO_ACTIVATE.read]);
    return { results, turnedOn, turnedOff };
  }
  const activation = await turnOn(AUTO_ACTIVATE);
  if (activation) {
    // Without activation no session joins through the core: every tool goes to MCP.
    for (const result of injected) {
      const stuck = await rollBack(deliveryKeys(result.id));
      result.status = 'failed';
      result.message = [`automatic activation: ${activation}`, ...stuck].join('; ');
      if (stuck.length > 0) result.stuck = stuck;
    }
  }
  return { results, turnedOn, turnedOff };
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

/** What `relay init` turned on in the core, kept for `--uninstall` and `--delivery mcp`. */
export interface DeliveryRecord {
  /** Core settings (by read key) init turned on. */
  turnedOn: string[];
  /**
   * Each Claude login's `crossSessionInbound` (null: absent) from before init
   * turned direct delivery on, by settings file: what turning it off again
   * puts back in place of the `hold` the core writes.
   */
  claudeInbound: Record<string, string | null>;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** Recorded originals; an older record's list named files that were unset. */
function originals(value: unknown): Record<string, string | null> {
  if (Array.isArray(value)) return Object.fromEntries(strings(value).map((file) => [file, null]));
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string | null] => entry[1] === null || typeof entry[1] === 'string'
    )
  );
}

/**
 * The record of what init turned on.
 * @param file - `<relay home>/local/core-settings.json`
 * @returns The record, empty when there is none or it is unreadable
 */
export function readDeliveryRecord(file: string): DeliveryRecord {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> | null;
    return { turnedOn: strings(parsed?.turnedOn), claudeInbound: originals(parsed?.claudeInbound) };
  } catch {
    return { turnedOn: [], claudeInbound: {} };
  }
}

/** The core settings init turned on, kept for `--uninstall`. */
export function readTurnedOn(file: string): string[] {
  return readDeliveryRecord(file).turnedOn;
}
