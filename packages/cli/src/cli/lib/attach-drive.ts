/**
 * `agent-relay drive <name>` — interactive read-write take-over client.
 *
 * Attaches to a running agent, flips it into `manual_flush` inbound delivery mode so the
 * broker parks new relay messages in a per-worker queue, and forwards your
 * keystrokes to the worker's PTY. Message queue control is deliberately out of
 * band: use `local agent message flush`, `local agent message hold`, and
 * `local agent message auto`
 * from another terminal instead of terminal control chords that agent TUIs may
 * intercept. `Ctrl+C` detaches, restores the worker's previous inbound delivery
 * mode, and leaves the agent running under the broker — `drive` never kills the
 * worker.
 *
 * Sequence of operations on attach (subscribe-first, so no output around
 * attach time is lost and none is double-painted):
 *
 *   1. Discover broker connection (CLI flag → env → connection.json).
 *   2. `GET  /api/spawned/{name}/delivery-mode`  → remember the previous mode.
 *   3. `PUT  /api/spawned/{name}/delivery-mode`  → switch to `manual_flush`.
 *   4. `GET /api/events/replay` → capture the durable-event `sinceSeq` cutoff,
 *      then `GET /api/spawned/{name}/pending` → seed the status-line counter
 *      and the set of already-queued `event_id`s. Cutoff-first + id-dedupe
 *      keeps the counter exact across the attach race (no under/over-count).
 *   5. Open `/ws?sinceSeq=<cutoff>`, subscribe, and buffer live output. The
 *      cutoff stops the broker replaying historical durable events that would
 *      inflate the pending counter; any replayed `delivery_queued` already in
 *      the seed is deduped by `event_id`.
 *   6. On subscribe: `captureAndRenderSnapshot` repaints the agent's current
 *      screen; buffered chunks are reconciled against the snapshot's stream
 *      offset (drop what the snapshot already shows, apply the rest).
 *   7. Forward the initial terminal size (resize now lands in the live stream,
 *      not a dead zone), then open the SDK PTY input stream and switch local
 *      stdin to raw mode.
 *
 * On detach (clean or abnormal), best-effort `PUT .../delivery-mode` restores the
 * previous mode so the queue doesn't fill up indefinitely.
 */

import { Buffer } from 'node:buffer';
import { StringDecoder } from 'node:string_decoder';

import type { InboundDeliveryMode } from '@agent-relay/harness-driver';
import WebSocket from 'ws';

import {
  captureAndRenderSnapshot,
  createBackpressureAwareWriter,
  pickInitialTerminalRows,
  prepareAttachTarget,
  restoreInboundDeliveryModeOnDetach,
  StatusLineController,
  StreamSyncBuffer,
  switchInboundDeliveryModeOrAbort,
  syncInitialPtySize,
  type AttachSnapshotConnection,
  type AttachSnapshotDeps,
} from '../lib/attach.js';
import {
  defaultStateDir,
  readConnectionFileFromDisk,
  toWsUrl,
  type BrokerConnection,
} from '../lib/broker-connection.js';
import { defaultExit, runSignalHandler } from '../lib/exit.js';
import {
  createBrokerClient,
  mapBrokerSdkFailure,
  type PtyInputStreamOptions,
  type PtyInputWriteResult,
} from '../lib/attach-broker.js';
import { createPredictiveEcho, type CreatePredictiveEchoOptions } from './predictive-echo-screen.js';
import type { PredictiveEcho } from '@agent-relay/harness-driver';

type ExitFn = (code: number) => never;

/** Wire string for the broker's `InboundDeliveryMode` enum. */
export type { InboundDeliveryMode };

/** Minimal WebSocket surface we depend on — same shape as `view`'s. */
export interface DriveWebSocket {
  on(event: 'open', listener: () => void): unknown;
  on(event: 'message', listener: (data: WebSocket.RawData) => void): unknown;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  close(code?: number, reason?: string): void;
}

export type DriveWebSocketFactory = (url: string, headers: Record<string, string>) => DriveWebSocket;

export interface DriveSignalRegistrar {
  (signal: NodeJS.Signals, handler: () => void | Promise<void>): void | (() => void);
}

/** Stdin surface — tests provide a fake that never touches the real TTY. */
export interface DriveStdin {
  setRawMode?: (mode: boolean) => unknown;
  isTTY?: boolean;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  off?(event: 'data', listener: (chunk: Buffer) => void): unknown;
  removeListener?(event: 'data', listener: (chunk: Buffer) => void): unknown;
}

