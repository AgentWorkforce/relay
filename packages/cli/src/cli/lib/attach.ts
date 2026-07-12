/**
 * Shared helpers for attach-style CLI commands (`view`, `drive`,
 * `passthrough`).
 *
 * - `captureAndRenderSnapshot` renders the agent's current visible screen
 *   so the user doesn't attach to a quiet agent and stare at a blank
 *   terminal until the next output.
 * - `prepareAttachTarget` / `pickInitialTerminalRows` / `syncInitialPtySize`
 *   / `switchInboundDeliveryModeOrAbort` / `captureInitialSnapshot` are
 *   the take-over prep steps that `drive` and `passthrough` both run on
 *   attach; centralised here so the two verbs stay in lockstep.
 */

import type { InboundDeliveryMode } from '@agent-relay/harness-driver';

import {
  resolveBrokerConnection,
  type BrokerConnection,
  type BrokerConnectionDeps,
  type BrokerConnectionOptions,
} from './broker-connection.js';
import { createBrokerClient, mapBrokerSdkFailure } from './attach-broker.js';

/** Connection metadata used to call the broker's snapshot endpoint. */
export interface AttachSnapshotConnection {
  /** Broker base URL (no trailing slash). */
  url: string;
  /** Optional API key — added as an `X-API-Key` header if present. */
  apiKey?: string;
}

/** Dependencies for `captureAndRenderSnapshot` — injected so tests don't hit
 *  the network. */
export interface AttachSnapshotDeps {
  /** Native `fetch` by default; swapped out by tests. */
  fetch: typeof globalThis.fetch;
  /** Where the ANSI bytes get written. Typically `process.stdout.write`. */
  writeChunk: (chunk: string) => void;
}

/** Outcome of a snapshot capture. Callers decide whether to bail or continue
 *  on each variant — `view` aborts on `not_found` / `no_pty`, warns and
 *  continues on `unavailable` / `transport_error`. */
export interface AttachSnapshotResult {
  status: 'ok' | 'not_found' | 'no_pty' | 'unavailable' | 'transport_error';
  /** Grid dimensions as reported by the broker, if the call succeeded. */
  rows?: number;
  cols?: number;
  /** Cursor position `[row, col]`, 1-indexed, if the call succeeded. */
  cursor?: [number, number];
  /**
   * Cumulative per-worker byte offset the grid had consumed when the
   * snapshot was captured. Used to reconcile the snapshot against buffered
   * `worker_stream` chunks (drop `offset <= this`, apply the rest).
   * `undefined` on brokers that predate stream-offset support.
   */
  offset?: number;
  /** Human-readable detail for error variants. */
  message?: string;
}

/**
 * Fetch a worker's current visible screen as ANSI reproduction bytes and
 * write them to the caller's output.
 *
 * The attach clients open and subscribe to the WebSocket event stream
 * *first*, buffer incoming `worker_stream` chunks, then call this to paint
 * the snapshot, and finally reconcile the buffer against the snapshot's
 * `offset` (see {@link StreamSyncBuffer}). That ordering closes the gap
 * between the snapshot and the live stream: no output emitted around attach
 * time is lost, and the per-worker byte offset lets the client drop exactly
 * the chunks the snapshot already reflects so nothing is double-applied.
 *
 * On brokers that don't report an `offset`, the clients fall back to
 * snapshot-authoritative behaviour (paint the snapshot, discard chunks that
 * arrived before it), which trades a tiny gap for no duplication — the same
 * bias the pre-offset code had.
 *
 * @returns A status describing the outcome. `ok` means the screen was
 * rendered; other variants carry a message the caller can surface. `offset`
 * is populated on `ok` when the broker reports one.
 */
