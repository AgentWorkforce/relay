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
 *
 * The snapshot offset is retained as a post-reconcile *watermark*: once
 * buffering ends, {@link push} keeps suppressing any live frame whose end
 * offset is `<=` the watermark. This closes a broker-side race — the PTY
 * reader advances `consumed_offset` and the grid *before* the decoded chunk
 * reaches the broadcast queue, so a chunk with `offset <= snapshotOffset`
 * can still arrive *after* the client reconciles. Offsets are cumulative and
 * monotonic, so the watermark drops exactly those already-painted stragglers
 * without touching genuinely new output.
 */
export class StreamSyncBuffer {
  private buffering = true;
  private readonly buffered: Array<{ chunk: string; offset?: number }> = [];
  /**
   * Post-reconcile suppression watermark: the snapshot offset the grid had
   * already painted. `undefined` until {@link reconcile} runs with a defined
   * offset (or forever, on brokers without offset support / after
   * {@link flushAll}), in which case no post-reconcile suppression happens.
   */
  private watermark: number | undefined = undefined;

  /**
   * Record a live `worker_stream` chunk. Returns `true` when the caller
   * should apply the chunk immediately, `false` when the chunk must be held
   * or dropped. While buffering, the chunk is retained for {@link reconcile}.
   * After reconcile, a chunk whose end offset is `<=` the snapshot watermark
   * is a late-arriving straggler the snapshot already painted and is
   * suppressed (see the class docstring's race note); everything else passes
   * through live.
   */
  push(chunk: string, offset: number | undefined): boolean {
    if (this.buffering) {
      this.buffered.push({ chunk, offset });
      return false;
    }
    // Live pass-through, minus stragglers the snapshot already reflects.
    if (this.watermark !== undefined && offset !== undefined && offset <= this.watermark) {
      return false;
    }
    return true;
  }