/**
 * Local terminal-size source. Wraps `process.stdout` in production so
 * the resize wiring reads the user's actual terminal dimensions and
 * gets a SIGWINCH-equivalent `'resize'` event for free. Tests inject a
 * controllable fake.
 */
export interface DriveTerminal {
  /** Current `(rows, cols)`. Returns `null` when stdout is not a TTY,
   *  in which case resize forwarding is skipped entirely. */
  getSize(): { rows: number; cols: number } | null;
  /** Subscribe to local-terminal resize events. Returns an unsubscribe
   *  function the client calls during teardown. */
  onResize(handler: () => void): () => void;
}

export interface CliPtyInputStream {
  waitUntilOpen(): Promise<void>;
  send(data: string): Promise<PtyInputWriteResult>;
  close(code?: number, reason?: string): void;
  /** Smoothed input→ack RTT (ms), or null before the first ack. */
  readonly srttMs?: number | null;
}

export interface DriveDependencies {
  /** Reads `<state-dir>/connection.json` and returns parsed JSON, or null. */
  readConnectionFile: (stateDir: string) => unknown;
  /** Project paths helper — used to pick the default state dir. */
  getDefaultStateDir: () => string;
  /** Environment variables (so tests can inject). */
  env: NodeJS.ProcessEnv;
  /** Factory for the WebSocket — overridden in tests with a mock. */
  createWebSocket: DriveWebSocketFactory;
  /** Where the PTY chunks get written. Defaults to `process.stdout.write`. */
  writeChunk: (chunk: string) => void;
  /** Signal registration (so tests can drive SIGINT without killing the test). */
  onSignal: DriveSignalRegistrar;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
  /** HTTP client used for mode/pending/flush/resize calls. Defaults to global `fetch`. */
  fetch: typeof globalThis.fetch;
  /** Override for the snapshot-on-attach helper (tests substitute a stub). */
  captureAndRenderSnapshot: (
    connection: AttachSnapshotConnection,
    name: string,
    deps: AttachSnapshotDeps
  ) => ReturnType<typeof captureAndRenderSnapshot>;
  /** Stdin handle — defaults to `process.stdin`. */
  stdin: DriveStdin;
  /** Local terminal size source — defaults to `process.stdout`. */
  terminal: DriveTerminal;
  /** Opens the SDK PTY input stream used for raw human keystrokes. */
  openInputStream: (
    connection: BrokerConnection,
    name: string,
    options?: PtyInputStreamOptions
  ) => CliPtyInputStream;
  /**
   * Builds the adaptive predictive-echo engine, or returns null to disable
   * it (degenerate terminal). Omitted by tests that want plain pass-through.
   */
  createPredictiveEcho?: (opts: CreatePredictiveEchoOptions) => PredictiveEcho | null;
  /**
   * Minimum ms between status-line repaints (coalescing window). Defaults to a
   * small positive value in production to shrink the per-chunk splice window;
   * tests set `0` for immediate, deterministic paints.
   */
  statusRepaintCoalesceMs?: number;
}

function withDefaults(overrides: Partial<DriveDependencies> = {}): DriveDependencies {
  const fetchFn: typeof globalThis.fetch = overrides.fetch ?? ((input, init) => fetch(input, init));
  return {
    readConnectionFile: readConnectionFileFromDisk,
    getDefaultStateDir: defaultStateDir,
    env: process.env,
    createWebSocket: (url, headers) => new WebSocket(url, { headers }) as DriveWebSocket,
    writeChunk: createBackpressureAwareWriter(process.stdout),
    statusRepaintCoalesceMs: 40,
    onSignal: (signal, handler) => {
      const listener = () => runSignalHandler(handler);
      process.on(signal, listener);
      return () => process.off(signal, listener);
    },
    log: (...args: unknown[]) => console.error(...args),
    error: (...args: unknown[]) => console.error(...args),
    exit: defaultExit,
    fetch: fetchFn,
    captureAndRenderSnapshot,
    stdin: process.stdin as DriveStdin,
    terminal: {
      getSize: () => {
        // process.stdout.isTTY is `true | undefined`; reading
        // rows/columns on a non-TTY returns `undefined`.
        const stdout = process.stdout;
        if (!stdout.isTTY) return null;
        const rows = stdout.rows;
        const cols = stdout.columns;
        if (typeof rows !== 'number' || typeof cols !== 'number') return null;
        return { rows, cols };
      },
      onResize: (handler) => {
        // Node automatically translates SIGWINCH into a `'resize'`
        // event on `process.stdout` when stdout is a TTY.
        process.stdout.on('resize', handler);
        return () => process.stdout.off('resize', handler);
      },
    },
    openInputStream: (connection, name, options) => openPtyInputStream(connection, name, fetchFn, options),
    createPredictiveEcho,
    ...overrides,
  };
}

