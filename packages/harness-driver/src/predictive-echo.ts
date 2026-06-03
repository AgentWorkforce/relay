/**
 * Mosh-style predictive (local) echo for interactive PTY attach sessions.
 *
 * On a remote broker, every keystroke's visual feedback is a full round trip:
 * stdin → broker → agent PTY → echo back → display. With the local terminal
 * in raw mode (no local echo), typing feels laggy because characters only
 * appear after that trip completes. This engine masks the latency the way
 * `mosh` does — it optimistically echoes printable characters locally
 * (rendered underlined while unconfirmed), then reconciles against the
 * authoritative server output as it arrives, dropping the underline on
 * confirmation and rolling back mispredictions.
 *
 * The engine is host-agnostic: it depends only on a {@link ScreenModel}
 * (confirmed cursor/screen state) and a `write` sink. The Agent Relay CLI
 * backs the model with a headless `xterm` and writes to stdout; an Electron
 * host (e.g. Pear) can back it with its live `@xterm/xterm` instance and
 * write to that terminal. No Node-only APIs are used, so it runs in a
 * browser/renderer as well as in Node.
 *
 * Design constraints that shape this implementation:
 *
 *   - We keep passing server output straight through to the real terminal
 *     (the agent's screen must stay byte-for-byte correct). Optimistic echo
 *     moves the real cursor, so before each pass-through we erase our
 *     predicted glyphs, repaint the confirmed row tail from
 *     {@link ScreenModel}, and restore the cursor to the *confirmed*
 *     position; surviving predictions are re-rendered afterward. Erasing
 *     first (rather than after) means a chunk that moves off-regime can
 *     never strand an underline on the old row.
 *
 *   - Predictions are confined to the simple, safe regime: printable
 *     characters appended at the end of the cursor's current row, on the
 *     normal (non-alternate) screen. That is exactly where `mosh` is most
 *     confident, and it keeps rollback to a bounded repaint of the
 *     predicted region (never touching confirmed content to its left).
 *     Anything outside that regime — alt-screen TUIs, row changes, cursor
 *     retreats, mid-line edits — suspends predictions and lets authoritative
 *     output drive the display.
 *
 *   - Activation is adaptive (the `mosh` default): predictions only render
 *     once measured echo latency crosses a threshold, so on a local broker
 *     the engine is invisible and risk-free.
 */

/**
 * Authoritative confirmed-screen model. The host supplies an implementation:
 * the CLI wraps a headless `xterm` terminal; an Electron host can back it
 * with its live `@xterm/xterm` instance. All coordinates are 0-indexed.
 */
export interface ScreenModel {
  /** Feed confirmed server bytes; resolves once buffer state reflects them. */
  write(data: string): Promise<void>;
  /** Confirmed cursor position within the viewport. */
  cursor(): { row: number; col: number };
  /** Confirmed text of a viewport row, with trailing blanks trimmed. */
  rowText(row: number): string;
  /** True when the alternate screen buffer is active (full-screen TUI). */
  isAltScreen(): boolean;
  /** Viewport width in columns. */
  cols(): number;
  /** Resize the model's viewport. */
  resize(cols: number, rows: number): void;
  /** Release any underlying resources (e.g. a headless terminal). */
  dispose?(): void;
}

export interface PredictionConfig {
  /**
   * Echo-latency threshold (ms) at or above which predictions render.
   * Below it, the engine stays dormant and the (now fast) server echo
   * provides feedback. Mirrors `mosh`'s adaptive default.
   */
  engageThresholdMs: number;
  /** SGR applied to unconfirmed predicted glyphs. Default: underline. */
  predictionSgr: string;
}

export const DEFAULT_PREDICTION_CONFIG: PredictionConfig = {
  engageThresholdMs: 30,
  predictionSgr: '\x1b[4m', // underline
};

/**
 * Client-facing surface the attach sessions depend on, so a test (or an
 * alternate host) can inject a fake. {@link PredictiveEchoEngine} satisfies it.
 */