  /**
   * Reconcile the buffered chunks against the painted snapshot's offset and
   * return the chunks to apply, in order. Switches to live pass-through and
   * arms the post-reconcile watermark (see {@link push}).
   *
   * When `snapshotOffset` is `undefined` (broker without offset support) all
   * buffered chunks are discarded: they arrived before the snapshot was
   * painted, so dropping them matches the snapshot-authoritative fallback
   * and avoids double-painting what the snapshot already shows. No watermark
   * is armed in that case — there is no offset to compare live frames to.
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
    this.watermark = snapshotOffset;
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
 * The sequence is intentionally direction-explicit and idempotent. Ordering is
 * load-bearing (see #1251): a few of these controls move the cursor, and
 * `\x1b[?1049l` (leave alt screen) *restores* the main-buffer cursor that was
 * saved on alt-screen entry. Anything that homes the cursor must therefore run
 * *before* the alt-screen leave, or it clobbers that restored position and the
 * next shell prompt lands at top-left. Two controls home the cursor:
 *
 *  - `\x1b[r` (DECSTBM scroll-region reset) homes the cursor on xterm/DEC-style
 *    terminals. The scroll-region margins are shared terminal state, so
 *    resetting them while still in the alt buffer heals a stale region and the
 *    homing is harmless (the pending `?1049l` restore supersedes it).
 *  - `\x1b[?6l` (DECOM origin-mode reset) also moves the cursor to home per the
 *    DEC spec, so it belongs in the same pre-leave group.
 *
 * Everything after the alt-screen leave is position-independent (mode flags
 * that never move the cursor): show cursor, application cursor keys off,
 * autowrap on, every mouse-reporting mode off, bracketed paste off, numeric
 * keypad, and a final SGR reset. Only written when stdout is a TTY, consistent
 * with how the sessions gate raw-mode restore and the status line.
 */
export const LOCAL_TERMINAL_RESET_SEQUENCE =
  // --- cursor-homing resets: must precede the alt-screen leave/restore ---
  '\x1b[?6l' + // origin mode off (DECOM) — homes the cursor
  '\x1b[r' + // reset scroll region to full screen (DECSTBM) — homes the cursor
  // --- leave alt screen: restores the main-buffer cursor saved on entry ---
  '\x1b[?1049l' + // leave alternate screen buffer
  // --- position-independent mode resets (none move the cursor) ---
  '\x1b[?25h' + // show cursor (DECTCEM)
  '\x1b[?1l' + // application cursor keys off (DECCKM)
  '\x1b[?7h' + // autowrap on (DECAWM)
  '\x1b[?1000l' + // mouse click reporting off
  '\x1b[?1002l' + // mouse button-event (drag) reporting off
  '\x1b[?1003l' + // mouse any-event (motion) reporting off
  '\x1b[?1004l' + // focus in/out reporting off
  '\x1b[?1005l' + // UTF-8 mouse coordinates off
  '\x1b[?1006l' + // SGR mouse coordinates off
  '\x1b[?1007l' + // alternate scroll off
  '\x1b[?2004l' + // bracketed paste off
  '\x1b>' + // keypad normal (DECKPNM)
  '\x1b[0m'; // reset SGR

/**
 * Emit {@link LOCAL_TERMINAL_RESET_SEQUENCE} to the local terminal on detach,
 * but only when stdout is a TTY. A no-op for piped/redirected stdout so the
 * reset never corrupts a captured log.
 */
export function resetLocalTerminalOnDetach(write: (chunk: string) => void, isTty: boolean): void {
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
 * Pick the status-line width. Same precedence as
 * {@link pickInitialTerminalRows} — the LOCAL terminal wins, because the
 * status line has to fit the pane the human is looking at, not the agent's
 * PTY.
 */
export function pickInitialTerminalCols(
  localSize: { rows: number; cols: number } | null,
  snapshotCols: number | undefined
): number | undefined {
  if (localSize) return localSize.cols;
  if (typeof snapshotCols === 'number' && snapshotCols > 0) return snapshotCols;
  return undefined;
}

/** Width assumed when the local terminal never reported one. */
export const DEFAULT_STATUS_LINE_COLS = 80;

/**
 * Clamp a status-line label to the terminal width.
 *
 * The interactive verbs paint their status line at the bottom row inside an
 * `ESC 7` / `ESC 8` (DECSC/DECRC) pair. That is only safe while the text
 * *fits*: a label wider than the pane wraps past the last row, which scrolls
 * the screen. Because the label is painted on the bottom row, every repaint
 * then scrolls again — promoting the previous status line into the scrollback
 * as content and eating one row of the agent's output each time. A narrow
 * pane therefore turns a single status line into a growing stack of them with
 * the agent's TUI shredded behind it. The `drive` label is 87 columns, so this
 * fired on a standard 80-column terminal too; at 66 columns six repaints cost
 * six rows of agent output.
 *
 * Truncation keeps the paint inside one row, so the wrap — and the scroll
 * cascade it triggers — can never happen. Callers painting a terminal row can
 * reserve the final column as well, avoiding the emulator's wrap-pending state.
 * The tail is the part that carries the key hints, so an over-long label is
 * trimmed from the *middle*: the verb and agent name stay readable and the
 * `Ctrl+…` hints survive.
 *
 * Measured in display columns, not UTF-16 code units: an agent name carrying
 * CJK or emoji is double-width, so a code-unit count would pass a label that
 * still wraps — re-arming the exact cascade this prevents. Slicing is done on
 * whole code points so a surrogate pair is never split in half.
 */
export function clampStatusLineText(
  text: string,
  cols: number | undefined,
  reserveFinalColumn = false
): string {
  const terminalWidth = typeof cols === 'number' && cols > 0 ? Math.floor(cols) : DEFAULT_STATUS_LINE_COLS;
  const width = reserveFinalColumn ? Math.max(terminalWidth - 1, 0) : terminalWidth;
  if (displayWidth(text) <= width) return text;
  // Too narrow to say anything useful — a bare head is still better than a
  // wrap, and `…` alone would be meaningless.
  if (width <= 1) return width === 1 ? takeColumns(text, 1).text : '';
  const keep = width - 1; // the ellipsis occupies one column
  const tailBudget = Math.floor(keep / 2);
  const headBudget = keep - tailBudget;
  const head = takeColumns(text, headBudget);
  const tail = tailBudget > 0 ? takeColumns(text, tailBudget, 'end') : { text: '' };
  return `${head.text}…${tail.text}`;
}

/**
 * Column width of a string, counting East Asian Wide/Fullwidth characters and
 * emoji as two columns and zero-width joiners/combining marks as none. This is
 * the pragmatic subset a status line needs — it is not a full `wcwidth`.
 */
function displayWidth(text: string): number {
  let total = 0;
  for (const char of text) total += charWidth(char);
  return total;
}

/** Codepoints that occupy no column: combining marks, ZWJ, variation selectors. */
const ZERO_WIDTH_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f],
  [0x200d, 0x200d],
  [0xfe00, 0xfe0f],
];

