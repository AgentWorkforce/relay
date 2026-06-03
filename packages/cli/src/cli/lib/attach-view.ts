/**
 * `agent-relay view <name>` — read-only PTY stream client.
 *
 * Connects to a running broker's `/ws` WebSocket, filters the event stream
 * for `worker_stream` frames matching the requested agent name, and writes
 * each chunk's raw bytes to stdout (preserving ANSI escapes).
 *
 * No keystrokes are forwarded — the broker keeps doing whatever it's doing.
 * Ctrl+C exits the client cleanly; the agent keeps running under the broker.
 */

import fs from 'node:fs';
import path from 'node:path';

import WebSocket from 'ws';

import { getProjectPaths } from '@agent-relay/config';

import {
  captureAndRenderSnapshot,
  type AttachSnapshotConnection,
  type AttachSnapshotDeps,
} from '../lib/attach.js';
import { defaultExit, runSignalHandler } from '../lib/exit.js';

type ExitFn = (code: number) => never;

/** Subset of the broker's `BrokerEvent` we actually care about for `view`. */
export interface ViewableWorkerStreamEvent {
  kind: 'worker_stream';
  name: string;
  stream: string;
  chunk: string;
}

/** Connection metadata discovered from `connection.json` or CLI/env overrides. */
export interface ViewBrokerConnection {
  url: string;
  apiKey?: string;
}

export interface ViewWebSocket {
  on(event: 'open', listener: () => void): unknown;
  on(event: 'message', listener: (data: WebSocket.RawData) => void): unknown;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  close(code?: number, reason?: string): void;
}

export type ViewWebSocketFactory = (url: string, headers: Record<string, string>) => ViewWebSocket;

export interface ViewSignalRegistrar {
  (signal: NodeJS.Signals, handler: () => void | Promise<void>): void | (() => void);
}

export interface ViewDependencies {
  /** Reads `<state-dir>/connection.json` and returns parsed JSON, or null. */
  readConnectionFile: (stateDir: string) => unknown;
  /** Project paths helper — used to pick the default state dir. */
  getDefaultStateDir: () => string;
  /** Environment variables (so tests can inject). */
  env: NodeJS.ProcessEnv;
  /** Factory for the WebSocket — overridden in tests with a mock. */
  createWebSocket: ViewWebSocketFactory;
  /** Where the PTY chunks get written. Defaults to `process.stdout.write`. */
  writeChunk: (chunk: string) => void;
  /** Signal registration (so tests can drive SIGINT without killing the test). */
  onSignal: ViewSignalRegistrar;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
  /** HTTP client used by the snapshot-on-attach call. Defaults to global `fetch`. */
  fetch: typeof globalThis.fetch;
  /** Override for the snapshot-on-attach helper (tests substitute a stub). */
  captureAndRenderSnapshot: (
    connection: AttachSnapshotConnection,
    agentName: string,
    deps: AttachSnapshotDeps
  ) => ReturnType<typeof captureAndRenderSnapshot>;
}