/** ----- HTTP helpers ----- */

/** `GET /api/spawned/{name}/delivery-mode` → `'manual_flush' | 'auto_inject'` or `null` on failure. */
export async function getInboundDeliveryMode(
  connection: BrokerConnection,
  name: string,
  fetchFn: typeof globalThis.fetch
): Promise<InboundDeliveryMode | null> {
  try {
    return await createBrokerClient(connection, fetchFn).getInboundDeliveryMode(name);
  } catch {
    return null;
  }
}

/** Outcome of a `PUT /api/spawned/{name}/delivery-mode` call. */
export interface SetInboundDeliveryModeResult {
  ok: boolean;
  status: number;
  /** Server-reported number of pending messages drained on a `manual_flush→auto_inject` flip. */
  flushed?: number;
  /** Human-readable error message when `ok` is false. */
  message?: string;
}

export async function setInboundDeliveryMode(
  connection: BrokerConnection,
  name: string,
  mode: InboundDeliveryMode,
  fetchFn: typeof globalThis.fetch
): Promise<SetInboundDeliveryModeResult> {
  try {
    const body = await createBrokerClient(connection, fetchFn).setInboundDeliveryMode(name, mode);
    const flushed = body.flushed;
    return { ok: true, status: 200, flushed };
  } catch (err: unknown) {
    const failure = mapBrokerSdkFailure(err);
    return { ok: false, status: failure.status, message: failure.message };
  }
}

/** Seed for the `drive` pending counter: the current queue depth plus the
 *  set of `event_id`s already in the queue. The id set lets the WS handler
 *  dedupe replayed `delivery_queued` frames against deliveries already
 *  counted in `count` (see {@link runDriveSession}). */
export interface PendingSeed {
  count: number;
  eventIds: Set<string>;
}

/**
 * `GET /api/spawned/{name}/pending` → `{ count, eventIds }`, or an empty seed
 * on failure (best-effort). The `eventIds` set carries every pending
 * delivery's `event_id` (deliveries without one are still counted but can't
 * be deduped) so a replayed `delivery_queued` frame for an already-seeded
 * delivery doesn't inflate the counter.
 */
export async function getPendingSeed(
  connection: BrokerConnection,
  name: string,
  fetchFn: typeof globalThis.fetch
): Promise<PendingSeed> {
  try {
    const pending = await createBrokerClient(connection, fetchFn).getPending(name);
    const eventIds = new Set<string>();
    for (const message of pending) {
      if (typeof message.event_id === 'string') eventIds.add(message.event_id);
    }
    return { count: pending.length, eventIds };
  } catch {
    return { count: 0, eventIds: new Set<string>() };
  }
}

/**
 * Current durable-event sequence cutoff, used as the event WS `sinceSeq` so
 * the broker does not replay historical durable events (old `delivery_queued`
 * frames) that would otherwise inflate the freshly-seeded pending counter.
 * Returns `0` on failure (best-effort) — the caller then omits `sinceSeq`
 * and behaves as before.
 */
export async function getCurrentEventSeq(
  connection: BrokerConnection,
  fetchFn: typeof globalThis.fetch
): Promise<number> {
  try {
    return await createBrokerClient(connection, fetchFn).currentEventSeq();
  } catch {
    return 0;
  }
}

/** `POST /api/spawned/{name}/flush` → server returns `{ flushed: N }`. */
export async function flushPending(
  connection: BrokerConnection,
  name: string,
  fetchFn: typeof globalThis.fetch
): Promise<{ ok: boolean; flushed?: number; message?: string }> {
  try {
    const body = await createBrokerClient(connection, fetchFn).flushPending(name);
    return { ok: true, flushed: body.flushed };
  } catch (err: unknown) {
    const failure = mapBrokerSdkFailure(err);
    return { ok: false, message: failure.message };
  }
}

/** `POST /api/input/{name}` body `{ data: "<bytes>" }`. */
export async function sendInput(
  connection: BrokerConnection,
  name: string,
  data: string,
  fetchFn: typeof globalThis.fetch
): Promise<{ ok: boolean; message?: string }> {
  try {
    await createBrokerClient(connection, fetchFn).sendInput(name, data);
    return { ok: true };
  } catch (err: unknown) {
    const failure = mapBrokerSdkFailure(err);
    return { ok: false, message: failure.message };
  }
}