export async function captureAndRenderSnapshot(
  connection: AttachSnapshotConnection,
  agentName: string,
  deps: AttachSnapshotDeps
): Promise<AttachSnapshotResult> {
  let body: unknown;
  try {
    body = await createBrokerClient(connection, deps.fetch).snapshot(agentName, 'ansi');
  } catch (err: unknown) {
    const failure = mapBrokerSdkFailure(err);
    if (failure.status === 404) {
      return { status: 'not_found', message: `no agent named '${agentName}'` };
    }
    if (failure.status === 409) {
      return {
        status: 'no_pty',
        message: `agent '${agentName}' has no PTY (headless worker — nothing to view)`,
      };
    }
    if (failure.status === 0 || failure.status === 200) {
      return { status: 'transport_error', message: failure.message };
    }
    return { status: 'unavailable', message: `snapshot returned HTTP ${failure.status}` };
  }

  if (typeof body !== 'object' || body === null) {
    return { status: 'transport_error', message: 'snapshot response was not an object' };
  }
  const obj = body as Record<string, unknown>;
  const screen = obj.screen;
  if (typeof screen !== 'string') {
    return { status: 'transport_error', message: "snapshot response missing 'screen' field" };
  }

  // Snapshot bytes are mostly ASCII (escape sequences) plus the cell
  // characters which are valid Unicode codepoints (alacritty stores
  // chars, not bytes). UTF-8 round-trips cleanly.
  const decoded = Buffer.from(screen, 'base64').toString('utf-8');
  deps.writeChunk(decoded);

  const rows = typeof obj.rows === 'number' ? obj.rows : undefined;
  const cols = typeof obj.cols === 'number' ? obj.cols : undefined;
  const offset = typeof obj.offset === 'number' ? obj.offset : undefined;
  const cursorRaw = Array.isArray(obj.cursor) ? obj.cursor : undefined;
  const cursor: [number, number] | undefined =
    cursorRaw &&
    cursorRaw.length === 2 &&
    typeof cursorRaw[0] === 'number' &&
    typeof cursorRaw[1] === 'number'
      ? [cursorRaw[0], cursorRaw[1]]
      : undefined;

  return { status: 'ok', rows, cols, cursor, offset };
}

/**
 * Reconciles a visible-screen snapshot with the live `worker_stream` byte
 * stream so an attaching client neither loses nor double-applies output
 * around attach time.
 *
 * Usage (subscribe-first):
 *
 *   1. Open + subscribe the event WS. Feed every `worker_stream` chunk to
 *      {@link push} as it arrives, applying the chunk only when `push`
 *      returns `true`.
 *   2. Fetch and paint the snapshot.
 *   3. Call {@link reconcile} with the snapshot's `offset`. Apply the
 *      returned chunks in order. From then on, `push` returns `true` for
 *      every chunk (live pass-through).
 *
 * Correlation rule: the snapshot reflects every byte with offset `<=`
 * `snapshotOffset`. A buffered chunk carries the cumulative byte offset at
 * its *end*; if that end offset is `<=` the snapshot offset the chunk is
 * already on screen and is dropped, otherwise it is applied.
 */
export class StreamSyncBuffer {
  private buffering = true;
  private readonly buffered: Array<{ chunk: string; offset?: number }> = [];

  /**
   * Record a live `worker_stream` chunk. Returns `true` when the caller
   * should apply the chunk immediately (post-reconcile live mode), `false`
   * while still buffering (the chunk is held for {@link reconcile}).
   */
  push(chunk: string, offset: number | undefined): boolean {
    if (!this.buffering) return true;
    this.buffered.push({ chunk, offset });
    return false;
  }

  /**
   * Reconcile the buffered chunks against the painted snapshot's offset and
   * return the chunks to apply, in order. Switches to live pass-through.
   *
   * When `snapshotOffset` is `undefined` (broker without offset support) all
   * buffered chunks are discarded: they arrived before the snapshot was
   * painted, so dropping them matches the snapshot-authoritative fallback
   * and avoids double-painting what the snapshot already shows.
   */
  reconcile(snapshotOffset: number | undefined): string[] {
    const out: string[] = [];
    if (snapshotOffset !== undefined) {
      for (const item of this.buffered) {
        // Drop chunks the snapshot already reflects; apply the rest. A chunk
        // with no offset (mixed/legacy frame) is applied rather than risk
        // silently dropping live output.
        if (item.offset !== undefined && item.offset <= snapshotOffset) continue;
        out.push(item.chunk);
      }
    }
    this.buffered.length = 0;
    this.buffering = false;
    return out;
  }