/** East Asian Wide / Fullwidth blocks, plus the emoji planes. */
const DOUBLE_WIDTH_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
  [0x20000, 0x3fffd],
];

function inRanges(code: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  return ranges.some(([lo, hi]) => code >= lo && code <= hi);
}

function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (inRanges(code, ZERO_WIDTH_RANGES)) return 0;
  return inRanges(code, DOUBLE_WIDTH_RANGES) ? 2 : 1;
}

/**
 * Take whole code points from `text` until `budget` columns are used, from the
 * start or the `end`. Never splits a surrogate pair, and never overshoots the
 * budget — a double-width character that would exceed it is dropped.
 */
function takeColumns(text: string, budget: number, from: 'start' | 'end' = 'start'): { text: string } {
  const chars = Array.from(text);
  const ordered = from === 'end' ? chars.slice().reverse() : chars;
  const taken: string[] = [];
  let used = 0;
  for (const char of ordered) {
    const w = charWidth(char);
    if (used + w > budget) break;
    used += w;
    taken.push(char);
  }
  return { text: (from === 'end' ? taken.reverse() : taken).join('') };
}

/**
 * Reserve the local terminal's final row for an attach status line.
 *
 * Full-screen CLIs treat every PTY row as application-owned. If the remote PTY
 * is resized to the local terminal's full height and Relay then paints a status
 * line over its final row, both renderers continually overwrite each other.
 * The result is the duplicated status text and torn TUI frames seen in drive
 * and passthrough sessions. Give the child one fewer row and column: the row
 * prevents cursor-addressed overlap, while the spare column prevents terminal
 * autowrap from stepping past the child scroll margin into Relay's row.
 */
export function reserveStatusLineRow(
  localSize: { rows: number; cols: number } | null
): { rows: number; cols: number } | null {
  if (!localSize) return null;
  if (localSize.rows < 3 || localSize.cols < 2) return localSize;
  return {
    rows: localSize.rows - 1,
    cols: localSize.cols - 1,
  };
}

/** Whether a terminal is large enough to dedicate a non-wrapping status row. */
export function canReserveStatusLine(
  localSize: { rows: number; cols: number } | null
): localSize is { rows: number; cols: number } {
  return localSize !== null && localSize.rows >= 3 && localSize.cols >= 2;
}

/**
 * Constrain local scrolling to the child PTY's rows while preserving the
 * current cursor. DECSTBM otherwise defaults to the physical terminal height,
 * which includes Relay's status row.
 */
export function renderChildScrollRegion(rows: number): string {
  // CSI s/u save only the cursor. DEC ESC 7/8 also preserve terminal state in
  // common emulators and would therefore undo the newly installed margins.
  return `\x1b[s\x1b[1;${Math.max(1, Math.floor(rows))}r\x1b[u`;
}

/**
 * Keep a status label strictly inside one terminal row.
 *
 * Writing the final column with autowrap enabled advances to the next row and,
 * on the terminal's bottom row, scrolls the entire TUI. Leave one cell unused
 * and conservatively count non-ASCII code points as two cells so even unusual
 * agent names cannot trigger a wrap.
 */
function conservativeTerminalCellWidth(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint >= 0x20 && codePoint <= 0x7e ? 1 : 2;
}