export interface PredictiveEcho {
  /** Prime the confirmed model with already-painted bytes (e.g. the attach
   *  snapshot) so its cursor matches the real screen before predicting. */
  seed(data: string): Promise<void>;
  /** The user typed bytes destined for the agent PTY (post keybind parse). */
  onUserInput(forward: string | Uint8Array): void;
  /** A server output chunk; the engine owns its pass-through + reconcile. */
  onServerOutput(chunk: string): Promise<void>;
  /** Discard outstanding predictions (e.g. the input send failed); repaints
   *  the confirmed row so no stale optimistic glyphs remain. */
  rollback(): void;
  /** Local terminal resized. */
  onResize(cols: number, rows: number): void;
  /** Tear down; subsequent server output is plain pass-through. */
  reset(): void;
}

export interface PredictiveEchoDeps {
  /** Authoritative confirmed-screen model. */
  model: ScreenModel;
  /** Writes raw bytes/escape sequences to the real terminal. */
  write: (data: string) => void;
  /** Monotonic-ish clock in ms (injectable for tests). */
  now: () => number;
  /**
   * Latest input→ack SRTT from the PTY input stream, or null. Used to
   * bootstrap the adaptive decision before the first echo is confirmed.
   */
  getInputSrtt: () => number | null;
  config?: Partial<PredictionConfig>;
}

/** A single optimistically-echoed glyph awaiting server confirmation. */
interface Prediction {
  /** 0-indexed column where the glyph was drawn (on {@link predRow}). */
  col: number;
  /** The predicted character (single grapheme; we only predict printables). */
  ch: string;
  /** Clock time the prediction was made, for echo-latency measurement. */
  at: number;
}

/** ESC[<row>;<col>H — move cursor (1-indexed args). */
function cup(row0: number, col0: number): string {
  return `\x1b[${row0 + 1};${col0 + 1}H`;
}

/**
 * Is this a single printable character we are willing to predict-echo?
 *
 * Restricted to single-column printable ASCII (0x20–0x7e). Wide glyphs
 * (CJK, emoji) occupy two columns, which would desync the engine's
 * one-column-per-char cursor math; non-ASCII input falls back to the
 * server echo rather than risk a misplaced prediction.
 */
function isPredictablePrintable(ch: string): boolean {
  if (ch.length !== 1) return false;
  const code = ch.charCodeAt(0);
  return code >= 0x20 && code <= 0x7e;
}

/**
 * Predictive-echo state machine. One instance per interactive attach
 * session. Server output is processed through an internal promise chain so
 * concurrent {@link onServerOutput} calls stay strictly ordered even though
 * the model's `write` is async.
 */
export class PredictiveEchoEngine implements PredictiveEcho {
  private readonly model: ScreenModel;
  private readonly write: (data: string) => void;
  private readonly now: () => number;
  private readonly getInputSrtt: () => number | null;
  private readonly config: PredictionConfig;

  /** Outstanding predictions, left-to-right on {@link predRow}. */
  private predictions: Prediction[] = [];
  /** Row the current prediction run lives on (0-indexed viewport row). */
  private predRow = 0;
  /** Smoothed echo-confirmation latency (ms), or null before first sample. */
  private echoSrttMs: number | null = null;
  /** Serializes async server-output processing. */
  private tail: Promise<void> = Promise.resolve();
  private disposed = false;
  /**
   * Streaming UTF-8 decoder for byte input. Per-instance and stateful so a
   * multibyte sequence split across two stdin chunks is held (not decoded as
   * U+FFFD and mispredicted) until the trailing bytes arrive.
   */
  private readonly decoder = new TextDecoder();
  /**
   * False only while an in-flight {@link seed} is still applying. Gates
   * optimistic echo so we never predict from an unseeded (0,0) cursor when
   * the user types before the snapshot finishes priming the model.
   */
  private seeded = true;

  constructor(deps: PredictiveEchoDeps) {
    this.model = deps.model;
    this.write = deps.write;
    this.now = deps.now;
    this.getInputSrtt = deps.getInputSrtt;
    this.config = { ...DEFAULT_PREDICTION_CONFIG, ...deps.config };
  }

  /**
   * Prime the confirmed model with bytes already painted to the terminal
   * (e.g. the attach snapshot) so its cursor/content match the real screen
   * before any prediction is made. Does not re-write to the terminal.
   */
  seed(data: string): Promise<void> {
    this.seeded = false;
    this.tail = this.tail
      .then(() => this.model.write(data))
      .then(() => {
        this.seeded = true;
      });
    return this.tail;
  }