/** Open the SDK-backed raw PTY input stream for interactive CLI sessions. */
export function openPtyInputStream(
  connection: BrokerConnection,
  name: string,
  fetchFn: typeof globalThis.fetch,
  options?: PtyInputStreamOptions
): CliPtyInputStream {
  return createBrokerClient(connection, fetchFn).openInputStream(name, options);
}

/**
 * `POST /api/resize/{name}` body `{ rows, cols }`. Forwards the
 * driver's local terminal dimensions so the agent's PTY (and any TUI
 * running in it) sees the size the human is actually looking at.
 * Called once on attach and again on every local-terminal resize.
 */
export async function resizeWorker(
  connection: BrokerConnection,
  name: string,
  rows: number,
  cols: number,
  fetchFn: typeof globalThis.fetch
): Promise<{ ok: boolean; message?: string }> {
  try {
    await createBrokerClient(connection, fetchFn).resizePty(name, rows, cols);
    return { ok: true };
  } catch (err: unknown) {
    const failure = mapBrokerSdkFailure(err);
    return { ok: false, message: failure.message };
  }
}

/** ----- WS message classification ----- */

function isStringObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Discriminated union of the broker events `drive` cares about. */
export type DriveWsEvent =
  | { kind: 'worker_stream'; chunk: string; offset?: number }
  | { kind: 'delivery_queued'; eventId?: string }
  | { kind: 'agent_pending_drained'; count?: number }
  | { kind: 'other' };

/**
 * Inspect a single WebSocket frame and classify it relative to the agent
 * we're driving. Non-matching / malformed frames return `{ kind: 'other' }`
 * so the caller can ignore them cheaply.
 *
 * Exported for unit testing the filter in isolation.
 */
export function classifyWsEvent(rawMessage: string, name: string): DriveWsEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    return { kind: 'other' };
  }
  if (!isStringObject(parsed)) return { kind: 'other' };
  // All three events we care about are scoped by the worker `name` field.
  if (parsed.name !== name) return { kind: 'other' };

  if (parsed.kind === 'worker_stream') {
    const chunk = parsed.chunk;
    if (typeof chunk !== 'string') return { kind: 'other' };
    const offset = typeof parsed.offset === 'number' ? parsed.offset : undefined;
    return { kind: 'worker_stream', chunk, offset };
  }
  if (parsed.kind === 'delivery_queued') {
    // `event_id` correlates a replayed frame with the pending seed so the
    // counter isn't double-incremented for a delivery already reflected in
    // the seed (see the seed-dedup note in `runDriveSession`). Absent on
    // legacy/mixed frames — treated as "not in the seed" (counted).
    const eventId = typeof parsed.event_id === 'string' ? parsed.event_id : undefined;
    return { kind: 'delivery_queued', eventId };
  }
  if (parsed.kind === 'agent_pending_drained') {
    const count = typeof parsed.count === 'number' ? parsed.count : undefined;
    return { kind: 'agent_pending_drained', count };
  }
  return { kind: 'other' };
}

/** ----- Keybind state machine ----- */

/** Outcome of feeding one chunk to the keybind parser. */
export interface KeybindOutcome {
  /** Bytes that should be forwarded to the agent (may be empty). */
  forward: Buffer;
  /** Local actions the client should perform, in order. */
  actions: KeybindAction[];
}

export type KeybindAction = 'detach';

/**
 * Parser for the one local control byte drive keeps: `Ctrl+C` detaches.
 *
 * Semantics:
 *   - `Ctrl+C` (0x03)    → emit `detach`, never forwarded.
 *   - Every other byte, including Ctrl+B and Ctrl+G, is forwarded to the agent.
 */
export class KeybindParser {
  /** Process one chunk; returns bytes to forward + actions to take. */
  feed(chunk: Buffer): KeybindOutcome {
    const forward: number[] = [];
    const actions: KeybindAction[] = [];

    for (const byte of chunk) {
      if (byte === 0x03 /* Ctrl+C */) {
        actions.push('detach');
        break;
      }
      forward.push(byte);
    }

    return {
      forward: Buffer.from(forward),
      actions,
    };
  }

  /** Reset the parser (e.g. before tearing down). */
  reset(): void {}
}

/** ----- Status line rendering ----- */

/**
 * Render the bottom-of-terminal status line for `drive`. Uses ANSI
 * save-cursor / restore-cursor so the agent's output isn't disturbed.
 *
 * Exported for unit testing — `runDriveSession` calls it on every
 * pending-count change.
 */
