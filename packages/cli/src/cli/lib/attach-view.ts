/**
 * `agent-relay view <name>` — read-only PTY stream client.
 *
 * Connects to a running broker's `/ws` WebSocket, filters the event stream
 * for `worker_stream` frames matching the requested agent name, and writes
 * each chunk's raw bytes to stdout (preserving ANSI escapes).
 *
 * No keystrokes are forwarded — the broker keeps doing whatever it's doing.
 * Ctrl+C exits the client cleanly; the agent keeps running under the broker.
 *
 * Because nothing is forwarded, DECSET modes that make the *local* terminal
 * generate input reports (mouse tracking, focus events, bracketed paste, …)
 * are stripped from the stream before it reaches stdout — see
 * {@link InputReportModeFilter}. The interactive verbs (`drive`,
 * `passthrough`) keep those modes: they own stdin in raw mode and forward
 * the reports to the agent, where a TUI can actually consume them.
 */

import fs from 'node:fs';
import path from 'node:path';

import WebSocket from 'ws';

import { getProjectPaths } from '@agent-relay/config';

import {
  captureAndRenderSnapshot,
  createBackpressureAwareWriter,
  resetLocalTerminalOnDetach,
  StreamSyncBuffer,
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

/**
 * Stdin surface used by view. Unlike drive and passthrough, view deliberately
 * consumes and discards input: it is read-only, but taking stdin out of cooked
 * echo mode prevents a terminal's mouse/focus reports from being painted as
 * literal escape characters when a TUI has enabled them.
 */
export interface ViewStdin {
  setRawMode?: (mode: boolean) => unknown;
  isTTY?: boolean;
  isRaw?: boolean;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  off?(event: 'data', listener: (chunk: Buffer) => void): unknown;
  removeListener?(event: 'data', listener: (chunk: Buffer) => void): unknown;
}

export interface ViewDependencies {
  /** Reads `<state-dir>/connection.json` and returns parsed JSON, or null. */
  readConnectionFile: (stateDir: string) => unknown;
  /** Project paths helper — used to pick the default state dir. */
  getDefaultStateDir: () => string;
  /** Environment variables (so tests can inject). */
  env: NodeJS.ProcessEnv;
  /** Local input, held in raw mode and discarded for the read-only session. */
  stdin: ViewStdin;
  /** Factory for the WebSocket — overridden in tests with a mock. */
  createWebSocket: ViewWebSocketFactory;
  /** Where the PTY chunks get written. Defaults to `process.stdout.write`. */
  writeChunk: (chunk: string) => void;
  /**
   * Tear down the backpressure-aware writer on detach: drop its pending queue
   * and unhook its `'drain'` listener so nothing flushes to stdout after the
   * session settles. Defaults to the writer created in {@link withDefaults};
   * tests that inject their own `writeChunk` can omit it (no-op).
   */
  disposeWriter?: () => void;
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
  /**
   * True when stdout is an interactive terminal. Gates the on-detach terminal
   * reset so a piped/redirected `view` never writes reset controls into the
   * captured log. Defaults to `Boolean(process.stdout.isTTY)`.
   */
  stdoutIsTty: boolean;
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
  const writer = createBackpressureAwareWriter(process.stdout);
  return {
    readConnectionFile: readConnectionFileFromDisk,
    getDefaultStateDir: defaultStateDir,
    env: process.env,
    stdin: process.stdin,
    createWebSocket: (url, headers) => new WebSocket(url, { headers }) as ViewWebSocket,
    writeChunk: writer.write,
    disposeWriter: writer.dispose,
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
    stdoutIsTty: Boolean(process.stdout.isTTY),
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

/** A matched `worker_stream` chunk plus its per-worker byte offset (absent on
 *  brokers that predate stream-offset support). */
export interface MatchedChunk {
  chunk: string;
  offset?: number;
}

/**
 * Inspect a single WebSocket message and, if it's a `worker_stream` event for
 * the requested agent, return the raw chunk string plus its stream offset.
 * Returns `null` for events that don't match (other kinds, other agents,
 * malformed JSON, etc.) so the caller can ignore them.
 *
 * Exported for unit testing the filter in isolation from any WebSocket.
 */
export function extractMatchingChunk(rawMessage: string, agentName: string): MatchedChunk | null {
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
  const offset = typeof parsed.offset === 'number' ? parsed.offset : undefined;
  return { chunk, offset };
}

/**
 * DECSET (`CSI ? … h`) modes that instruct the terminal to *send* escape
 * sequences on input events. Enabling any of these on the viewer's local
 * terminal is harmful: `view` never reads stdin (it stays cooked and
 * echoing), so every report the terminal emits — mouse motion like
 * `ESC [<35;22;25M`, focus in/out, paste guards — is echoed straight into
 * the display as garbage instead of being consumed (#1247-adjacent; the
 * on-detach reset already disables them, but that never helped mid-session).
 *
 *  - 9, 1000, 1001, 1002, 1003 — X10/normal/highlight/button/any-event mouse
 *  - 1004                      — focus in/out reporting
 *  - 1005, 1006, 1015, 1016    — mouse coordinate encodings
 *  - 1007                      — alternate scroll (wheel → arrow-key input)
 *  - 2004                      — bracketed paste
 */
const INPUT_REPORT_MODES: ReadonlySet<number> = new Set([
  9, 1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1015, 1016, 2004,
]);

/** Longest escape-sequence prefix the filter will hold across chunk
 *  boundaries before giving up on it. Any DECSET we care about is far
 *  shorter — even a full private-mode init that batches every mode stays well
 *  under this — so the cap only bites on a pathological CSI (an agent that
 *  stalls mid-sequence), where it bounds memory and latency. Beyond the cap an
 *  incomplete private-mode (`CSI ? …`) prefix is dropped rather than flushed,
 *  so a later chunk's final `h` can't re-enable an input-report mode on the
 *  local terminal; any other CSI is passed through verbatim. */
const MAX_HELD_SEQUENCE_LENGTH = 256;

/** An incomplete private-mode CSI (`CSI ? …`) that is still only parameter
 *  bytes — digits and `;` with no final byte yet. Flushing a prefix like this
 *  is unsafe: a later chunk's `h` would complete it locally and re-enable the
 *  very input-report modes this filter strips, so an over-long one is dropped
 *  instead of passed through. */
// eslint-disable-next-line no-control-regex -- intentionally matching a raw ESC byte in PTY output
const PARTIAL_PRIVATE_MODE = /^\x1b\[\?[0-9;]*$/;

/**
 * Streaming filter that removes input-report DECSET *enables* from a PTY
 * byte stream. Everything else — including the matching `CSI ? … l`
 * disables, all other CSIs, OSC/DCS strings, and printable text — passes
 * through byte-for-byte.
 *
 * A CSI sequence may be split across `worker_stream` frames, so the filter
 * holds an incomplete trailing ESC/CSI prefix (bounded by
 * {@link MAX_HELD_SEQUENCE_LENGTH}) until the next chunk completes it.
 * Multi-mode sets like `CSI ? 1002;1006 h` are rewritten to keep only the
 * non-input-report modes (dropped entirely when none remain).
 *
 * Only ASCII control bytes drive the parsing; multi-byte UTF-8 payload
 * characters never appear inside a CSI, so scanning UTF-16 code units is
 * safe (same reasoning as `AnsiBoundaryScanner`).
 */
export class InputReportModeFilter {
  /** Incomplete ESC/CSI prefix held from the previous chunk. */
  private held = '';

  /** Filter a chunk, returning the bytes safe to write to the local
   *  terminal. May return `''` while a split sequence is being held. */
  push(chunk: string): string {
    // Fast path: nothing held and no ESC anywhere — pass through untouched.
    if (this.held === '' && chunk.indexOf('\x1b') === -1) return chunk;

    const data = this.held + chunk;
    this.held = '';
    let out = '';
    let i = 0;
    while (i < data.length) {
      const esc = data.indexOf('\x1b', i);
      if (esc === -1) {
        out += data.slice(i);
        break;
      }
      out += data.slice(i, esc);
      if (esc + 1 >= data.length) {
        // Chunk ends on a bare ESC — hold it for the next push.
        this.held = '\x1b';
        break;
      }
      if (data.charCodeAt(esc + 1) !== 0x5b /* [ */) {
        // Not a CSI (2-byte escape, OSC/DCS intro, …) — never a DECSET;
        // emit the ESC and resume scanning right after it.
        out += '\x1b';
        i = esc + 1;
        continue;
      }
      // CSI: find the final byte (0x40–0x7E).
      let j = esc + 2;
      while (j < data.length && !(data.charCodeAt(j) >= 0x40 && data.charCodeAt(j) <= 0x7e)) {
        j += 1;
      }
      if (j >= data.length) {
        const tail = data.slice(esc);
        if (tail.length <= MAX_HELD_SEQUENCE_LENGTH) {
          this.held = tail; // incomplete CSI — hold until the next chunk
        } else if (!PARTIAL_PRIVATE_MODE.test(tail)) {
          out += tail; // pathologically long non-private CSI — give up filtering it
        }
        // else: an over-long incomplete private-mode prefix. Drop it — flushing
        // the partial `CSI ? …` would let the next frame's final `h` re-enable
        // an input-report mode locally, the exact spray this filter prevents.
        break;
      }
      out += filterCompleteCsi(data.slice(esc, j + 1));
      i = j + 1;
    }
    return out;
  }

  /** Drop any held partial sequence (detach teardown — an incomplete
   *  escape prefix written alone would itself garble the terminal). */
  reset(): void {
    this.held = '';
  }
}

/** Rewrite one complete CSI sequence: strip input-report modes from a
 *  DECSET enable, pass every other CSI through verbatim. */
function filterCompleteCsi(sequence: string): string {
  // eslint-disable-next-line no-control-regex -- intentionally matching a raw ESC byte in PTY output
  const match = /^\x1b\[\?([0-9;]+)h$/.exec(sequence);
  if (!match) return sequence;
  const kept = match[1].split(';').filter((mode) => !INPUT_REPORT_MODES.has(Number(mode)));
  if (kept.length === 0) return '';
  return `\x1b[?${kept.join(';')}h`;
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

  const wsUrl = toWsUrl(connection.url);
  const headers: Record<string, string> = {};
  if (connection.apiKey) {
    headers['X-API-Key'] = connection.apiKey;
  }

  return new Promise<number>((resolve) => {
    let settled = false;
    let rawModeWasSet = false;
    const cleanupSignals: Array<() => void> = [];
    // Subscribe-first: buffer live `worker_stream` chunks until the snapshot
    // is painted and reconciled, so no output around attach time is lost and
    // (via per-worker offsets) none is double-applied. See StreamSyncBuffer.
    const sync = new StreamSyncBuffer();
    // Every byte of agent output (snapshot + live) flows through this filter
    // so input-report modes never reach the viewer's terminal — `view` has no
    // one consuming the reports they would trigger. The on-detach reset below
    // bypasses it deliberately (its `?…l` disables must go out verbatim).
    const inputModeFilter = new InputReportModeFilter();
    const writeAgentOutput = (chunk: string): void => {
      const filtered = inputModeFilter.push(chunk);
      if (filtered.length > 0) deps.writeChunk(filtered);
    };
    // `view` never forwards stdin. Still consume it in raw mode so mouse,
    // focus, and alternate-scroll reports cannot be cooked-mode echoed into
    // the viewer as visible `^[[0A` / `^[[0B` garbage. Ctrl+C must be handled
    // here because raw mode disables the terminal driver's SIGINT handling.
    const stdinDataHandler = (chunk: Buffer): void => {
      if (chunk.includes(0x03)) finish(0);
    };
    const teardownStdin = (): void => {
      try {
        if (deps.stdin.off) {
          deps.stdin.off('data', stdinDataHandler);
        } else if (deps.stdin.removeListener) {
          deps.stdin.removeListener('data', stdinDataHandler);
        }
      } catch {
        // best effort
      }
      try {
        if (rawModeWasSet && typeof deps.stdin.setRawMode === 'function') {
          deps.stdin.setRawMode(false);
        }
      } catch {
        // best effort
      }
      try {
        deps.stdin.pause();
      } catch {
        // best effort
      }
    };
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
      try {
        // Heal the local terminal: a replayed snapshot re-emits terminal modes
        // (alt-screen, mouse reporting, bracketed paste, ...) that would
        // otherwise linger after the viewer detaches. TTY stdout only.
        // Must run before disposeWriter — the writer no-ops once disposed.
        resetLocalTerminalOnDetach(deps.writeChunk, deps.stdoutIsTty);
      } catch {
        // best effort
      }
      teardownStdin();
      // Drop the writer's pending queue and unhook its drain listener so no
      // buffered chunk flushes to stdout after detach.
      deps.disposeWriter?.();
      resolve(code);
    };

    // Render the agent's current screen once the WS is subscribed, then
    // reconcile the buffered live chunks against it. Hard errors
    // (`not_found` / `no_pty`) abort — there's nothing meaningful to view.
    // Transient errors (`unavailable` / `transport_error`) are surfaced as a
    // warning and we fall through to the live stream; the agent may still
    // produce useful output even if the snapshot couldn't be served.
    // Guard every snapshot-path write on `settled` so a Ctrl+C that lands
    // while the snapshot HTTP fetch is in flight can't paint the snapshot
    // after teardown has begun (the snapshot render path runs inside the
    // awaited `captureAndRenderSnapshot`, past the WS `message` guard).
    const guardedWrite = (chunk: string): void => {
      if (!settled) writeAgentOutput(chunk);
    };
    const paintSnapshotAndReconcile = async (): Promise<void> => {
      const snapshot = await deps.captureAndRenderSnapshot(
        { url: connection.url, apiKey: connection.apiKey },
        name,
        { fetch: deps.fetch, writeChunk: guardedWrite }
      );
      if (settled) return;
      switch (snapshot.status) {
        case 'ok':
          for (const chunk of sync.reconcile(snapshot.offset)) writeAgentOutput(chunk);
          return;
        case 'not_found':
          deps.error(`Error: ${snapshot.message ?? `no agent named '${name}'`}`);
          finish(1);
          return;
        case 'no_pty':
          deps.error(`Error: ${snapshot.message ?? `agent '${name}' has no PTY to view`}`);
          finish(1);
          return;
        case 'unavailable':
        case 'transport_error':
          deps.log(
            `[view] could not capture initial screen (${snapshot.message ?? snapshot.status}); streaming live output only`
          );
          // No snapshot painted — apply everything buffered so far rather
          // than dropping live output we already received.
          for (const chunk of sync.flushAll()) writeAgentOutput(chunk);
          return;
      }
    };

    const socket = deps.createWebSocket(wsUrl, headers);

    // Do this before rendering the snapshot: a source TUI may have enabled
    // mouse or alternate-scroll already, and raw input is the final safeguard
    // even if an unusual escape sequence evades the output filter.
    try {
      if (typeof deps.stdin.setRawMode === 'function' && deps.stdin.isTTY !== false && !deps.stdin.isRaw) {
        deps.stdin.setRawMode(true);
        rawModeWasSet = true;
      }
      deps.stdin.resume();
      deps.stdin.on('data', stdinDataHandler);
    } catch {
      // Read-only viewing still works on non-TTY or unusual stdin surfaces.
    }

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const cleanup = deps.onSignal(signal, () => finish(0));
      if (typeof cleanup === 'function') cleanupSignals.push(cleanup);
    }

    socket.on('open', () => {
      void paintSnapshotAndReconcile();
    });

    socket.on('message', (data) => {
      // Stop writing output once teardown has begun (no spray past detach).
      if (settled) return;
      const text =
        typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf-8') : String(data);
      const matched = extractMatchingChunk(text, name);
      if (matched !== null && sync.push(matched.chunk, matched.offset)) {
        writeAgentOutput(matched.chunk);
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