  /**
   * Return every buffered chunk unchanged and switch to live pass-through.
   * Used when no snapshot was painted (transient snapshot failure): there is
   * nothing to reconcile against, so applying everything preserves output
   * rather than dropping the buffered live stream.
   */
  flushAll(): string[] {
    const out = this.buffered.map((item) => item.chunk);
    this.buffered.length = 0;
    this.buffering = false;
    return out;
  }

  /** True while chunks are still being buffered (before reconcile). */
  get isBuffering(): boolean {
    return this.buffering;
  }
}

/**
 * Conservative terminal-reset control sequence emitted on detach (see #1247).
 *
 * A drive/view/passthrough session paints the agent's snapshot (which now
 * re-emits terminal modes) and then relays the live stream, either of which can
 * leave the *local* terminal in application-cursor-keys, mouse-reporting,
 * bracketed-paste, or alt-screen mode. Without a reset on detach the user is
 * dropped back to their shell with arrows emitting escape codes, mouse clicks
 * spewing coordinates, or a blank alt screen.
 *
 * The sequence is intentionally direction-explicit and idempotent: leave the
 * alternate screen, show the cursor, restore numeric keypad + application
 * cursor keys off, autowrap on, origin off, disable every mouse-reporting mode
 * and bracketed paste, reset the scroll region to full screen, and clear
 * pending SGR. Only written when stdout is a TTY, consistent with how the
 * sessions gate raw-mode restore and the status line.
 */
export const LOCAL_TERMINAL_RESET_SEQUENCE =
  '\x1b[?1049l' + // leave alternate screen buffer
  '\x1b[?25h' + // show cursor (DECTCEM)
  '\x1b[?1l' + // application cursor keys off (DECCKM)
  '\x1b[?7h' + // autowrap on (DECAWM)
  '\x1b[?6l' + // origin mode off (DECOM)
  '\x1b[?1000l' + // mouse click reporting off
  '\x1b[?1002l' + // mouse button-event (drag) reporting off
  '\x1b[?1003l' + // mouse any-event (motion) reporting off
  '\x1b[?1004l' + // focus in/out reporting off
  '\x1b[?1005l' + // UTF-8 mouse coordinates off
  '\x1b[?1006l' + // SGR mouse coordinates off
  '\x1b[?1007l' + // alternate scroll off
  '\x1b[?2004l' + // bracketed paste off
  '\x1b>' + // keypad normal (DECKPNM)
  '\x1b[r' + // reset scroll region to full screen (DECSTBM)
  '\x1b[0m'; // reset SGR

/**
 * Emit {@link LOCAL_TERMINAL_RESET_SEQUENCE} to the local terminal on detach,
 * but only when stdout is a TTY. A no-op for piped/redirected stdout so the
 * reset never corrupts a captured log.
 */
export function resetLocalTerminalOnDetach(
  write: (chunk: string) => void,
  isTty: boolean
): void {
  if (!isTty) return;
  write(LOCAL_TERMINAL_RESET_SEQUENCE);
}

/** ----- Interactive attach prep helpers ----- */

/** Validated attach target: trimmed agent name + resolved broker connection. */
export interface AttachTarget {
  name: string;
  connection: BrokerConnection;
}

/** Dependencies for `prepareAttachTarget` — connection lookup + error sink. */
export interface PrepareAttachTargetDeps extends BrokerConnectionDeps {
  error: (...args: unknown[]) => void;
}

/**
 * Trim the agent name and resolve the broker connection (flag → env →
 * `connection.json`). Writes the appropriate error and returns `null` on
 * either failure so every interactive attach verb rejects empty or
 * unreachable targets consistently.
 */