export function fitStatusLineText(text: string, columns: number | undefined): string {
  if (columns === undefined || !Number.isFinite(columns)) return text;
  const available = Math.max(0, Math.floor(columns) - 1);
  if (available === 0) return '';

  let width = 0;
  let result = '';
  let truncated = false;
  for (const character of text) {
    const characterWidth = conservativeTerminalCellWidth(character);
    if (width + characterWidth > available) {
      truncated = true;
      break;
    }
    result += character;
    width += characterWidth;
  }
  if (!truncated) return result;
  while (width + 1 > available && result.length > 0) {
    const characters = Array.from(result);
    const removed = characters.pop() ?? '';
    width -= conservativeTerminalCellWidth(removed);
    result = characters.join('');
  }
  return `${result}~`;
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
  deps: { fetch: typeof globalThis.fetch; log: (...args: unknown[]) => void },
  options?: { sessionId?: string }
): Promise<boolean> {
  if (!localSize) return false;
  try {
    const result = await createBrokerClient(connection, deps.fetch).resizePty(
      name,
      localSize.rows,
      localSize.cols,
      options
    );
    if (result.applied === false) {
      deps.log(`[${verb}] broker did not apply the reserved PTY size; using status repaint fallback`);
      return false;
    }
    return true;
  } catch (err: unknown) {
    const failure = mapBrokerSdkFailure(err);
    deps.log(
      `[${verb}] could not sync agent PTY size to local terminal (${failure.message ?? 'unknown'}); continuing`
    );
    return false;
  }
}

/**
 * Read the worker's prior inbound delivery mode and flip it to
 * `targetMode`. Returns the previous mode on success so the caller can
 * restore it on detach; returns `null` (and writes an error) when the
 * request fails or the broker reports that the requested transition did not
 * complete, so the caller bails before touching the terminal.
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
): Promise<{ previousMode: InboundDeliveryMode | null; sessionRevision: string | null } | null> {
  let previousMode: InboundDeliveryMode | null = null;
  try {
    previousMode = await createBrokerClient(connection, deps.fetch).getInboundDeliveryMode(name);
  } catch {
    // Best-effort — fall through with null; the caller restores to
    // `auto_inject` in that case so the queue can't grow indefinitely.
  }
  try {
    const result = await createBrokerClient(connection, deps.fetch).setInboundDeliveryMode(name, targetMode);
    // A manual_flush → auto_inject transition can fail partway through when
    // draining a parked message into the harness fails. The broker deliberately
    // keeps and reports manual_flush in that case even though the PUT itself
    // succeeded. Starting an attach session as if the target mode landed would
    // render false state and make its first guarded toggle a no-op.
    if (result.mode !== targetMode) {
      deps.error(
        `Error: could not ${actionPhrase}: broker remained in ${result.mode} mode while draining queued messages`
      );
      return null;
    }
    return { previousMode, sessionRevision: result.revision };
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
 * Upper bound (ms) on the best-effort detach teardown — resize-ownership
 * release and inbound-delivery-mode restore. Both are HTTP round-trips to the
 * broker that can stall if the broker is down; the terminal must still exit
 * promptly, so `finish()` resolves the exit code once these settle *or* this
 * deadline elapses, whichever comes first. The broker's idle-takeover net
 * still frees any ownership left behind.
 */
export const DETACH_CLEANUP_DEADLINE_MS = 2000;

/**
 * Best-effort restore of a worker's inbound delivery mode on detach.
 *
 * Two hazards this guards against (see #1247):
 *
 *  1. Concurrent-change race — a second session attaching while this one is
 *     active would read *this* session's mode as the "previous" one, so blindly
 *     writing `previousMode` back on detach can clobber a change another
 *     session/CLI made in the meantime. We restore via the broker's atomic
 *     compare-and-set (`expectedMode: sessionMode`): the broker applies
 *     `previousMode` only if the worker's current mode still equals what *this*
 *     session set, and no-ops (`matched: false`) otherwise. This removes the
 *     read-then-set TOCTOU a client-side re-read still had (a change landing
 *     between the read and the restore PUT).
 *  2. Failed initial read — when the pre-attach mode was never learned
 *     (`previousMode === null`), forcing a default (`auto_inject`) would
 *     silently cancel an explicit `agent message hold`. In that case we leave
 *     the mode untouched and warn.
 *
 * The broker's monotonic mode revision closes ABA races where another session
 * changes the mode away and back to `sessionMode` before this restore.
 */