export function renderStatusLine(opts: {
  name: string;
  mode: InboundDeliveryMode;
  pending: number;
  /** Terminal rows — defaults to 24 if unknown. The status line lands on row N. */
  rows?: number;
}): string {
  const row = Math.max(opts.rows ?? 24, 1);
  const text = `[drive ${opts.name} | delivery=${opts.mode} | pending=${opts.pending} | Ctrl+C detach]`;
  // ESC 7 = save cursor; ESC[<row>;1H = move to bottom row; ESC[2K = clear line;
  // ESC[7m = reverse video; ESC[0m = reset; ESC 8 = restore cursor.
  return `\x1b7\x1b[${row};1H\x1b[2K\x1b[7m${text}\x1b[0m\x1b8`;
}

/** ----- Main session runner ----- */

/** Initial state handed off to the interactive session loop. */
interface DriveSessionState {
  connection: BrokerConnection;
  name: string;
  previousMode: InboundDeliveryMode | null;
  initialPending: number;
  /**
   * `event_id`s already reflected in `initialPending`. The event WS replays
   * durable `delivery_queued` frames with `seq > cutoffSeq`; a frame whose id
   * is in this set was already counted in the seed and must not re-increment
   * the counter (see {@link runDriveSession} for why the cutoff is captured
   * first and the seed second).
   */
  seededEventIds: Set<string>;
  /** Local terminal size at attach, for sizing the predictive-echo model. */
  initialLocalSize: { rows: number; cols: number } | null;
  /**
   * Durable-event sequence cutoff at attach. Passed to the event WS as
   * `sinceSeq` so the broker doesn't replay historical durable events
   * (old `delivery_queued`) that would inflate the pending counter.
   */
  cutoffSeq: number;
  /**
   * Tears down the early SIGINT/SIGTERM handlers registered by
   * {@link runDriveSession} right after the delivery-mode flip. Called by the
   * loop before it installs its own fuller handlers so Ctrl+C is never
   * double-handled. Also disables the early restore path.
   */
  disposeEarlySignals: () => void;
}

/**
 * Run the interactive session. Subscribe-first: opens the event WS, buffers
 * live `worker_stream` chunks, then (on subscribe) paints the snapshot,
 * reconciles the buffer against the snapshot offset, forwards the initial
 * resize, and takes over stdin. Restores the worker's previous mode on any
 * exit path. Resolves with the exit code the CLI should propagate.
 */