export function prepareAttachTarget(
  agentName: string,
  options: BrokerConnectionOptions,
  deps: PrepareAttachTargetDeps
): AttachTarget | null {
  const name = agentName.trim();
  if (!name) {
    deps.error('Error: agent name is required');
    return null;
  }
  const connection = resolveBrokerConnection(options, deps);
  if (!connection) {
    deps.error(
      'Error: could not locate broker connection. Pass --broker-url, set RELAY_BROKER_URL, ' +
        'or run from a directory containing .agentworkforce/relay/connection.json.'
    );
    return null;
  }
  return { name, connection };
}

/**
 * Pick the status-line row. Prefers the LOCAL terminal's height (the
 * status line must land where the human is looking) and falls back to
 * the snapshot's PTY rows, then `undefined` so the renderer applies its
 * own default.
 */
export function pickInitialTerminalRows(
  localSize: { rows: number; cols: number } | null,
  snapshotRows: number | undefined
): number | undefined {
  if (localSize) return localSize.rows;
  if (typeof snapshotRows === 'number' && snapshotRows > 0) return snapshotRows;
  return undefined;
}

/**
 * Sync the agent's PTY to the driver's local terminal size. tmux /
 * screen / ssh all do this — without it a TUI in the agent renders into
 * the size the PTY was spawned with, ignoring the human's viewport.
 * Best-effort: a failure is annoying but not fatal. Skipped entirely
 * when `localSize` is `null` (stdout isn't a TTY).
 */
export async function syncInitialPtySize(
  connection: BrokerConnection,
  name: string,
  localSize: { rows: number; cols: number } | null,
  verb: string,
  deps: { fetch: typeof globalThis.fetch; log: (...args: unknown[]) => void }
): Promise<void> {
  if (!localSize) return;
  try {
    await createBrokerClient(connection, deps.fetch).resizePty(name, localSize.rows, localSize.cols);
  } catch (err: unknown) {
    const failure = mapBrokerSdkFailure(err);
    deps.log(
      `[${verb}] could not sync agent PTY size to local terminal (${failure.message ?? 'unknown'}); continuing`
    );
  }
}

/**
 * Read the worker's prior inbound delivery mode and flip it to
 * `targetMode`. Returns the previous mode on success so the caller can
 * restore it on detach; returns `null` (and writes an error) when the
 * flip fails so the caller bails before touching the terminal.
 *
 * Non-404 errors are surfaced as `Error: could not ${actionPhrase}:
 * ${message}` so callers pass verb-appropriate wording (e.g. "switch to
 * manual_flush mode" or "ensure passthrough session"). 404s get a
 * uniform "no agent named X" message.
 */
export async function switchInboundDeliveryModeOrAbort(
  connection: BrokerConnection,
  name: string,
  targetMode: InboundDeliveryMode,
  actionPhrase: string,
  deps: { fetch: typeof globalThis.fetch; error: (...args: unknown[]) => void }
): Promise<{ previousMode: InboundDeliveryMode | null } | null> {
  let previousMode: InboundDeliveryMode | null = null;
  try {
    previousMode = await createBrokerClient(connection, deps.fetch).getInboundDeliveryMode(name);
  } catch {
    // Best-effort — fall through with null; the caller restores to
    // `auto_inject` in that case so the queue can't grow indefinitely.
  }
  try {
    await createBrokerClient(connection, deps.fetch).setInboundDeliveryMode(name, targetMode);
    return { previousMode };
  } catch (err: unknown) {
    const failure = mapBrokerSdkFailure(err);
    if (failure.status === 404) {
      deps.error(`Error: no agent named '${name}'`);
    } else {
      deps.error(`Error: could not ${actionPhrase}: ${failure.message ?? 'unknown error'}`);
    }
    return null;
  }
}

/**
 * Best-effort restore of a worker's inbound delivery mode on detach.
 *
 * Two hazards this guards against (see #1247):
 *
 *  1. Get-then-set race — a second session attaching while this one is active
 *     would read *this* session's mode as the "previous" one, so blindly
 *     writing `previousMode` back on detach can clobber a change another
 *     session/CLI made in the meantime. We re-read the current mode and only
 *     restore when it still equals what *this* session set.
 *  2. Failed initial read — when the pre-attach mode was never learned
 *     (`previousMode === null`), forcing a default (`auto_inject`) would
 *     silently cancel an explicit `agent message hold`. In that case we leave
 *     the mode untouched and warn.
 *
 * A full ownership/lease protocol is out of scope; this is the pragmatic
 * "don't clobber someone else, don't force a default" version.
 */
