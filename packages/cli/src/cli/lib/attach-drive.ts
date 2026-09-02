/**
 * `agent-relay drive <name>` — interactive read-write take-over client.
 *
 * Attaches to a running agent, puts it in `auto_inject` inbound delivery mode so
 * relay messages keep reaching it live, and forwards your keystrokes to the
 * worker's PTY. Watching an agent never pauses it: a driven agent goes on
 * receiving its peers' messages exactly as it would unattended, which is what
 * makes it possible to observe a team coordinating instead of freezing it by
 * looking at it.
 *
 * `Ctrl+]` toggles the worker into `manual_flush` when you want the screen to
 * hold still while you type — messages park in a per-worker queue, the status
 * line counts them (`pending=N`), and the next press drains the queue and
 * returns to live delivery. The out-of-band commands `local agent message
 * flush`, `local agent message hold`, and `local agent message auto` still work
 * from another terminal: a bare `flush` during a drive session injects the
 * queued backlog immediately (the broker follows the handoff with a one-shot
 * `flush_injections` frame that exempts it from the interactive hold) while
 * leaving the mode — and the parking of later messages — unchanged. `Ctrl+C`
 * detaches, restores the worker's previous inbound delivery mode, and leaves
 * the agent running under the broker — `drive` never kills the worker.
 *
 * Sequence of operations on attach (subscribe-first, so no output around
 * attach time is lost and none is double-painted):
 *
 *   1. Discover broker connection (CLI flag → env → connection.json).
 *   2. `GET  /api/spawned/{name}/delivery-mode`  → remember the previous mode.
 *   3. `PUT  /api/spawned/{name}/delivery-mode`  → assert `auto_inject`.
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
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

import type { InboundDeliveryMode } from '@agent-relay/harness-driver';
import WebSocket from 'ws';

import {
  createInputStreamRecovery,
  INPUT_REOPEN_BASE_DELAY_MS,
  INPUT_REOPEN_MAX_ATTEMPTS,
} from './attach-input-recovery.js';
import {
  captureAndRenderSnapshot,
  canReserveStatusLine,
  clampStatusLineText,
  createBackpressureAwareWriter,
  DETACH_CLEANUP_DEADLINE_MS,
  pickInitialTerminalCols,
  pickInitialTerminalRows,
  prepareAttachTarget,
  reserveStatusLineRow,
  renderChildScrollRegion,
  resetLocalTerminalOnDetach,
  restoreInboundDeliveryModeOnDetach,
  StatusLineController,
  StreamSyncBuffer,
  switchInboundDeliveryModeOrAbort,
  syncInitialPtySize,
  TerminalScrollRegionTracker,
  type AttachSnapshotConnection,
  type AttachSnapshotDeps,
} from '../lib/attach.js';
import {
  defaultStateDir,
  readConnectionFileFromDisk,
  toWsUrl,
  type BrokerConnection,
  type BrokerConnectionOptions,
} from '../lib/broker-connection.js';
import { defaultExit, runSignalHandler } from '../lib/exit.js';
import { resolveFleetHint } from '../lib/fleet-hint.js';
import {
  createBrokerClient,
  mapBrokerSdkFailure,
  type PtyInputStreamOptions,
  type PtyInputWriteResult,
} from '../lib/attach-broker.js';
import { describeError } from './describe-error.js';
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
  isRaw?: boolean;
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
  /**
   * True once the underlying socket has closed. The stream never reopens
   * itself, so this latches: every later `send()` rejects immediately. Read it
   * before sending so a dead stream is handled as one liveness event rather
   * than once per keystroke.
   */
  readonly closed?: boolean;
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
  /**
   * Tear down the backpressure-aware writer on detach: drop its pending queue
   * and unhook its `'drain'` listener so nothing flushes to stdout after the
   * session settles. Defaults to the writer created in {@link withDefaults};
   * tests that inject their own `writeChunk` can omit it (no-op).
   */
  disposeWriter?: () => void;
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
  /**
   * Best-effort workspace lookup for improving cross-node 404 messages.
   * Defaults to `resolveFleetHint` from `fleet-hint.ts`. Tests inject a stub
   * to avoid network calls.
   */
  fleetHint?: (name: string) => Promise<string | null>;
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
  /**
   * Interval (ms) at which the session re-asserts PTY resize ownership by
   * re-sending its current size (single-resizer policy, #1247). Keeps an
   * idle-but-live session from being superseded after the broker's
   * stale-owner window; the broker treats a same-size re-assert as a no-op
   * refresh (no SIGWINCH). Defaults to 60000. Set `0` to disable (tests).
   */
  ownershipReassertMs?: number;
  /**
   * How many times to reopen a dead PTY input stream before giving up and
   * exiting non-zero. Defaults to 5. Set `0` to disable recovery and fail on
   * the first loss.
   */
  inputReopenMaxAttempts?: number;
  /**
   * Base delay (ms) for the input-stream reopen backoff; doubles per attempt up
   * to {@link INPUT_REOPEN_MAX_DELAY_MS}. Defaults to 250. Tests set a small
   * value to keep the backoff deterministic and fast.
   */
  inputReopenBaseDelayMs?: number;
  /**
   * Reads the identity of the worker process behind `name`, or `null` when it
   * cannot be established. Used to reject a reopen that landed on a different
   * process. See {@link fetchWorkerIdentity}.
   */
  getWorkerIdentity: (connection: BrokerConnection, name: string) => Promise<string | null>;
}

