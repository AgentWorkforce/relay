/**
 * `agent-relay drive <name>` — interactive read-write take-over client.
 *
 * Attaches to a running agent, flips it into `manual_flush` inbound delivery mode so the
 * broker parks new relay messages in a per-worker queue, and forwards your
 * keystrokes to the worker's PTY. You can drain the queue on demand with
 * `Ctrl+G` and detach with `Ctrl+B D` (or `Ctrl+C` as a safety alias).
 * Detaching restores the worker's previous inbound delivery mode and leaves the
 * agent running under the broker — `drive` never kills the worker.
 *
 * Sequence of operations on attach:
 *
 *   1. Discover broker connection (CLI flag → env → connection.json).
 *   2. `GET  /api/spawned/{name}/delivery-mode`  → remember the previous mode.
 *   3. `PUT  /api/spawned/{name}/delivery-mode`  → switch to `manual_flush`.
 *   4. `captureAndRenderSnapshot`       → repaint the agent's current screen.
 *   5. `GET  /api/spawned/{name}/pending` → seed the status-line counter.
 *   6. Open `/ws`, subscribe to events for this worker.
 *   7. Switch local stdin to raw mode; forward bytes to `POST /api/input/{name}`.
 *
 * On detach (clean or abnormal), best-effort `PUT .../delivery-mode` restores the
 * previous mode so the queue doesn't fill up indefinitely.
 */

import { Buffer } from 'node:buffer';

import type { InboundDeliveryMode } from '@agent-relay/sdk';
import { Command } from 'commander';
import WebSocket from 'ws';

import {
  captureAndRenderSnapshot,
  type AttachSnapshotConnection,
  type AttachSnapshotDeps,
} from '../lib/attach.js';
import {
  defaultStateDir,
  readConnectionFileFromDisk,
  resolveBrokerConnection,
  toWsUrl,
  type BrokerConnection,
} from '../lib/broker-connection.js';
import { defaultExit, runSignalHandler } from '../lib/exit.js';
import { createBrokerClient, mapBrokerSdkFailure } from '../lib/sdk-client.js';

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
  (signal: NodeJS.Signals, handler: () => void | Promise<void>): void;
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
  /** HTTP client used for mode/pending/flush/input calls. Defaults to global `fetch`. */
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
}