export async function restoreInboundDeliveryModeOnDetach(
  connection: BrokerConnection,
  name: string,
  previousMode: InboundDeliveryMode | null,
  sessionMode: InboundDeliveryMode,
  verb: string,
  deps: { fetch: typeof globalThis.fetch; log: (...args: unknown[]) => void }
): Promise<void> {
  if (previousMode === null) {
    deps.log(
      `[${verb}] could not restore '${name}' inbound delivery mode (pre-attach mode was unknown); leaving it unchanged`
    );
    return;
  }
  let current: InboundDeliveryMode | null = null;
  try {
    current = await createBrokerClient(connection, deps.fetch).getInboundDeliveryMode(name);
  } catch {
    current = null;
  }
  // Only restore when the mode is still what this session set. If the read
  // failed (null) or another session changed it, leave it alone.
  if (current !== sessionMode) return;
  try {
    await createBrokerClient(connection, deps.fetch).setInboundDeliveryMode(name, previousMode);
  } catch {
    // best-effort
  }
}

/**
 * Streaming scanner that tracks whether a byte stream currently *ends* inside
 * an incomplete ANSI escape sequence (ESC, CSI, OSC, or DCS/SOS/PM/APC string).
 *
 * The attach status line wraps its repaint in cursor save/restore controls;
 * splicing that in while the agent is mid-transmission of its own CSI sequence
 * corrupts the agent's output. Feeding every server chunk through this scanner
 * lets the status painter hold its repaint until the stream is back at a
 * sequence boundary. State persists across chunks (a sequence may span several
 * `worker_stream` frames).
 *
 * Only ASCII control bytes drive the state machine; multi-byte UTF-8 payload
 * bytes are printable in the ground state and never appear inside a CSI/escape
 * sequence, so scanning UTF-16 code units is safe here.
 */
export class AnsiBoundaryScanner {
  private state: 'ground' | 'esc' | 'csi' | 'osc' | 'osc_esc' | 'str' | 'str_esc' = 'ground';

  push(chunk: string): void {
    for (let i = 0; i < chunk.length; i += 1) {
      this.step(chunk.charCodeAt(i));
    }
  }

  reset(): void {
    this.state = 'ground';
  }

  /** True when the stream ends at a safe boundary (not mid-sequence). */
  get atBoundary(): boolean {
    return this.state === 'ground';
  }

  private step(c: number): void {
    switch (this.state) {
      case 'ground':
        if (c === 0x1b) this.state = 'esc';
        return;
      case 'esc':
        if (c === 0x5b)
          this.state = 'csi'; // ESC [
        else if (c === 0x5d)
          this.state = 'osc'; // ESC ]
        else if (c === 0x50 || c === 0x58 || c === 0x5e || c === 0x5f)
          this.state = 'str'; // DCS / SOS / PM / APC
        else this.state = 'ground'; // 2-byte escape (ESC 7, ESC 8, ESC c, …)
        return;
      case 'csi':
        if (c === 0x1b)
          this.state = 'esc'; // stray ESC restarts
        else if (c >= 0x40 && c <= 0x7e)
          this.state = 'ground'; // final byte ends the CSI
        return;
      case 'osc':
        if (c === 0x07)
          this.state = 'ground'; // BEL terminator
        else if (c === 0x1b)
          this.state = 'osc_esc'; // possible ST (ESC \)
        return;
      case 'osc_esc':
        this.state = c === 0x5c ? 'ground' : 'osc';
        return;
      case 'str':
        if (c === 0x1b) this.state = 'str_esc';
        return;
      case 'str_esc':
        this.state = c === 0x5c ? 'ground' : 'str';
        return;
    }
  }
}