  /**
   * Whether predictions should currently render (adaptive on latency).
   * Prefers the live input→ack SRTT so the engine re-engages promptly when
   * latency spikes again after a recovery period; the slow-moving echo EWMA
   * is only a fallback before the first ack.
   */
  private get engaged(): boolean {
    const srtt = this.getInputSrtt() ?? this.echoSrttMs;
    return srtt !== null && srtt >= this.config.engageThresholdMs;
  }

  /** True while at least one optimistic glyph is on screen. */
  get hasPredictions(): boolean {
    return this.predictions.length > 0;
  }

  /** Smoothed echo-confirmation latency in ms, or null. (Diagnostics.) */
  get echoLatencyMs(): number | null {
    return this.echoSrttMs;
  }

  /**
   * The user typed `forward` (the bytes already destined for the agent's
   * PTY, post keybind-parsing). Optimistically echoes the printable tail
   * when engaged and in the safe end-of-line regime.
   */
  onUserInput(forward: string | Uint8Array): void {
    if (this.disposed || !this.seeded || !this.engaged) return;
    if (this.model.isAltScreen()) {
      this.killPredictions();
      return;
    }

    const text = typeof forward === 'string' ? forward : this.decoder.decode(forward, { stream: true });
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      if (code === 0x7f || code === 0x08) {
        this.predictBackspace();
        continue;
      }
      if (isPredictablePrintable(ch)) {
        this.predictPrintable(ch);
        continue;
      }
      // Anything else (Enter, arrows, control bytes) leaves the simple
      // append regime — stop predicting and let the server drive.
      this.killPredictions();
      return;
    }
  }

  /** Optimistically echo one printable char at the predicted cursor. */
  private predictPrintable(ch: string): void {
    const confirmed = this.model.cursor();
    const base = this.predictedCursorCol(confirmed);
    // Only predict appends at the end of the current row's content — the
    // regime where rollback is a safe clear-to-EOL.
    if (this.predictions.length === 0) {
      const rowLen = this.model.rowText(confirmed.row).length;
      if (confirmed.col !== rowLen) return; // mid-line; don't guess
      if (confirmed.col >= this.model.cols() - 1) return; // avoid wrap edge
      this.predRow = confirmed.row;
    } else if (confirmed.row !== this.predRow) {
      // Confirmed cursor wandered off the prediction row; bail.
      this.killPredictions();
      return;
    }
    if (base >= this.model.cols() - 1) return; // would wrap; stay safe

    this.predictions.push({ col: base, ch, at: this.now() });
    // Render underlined glyph at `base`, leaving the real cursor after it.
    this.write(`${cup(this.predRow, base)}${this.config.predictionSgr}${ch}\x1b[0m`);
  }

  /** Roll back the most recent outstanding prediction (local backspace). */
  private predictBackspace(): void {
    const last = this.predictions.pop();
    if (!last) return; // nothing of ours to erase — let the server handle it
    // Erase the glyph: move onto it, clear to end of line (safe — nothing
    // confirmed lives to the right of our predictions in this regime).
    this.write(`${cup(this.predRow, last.col)}\x1b[K`);
  }

  /** Predicted real-cursor column given the confirmed cursor. */
  private predictedCursorCol(confirmed: { row: number; col: number }): number {
    if (this.predictions.length === 0) return confirmed.col;
    return this.predictions[this.predictions.length - 1].col + 1;
  }

  /**
   * Process one server output chunk: pass it through to the terminal and
   * reconcile predictions against the new confirmed state. Ordered via the
   * internal promise chain; callers may fire-and-forget.
   */
  onServerOutput(chunk: string): Promise<void> {
    this.tail = this.tail.then(() => this.processServerChunk(chunk));
    return this.tail;
  }

  private async processServerChunk(chunk: string): Promise<void> {
    if (this.disposed) {
      this.write(chunk);
      return;
    }

    const hadPredictions = this.predictions.length > 0;
    const confirmedBefore = this.model.cursor();
    const predStartCol = hadPredictions ? this.predictions[0].col : 0;

    // 1. Erase our optimistic glyphs and repaint the confirmed row tail
    //    BEFORE the authoritative chunk lands. This both neutralizes the
    //    cursor advance (so cursor-relative server bytes land correctly) and
    //    guarantees we never strand an underline — if the chunk turns out to
    //    move off-regime (newline, alt-screen, cursor jump), there is nothing
    //    left on the old row to clean up.
    if (hadPredictions) {
      this.erasePredictionRegion(predStartCol, confirmedBefore);
    }

    // 2. Pass the authoritative chunk through to the real terminal.
    this.write(chunk);

    // 3. Advance the confirmed model.
    await this.model.write(chunk);
    if (this.disposed) return;
    if (!hadPredictions) return;

    const confirmedAfter = this.model.cursor();

    // 4. Suspend on anything outside the simple append regime: alt-screen, a
    //    different row, or a cursor that retreated (e.g. `\r` + prompt
    //    redraw) rather than advancing through the predicted columns. The
    //    glyphs are already gone (step 1), so this is just dropping state.
    if (
      this.model.isAltScreen() ||
      confirmedAfter.row !== this.predRow ||
      confirmedAfter.col < confirmedBefore.col
    ) {
      this.predictions = [];
      return;
    }

    // 5. Drop predictions the server has now confirmed (its own echo
    //    repainted them during pass-through). A prediction at column <
    //    confirmedAfter.col has been overtaken.
    const stillPending = this.predictions.filter((p) => p.col >= confirmedAfter.col);
    const confirmedCount = this.predictions.length - stillPending.length;
    if (confirmedCount > 0) {
      this.recordEchoLatency(this.predictions[confirmedCount - 1].at);
    }

    // 6. Validate overtaken cells: if the server echoed something other than
    //    what we guessed, the remaining glyphs are suspect — drop them. The
    //    confirmed content is already on screen from step 2.
    const rowText = this.model.rowText(this.predRow);
    for (const p of this.predictions) {
      if (p.col < confirmedAfter.col && rowText[p.col] !== p.ch) {
        this.predictions = [];
        return;
      }
    }

    // 7. Re-render the survivors to the right of the confirmed cursor and
    //    park the real cursor at the predicted column.
    this.predictions = stillPending;
    this.renderPredictions();
  }

  /**
   * Repaint the confirmed row from `startCol` to end-of-line, then restore
   * the cursor to `restoreTo`. Replaces any optimistic glyphs at/after
   * `startCol` with authoritative model content. Only touches columns
   * `>= startCol`, so confirmed output to the left is never clobbered. No-op
   * when the cursor has already left the prediction row (we can't safely
   * repaint a row we no longer own).
   */
  private erasePredictionRegion(startCol: number, restoreTo: { row: number; col: number }): void {
    if (restoreTo.row !== this.predRow) return;
    const tail = this.model.rowText(this.predRow).slice(startCol);
    this.write(`${cup(this.predRow, startCol)}\x1b[K${tail}${cup(restoreTo.row, restoreTo.col)}`);
  }

  /** Draw the outstanding predicted glyphs underlined, parking the cursor
   *  just past the last one. */
  private renderPredictions(): void {
    if (this.predictions.length === 0) return;
    let out = '';
    for (const p of this.predictions) {
      out += `${cup(this.predRow, p.col)}${this.config.predictionSgr}${p.ch}\x1b[0m`;
    }
    out += cup(this.predRow, this.predictions[this.predictions.length - 1].col + 1);
    this.write(out);
  }

  /** Erase all outstanding predicted glyphs and forget them. */
  private killPredictions(): void {
    if (this.predictions.length === 0) return;
    const startCol = this.predictions[0].col;
    this.predictions = [];
    this.erasePredictionRegion(startCol, this.model.cursor());
  }

  /** Public rollback: discard predictions (e.g. an input send failed). */
  rollback(): void {
    this.killPredictions();
  }

  private recordEchoLatency(predictedAt: number): void {
    const sample = this.now() - predictedAt;
    if (!Number.isFinite(sample) || sample < 0) return;
    this.echoSrttMs = this.echoSrttMs === null ? sample : this.echoSrttMs * 0.875 + sample * 0.125;
  }

  onResize(cols: number, rows: number): void {
    this.killPredictions();
    this.model.resize(cols, rows);
  }

  /** Drop all state; subsequent server output is plain pass-through. */
  reset(): void {
    this.killPredictions();
    this.disposed = true;
    this.model.dispose?.();
  }
}