export async function restoreInboundDeliveryModeOnDetach(
  connection: BrokerConnection,
  name: string,
  previousMode: InboundDeliveryMode | null,
  sessionMode: InboundDeliveryMode,
  sessionRevision: string | null,
  verb: string,
  deps: { fetch: typeof globalThis.fetch; log: (...args: unknown[]) => void }
): Promise<void> {
  if (previousMode === null) {
    deps.log(
      `[${verb}] could not restore '${name}' inbound delivery mode (pre-attach mode was unknown); leaving it unchanged`
    );
    return;
  }
  if (sessionRevision === null) {
    deps.log(
      `[${verb}] could not safely restore '${name}' inbound delivery mode (broker did not report a mode revision); leaving it unchanged`
    );
    return;
  }
  try {
    // Atomic compare-and-set: restore only if both the mode and its monotonic
    // revision still match this session's write. If another session changed it
    // (including an ABA away-and-back), the broker no-ops.
    const result = await createBrokerClient(connection, deps.fetch).setInboundDeliveryMode(
      name,
      previousMode,
      {
        expectedMode: sessionMode,
        expectedRevision: sessionRevision,
      }
    );
    if (!result.matched) {
      deps.log(
        `[${verb}] did not restore '${name}' inbound delivery mode because another session changed it; leaving it unchanged`
      );
    }
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
        else if (c === 0x9b) this.state = 'csi';
        else if (c === 0x9d) this.state = 'osc';
        else if (c === 0x90 || c === 0x98 || c === 0x9e || c === 0x9f) this.state = 'str';
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
        if (c === 0x18 || c === 0x1a)
          this.state = 'ground'; // CAN / SUB cancel the sequence
        else if (c === 0x1b)
          this.state = 'esc'; // stray ESC restarts
        else if (c >= 0x40 && c <= 0x7e) this.state = 'ground'; // final byte ends the CSI
        return;
      case 'osc':
        if (c === 0x07 || c === 0x9c || c === 0x18 || c === 0x1a)
          this.state = 'ground'; // BEL terminator
        else if (c === 0x1b) this.state = 'osc_esc'; // possible ST (ESC \)
        return;
      case 'osc_esc':
        this.state =
          c === 0x5c || c === 0x9c || c === 0x18 || c === 0x1a ? 'ground' : c === 0x1b ? 'osc_esc' : 'osc';
        return;
      case 'str':
        if (c === 0x9c || c === 0x18 || c === 0x1a) this.state = 'ground';
        else if (c === 0x1b) this.state = 'str_esc';
        return;
      case 'str_esc':
        this.state =
          c === 0x5c || c === 0x9c || c === 0x18 || c === 0x1a ? 'ground' : c === 0x1b ? 'str_esc' : 'str';
        return;
    }
  }
}

/**
 * Detect terminal controls that can erase or replace Relay's reserved status
 * row even though the child PTY itself is one row shorter.
 *
 * Cursor-addressed TUI drawing stays inside the child grid, but erase-display,
 * terminal reset, and alternate-screen switches act on the local terminal as a
 * whole. Attach clients reinstall their child scroll region after those
 * operations; the status controller separately repaints at a safe ANSI
 * boundary. A short carry handles controls split across WS frames.
 */
export class StatusLineInvalidationScanner {
  private carry = '';

  push(chunk: string): boolean {
    const input = this.carry + chunk;
    const esc = String.fromCharCode(0x1b);
    const privateModes = new RegExp(`${esc}\\[\\?([0-9;]+)[hl]`, 'g');
    let invalidatesDisplay = false;
    let privateMatch: RegExpExecArray | null;
    while ((privateMatch = privateModes.exec(input)) !== null) {
      if (privateMatch[1].split(';').some((mode) => ['47', '1047', '1049'].includes(mode))) {
        invalidatesDisplay = true;
      }
    }
    // Retain only an incomplete candidate control. Keeping arbitrary completed
    // output would rediscover the same erase on later chunks and recreate the
    // repaint storm this scanner exists to prevent.
    const lastEscape = input.lastIndexOf(esc);
    const suffix = lastEscape >= 0 ? input.slice(lastEscape) : '';
    const incompleteCsi = suffix.startsWith(`${esc}[`) && /^[?0-9;]*$/.test(suffix.slice(2));
    this.carry = suffix === esc || incompleteCsi ? suffix : '';

    return (
      // ED 0/default clears from the cursor through the reserved final row;
      // ED 2 clears the full display.
      input.includes(`${esc}[J`) ||
      input.includes(`${esc}[0J`) ||
      input.includes(`${esc}[2J`) ||
      // Alternate-screen changes replace the entire visible buffer.
      invalidatesDisplay ||
      // RIS resets the terminal and clears the active display.
      input.includes(`${esc}c`)
    );
  }
}