/** Options for {@link StatusLineController}. Timers are injectable for tests. */
export interface StatusLineControllerOptions {
  /** Produce the current status-line ANSI string. */
  render: () => string;
  /** Write to stdout. */
  write: (chunk: string) => void;
  /** When false (stdout is not a TTY) the status line is never painted. */
  enabled: boolean;
  /**
   * Minimum ms between repaints. `0` paints on every request (no coalescing);
   * a positive value coalesces bursts of per-chunk repaints into at most one
   * paint per window, shrinking the splice/DECSC-clobber window.
   */
  coalesceMs: number;
  /**
   * Max ms to hold a repaint while output keeps ending mid escape-sequence
   * before painting anyway (bounded residual splice risk). Default 100.
   */
  boundaryHoldMs?: number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
  now?: () => number;
}

/**
 * Coordinates status-line repaints for the interactive attach clients.
 *
 * Correctness properties (see #1247):
 *  - **Non-TTY skip** — when `enabled` is false, nothing is ever written.
 *  - **Boundary-hold** — a repaint is deferred while the observed output ends
 *    mid ANSI escape sequence, so the status line never splices into a
 *    half-transmitted CSI. It paints as soon as the next chunk lands at a
 *    boundary (or after `boundaryHoldMs` as a bounded fallback).
 *  - **Coalescing** — repaints are rate-limited to at most one per
 *    `coalesceMs`, shrinking the window in which our save/restore-cursor wrap
 *    can clobber the agent's own pending DECSC.
 *  - **Teardown-safe** — after {@link dispose} no further writes happen.
 *
 * Residual risk (documented): ESC 7/ESC 8 (and CSI s/u) share a single
 * saved-cursor slot on many terminals, so a repaint landing between the
 * agent's DECSC and DECRC can still restore to the wrong spot. Boundary-hold +
 * coalescing shrink but do not eliminate that window.
 */
export class StatusLineController {
  private readonly scanner = new AnsiBoundaryScanner();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerForce = false;
  private wantPaint = false;
  private lastPaintAt = Number.NEGATIVE_INFINITY;
  private disposed = false;

  constructor(private readonly opts: StatusLineControllerOptions) {}

  /** Record server output for boundary tracking; flush a held repaint if the
   *  stream is now back at a sequence boundary. */
  observeOutput(chunk: string): void {
    if (this.disposed) return;
    this.scanner.push(chunk);
    if (this.wantPaint) this.flush();
  }

  /** Request a repaint (coalesced + boundary-held). */
  request(): void {
    if (this.disposed || !this.opts.enabled) return;
    this.wantPaint = true;
    this.flush();
  }