function withDefaults(overrides: Partial<DriveDependencies> = {}): DriveDependencies {
  return {
    readConnectionFile: readConnectionFileFromDisk,
    getDefaultStateDir: defaultStateDir,
    env: process.env,
    createWebSocket: (url, headers) => new WebSocket(url, { headers }) as DriveWebSocket,
    writeChunk: (chunk) => {
      process.stdout.write(chunk);
    },
    onSignal: (signal, handler) => {
      process.on(signal, () => runSignalHandler(handler));
    },
    log: (...args: unknown[]) => console.error(...args),
    error: (...args: unknown[]) => console.error(...args),
    exit: defaultExit,
    fetch: (input, init) => fetch(input, init),
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

/** `GET /api/spawned/{name}/pending` → count, or `0` on failure (best-effort). */
export async function getPendingCount(
  connection: BrokerConnection,
  name: string,
  fetchFn: typeof globalThis.fetch
): Promise<number> {
  try {
    return (await createBrokerClient(connection, fetchFn).getPending(name)).length;
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
  | { kind: 'worker_stream'; chunk: string }
  | { kind: 'delivery_queued' }
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
    return { kind: 'worker_stream', chunk };
  }
  if (parsed.kind === 'delivery_queued') {
    return { kind: 'delivery_queued' };
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

export type KeybindAction = 'flush' | 'detach' | 'toggle_help';

/**
 * Stateful parser that recognises the `Ctrl+B <key>` two-byte prefix
 * sequence, plus the single-byte safety keybinds (`Ctrl+G` flush,
 * `Ctrl+C` detach).
 *
 * The parser is intentionally tiny — no readline, no keypress — because
 * the keybinds are all ASCII control characters, and pulling in a
 * keypress parser would just add a dependency for no real benefit.
 *
 * Semantics:
 *   - `Ctrl+G` (0x07)    → emit `flush`, never forwarded.
 *   - `Ctrl+C` (0x03)    → emit `detach`, never forwarded.
 *   - `Ctrl+B` (0x02)    → swallow, arm the prefix state.
 *     Next byte (within the same chunk OR a subsequent chunk):
 *       - 'd' / 'D' / 0x04 (Ctrl+D) → emit `detach`.
 *       - '?'                       → emit `toggle_help`.
 *       - anything else             → forward the original `Ctrl+B` byte
 *                                     followed by the new byte, so the
 *                                     agent isn't deprived if the user
 *                                     hit Ctrl+B by accident.
 *
 * Multiple keybinds in one chunk are handled in order; bytes between
 * them are forwarded normally.
 */
export class KeybindParser {
  private pendingPrefix = false;

  /** Process one chunk; returns bytes to forward + actions to take. */
  feed(chunk: Buffer): KeybindOutcome {
    const forward: number[] = [];
    const actions: KeybindAction[] = [];

    for (const byte of chunk) {
      if (this.pendingPrefix) {
        this.pendingPrefix = false;
        if (byte === 0x44 /* 'D' */ || byte === 0x64 /* 'd' */ || byte === 0x04 /* Ctrl+D */) {
          actions.push('detach');
          continue;
        }
        if (byte === 0x3f /* '?' */) {
          actions.push('toggle_help');
          continue;
        }
        // Not a recognised prefix command — forward Ctrl+B + the byte
        // so the agent isn't deprived (some TUI apps use Ctrl+B for
        // their own bindings).
        forward.push(0x02);
        forward.push(byte);
        continue;
      }
      if (byte === 0x07 /* Ctrl+G */) {
        actions.push('flush');
        continue;
      }
      if (byte === 0x03 /* Ctrl+C */) {
        actions.push('detach');
        continue;
      }
      if (byte === 0x02 /* Ctrl+B */) {
        this.pendingPrefix = true;
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
  reset(): void {
    this.pendingPrefix = false;
  }
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
  showHelp: boolean;
  /** Terminal rows — defaults to 24 if unknown. The status line lands on row N. */
  rows?: number;
}): string {
  const row = Math.max(opts.rows ?? 24, 1);
  const help = opts.showHelp
    ? ' | Ctrl+G flush | Ctrl+B D detach | Ctrl+B ? hide help'
    : ' | Ctrl+G flush | Ctrl+B D detach';
  const text = `[drive ${opts.name} | delivery=${opts.mode} | pending=${opts.pending}${help}]`;
  // ESC 7 = save cursor; ESC[<row>;1H = move to bottom row; ESC[2K = clear line;
  // ESC[7m = reverse video; ESC[0m = reset; ESC 8 = restore cursor.
  return `\x1b7\x1b[${row};1H\x1b[2K\x1b[7m${text}\x1b[0m\x1b8`;
}

/** ----- Main session runner ----- */

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
  // Normalize once so every downstream broker call, WS-event match,
  // status-line label, and error message uses the same trimmed value.
  // Without this a stray space in the raw input turns into a silent
  // 404 (the broker stores names verbatim).
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

  // Remember the worker's prior mode so we can restore it on detach.
  // `null` means we couldn't read it (broker hiccup or worker missing);
  // we default the restore target to `auto_inject` in that case so the
  // queue doesn't keep growing.
  const previousMode = await getInboundDeliveryMode(connection, name, deps.fetch);

  // Flip the worker into manual_flush mode. If this fails outright, abort
  // before doing anything else — we don't want to redraw the screen
  // and then silently keep auto-injecting into the agent.
  const flip = await setInboundDeliveryMode(connection, name, 'manual_flush', deps.fetch);
  if (!flip.ok) {
    if (flip.status === 404) {
      deps.error(`Error: no agent named '${name}'`);
    } else {
      deps.error(
        `Error: could not switch '${name}' to manual_flush mode: ${flip.message ?? 'unknown error'}`
      );
    }
    return 1;
  }

  // Render the agent's current visible screen before the live stream
  // begins. Same error semantics as `view`: hard errors abort, transient
  // errors warn and proceed.
  const snapshot = await deps.captureAndRenderSnapshot(
    { url: connection.url, apiKey: connection.apiKey },
    name,
    { fetch: deps.fetch, writeChunk: deps.writeChunk }
  );
  switch (snapshot.status) {
    case 'ok':
      break;
    case 'not_found':
      // Best-effort restore — we did flip the mode above.
      await setInboundDeliveryMode(connection, name, previousMode ?? 'auto_inject', deps.fetch);
      deps.error(`Error: ${snapshot.message ?? `no agent named '${name}'`}`);
      return 1;
    case 'no_pty':
      await setInboundDeliveryMode(connection, name, previousMode ?? 'auto_inject', deps.fetch);
      deps.error(`Error: ${snapshot.message ?? `agent '${name}' has no PTY to drive`}`);
      return 1;
    case 'unavailable':
    case 'transport_error':
      deps.log(
        `[drive] could not capture initial screen (${snapshot.message ?? snapshot.status}); streaming live output only`
      );
      break;
  }

  // Seed the pending counter so the status line is correct from the
  // first paint.
  let pending = await getPendingCount(connection, name, deps.fetch);
  let showHelp = false;

  // Status-line row tracks the LOCAL terminal's bottom row, not the
  // agent's PTY rows from the snapshot — those can differ before we
  // forward our size to the broker, and the status line needs to land
  // where the human is looking. Falls back to the snapshot rows, then
  // the renderer's own 24-row default.
  const initialLocalSize = deps.terminal.getSize();
  let terminalRows: number | undefined =
    initialLocalSize?.rows ??
    (typeof snapshot.rows === 'number' && snapshot.rows > 0 ? snapshot.rows : undefined);

  const paintStatus = (): void => {
    deps.writeChunk(
      renderStatusLine({
        name,
        mode: 'manual_flush',
        pending,
        showHelp,
        rows: terminalRows,
      })
    );
  };
  paintStatus();

  // Sync the agent's PTY to the driver's local terminal size. tmux /
  // screen / ssh all do this — without it, a TUI in the agent renders
  // into whatever 24×80 box the PTY was spawned with, ignoring the
  // human's actual viewport. Best-effort: a failure here is annoying
  // but not fatal (the human can still type, output just renders into
  // the old size). Skipped entirely when stdout isn't a TTY.
  if (initialLocalSize) {
    const initialResize = await resizeWorker(
      connection,
      name,
      initialLocalSize.rows,
      initialLocalSize.cols,
      deps.fetch
    );
    if (!initialResize.ok) {
      deps.log(
        `[drive] could not sync agent PTY size to local terminal (${initialResize.message ?? 'unknown'}); continuing`
      );
    }
  }

  const wsUrl = toWsUrl(connection.url);
  const headers: Record<string, string> = {};
  if (connection.apiKey) {
    headers['X-API-Key'] = connection.apiKey;
  }

  return new Promise<number>((resolve) => {
    let settled = false;
    let rawModeWasSet = false;
    let unsubscribeResize: (() => void) | null = null;
    const parser = new KeybindParser();

    // Local-terminal resize handler. Forwards to the broker and
    // repaints the status line at the new bottom-row index. Registered
    // on `socket.on('open')` (same point we take over stdin) so a
    // failed connection doesn't leave a dangling listener; unregistered
    // in `teardownStdin` so detach is clean.
    const resizeHandler = (): void => {
      const size = deps.terminal.getSize();
      if (!size) return;
      terminalRows = size.rows;
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
        // Fire-and-forget; surface errors via log but don't block the
        // event loop on every keystroke.
        // UTF-8, not latin1 — the broker deserializes /api/input's
        // `data` as a Rust `String` and forwards the bytes verbatim.
        // 'binary' would map bytes ≥ 0x80 to Latin-1 code points,
        // which then get UTF-8 re-encoded on the wire, doubling
        // multi-byte characters (e.g. `é` → `Ã©` on the agent's side).
        void sendInput(connection, name, outcome.forward.toString('utf-8'), deps.fetch).then((res) => {
          if (!res.ok) {
            deps.log(`[drive] input send failed: ${res.message ?? 'unknown error'}`);
          }
        });
      }
      for (const action of outcome.actions) {
        switch (action) {
          case 'flush':
            void flushPending(connection, name, deps.fetch).then((res) => {
              if (!res.ok) {
                deps.log(`[drive] flush failed: ${res.message ?? 'unknown error'}`);
              }
            });
            break;
          case 'detach':
            finish(0);
            return;
          case 'toggle_help':
            showHelp = !showHelp;
            paintStatus();
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

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      teardownStdin();
      try {
        socket.close(1000, 'drive client exiting');
      } catch {
        // best effort
      }
      // Best-effort: restore the worker's previous mode so we don't
      // leave it stuck in manual_flush and silently piling up queued messages.
      void setInboundDeliveryMode(connection, name, previousMode ?? 'auto_inject', deps.fetch).finally(() => {
        resolve(code);
      });
    };

    const socket = deps.createWebSocket(wsUrl, headers);

    deps.onSignal('SIGINT', () => finish(0));
    deps.onSignal('SIGTERM', () => finish(0));

    socket.on('open', () => {
      deps.log(`[drive] driving ${name} via ${connection.url} (Ctrl+B D to detach)`);
      // Now that the WS is up, take over stdin. We do this on `open`
      // rather than synchronously so a failed connection doesn't leave
      // the user's terminal in raw mode with nothing to type into.
      try {
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
        const message = err instanceof Error ? err.message : String(err);
        deps.error(`[drive] could not enable raw input mode: ${message}`);
        finish(1);
      }
    });

    socket.on('message', (data) => {
      const text =
        typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf-8') : String(data);
      const event = classifyWsEvent(text, name);
      switch (event.kind) {
        case 'worker_stream':
          deps.writeChunk(event.chunk);
          // Repaint the status line so the worker's writes don't
          // obscure it. Cheap — it's just an ANSI escape sequence.
          paintStatus();
          break;
        case 'delivery_queued':
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

/** Register `agent-relay drive <name>` on the supplied commander program. */
export function registerDriveCommands(program: Command, overrides: Partial<DriveDependencies> = {}): void {
  const deps = withDefaults(overrides);

  program
    .command('drive')
    .description(
      'Take interactive control of a running agent: queue inbound relay messages, type into the worker, flush on demand, detach when done'
    )
    .argument('<name>', 'Agent name to drive')
    .option('--broker-url <url>', 'Broker base URL (overrides RELAY_BROKER_URL and connection.json)')
    .option('--api-key <key>', 'Broker API key (overrides RELAY_BROKER_API_KEY and connection.json)')
    .option('--state-dir <dir>', 'Directory containing connection.json (default: .agent-relay/)')
    .action(async (name: string, options: { brokerUrl?: string; apiKey?: string; stateDir?: string }) => {
      const code = await runDriveSession(name, options, deps);
      if (code !== 0) {
        deps.exit(code);
      }
    });
}