/** Track the child application's active DECSTBM margins across streamed ANSI. */
export class TerminalScrollRegionTracker {
  private parserState: 'ground' | 'escape' | 'csi' | 'string' | 'string_escape' = 'ground';
  private csiParams = '';
  private csiSupported = true;
  private stringAllowsBel = false;
  private rows: number;
  private top = 1;
  private bottom: number;
  private originMode = false;
  private alternateActive = false;
  private primaryRegion: { top: number; bottom: number };
  private alternateRegion: { top: number; bottom: number };

  constructor(rows: number) {
    this.rows = Math.max(1, Math.floor(rows));
    this.bottom = this.rows;
    this.primaryRegion = { top: 1, bottom: this.rows };
    this.alternateRegion = { top: 1, bottom: this.rows };
  }

  setRows(rows: number): void {
    this.rows = Math.max(1, Math.floor(rows));
    this.top = 1;
    this.bottom = this.rows;
    this.primaryRegion = { top: 1, bottom: this.rows };
    this.alternateRegion = { top: 1, bottom: this.rows };
  }

  push(chunk: string): void {
    for (const character of chunk) this.consumeCharacter(character);
  }

  get region(): { top: number; bottom: number } {
    return { top: this.top, bottom: this.bottom };
  }

  get isOriginMode(): boolean {
    return this.originMode;
  }

  private consumeCharacter(character: string): void {
    switch (this.parserState) {
      case 'ground':
        this.consumeGround(character);
        break;
      case 'escape':
        this.consumeEscape(character);
        break;
      case 'csi':
        this.consumeCsi(character);
        break;
      case 'string':
        this.consumeString(character);
        break;
      case 'string_escape':
        this.consumeStringEscape(character);
        break;
    }
  }

  private consumeString(character: string): void {
    if (character === '\x1b') {
      this.parserState = 'string_escape';
      return;
    }
    if (
      character === '\x9c' ||
      character === '\x18' ||
      character === '\x1a' ||
      (this.stringAllowsBel && character === '\x07')
    ) {
      this.parserState = 'ground';
    }
  }

  private consumeStringEscape(character: string): void {
    if (character === '\\' || character === '\x9c' || character === '\x18' || character === '\x1a') {
      this.parserState = 'ground';
    } else {
      this.parserState = character === '\x1b' ? 'string_escape' : 'string';
    }
  }

  private consumeGround(character: string): void {
    if (character === '\x1b') this.parserState = 'escape';
    else if (character === '\x9b') this.beginCsi();
    else if (['\x90', '\x98', '\x9d', '\x9e', '\x9f'].includes(character)) {
      this.beginString(character === '\x9d');
    }
  }

  private consumeEscape(character: string): void {
    if (character === '[') this.beginCsi();
    else if (['P', 'X', ']', '^', '_'].includes(character)) this.beginString(character === ']');
    else {
      if (character === 'c') this.resetTrackedState();
      this.parserState = character === '\x1b' ? 'escape' : 'ground';
    }
  }

  private beginCsi(): void {
    this.parserState = 'csi';
    this.csiParams = '';
    this.csiSupported = true;
  }

  private beginString(allowsBel: boolean): void {
    this.parserState = 'string';
    this.stringAllowsBel = allowsBel;
  }