  /** Stop all painting and cancel any pending timer. */
  dispose(): void {
    this.disposed = true;
    this.wantPaint = false;
    this.clearTimer();
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private flush(): void {
    if (this.disposed || !this.wantPaint) return;
    if (!this.scanner.atBoundary) {
      this.arm(this.opts.boundaryHoldMs ?? 100, true);
      return;
    }
    const elapsed = this.now() - this.lastPaintAt;
    if (elapsed >= this.opts.coalesceMs) {
      this.paintNow();
    } else {
      this.arm(this.opts.coalesceMs - elapsed, false);
    }
  }

  private paintNow(): void {
    this.clearTimer();
    this.wantPaint = false;
    this.lastPaintAt = this.now();
    this.opts.write(this.opts.render());
  }

  private arm(ms: number, force: boolean): void {
    if (this.timer) return;
    this.timerForce = force;
    const set =
      this.opts.setTimer ??
      ((fn, delay) => {
        const t = setTimeout(fn, delay);
        (t as { unref?: () => void }).unref?.();
        return t;
      });
    this.timer = set(() => {
      this.timer = null;
      if (this.disposed || !this.wantPaint) return;
      if (this.timerForce) this.paintNow();
      else this.flush();
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer) {
      (this.opts.clearTimer ?? clearTimeout)(this.timer);
      this.timer = null;
    }
  }
}

/** Minimal writable surface {@link createBackpressureAwareWriter} needs. */
export interface BackpressureWritable {
  write(chunk: string): boolean;
  once(event: 'drain', listener: () => void): unknown;
}

/**
 * Default stdout writer that respects backpressure (see #1247, item 7).
 *
 * When the underlying stream reports saturation (`write()` returns false) we
 * hold subsequent chunks in a bounded in-memory queue and flush them on
 * `'drain'`, rather than letting Node's stdout buffer grow without limit under
 * a fast agent + slow terminal. If our own queue reaches `maxQueuedBytes` we
 * fall back to writing straight through — bounded extra buffering, never
 * dropped output. Documented residual risk: under sustained overload Node's
 * internal stdout buffer can still grow.
 */
export function createBackpressureAwareWriter(
  stdout: BackpressureWritable,
  maxQueuedBytes = 4 * 1024 * 1024
): (chunk: string) => void {
  let paused = false;
  const queue: string[] = [];
  let queuedBytes = 0;

  const flushQueue = (): void => {
    while (queue.length > 0) {
      const next = queue.shift() as string;
      queuedBytes -= Buffer.byteLength(next, 'utf8');
      if (!stdout.write(next)) {
        stdout.once('drain', flushQueue);
        return;
      }
    }
    paused = false;
  };

  return (chunk: string): void => {
    if (paused) {
      const bytes = Buffer.byteLength(chunk, 'utf8');
      if (queuedBytes + bytes <= maxQueuedBytes) {
        queue.push(chunk);
        queuedBytes += bytes;
        return;
      }
      // Queue is full — write through rather than drop output.
      stdout.write(chunk);
      return;
    }
    if (!stdout.write(chunk)) {
      paused = true;
      stdout.once('drain', flushQueue);
    }
  };
}

/** Dependencies for `captureInitialSnapshot`. `captureAndRenderSnapshot`
 *  is injectable so tests can substitute a stub. */
export interface CaptureInitialSnapshotDeps extends AttachSnapshotDeps {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  captureAndRenderSnapshot?: typeof captureAndRenderSnapshot;
}

/**
 * Render the agent's current visible screen, then dispatch on the
 * outcome. Hard errors (`not_found`, `no_pty`) abort: this helper
 * best-effort restores the prior delivery mode and writes the
 * appropriate error before returning `null` so the caller bails.
 * Transient errors warn and proceed. Returns `{ snapshotRows }` on the
 * happy path so the caller can seed the status-line row fallback.
 *
 * `noPtyAction` is the verb phrase used in the no-PTY message
 * (`agent 'X' has no PTY to ${noPtyAction}`) — e.g. "drive" or
 * "attach to".
 */
export async function captureInitialSnapshot(
  connection: BrokerConnection,
  name: string,
  previousMode: InboundDeliveryMode | null,
  verb: string,
  noPtyAction: string,
  deps: CaptureInitialSnapshotDeps
): Promise<{ snapshotRows?: number } | null> {
  const render = deps.captureAndRenderSnapshot ?? captureAndRenderSnapshot;
  const snapshot = await render({ url: connection.url, apiKey: connection.apiKey }, name, {
    fetch: deps.fetch,
    writeChunk: deps.writeChunk,
  });
  switch (snapshot.status) {
    case 'ok':
      return { snapshotRows: snapshot.rows };
    case 'not_found':
    case 'no_pty': {
      try {
        await createBrokerClient(connection, deps.fetch).setInboundDeliveryMode(
          name,
          previousMode ?? 'auto_inject'
        );
      } catch {
        // best-effort restore
      }
      const fallback =
        snapshot.status === 'not_found'
          ? `no agent named '${name}'`
          : `agent '${name}' has no PTY to ${noPtyAction}`;
      deps.error(`Error: ${snapshot.message ?? fallback}`);
      return null;
    }
    case 'unavailable':
    case 'transport_error':
      deps.log(
        `[${verb}] could not capture initial screen (${snapshot.message ?? snapshot.status}); streaming live output only`
      );
      return { snapshotRows: snapshot.rows };
  }
}