function withDefaults(overrides: Partial<DriveDependencies> = {}): DriveDependencies {
  const fetchFn: typeof globalThis.fetch = overrides.fetch ?? ((input, init) => fetch(input, init));
  const writer = createBackpressureAwareWriter(process.stdout);
  return {
    readConnectionFile: readConnectionFileFromDisk,
    getDefaultStateDir: defaultStateDir,
    env: process.env,
    createWebSocket: (url, headers) => new WebSocket(url, { headers }) as DriveWebSocket,
    writeChunk: writer.write,
    disposeWriter: writer.dispose,
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
    fleetHint: resolveFleetHint,
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
    getWorkerIdentity: (connection, name) => fetchWorkerIdentity(connection, name, fetchFn),
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

/**
 * Best-available identity for the worker process behind `name`, or `null` when
 * it cannot be established.
 *
 * The broker exposes no per-instance token for a worker — no `instance_id`,
 * `run_id`, `epoch`, or absolute spawn timestamp reaches the wire (#1454). The
 * only restart-discriminating values on `GET /api/spawned` are two pids, and
 * they are not interchangeable:
 *
 * - `workerPid` (`crates/broker/src/worker.rs:243` = `handle.child.id()`) is the
 *   PTY child itself — the process whose terminal we are driving. Present as
 *   soon as the worker is spawned.
 * - `pid` (`worker.rs:242` = `handle.harness_pid`) is the *harness* wrapper, and
 *   stays null until the worker completes the harness ready handshake
 *   (`worker_events.rs:849`). Verified against a live broker: a plain PTY worker
 *   reports `pid: null` and `workerPid: 30209`, so keying on `pid` alone would
 *   make every reopen unverifiable for exactly the workers this path serves.
 *
 * So prefer `workerPid` and fold in `pid` when the broker also has it — a change
 * in either means the process behind the name changed.
 *
 * This is a heuristic, not a nonce: the OS can reuse a pid. It is used to
 * *reject* a reopen that lands on a visibly different process, never to prove
 * two processes are the same — callers treat `null` as "cannot verify" and
 * fail closed. The durable fix is for the broker to surface the per-spawn
 * identity it already holds in memory (`WorkerHandle.spawned_at`,
 * `PersistedAgent.started_at`, or the `MetricsCollector` spawn counter) — #1454.
 */
export async function fetchWorkerIdentity(
  connection: BrokerConnection,
  name: string,
  fetchFn: typeof globalThis.fetch
): Promise<string | null> {
  try {
    const agents = await createBrokerClient(connection, fetchFn).listAgents();
    const agent = agents.find((candidate) => candidate.name === name);
    if (!agent) return null;
    // `workerPid` is on the wire but absent from the typed contract, so read it
    // off the record defensively rather than widening `ListAgent` here.
    const workerPid = (agent as { workerPid?: unknown }).workerPid;
    const parts: string[] = [];
    if (typeof workerPid === 'number') parts.push(`worker:${workerPid}`);
    if (typeof agent.pid === 'number') parts.push(`harness:${agent.pid}`);
    // No pid of either kind means the broker cannot tell us who this is.
    return parts.length > 0 ? parts.join('/') : null;
  } catch {
    return null;
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
  fetchFn: typeof globalThis.fetch,
  options?: { sessionId?: string }
): Promise<{ ok: boolean; message?: string; applied?: boolean }> {
  try {
    const result = await createBrokerClient(connection, fetchFn).resizePty(name, rows, cols, options);
    return { ok: true, applied: result.applied !== false };
  } catch (err: unknown) {
    const failure = mapBrokerSdkFailure(err);
    return { ok: false, message: failure.message };
  }
}

/**
 * Release this session's PTY resize ownership on detach (single-resizer
 * policy, #1247), so the next client that attaches can resize the shared PTY.
 * Best-effort: the broker also supersedes a crashed owner after an idle window.
 *
 * `restoreSize` gives back the row and column a writable attach reserved for
 * Relay's status line (see `reserveStatusLineRow`). Without it the worker stays
 * at `rows - 1`/`cols - 1` after the status line disappears, and since a
 * read-only `view` session never resizes the PTY, the agent's TUI would remain
 * one row and column short until the next writable attach. The broker applies
 * the size before dropping ownership, so this stays one round-trip and cannot
 * lose the ordering race a separate resize call would introduce.
 */
export async function releaseResizeOwnership(
  connection: BrokerConnection,
  name: string,
  sessionId: string,
  fetchFn: typeof globalThis.fetch,
  restoreSize?: { rows: number; cols: number } | null
): Promise<void> {
  try {
    // Omitting the dimensions is a pure release — the broker skips the resize,
    // so a session with no local TTY invents no placeholder size.
    await createBrokerClient(connection, fetchFn).resizePty(name, restoreSize?.rows, restoreSize?.cols, {
      sessionId,
      release: true,
    });
  } catch {
    // Best-effort — ownership falls back to the broker's idle-takeover net.
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
    // Two different layers emit `delivery_queued`. Only the inbound hold means
    // "parked in the per-worker pending queue" — the count this status line
    // shows and the one `/api/spawned/{name}/pending` seeds. The harness
    // runtimes emit the same kind for every delivery they enqueue for
    // injection, which is ordinary traffic on its way to the agent; counting
    // those would make `pending` climb on every message the agent receives and
    // never come back down (nothing drains a queue the message was never in).
    if (parsed.reason !== 'inbound_delivery_manual_flush') return { kind: 'other' };
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

export type KeybindAction = 'detach' | 'toggle-delivery';

/**
 * Parser for the two local control bytes drive keeps: `Ctrl+C` detaches and
 * `Ctrl+]` toggles inbound delivery between hold and live injection.
 *
 * Semantics:
 *   - `Ctrl+C` (0x03)    → emit `detach`, never forwarded.
 *   - `Ctrl+]` (0x1D)    → emit `toggle-delivery`, never forwarded.
 *   - Every other byte, including Ctrl+B and Ctrl+G, is forwarded to the agent.
 *
 * Neither byte can appear inside a multi-byte UTF-8 sequence (continuation
 * bytes are ≥ 0x80) or a keyboard escape sequence, so scanning raw bytes is
 * safe.
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
      if (byte === 0x1d /* Ctrl+] */) {
        actions.push('toggle-delivery');
        continue;
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
  /** Terminal columns — the label is truncated to fit. Defaults to 80. */
  cols?: number;
  scrollTop?: number;
  scrollBottom?: number;
  originMode?: boolean;
}): string {
  const row = Math.max(opts.rows ?? 24, 1);
  const scrollTop = Math.max(1, opts.scrollTop ?? 1);
  const scrollBottom = Math.max(scrollTop + 1, opts.scrollBottom ?? row - 1);
  // The Ctrl+] hint names the action the NEXT press performs: in auto_inject
  // (the session default) it holds; in manual_flush it delivers, draining the
  // parked queue and going live again. Without the hint, a parked message is
  // invisible beyond the pending counter and a held agent looks like it never
  // receives replies.
  const toggleHint = opts.mode === 'manual_flush' ? 'Ctrl+] deliver' : 'Ctrl+] hold';
  const text = clampStatusLineText(
    `[drive ${opts.name} | delivery=${opts.mode} | pending=${opts.pending} | ${toggleHint} | Ctrl+C detach]`,
    opts.cols,
    true
  );
  // ESC 7 = save cursor; ESC[<row>;1H = move to bottom row; ESC[2K = clear line;
  // ESC[7m = reverse video; ESC[0m = reset; ESC 8 = restore cursor.
  // Temporarily restore the full physical scroll region so CUP can reach the
  // reserved row even if autowrap left the cursor below the child margin.
  // Reinstall the child margin before restoring its cursor.
  const restoreOrigin = opts.originMode ? '\x1b[?6h' : '';
  return `\x1b7\x1b[?6l\x1b[r\x1b[${row};1H\x1b[2K\x1b[7m${text}\x1b[0m\x1b[${scrollTop};${scrollBottom}r${restoreOrigin}\x1b8`;
}

/** ----- Main session runner ----- */

/** Initial state handed off to the interactive session loop. */
interface DriveSessionState {
  connection: BrokerConnection;
  name: string;
  previousMode: InboundDeliveryMode | null;
  sessionRevision: string | null;
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
    // Stable per-attach id for the broker's single-resizer policy (#1247): all
    // of this session's resizes carry it so we own the shared PTY size while
    // driving, and we release it on detach.
    const resizeSessionId = randomUUID();
    // In-flight resize requests. Detach awaits these before releasing ownership
    // so a late-resolving SIGWINCH resize can't re-claim the PTY *after* the
    // release lands (single-resizer detach race, #1247).
    const outstandingResizes = new Set<Promise<unknown>>();
    const trackResize = (p: Promise<unknown>): void => {
      outstandingResizes.add(p);
      void p.finally(() => outstandingResizes.delete(p));
    };
    // Periodic ownership re-assert timer (see `ownershipReassertMs`).
    let reassertTimer: ReturnType<typeof setInterval> | null = null;
    let pending = state.initialPending;
    // This session's last-known inbound delivery mode and its broker revision.
    // The attach asserted `auto_inject`; `Ctrl+]` toggles it mid-session, and
    // the detach restore compare-and-sets against whatever this session last
    // wrote so an out-of-band change is never clobbered.
    let currentMode: InboundDeliveryMode = 'auto_inject';
    let currentRevision = state.sessionRevision;
    let terminalRows = pickInitialTerminalRows(state.initialLocalSize, undefined);
    let terminalCols = pickInitialTerminalCols(state.initialLocalSize, undefined);
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
    const isTtyOutput = state.initialLocalSize !== null;
    // Skip the status line entirely when stdout is not a TTY (e.g. piped to
    // `tee`) — a fabricated row-24 repaint would corrupt the captured log.
    let statusLineEnabled = canReserveStatusLine(state.initialLocalSize);
    // Subscribe-first: buffer live `worker_stream` chunks until the snapshot
    // is painted and reconciled against its per-worker offset.
    const sync = new StreamSyncBuffer();

    // Adaptive predictive echo masks round-trip latency on remote brokers.
    // Seeded with the snapshot (once painted) so its confirmed model matches
    // the screen.
    let initialAgentSize = reserveStatusLineRow(state.initialLocalSize);
    const scrollRegion = new TerminalScrollRegionTracker(initialAgentSize?.rows ?? 1);
    let observeRenderedOutput = (_chunk: string): void => {};
    const predictiveEcho =
      deps.createPredictiveEcho?.({
        cols: initialAgentSize?.cols ?? 0,
        rows: initialAgentSize?.rows ?? 0,
        write: (chunk) => {
          deps.writeChunk(chunk);
          observeRenderedOutput(chunk);
        },
        getInputSrtt: () => inputStream?.srttMs ?? null,
      }) ?? null;

    // Tee the snapshot's painted bytes so we can seed the predictive-echo
    // model with them — its cursor must match the real screen before we
    // optimistically echo, or predicted glyphs land at the wrong position.
    let snapshotBytes = '';
    // Guard the snapshot paint on `settled`: a Ctrl+C during the snapshot HTTP
    // fetch would otherwise paint the snapshot after teardown began (the render
    // runs inside the awaited `captureAndRenderSnapshot`, past the WS guard).
    const captureWrite = (chunk: string): void => {
      if (settled) return;
      deps.writeChunk(chunk);
      snapshotBytes += chunk;
    };

    const correctSetupResize = async (baseline: { rows: number; cols: number } | null): Promise<void> => {
      const latest = reserveStatusLineRow(deps.terminal.getSize());
      if (!latest || (latest.rows === baseline?.rows && latest.cols === baseline?.cols)) return;
      const correction = resizeWorker(connection, name, latest.rows, latest.cols, deps.fetch, {
        sessionId: resizeSessionId,
      });
      trackResize(correction);
      const result = await correction;
      if (!result.ok) {
        deps.log(`[drive] setup resize correction failed: ${result.message ?? 'unknown error'}`);
      }
    };

    const beginSubscribedLayout = (): void => {
      // Install this before the first resize/snapshot await so a local resize
      // during setup cannot be lost.
      unsubscribeResize ??= deps.terminal.onResize(resizeHandler);
      const currentSize = deps.terminal.getSize();
      terminalRows = pickInitialTerminalRows(currentSize, undefined);
      terminalCols = currentSize?.cols;
      statusLineEnabled = canReserveStatusLine(currentSize);
      initialAgentSize = reserveStatusLineRow(currentSize);
      if (initialAgentSize) {
        scrollRegion.setRows(initialAgentSize.rows);
        predictiveEcho?.onResize(initialAgentSize.cols, initialAgentSize.rows);
      }
      if (statusLineEnabled && initialAgentSize) {
        deps.writeChunk(renderChildScrollRegion(initialAgentSize.rows));
      }
    };

    // Boundary-held + coalesced status painter. Holds repaints while the agent
    // is mid escape-sequence (no splicing into a half-sent CSI), rate-limits
    // per-chunk repaints, and skips painting entirely on a non-TTY stdout.
    const statusController = new StatusLineController({
      render: () => {
        const region = scrollRegion.region;
        return renderStatusLine({
          name,
          mode: currentMode,
          pending,
          rows: terminalRows,
          cols: terminalCols,
          scrollTop: region.top,
          scrollBottom: region.bottom,
          originMode: scrollRegion.isOriginMode,
        });
      },
      write: deps.writeChunk,
      enabled: () => statusLineEnabled,
      coalesceMs: deps.statusRepaintCoalesceMs ?? 40,
    });
    const paintStatus = (): void => {
      statusController.request();
    };
    observeRenderedOutput = (chunk): void => {
      scrollRegion.push(chunk);
      statusController.observeOutput(chunk);
    };

    // Route server output through the predictive-echo engine (which owns
    // cursor save/restore) or straight to stdout. Feed every chunk to the
    // status controller for boundary tracking. Repaint after each completed
    // chunk because terminal autowrap can briefly cross a DECSTBM bottom
    // margin. The clipped label cannot autowrap itself, and the child PTY's
    // reserved row prevents cursor-addressed TUI frames from fighting it.
    const applyServerOutput = (chunk: string): void => {
      if (predictiveEcho) {
        void predictiveEcho.onServerOutput(chunk).then(
          () => {
            paintStatus();
          },
          () => {
            paintStatus();
          }
        );
      } else {
        deps.writeChunk(chunk);
        observeRenderedOutput(chunk);
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
      terminalCols = size.cols;
      statusLineEnabled = canReserveStatusLine(size);
      const agentSize = reserveStatusLineRow(size);
      if (!agentSize) return;
      scrollRegion.setRows(agentSize.rows);
      predictiveEcho?.onResize(agentSize.cols, agentSize.rows);
      trackResize(
        resizeWorker(connection, name, agentSize.rows, agentSize.cols, deps.fetch, {
          sessionId: resizeSessionId,
        }).then((res) => {
          if (!res.ok) {
            deps.log(`[drive] resize forward failed: ${res.message ?? 'unknown error'}`);
          } else if (res.applied === false) {
            deps.log('[drive] broker did not apply the reserved PTY size; using status repaint fallback');
          }
        })
      );
      // Repaint regardless of fetch outcome — the local terminal has
      // already moved, so the status line position needs to move with
      // it whether or not the broker accepted the resize.
      paintStatus();
    };

    // In-band delivery toggle (`Ctrl+]`). Flips the worker between
    // `auto_inject` (the session default — messages inject live while you
    // watch) and `manual_flush` (messages park so nothing splices into what
    // you are typing); flipping back drains the parked queue into the PTY.
    //
    // Guarded compare-and-set against this session's last-known revision: if
    // another session or CLI changed the mode out-of-band, the broker no-ops
    // and reports the current mode/revision, which we adopt (the next press
    // toggles from the adopted state). Pending-counter updates come from the
    // broker's `agent_pending_drained` event, not from this response, so the
    // count is never double-subtracted.
    // In-flight toggle request, if any. `finish()` awaits it before the
    // detach restore so a quick Ctrl+] → Ctrl+C can't restore against a
    // stale mode/revision while the toggle PUT is still changing broker
    // state — the session's `currentMode`/`currentRevision` are updated even
    // when teardown began mid-request, precisely so the restore CASes
    // against what this session actually last wrote.
    let deliveryToggleInFlight: Promise<void> | null = null;
    const toggleDeliveryMode = (): Promise<void> => {
      if (deliveryToggleInFlight) return deliveryToggleInFlight;
      if (settled) return Promise.resolve();
      const run = async (): Promise<void> => {
        try {
          const target: InboundDeliveryMode = currentMode === 'manual_flush' ? 'auto_inject' : 'manual_flush';
          // Always guard on the session's last-known mode; add the revision
          // when the broker reports one. A legacy broker without revisions
          // still gets mode-level CAS instead of an unconditional write.
          const result = await createBrokerClient(connection, deps.fetch).setInboundDeliveryMode(
            name,
            target,
            {
              expectedMode: currentMode,
              ...(currentRevision !== null ? { expectedRevision: currentRevision } : {}),
            }
          );
          currentMode = result.mode;
          if (result.revision !== null) {
            currentRevision = result.revision;
          }
          if (settled) return;
          if (!result.matched) {
            deps.log(`[drive] delivery mode was changed by another session; now ${result.mode}`);
          }
          paintStatus();
        } catch (err: unknown) {
          if (settled) return;
          const failure = mapBrokerSdkFailure(err);
          deps.log(`[drive] could not toggle delivery mode: ${failure.message ?? 'unknown error'}`);
        }
      };
      deliveryToggleInFlight = run().finally(() => {
        deliveryToggleInFlight = null;
      });
      return deliveryToggleInFlight;
    };

    // ---- input-stream liveness ----
    // A closed PTY input stream is a session-liveness event, not a
    // per-keystroke error. See `attach-input-recovery.ts` for why (#1419).
    //
    // Identity of the worker this session attached to, captured once at attach
    // and compared after any reopen. `null` means the broker could not tell us,
    // which is treated as "cannot verify" — never as "verified".
    let attachedWorkerIdentity: string | null = null;
    const inputRecovery = createInputStreamRecovery({
      label: 'drive',
      name,
      maxAttempts: deps.inputReopenMaxAttempts ?? INPUT_REOPEN_MAX_ATTEMPTS,
      baseDelayMs: deps.inputReopenBaseDelayMs ?? INPUT_REOPEN_BASE_DELAY_MS,
      log: (message) => deps.log(message),
      error: (message) => deps.error(message),
      isSettled: () => settled,
      getStream: () => inputStream,
      setStream: (stream) => {
        inputStream = stream;
      },
      openStream: () => deps.openInputStream(connection, name),
      onRollback: () => predictiveEcho?.rollback(),
      onExhausted: () => finish(1),
      verifyIdentity: async () => {
        // Fail closed in both directions: if we never learned who we attached
        // to, we cannot claim the replacement is the same process either.
        if (attachedWorkerIdentity === null) {
          return { ok: false, reason: 'worker identity was unavailable at attach' };
        }
        const current = await deps.getWorkerIdentity(connection, name);
        if (current === null) {
          return { ok: false, reason: 'worker identity could not be read after reconnect' };
        }
        if (current !== attachedWorkerIdentity) {
          return { ok: false, reason: `worker process changed (${attachedWorkerIdentity} → ${current})` };
        }
        return { ok: true };
      },
    });

    // ---- stdin handling ----
    let stdinReady = false;
    const stdinDataHandler = (chunk: Buffer): void => {
      // Raw mode starts before snapshot replay so terminal input reports cannot
      // echo. Until the predictive echo model is seeded, discard all input
      // except Ctrl+C: forwarding stale mouse/focus reports (or echoing user
      // input against an unseeded screen) would be worse than dropping it.
      if (!stdinReady) {
        if (chunk.includes(0x03)) finish(0);
        return;
      }
      const outcome = parser.feed(chunk);
      if (outcome.forward.length > 0) {
        const stream = inputStream;
        // A dead or missing stream is a liveness event, not a per-keystroke
        // error. Recovery announces it once and buffers decoded input behind a
        // strict same-worker identity gate.
        //
        // Skip only the *forwarding*; fall through to the action loop below.
        // Ctrl+C can share a chunk with ordinary bytes, and returning here
        // would swallow the detach — leaving the human unable to escape a
        // broken session, which is worse than the flood.
        if (!inputRecovery.isUsable(stream)) {
          const decoded = inputDecoder.write(outcome.forward);
          inputRecovery.recover('stream closed', decoded);
        } else {
          // Decode through the stateful UTF-8 decoder so a multi-byte character
          // split across stdin chunks is forwarded intact rather than as U+FFFD.
          // An incomplete trailing sequence decodes to '' and is held until the
          // next chunk completes it.
          const decoded = inputDecoder.write(outcome.forward);
          if (decoded.length > 0) {
            // Fire-and-forget; don't block the event loop on every keystroke.
            void stream.send(decoded).then(
              () => inputRecovery.noteSendSuccess(),
              (err: unknown) => {
                if (settled) return;
                // Classified, not assumed: backpressure leaves the stream
                // healthy and must not trigger a teardown.
                inputRecovery.handleSendFailure(err);
              }
            );
          }
          predictiveEcho?.onUserInput(outcome.forward);
        }
      }
      for (const action of outcome.actions) {
        switch (action) {
          case 'detach':
            finish(0);
            return;
          case 'toggle-delivery':
            void toggleDeliveryMode();
            break;
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
        // Heal the local terminal: the snapshot + live stream may have left it
        // in app-cursor / mouse / bracketed-paste / alt-screen mode. Gate on a
        // TTY stdout (same signal that gates the status line).
        resetLocalTerminalOnDetach(deps.writeChunk, isTtyOutput);
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
      try {
        if (reassertTimer) {
          clearInterval(reassertTimer);
          reassertTimer = null;
        }
      } catch {
        // best effort
      }
      rawModeWasSet = false;
    };

    const closeInputStream = (): void => {
      // Cancel any pending reopen backoff so a detach mid-recovery doesn't
      // leave a timer holding a reference to a torn-down session.
      inputRecovery.cancel();
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
      // Release resize ownership so the next client can size the shared PTY.
      // Await any in-flight resizes first: the release must be ordered *after*
      // the last SIGWINCH resize resolves, or that resize could re-claim the
      // PTY just after the release lands (detach race, #1247). `teardownStdin`
      // has already stopped the resize handler and re-assert timer above, so
      // no new resizes are enqueued past this point.
      const releasePromise = (async () => {
        try {
          if (outstandingResizes.size > 0) {
            await Promise.allSettled([...outstandingResizes]);
          }
          // Hand the reserved status row/column back in the same request, so
          // the agent's TUI is not left one row and column short.
          await releaseResizeOwnership(
            connection,
            name,
            resizeSessionId,
            deps.fetch,
            deps.terminal.getSize()
          );
        } catch {
          // Best-effort — the broker's idle-takeover net still frees ownership.
        }
      })();
      try {
        socket.close(1000, 'drive client exiting');
      } catch {
        // best effort
      }
      // Drop the writer's pending queue and unhook its drain listener so no
      // buffered chunk flushes to stdout after detach.
      deps.disposeWriter?.();
      // Best-effort restore: re-read the mode and only revert if it's still
      // what this session set, so an explicit pre-attach `hold` is put back and
      // a change another session made is never clobbered.
      //
      // Await the release alongside the restore before resolving: `resolve`
      // typically ends the process, which aborts any still-pending fetch. The
      // release awaits `outstandingResizes` first, so it would otherwise lose
      // the race to the restore and be aborted, defeating the detach-race fix.
      //
      // Bound the wait: both are best-effort HTTP round-trips that can stall if
      // the broker is down, and terminal exit must not hang on them. Resolve
      // once they settle or after DETACH_CLEANUP_DEADLINE_MS, whichever first.
      const cleanup = Promise.allSettled([
        releasePromise,
        // Compare-and-set against this session's LAST write (`Ctrl+]` may have
        // toggled the mode and bumped the revision since the attach flip) so
        // the restore still matches after an in-session toggle but never
        // clobbers an out-of-band change. Await any in-flight toggle first —
        // a quick Ctrl+] → Ctrl+C must not restore against the pre-toggle
        // mode/revision while the toggle PUT is still landing — and read
        // `currentMode`/`currentRevision` only after it settles.
        (async () => {
          if (deliveryToggleInFlight) {
            try {
              await deliveryToggleInFlight;
            } catch {
              // best effort — restore proceeds with the latest known state
            }
          }
          await restoreInboundDeliveryModeOnDetach(
            connection,
            name,
            previousMode,
            currentMode,
            currentRevision,
            'drive',
            deps
          );
        })(),
      ]);
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((res) => {
        deadlineTimer = setTimeout(res, DETACH_CLEANUP_DEADLINE_MS);
      });
      void Promise.race([cleanup, deadline]).finally(() => {
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        resolve(code);
      });
    };

    const socket = deps.createWebSocket(wsUrl, headers);

    const openInputStreamAndSetRawMode = async (): Promise<void> => {
      try {
        inputStream = deps.openInputStream(connection, name);
        await inputStream.waitUntilOpen();
        if (settled) {
          closeInputStream();
          return;
        }
        // Baseline for the reopen identity gate. Best-effort: a broker that
        // won't tell us leaves this null, which makes any later reopen refuse
        // rather than guess. Not fatal here — the initial attach is the seat
        // the human asked for.
        attachedWorkerIdentity = await deps.getWorkerIdentity(connection, name);
        if (settled) {
          closeInputStream();
          return;
        }
        // Register the temporary input handler before raw mode. Ctrl+C is an
        // ordinary byte in raw mode, so this keeps detach available while a
        // snapshot fetch or initial resize is still pending.
        deps.stdin.resume();
        deps.stdin.on('data', stdinDataHandler);
        if (typeof deps.stdin.setRawMode === 'function' && deps.stdin.isTTY !== false && !deps.stdin.isRaw) {
          deps.stdin.setRawMode(true);
          rawModeWasSet = true;
        }
      } catch (err: unknown) {
        if (settled) return;
        const message = describeError(err);
        deps.error(`[drive] could not open PTY input stream: ${message}`);
        finish(1);
      }
    };

    const takeStdin = (): void => {
      try {
        if (settled) return;
        stdinReady = true;
        // Subscribe to local-terminal resize events at the same point
        // we take over stdin so the lifecycles match — both go away in
        // `teardownStdin` on any exit path.
        // Start the periodic ownership re-assert so an idle-but-live session
        // keeps the single-resizer lease past the broker's stale window. The
        // broker no-ops a same-size re-assert (no SIGWINCH/repaint).
        const reassertMs = deps.ownershipReassertMs ?? 60_000;
        if (reassertMs > 0) {
          reassertTimer = setInterval(() => {
            const size = deps.terminal.getSize() ?? state.initialLocalSize;
            const agentSize = reserveStatusLineRow(size);
            if (!agentSize) return;
            trackResize(
              resizeWorker(connection, name, agentSize.rows, agentSize.cols, deps.fetch, {
                sessionId: resizeSessionId,
              }).then((res) => {
                if (!res.ok) {
                  deps.log(`[drive] resize ownership re-assert failed: ${res.message ?? 'unknown error'}`);
                }
              })
            );
          }, reassertMs);
          // Don't let the keep-alive timer hold the process open on its own.
          reassertTimer.unref?.();
        }
      } catch (err: unknown) {
        if (settled) return;
        const message = describeError(err);
        deps.error(`[drive] could not take terminal input: ${message}`);
        finish(1);
      }
    };

    // Runs once the event WS is subscribed: first reserve the local bottom row
    // and take over stdin before replaying the snapshot. A source TUI can
    // enable mouse/focus/alternate-scroll reporting in that replay, and
    // cooked-mode stdin would echo those reports as visible escape text.
    // The WS is already buffering, so the resize repaint is reconciled against
    // the snapshot without a dead zone.
    const onSubscribed = async (): Promise<void> => {
      beginSubscribedLayout();
      await openInputStreamAndSetRawMode();
      if (settled) return;
      const initialResize = syncInitialPtySize(connection, name, initialAgentSize, 'drive', deps, {
        sessionId: resizeSessionId,
      });
      trackResize(initialResize);
      await initialResize;
      if (settled) return;
      await correctSetupResize(initialAgentSize);
      const snapshot = await deps.captureAndRenderSnapshot(connection, name, {
        fetch: deps.fetch,
        writeChunk: captureWrite,
        fleetHint: deps.fleetHint,
      });
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
      if (predictiveEcho) {
        try {
          await predictiveEcho.seed(snapshotBytes);
        } catch (err: unknown) {
          const message = describeError(err);
          deps.log(`[drive] could not seed predictive echo: ${message}`);
          finish(1);
          return;
        }
        if (settled) return;
      }
      const currentLocalSize = deps.terminal.getSize();
      terminalRows = pickInitialTerminalRows(currentLocalSize, snapshot.rows);
      terminalCols = pickInitialTerminalCols(currentLocalSize, snapshot.cols);
      // Track the snapshot bytes for boundary state before the first repaint.
      scrollRegion.push(snapshotBytes);
      statusController.observeOutput(snapshotBytes);
      paintStatus();
      // Reconcile buffered chunks. On `ok`, drop what the snapshot already
      // reflects (by offset); with no offset this drops the pre-snapshot
      // buffer (snapshot-authoritative, matching the legacy behaviour). On a
      // transient snapshot failure nothing was painted, so apply everything.
      const pendingChunks = snapshot.status === 'ok' ? sync.reconcile(snapshot.offset) : sync.flushAll();
      for (const chunk of pendingChunks) applyServerOutput(chunk);
      // Input forwarding starts only after predictive echo has been seeded by
      // the snapshot. Raw mode was already enabled above, so terminal reports
      // could not echo during the setup window.
      takeStdin();
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
          // Subtract the drained count when the broker reports one: a partial
          // drain (a failed injection stops the flush mid-queue) leaves the
          // remainder parked, and zeroing the counter would hide it. A legacy
          // frame without a count still zeroes.
          pending = typeof event.count === 'number' ? Math.max(0, pending - event.count) : 0;
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
  options: BrokerConnectionOptions,
  deps: DriveDependencies
): Promise<number> {
  const target = prepareAttachTarget(agentName, options, deps);
  if (!target) return 1;
  const { name, connection } = target;

  const flipResult = await switchInboundDeliveryModeOrAbort(
    connection,
    name,
    'auto_inject',
    `switch '${name}' to auto_inject mode`,
    deps
  );
  if (!flipResult) return 1;
  const { previousMode, sessionRevision } = flipResult;

  // The mode is now asserted to `auto_inject`, but the terminal is still cooked
  // and we have several awaited HTTP round-trips (pending, cutoff, snapshot,
  // input stream) before the session loop installs its signal handlers. Ctrl+C
  // in that window would otherwise kill the process with the worker stranded in
  // this session's mode, silently discarding an explicit `hold` the operator had
  // set before attaching. Register early restore-and-exit handlers immediately;
  // the loop disposes them once its own handlers are ready (no double restore —
  // see `disposeEarlySignals`).
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
    await restoreInboundDeliveryModeOnDetach(
      connection,
      name,
      previousMode,
      'auto_inject',
      sessionRevision,
      'drive',
      deps
    );
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
      sessionRevision,
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
  options: BrokerConnectionOptions,
  overrides: Partial<DriveDependencies> = {}
): Promise<number> {
  return runDriveSession(name, options, withDefaults(overrides));
}