  private consumeCsi(character: string): void {
    if (character === '\x18' || character === '\x1a') {
      this.parserState = 'ground';
      return;
    }
    if (character === '\x1b') {
      this.parserState = 'escape';
      return;
    }
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x30 && code <= 0x3f) {
      this.csiParams += character;
      return;
    }
    if (code >= 0x20 && code <= 0x2f) {
      this.csiSupported = false;
      return;
    }
    if (code >= 0x40 && code <= 0x7e) {
      if (this.csiSupported) this.applyCsi(this.csiParams, character);
      this.parserState = 'ground';
    }
  }

  private applyCsi(params: string, final: string): void {
    if ((final === 'h' || final === 'l') && params.startsWith('?')) {
      this.applyPrivateModes(params.slice(1).split(';'), final === 'h');
      return;
    }
    if (final !== 'r' || params.startsWith('?')) return;
    const [topRaw = '', bottomRaw = ''] = params.split(';');
    const parsedTop = topRaw === '' ? 0 : Number.parseInt(topRaw, 10);
    const parsedBottom = bottomRaw === '' ? 0 : Number.parseInt(bottomRaw, 10);
    const top = parsedTop === 0 ? 1 : parsedTop;
    const bottom = parsedBottom === 0 ? this.rows : parsedBottom;
    if (Number.isFinite(top) && Number.isFinite(bottom) && top >= 1 && bottom > top) {
      const clampedTop = Math.min(top, this.rows);
      const clampedBottom = Math.min(bottom, this.rows);
      if (clampedBottom > clampedTop) {
        this.top = clampedTop;
        this.bottom = clampedBottom;
      }
    }
  }

  private applyPrivateModes(modes: string[], enabled: boolean): void {
    if (modes.includes('6')) this.originMode = enabled;
    if (modes.some((mode) => ['47', '1047', '1049'].includes(mode))) {
      this.switchScreenBuffer(enabled, enabled);
    }
  }

  private resetTrackedState(): void {
    this.top = 1;
    this.bottom = this.rows;
    this.originMode = false;
    this.alternateActive = false;
    this.primaryRegion = { top: 1, bottom: this.rows };
    this.alternateRegion = { top: 1, bottom: this.rows };
  }

  private switchScreenBuffer(enterAlternate: boolean, resetAlternate: boolean): void {
    if (enterAlternate === this.alternateActive) return;
    if (resetAlternate) {
      this.alternateRegion = { top: 1, bottom: this.rows };
    }
    if (this.alternateActive) {
      this.alternateRegion = { top: this.top, bottom: this.bottom };
    } else {
      this.primaryRegion = { top: this.top, bottom: this.bottom };
    }
    this.alternateActive = enterAlternate;
    const region = enterAlternate ? this.alternateRegion : this.primaryRegion;
    this.top = region.top;
    this.bottom = region.bottom;
  }
}

/** Options for {@link StatusLineController}. Timers are injectable for tests. */
export interface StatusLineControllerOptions {
  /** Produce the current status-line ANSI string. */
  render: () => string;
  /** Write to stdout. */
  write: (chunk: string) => void;
  /** When false (stdout is not a TTY) the status line is never painted. */
  enabled: boolean | (() => boolean);
  /**
   * Minimum ms between repaints. `0` paints on every request (no coalescing);
   * a positive value coalesces bursts of per-chunk repaints into at most one
   * paint per window, shrinking the splice/DECSC-clobber window.
   */
  coalesceMs: number;
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
 *    half-transmitted CSI. It paints only after a later chunk returns the
 *    stream to a real boundary.
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
  private wantPaint = false;
  private lastPaintAt = Number.NEGATIVE_INFINITY;
  private disposed = false;

  constructor(private readonly opts: StatusLineControllerOptions) {}

  private isEnabled(): boolean {
    return typeof this.opts.enabled === 'function' ? this.opts.enabled() : this.opts.enabled;
  }

  /** Record server output for boundary tracking; flush a held repaint if the
   *  stream is now back at a sequence boundary. */
  observeOutput(chunk: string): void {
    if (this.disposed) return;
    this.scanner.push(chunk);
    if (!this.isEnabled()) {
      this.wantPaint = false;
      this.clearTimer();
      return;
    }
    if (this.wantPaint) this.flush();
  }