function runDriveSessionLoop(state: DriveSessionState, deps: DriveDependencies): Promise<number> {
  const { connection, name, previousMode, seededEventIds } = state;

  // Connect with a `sinceSeq` cutoff so the broker replays only events after
  // attach — historical durable events must not inflate the pending counter.
  // Omit it when the cutoff is 0 (no durable events yet / lookup failed) so
  // the URL and behaviour match the pre-cutoff default.
  const wsUrl =
    state.cutoffSeq > 0 ? `${toWsUrl(connection.url)}?sinceSeq=${state.cutoffSeq}` : toWsUrl(connection.url);
  const headers: Record<string, string> = {};
  if (connection.apiKey) {
    headers['X-API-Key'] = connection.apiKey;
  }

  return new Promise<number>((resolve) => {
    let settled = false;
    let rawModeWasSet = false;
    let unsubscribeResize: (() => void) | null = null;
    let pending = state.initialPending;
    let terminalRows = pickInitialTerminalRows(state.initialLocalSize, undefined);
    const parser = new KeybindParser();
    // Stateful UTF-8 decoder for forwarded stdin. Decoding each raw stdin chunk
    // independently would turn a multi-byte character split across `data`
    // events (routine in large pastes / IME) into U+FFFD; the StringDecoder
    // buffers a trailing incomplete sequence until the next chunk completes it.
    // Detach scanning still runs on raw bytes upstream (0x03 can't appear inside
    // a multi-byte sequence), so this only touches the forwarded payload.
    const inputDecoder = new StringDecoder('utf8');
    let inputStream: CliPtyInputStream | null = null;
    const cleanupSignals: Array<() => void> = [];
    // Skip the status line entirely when stdout is not a TTY (e.g. piped to
    // `tee`) — a fabricated row-24 repaint would corrupt the captured log.
    const statusLineEnabled = state.initialLocalSize !== null;
    // Subscribe-first: buffer live `worker_stream` chunks until the snapshot
    // is painted and reconciled against its per-worker offset.
    const sync = new StreamSyncBuffer();

    // Adaptive predictive echo masks round-trip latency on remote brokers.
    // Seeded with the snapshot (once painted) so its confirmed model matches
    // the screen.
    const predictiveEcho =
      deps.createPredictiveEcho?.({
        cols: state.initialLocalSize?.cols ?? 0,
        rows: state.initialLocalSize?.rows ?? 0,
        write: deps.writeChunk,
        getInputSrtt: () => inputStream?.srttMs ?? null,
      }) ?? null;

    // Tee the snapshot's painted bytes so we can seed the predictive-echo
    // model with them — its cursor must match the real screen before we
    // optimistically echo, or predicted glyphs land at the wrong position.
    let snapshotBytes = '';
    const captureWrite = (chunk: string): void => {
      deps.writeChunk(chunk);
      snapshotBytes += chunk;
    };

    // Boundary-held + coalesced status painter. Holds repaints while the agent
    // is mid escape-sequence (no splicing into a half-sent CSI), rate-limits
    // per-chunk repaints, and skips painting entirely on a non-TTY stdout.
    const statusController = new StatusLineController({
      render: () => renderStatusLine({ name, mode: 'manual_flush', pending, rows: terminalRows }),
      write: deps.writeChunk,
      enabled: statusLineEnabled,
      coalesceMs: deps.statusRepaintCoalesceMs ?? 40,
    });
    const paintStatus = (): void => {
      statusController.request();
    };

    // Route server output through the predictive-echo engine (which owns
    // cursor save/restore) or straight to stdout, then repaint the status.
    // Feed every chunk to the status controller for boundary tracking so the
    // repaint holds off until the stream is back at a sequence boundary.
    const applyServerOutput = (chunk: string): void => {
      statusController.observeOutput(chunk);
      if (predictiveEcho) {
        void predictiveEcho.onServerOutput(chunk).then(paintStatus, paintStatus);
      } else {
        deps.writeChunk(chunk);
        paintStatus();
      }
    };

    // Local-terminal resize handler. Forwards to the broker and
    // repaints the status line at the new bottom-row index. Registered
    // on `socket.on('open')` (same point we take over stdin) so a
    // failed connection doesn't leave a dangling listener; unregistered
    // in `teardownStdin` so detach is clean.
    const resizeHandler = (): void => {
      const size = deps.terminal.getSize();
      if (!size) return;
      terminalRows = size.rows;
      predictiveEcho?.onResize(size.cols, size.rows);
      void resizeWorker(connection, name, size.rows, size.cols, deps.fetch).then((res) => {
        if (!res.ok) {
          deps.log(`[drive] resize forward failed: ${res.message ?? 'unknown error'}`);
        }
      });
      // Repaint regardless of fetch outcome — the local terminal has
      // already moved, so the status line position needs to move with
      // it whether or not the broker accepted the resize.
      paintStatus();
    };

    // ---- stdin handling ----
    const stdinDataHandler = (chunk: Buffer): void => {
      const outcome = parser.feed(chunk);
      if (outcome.forward.length > 0) {
        const stream = inputStream;
        if (!stream) {
          deps.log('[drive] input stream is not ready');
          return;
        }
        // Decode through the stateful UTF-8 decoder so a multi-byte character
        // split across stdin chunks is forwarded intact rather than as U+FFFD.
        // An incomplete trailing sequence decodes to '' and is held until the
        // next chunk completes it.
        const decoded = inputDecoder.write(outcome.forward);
        if (decoded.length > 0) {
          // Fire-and-forget; surface errors via log but don't block the
          // event loop on every keystroke.
          void stream.send(decoded).catch((err: unknown) => {
            if (settled) return;
            const message = err instanceof Error ? err.message : String(err);
            deps.log(`[drive] input stream send failed: ${message}`);
            // The keystroke never reached the PTY — drop any optimistic echo
            // for it so the screen doesn't show input the agent didn't get.
            predictiveEcho?.rollback();
          });
        }
        predictiveEcho?.onUserInput(outcome.forward);
      }
      for (const action of outcome.actions) {
        switch (action) {
          case 'detach':
            finish(0);
            return;
        }
      }
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
      try {
        if (unsubscribeResize) {
          unsubscribeResize();
          unsubscribeResize = null;
        }
      } catch {
        // best effort
      }
      rawModeWasSet = false;
    };

    const closeInputStream = (): void => {
      const stream = inputStream;
      inputStream = null;
      if (!stream) return;
      try {
        stream.close(1000, 'drive client exiting');
      } catch {
        // best effort
      }
    };

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      // Stop the status painter first so no queued repaint fires after we
      // restore cooked mode (output would otherwise spray past detach).
      statusController.dispose();
      for (const cleanup of cleanupSignals.splice(0)) {
        try {
          cleanup();
        } catch {
          // best effort
        }
      }
      teardownStdin();
      predictiveEcho?.reset();
      closeInputStream();
      try {
        socket.close(1000, 'drive client exiting');
      } catch {
        // best effort
      }
      // Best-effort restore: re-read the mode and only revert if it's still
      // what this session set, so we don't leave the worker stuck in
      // manual_flush and don't clobber a change another session made.
      void restoreInboundDeliveryModeOnDetach(
        connection,
        name,
        previousMode,
        'manual_flush',
        'drive',
        deps
      ).finally(() => {
        resolve(code);
      });
    };

    const socket = deps.createWebSocket(wsUrl, headers);

    const openInputStreamAndTakeStdin = async (): Promise<void> => {
      try {
        inputStream = deps.openInputStream(connection, name);
        await inputStream.waitUntilOpen();
        if (settled) {
          closeInputStream();
          return;
        }
        if (typeof deps.stdin.setRawMode === 'function' && deps.stdin.isTTY !== false) {
          deps.stdin.setRawMode(true);
          rawModeWasSet = true;
        }
        deps.stdin.resume();
        deps.stdin.on('data', stdinDataHandler);
        // Subscribe to local-terminal resize events at the same point
        // we take over stdin so the lifecycles match — both go away in
        // `teardownStdin` on any exit path.
        unsubscribeResize = deps.terminal.onResize(resizeHandler);
      } catch (err: unknown) {
        if (settled) return;
        const message = err instanceof Error ? err.message : String(err);
        deps.error(`[drive] could not open PTY input stream: ${message}`);
        finish(1);
      }
    };

    // Runs once the event WS is subscribed: paint the snapshot, seed
    // predictive echo, reconcile buffered live output against the snapshot
    // offset, forward the initial resize (now that we're subscribed, so its
    // SIGWINCH repaint lands in the live stream instead of a dead zone before
    // subscription), then open the input stream and take over stdin.
    const onSubscribed = async (): Promise<void> => {
      const snapshot = await deps.captureAndRenderSnapshot(
        { url: connection.url, apiKey: connection.apiKey },
        name,
        { fetch: deps.fetch, writeChunk: captureWrite }
      );
      if (settled) return;
      switch (snapshot.status) {
        case 'ok':
          break;
        case 'not_found':
          deps.error(`Error: ${snapshot.message ?? `no agent named '${name}'`}`);
          finish(1);
          return;
        case 'no_pty':
          deps.error(`Error: ${snapshot.message ?? `agent '${name}' has no PTY to drive`}`);
          finish(1);
          return;
        case 'unavailable':
        case 'transport_error':
          deps.log(
            `[drive] could not capture initial screen (${snapshot.message ?? snapshot.status}); streaming live output only`
          );
          break;
      }
      if (predictiveEcho) void predictiveEcho.seed(snapshotBytes);
      terminalRows = pickInitialTerminalRows(state.initialLocalSize, snapshot.rows);
      // Track the snapshot bytes for boundary state before the first repaint.
      statusController.observeOutput(snapshotBytes);
      paintStatus();
      // Reconcile buffered chunks. On `ok`, drop what the snapshot already
      // reflects (by offset); with no offset this drops the pre-snapshot
      // buffer (snapshot-authoritative, matching the legacy behaviour). On a
      // transient snapshot failure nothing was painted, so apply everything.
      const pendingChunks = snapshot.status === 'ok' ? sync.reconcile(snapshot.offset) : sync.flushAll();
      for (const chunk of pendingChunks) applyServerOutput(chunk);
      await syncInitialPtySize(connection, name, state.initialLocalSize, 'drive', deps);
      if (settled) return;
      // Open the SDK input stream before taking over stdin. A failed stream
      // should not leave the user's terminal in raw mode with nowhere to
      // send bytes.
      await openInputStreamAndTakeStdin();
    };

    // Hand off from the early restore handlers (installed before the awaited
    // setup) to the fuller session-loop handlers — no double restore.
    state.disposeEarlySignals();
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const cleanup = deps.onSignal(signal, () => finish(0));
      if (typeof cleanup === 'function') cleanupSignals.push(cleanup);
    }

    socket.on('open', () => {
      void onSubscribed();
    });

    socket.on('message', (data) => {
      // Once teardown has begun, drop inbound frames so we don't write output
      // or repaint the status line after cooked mode is restored.
      if (settled) return;
      const text =
        typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf-8') : String(data);
      const event = classifyWsEvent(text, name);
      switch (event.kind) {
        case 'worker_stream':
          if (sync.push(event.chunk, event.offset)) applyServerOutput(event.chunk);
          break;
        case 'delivery_queued':
          // A replayed frame (seq > cutoff) can still be for a delivery
          // already reflected in the seeded pending count when it raced the
          // cutoff/seed capture. Dedupe by `event_id`: count it once, then
          // forget the id so a genuine re-queue of the same event later still
          // registers.
          if (event.eventId !== undefined && seededEventIds.delete(event.eventId)) {
            break;
          }
          pending += 1;
          paintStatus();
          break;
        case 'agent_pending_drained':
          pending = 0;
          paintStatus();
          break;
        case 'other':
          break;
      }
    });

    socket.on('error', (err: Error) => {
      deps.error(`[drive] WebSocket error: ${err.message}`);
      finish(1);
    });

    socket.on('close', (code: number, reason: Buffer) => {
      if (settled) return;
      const reasonText = reason && reason.length > 0 ? reason.toString('utf-8') : '';
      if (code === 1000 || code === 1005) {
        finish(0);
      } else {
        deps.error(`[drive] connection closed (code: ${code}${reasonText ? `, reason: ${reasonText}` : ''})`);
        finish(1);
      }
    });
  });
}