function readConnectionFileFromDisk(stateDir: string): unknown {
  const connPath = path.join(stateDir, 'connection.json');
  try {
    const raw = fs.readFileSync(connPath, 'utf-8');
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function defaultStateDir(): string {
  // Match the Rust broker's discovery convention: `.agentworkforce/relay/` under the
  // project root (resolved the same way the rest of the CLI does it).
  const projectRoot = getProjectPaths().projectRoot;
  return path.join(projectRoot, '.agentworkforce/relay');
}

function withDefaults(overrides: Partial<ViewDependencies> = {}): ViewDependencies {
  return {
    readConnectionFile: readConnectionFileFromDisk,
    getDefaultStateDir: defaultStateDir,
    env: process.env,
    createWebSocket: (url, headers) => new WebSocket(url, { headers }) as ViewWebSocket,
    writeChunk: (chunk) => {
      process.stdout.write(chunk);
    },
    onSignal: (signal, handler) => {
      const listener = () => runSignalHandler(handler);
      process.on(signal, listener);
      return () => process.off(signal, listener);
    },
    log: (...args: unknown[]) => console.error(...args),
    error: (...args: unknown[]) => console.error(...args),
    exit: defaultExit,
    fetch: (input, init) => fetch(input, init),
    captureAndRenderSnapshot,
    ...overrides,
  };
}

function isStringObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(obj: unknown, key: string): string | undefined {
  if (!isStringObject(obj)) return undefined;
  const value = obj[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Resolve the broker connection to use for `view`, in priority order:
 *
 *  1. `--broker-url` / `--api-key` CLI flags
 *  2. `RELAY_BROKER_URL` / `RELAY_BROKER_API_KEY` environment variables
 *  3. `<state-dir>/connection.json` (default `.agentworkforce/relay/connection.json`)
 *
 * Matches the resolution order used by `agent-relay-broker dump-pty` so users
 * don't have to learn two patterns.
 */
export function resolveViewBrokerConnection(
  options: { brokerUrl?: string; apiKey?: string; stateDir?: string },
  deps: ViewDependencies
): ViewBrokerConnection | null {
  const explicitUrl = trimOrUndefined(options.brokerUrl);
  const envUrl = trimOrUndefined(deps.env.RELAY_BROKER_URL);
  const stateDir = options.stateDir ? path.resolve(options.stateDir) : deps.getDefaultStateDir();
  const connectionFile = deps.readConnectionFile(stateDir);
  const fileUrl = readString(connectionFile, 'url');

  const resolveApiKey = (): string | undefined => {
    const explicit = trimOrUndefined(options.apiKey);
    if (explicit) return explicit;
    const fromEnv = trimOrUndefined(deps.env.RELAY_BROKER_API_KEY);
    if (fromEnv) return fromEnv;
    return readString(connectionFile, 'api_key');
  };

  const url = explicitUrl ?? envUrl ?? fileUrl;
  if (!url) return null;

  return {
    url: url.replace(/\/+$/, ''),
    apiKey: resolveApiKey(),
  };
}

function trimOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Convert an `http(s)://host:port` base URL to the matching `ws(s)://…/ws`. */
export function toWsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/^http/, 'ws')}/ws`;
}

/**
 * Inspect a single WebSocket message and, if it's a `worker_stream` event for
 * the requested agent, return the raw chunk string. Returns `null` for events
 * that don't match (other kinds, other agents, malformed JSON, etc.) so the
 * caller can ignore them.
 *
 * Exported for unit testing the filter in isolation from any WebSocket.
 */
export function extractMatchingChunk(rawMessage: string, agentName: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    return null;
  }
  if (!isStringObject(parsed)) return null;
  if (parsed.kind !== 'worker_stream') return null;
  if (parsed.name !== agentName) return null;
  const chunk = parsed.chunk;
  if (typeof chunk !== 'string') return null;
  return chunk;
}

/**
 * Open the read-only view stream and run until the WebSocket closes, the
 * caller signals SIGINT/SIGTERM, or an unrecoverable error occurs. Resolves
 * with the exit code the CLI should propagate.
 */
export async function runViewSession(
  agentName: string,
  options: { brokerUrl?: string; apiKey?: string; stateDir?: string },
  deps: ViewDependencies
): Promise<number> {
  // Normalize once so every downstream lookup, WS-event match, and
  // error message uses the same value. A stray space in the raw input
  // otherwise turns into a silent 404 (broker stores names verbatim).
  const name = agentName.trim();
  if (!name) {
    deps.error('Error: agent name is required');
    return 1;
  }

  const connection = resolveViewBrokerConnection(options, deps);
  if (!connection) {
    deps.error(
      'Error: could not locate broker connection. Pass --broker-url, set RELAY_BROKER_URL, ' +
        'or run from a directory containing .agentworkforce/relay/connection.json.'
    );
    return 1;
  }

  // Render the agent's current screen before the live stream begins, so
  // the user sees what's there instead of staring at a blank terminal
  // until the agent happens to produce more output. Hard errors
  // (`not_found` / `no_pty`) abort — there's nothing meaningful to view.
  // Transient errors (`unavailable` / `transport_error`) are surfaced as
  // a warning and we fall through to the live stream; the agent may
  // still produce useful output even if the snapshot couldn't be served.
  const snapshot = await deps.captureAndRenderSnapshot(
    { url: connection.url, apiKey: connection.apiKey },
    name,
    { fetch: deps.fetch, writeChunk: deps.writeChunk }
  );
  switch (snapshot.status) {
    case 'ok':
      break;
    case 'not_found':
      deps.error(`Error: ${snapshot.message ?? `no agent named '${name}'`}`);
      return 1;
    case 'no_pty':
      deps.error(`Error: ${snapshot.message ?? `agent '${name}' has no PTY to view`}`);
      return 1;
    case 'unavailable':
    case 'transport_error':
      deps.log(
        `[view] could not capture initial screen (${snapshot.message ?? snapshot.status}); streaming live output only`
      );
      break;
  }

  const wsUrl = toWsUrl(connection.url);
  const headers: Record<string, string> = {};
  if (connection.apiKey) {
    headers['X-API-Key'] = connection.apiKey;
  }

  return new Promise<number>((resolve) => {
    let settled = false;
    const cleanupSignals: Array<() => void> = [];
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      for (const cleanup of cleanupSignals.splice(0)) {
        try {
          cleanup();
        } catch {
          // best effort
        }
      }
      try {
        socket.close(1000, 'view client exiting');
      } catch {
        // best effort — already closed
      }
      resolve(code);
    };

    const socket = deps.createWebSocket(wsUrl, headers);

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const cleanup = deps.onSignal(signal, () => finish(0));
      if (typeof cleanup === 'function') cleanupSignals.push(cleanup);
    }

    socket.on('message', (data) => {
      const text =
        typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf-8') : String(data);
      const chunk = extractMatchingChunk(text, name);
      if (chunk !== null) {
        deps.writeChunk(chunk);
      }
    });

    socket.on('error', (err: Error) => {
      deps.error(`[view] WebSocket error: ${err.message}`);
      finish(1);
    });

    socket.on('close', (code: number, reason: Buffer) => {
      if (settled) return;
      const reasonText = reason && reason.length > 0 ? reason.toString('utf-8') : '';
      if (code === 1000 || code === 1005) {
        // Normal closure (server shut down or sent close frame without status)
        finish(0);
      } else {
        deps.error(`[view] connection closed (code: ${code}${reasonText ? `, reason: ${reasonText}` : ''})`);
        finish(1);
      }
    });
  });
}

/** Run a view session with default dependencies. Used by `runtime agent attach --mode view`. */
export function attachView(
  name: string,
  options: { brokerUrl?: string; apiKey?: string; stateDir?: string },
  overrides: Partial<ViewDependencies> = {}
): Promise<number> {
  return runViewSession(name, options, withDefaults(overrides));
}