  /** Request a repaint (coalesced + boundary-held). */
  request(): void {
    if (this.disposed || !this.isEnabled()) return;
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
    if (this.disposed || !this.wantPaint || !this.isEnabled()) return;
    if (!this.scanner.atBoundary) {
      return;
    }
    const elapsed = this.now() - this.lastPaintAt;
    if (elapsed >= this.opts.coalesceMs) {
      this.paintNow();
    } else {
      this.arm(this.opts.coalesceMs - elapsed);
    }
  }

  private paintNow(): void {
    this.clearTimer();
    if (!this.isEnabled()) {
      this.wantPaint = false;
      return;
    }
    this.wantPaint = false;
    this.lastPaintAt = this.now();
    this.opts.write(this.opts.render());
  }

  private arm(ms: number): void {
    if (this.timer) return;
    const set =
      this.opts.setTimer ??
      ((fn, delay) => {
        const t = setTimeout(fn, delay);
        (t as { unref?: () => void }).unref?.();
        return t;
      });
    this.timer = set(() => {
      this.timer = null;
      if (this.disposed || !this.wantPaint || !this.isEnabled()) {
        this.wantPaint = false;
        return;
      }
      this.flush();
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
  off?(event: 'drain', listener: () => void): unknown;
  removeListener?(event: 'drain', listener: () => void): unknown;
}

/**
 * A backpressure-aware writer plus a teardown hook. Call the writer with each
 * chunk; call {@link BackpressureAwareWriter.dispose} on detach to drop any
 * still-queued chunks and unhook the pending `'drain'` listener so nothing
 * flushes to stdout after the session tears down.
 */
export interface BackpressureAwareWriter {
  /** Write a chunk, respecting backpressure. No-op after {@link dispose}. */
  write: (chunk: string) => void;
  /** Drop the pending queue and unhook the `'drain'` listener. Idempotent. */
  dispose: () => void;
}

/**
 * Default stdout writer that respects backpressure (see #1247, item 7).
 *
 * When the underlying stream reports saturation (`write()` returns false) we
 * hold subsequent chunks in a bounded in-memory queue and flush them on
 * `'drain'`, rather than letting Node's stdout buffer grow without limit under
 * a fast agent + slow terminal.
 *
 * FIFO is preserved even when our own queue reaches `maxQueuedBytes`: rather
 * than writing the overflow chunk straight through (which would jump it ahead
 * of older queued chunks and reorder/split the PTY byte stream), we first flush
 * the entire local queue into stdout's internal buffer — `stdout.write` buffers
 * internally when saturated, so ignoring its return value here is safe — then
 * write the new chunk last. Bounded extra buffering, never dropped or reordered
 * output. Documented residual risk: under sustained overload Node's internal
 * stdout buffer can still grow.
 */
export function createBackpressureAwareWriter(
  stdout: BackpressureWritable,
  maxQueuedBytes = 4 * 1024 * 1024
): BackpressureAwareWriter {
  let paused = false;
  let disposed = false;
  let queue: string[] = [];
  let queuedBytes = 0;

  const flushQueue = (): void => {
    if (disposed) return;
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

  const write = (chunk: string): void => {
    if (disposed) return;
    if (paused) {
      const bytes = Buffer.byteLength(chunk, 'utf8');
      if (queuedBytes + bytes <= maxQueuedBytes) {
        queue.push(chunk);
        queuedBytes += bytes;
        return;
      }
      // Queue cap hit. Preserve FIFO: flush the whole local queue into
      // stdout's internal buffer first (write buffers internally when
      // saturated, so the return value is intentionally ignored), then write
      // the new chunk last so it never jumps ahead of older output.
      for (const queued of queue) stdout.write(queued);
      queue = [];
      queuedBytes = 0;
      stdout.write(chunk);
      return;
    }
    if (!stdout.write(chunk)) {
      paused = true;
      stdout.once('drain', flushQueue);
    }
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    queue = [];
    queuedBytes = 0;
    paused = false;
    const off = stdout.off ?? stdout.removeListener;
    off?.call(stdout, 'drain', flushQueue);
  };

  return { write, dispose };
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