/**
 * Open a `drive` session. Resolves with the exit code the CLI should
 * propagate. Cleans up its own stdin raw-mode and best-effort restores
 * the worker's previous inbound delivery mode on any exit path.
 */
export async function runDriveSession(
  agentName: string,
  options: { brokerUrl?: string; apiKey?: string; stateDir?: string },
  deps: DriveDependencies
): Promise<number> {
  const target = prepareAttachTarget(agentName, options, deps);
  if (!target) return 1;
  const { name, connection } = target;

  const flipResult = await switchInboundDeliveryModeOrAbort(
    connection,
    name,
    'manual_flush',
    `switch '${name}' to manual_flush mode`,
    deps
  );
  if (!flipResult) return 1;
  const { previousMode } = flipResult;

  // The mode is now flipped to `manual_flush`, but the terminal is still cooked
  // and we have several awaited HTTP round-trips (pending, cutoff, snapshot,
  // input stream) before the session loop installs its signal handlers. Ctrl+C
  // in that window would otherwise kill the process with the worker stranded in
  // `manual_flush`, silently queueing every later relay message. Register early
  // restore-and-exit handlers immediately; the loop disposes them once its own
  // handlers are ready (no double restore — see `disposeEarlySignals`).
  let earlyHandled = false;
  const earlyCleanups: Array<() => void> = [];
  const earlyRestore = async (): Promise<void> => {
    if (earlyHandled) return;
    earlyHandled = true;
    for (const cleanup of earlyCleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // best effort
      }
    }
    await restoreInboundDeliveryModeOnDetach(connection, name, previousMode, 'manual_flush', 'drive', deps);
    deps.exit(0);
  };
  const disposeEarlySignals = (): void => {
    earlyHandled = true;
    for (const cleanup of earlyCleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // best effort
      }
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const cleanup = deps.onSignal(signal, earlyRestore);
    if (typeof cleanup === 'function') earlyCleanups.push(cleanup);
  }

  const initialLocalSize = deps.terminal.getSize();
  // Capture the durable-event cutoff *first*, then seed the pending counter.
  //
  // The event WS replays durable `delivery_queued` frames with `seq >
  // cutoffSeq`. Reading the cutoff before the seed guarantees every delivery
  // NOT captured in the seed has `seq > cutoffSeq` (it was queued after the
  // cutoff snapshot), so it is replayed and counted — closing the
  // undercount hole where a delivery racing between the two reads was in
  // neither the seed nor the replay. The flip side (a delivery that IS in the
  // seed and also replays because its `seq > cutoffSeq`) is handled by
  // deduping replayed frames against the seed's `event_id`s (see
  // `seededEventIds` in the WS handler), so it's counted exactly once.
  const cutoffSeq = await getCurrentEventSeq(connection, deps.fetch);
  const { count: initialPending, eventIds: seededEventIds } = await getPendingSeed(
    connection,
    name,
    deps.fetch
  );

  return runDriveSessionLoop(
    {
      connection,
      name,
      previousMode,
      initialPending,
      seededEventIds,
      initialLocalSize,
      cutoffSeq,
      disposeEarlySignals,
    },
    deps
  );
}

/** Run a drive session with default dependencies. Used by `runtime agent attach --mode drive`. */
export function attachDrive(
  name: string,
  options: { brokerUrl?: string; apiKey?: string; stateDir?: string },
  overrides: Partial<DriveDependencies> = {}
): Promise<number> {
  return runDriveSession(name, options, withDefaults(overrides));
}
