/**
 * {@link ScreenModel} backed by a headless `xterm` terminal. Kept separate
 * from the prediction engine so the engine can be unit-tested against a
 * deterministic fake without spinning up a real VT emulator.
 *
 * `@xterm/headless` is CommonJS with a default export, and its `write()` is
 * asynchronous — buffer state only reflects the data once the write callback
 * fires — so {@link XtermScreenModel.write} resolves on that callback and the
 * engine awaits it before reading cursor/row state.
 */

import xtermHeadless from '@xterm/headless';

import { PredictiveEchoEngine, type PredictiveEcho, type ScreenModel } from '@agent-relay/harness-driver';

const { Terminal } = xtermHeadless;

export interface XtermScreenModelOptions {
  cols: number;
  rows: number;
}

class XtermScreenModel implements ScreenModel {
  private readonly term: InstanceType<typeof Terminal>;

  constructor(options: XtermScreenModelOptions) {
    this.term = new Terminal({
      cols: Math.max(options.cols, 1),
      rows: Math.max(options.rows, 1),
      allowProposedApi: true,
      // No scrollback needed — we only reason about the visible viewport.
      scrollback: 0,
    });
  }

  write(data: string): Promise<void> {
    return new Promise((resolve) => {
      this.term.write(data, resolve);
    });
  }

  cursor(): { row: number; col: number } {
    const buffer = this.term.buffer.active;
    return { row: buffer.cursorY, col: buffer.cursorX };
  }

  rowText(row: number): string {
    const buffer = this.term.buffer.active;
    const line = buffer.getLine(buffer.baseY + row);
    // translateToString(true) trims trailing whitespace cells.
    return line ? line.translateToString(true) : '';
  }

  isAltScreen(): boolean {
    return this.term.buffer.active.type === 'alternate';
  }

  cols(): number {
    return this.term.cols;
  }

  resize(cols: number, rows: number): void {
    this.term.resize(Math.max(cols, 1), Math.max(rows, 1));
  }

  dispose(): void {
    this.term.dispose();
  }
}

/** Construct an xterm-backed {@link ScreenModel}. */
export function createXtermScreenModel(options: XtermScreenModelOptions): XtermScreenModel {
  return new XtermScreenModel(options);
}

export type { XtermScreenModel };

export interface CreatePredictiveEchoOptions {
  cols: number;
  rows: number;
  /** Writes raw bytes/escape sequences to the real terminal. */
  write: (data: string) => void;
  /** Latest input→ack SRTT (ms) from the PTY input stream, or null. */
  getInputSrtt: () => number | null;
}

/**
 * Default {@link PredictiveEcho} factory used by the interactive attach
 * clients: an {@link PredictiveEchoEngine} backed by a headless xterm model.
 * Returns null for a degenerate (zero-size) terminal, where prediction makes
 * no sense and the caller falls back to plain pass-through.
 */
export function createPredictiveEcho(opts: CreatePredictiveEchoOptions): PredictiveEcho | null {
  if (opts.cols <= 0 || opts.rows <= 0) return null;
  const model = createXtermScreenModel({ cols: opts.cols, rows: opts.rows });
  return new PredictiveEchoEngine({
    model,
    write: opts.write,
    now: () => Date.now(),
    getInputSrtt: opts.getInputSrtt,
  });
}
