import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { PredictiveEchoEngine, type ScreenModel } from './predictive-echo.js';

/**
 * Minimal deterministic {@link ScreenModel} for engine tests. Interprets just
 * enough of the server byte stream — printable chars advance the cursor, `\r`
 * returns to column 0, `\n` moves down — to drive the prediction/reconcile
 * logic without a real VT emulator.
 */
class FakeScreenModel implements ScreenModel {
  private grid: string[][] = [[]];
  private cy = 0;
  private cx = 0;
  private alt = false;
  private width: number;

  constructor(width = 80) {
    this.width = width;
  }

  setAlt(value: boolean): void {
    this.alt = value;
  }

  write(data: string): Promise<void> {
    for (const ch of data) {
      if (ch === '\r') {
        this.cx = 0;
      } else if (ch === '\n') {
        this.cy += 1;
        if (!this.grid[this.cy]) this.grid[this.cy] = [];
      } else {
        if (!this.grid[this.cy]) this.grid[this.cy] = [];
        this.grid[this.cy][this.cx] = ch;
        this.cx += 1;
      }
    }
    return Promise.resolve();
  }

  cursor(): { row: number; col: number } {
    return { row: this.cy, col: this.cx };
  }

  rowText(row: number): string {
    const cells = this.grid[row] ?? [];
    let s = '';
    for (let i = 0; i < cells.length; i++) s += cells[i] ?? ' ';
    return s.replace(/\s+$/, '');
  }

  isAltScreen(): boolean {
    return this.alt;
  }

  cols(): number {
    return this.width;
  }

  resize(cols: number): void {
    this.width = cols;
  }
}

interface Harness {
  engine: PredictiveEchoEngine;
  model: FakeScreenModel;
  writes: string[];
  tick: (ms: number) => void;
  setSrtt: (ms: number | null) => void;
}

function createHarness(opts: { inputSrtt?: number | null } = {}): Harness {
  const model = new FakeScreenModel();
  const writes: string[] = [];
  let clock = 0;
  let srtt: number | null = opts.inputSrtt ?? null;
  const engine = new PredictiveEchoEngine({
    model,
    write: (s) => writes.push(s),
    now: () => clock,
    getInputSrtt: () => srtt,
    config: { engageThresholdMs: 30, predictionSgr: '\x1b[4m' },
  });
  return {
    engine,
    model,
    writes,
    tick: (ms) => {
      clock += ms;
    },
    setSrtt: (ms) => {
      srtt = ms;
    },
  };
}

const type = (engine: PredictiveEchoEngine, s: string) => engine.onUserInput(Buffer.from(s, 'utf-8'));

describe('PredictiveEchoEngine — adaptive activation', () => {
  it('stays dormant on a fast link (no optimistic echo)', () => {
    const h = createHarness({ inputSrtt: 5 }); // below threshold
    type(h.engine, 'a');
    expect(h.writes).toEqual([]);
    expect(h.engine.hasPredictions).toBe(false);
  });

  it('engages once latency crosses the threshold', () => {
    const h = createHarness({ inputSrtt: 100 });
    type(h.engine, 'a');
    expect(h.engine.hasPredictions).toBe(true);
    // Underlined glyph drawn at row0/col0.
    expect(h.writes.join('')).toBe('\x1b[1;1H\x1b[4ma\x1b[0m');
  });
});

describe('PredictiveEchoEngine — predict then confirm', () => {
  it('confirms a predicted glyph when the server echoes it', async () => {
    const h = createHarness({ inputSrtt: 100 });
    type(h.engine, 'a');
    expect(h.engine.hasPredictions).toBe(true);
    h.writes.length = 0;

    // Server echoes the same char ~40ms later.
    h.tick(40);
    await h.engine.onServerOutput('a');

    // Pass-through repaints 'a' (un-underlined); no predictions remain.
    expect(h.engine.hasPredictions).toBe(false);
    expect(h.writes.join('')).toContain('a');
    // Echo latency was measured.
    expect(h.engine.echoLatencyMs).toBe(40);
  });

  it('keeps later predictions underlined until their own echo lands', async () => {
    const h = createHarness({ inputSrtt: 100 });
    type(h.engine, 'a');
    type(h.engine, 'b');
    expect(h.engine.hasPredictions).toBe(true);
    h.writes.length = 0;

    await h.engine.onServerOutput('a'); // confirms 'a', 'b' still pending
    expect(h.engine.hasPredictions).toBe(true);
    // 'b' re-rendered underlined to the right of the confirmed cursor.
    expect(h.writes.join('')).toContain('\x1b[4mb\x1b[0m');

    await h.engine.onServerOutput('b');
    expect(h.engine.hasPredictions).toBe(false);
  });
});

describe('PredictiveEchoEngine — rollback', () => {
  it('rolls back when the server echoes something different', async () => {
    const h = createHarness({ inputSrtt: 100 });
    type(h.engine, 'x');
    h.writes.length = 0;

    // Server echoes 'Y' instead of 'x' (e.g. an autocorrect / different glyph).
    await h.engine.onServerOutput('Y');

    expect(h.engine.hasPredictions).toBe(false);
    // Clear-to-EOL was emitted to erase the bad prediction.
    expect(h.writes.join('')).toContain('\x1b[K');
  });

  it('suspends predictions when the alternate screen is active', () => {
    const h = createHarness({ inputSrtt: 100 });
    h.model.setAlt(true);
    type(h.engine, 'a');
    expect(h.engine.hasPredictions).toBe(false);
    expect(h.writes).toEqual([]);
  });
});

describe('PredictiveEchoEngine — backspace', () => {
  it('erases the most recent prediction on backspace', () => {
    const h = createHarness({ inputSrtt: 100 });
    type(h.engine, 'a');
    type(h.engine, 'b');
    expect(h.engine.hasPredictions).toBe(true);
    h.writes.length = 0;

    type(h.engine, '\x7f'); // DEL
    // 'b' erased; one prediction ('a') remains.
    expect(h.writes.join('')).toContain('\x1b[K');
    type(h.engine, '\x7f'); // erase 'a' too
    type(h.engine, '\x7f'); // nothing left — no-op for our overlay
    expect(h.engine.hasPredictions).toBe(false);
  });
});

describe('PredictiveEchoEngine — ordering', () => {
  it('processes concurrent server output in order', async () => {
    const h = createHarness({ inputSrtt: 100 });
    type(h.engine, 'a');

    // Fire two chunks without awaiting the first.
    const p1 = h.engine.onServerOutput('a');
    const p2 = h.engine.onServerOutput('b');
    await Promise.all([p1, p2]);

    expect(h.model.rowText(0)).toBe('ab');
  });
});

describe('PredictiveEchoEngine — non-printable input', () => {
  it('does not predict for Enter / control bytes', () => {
    const h = createHarness({ inputSrtt: 100 });
    type(h.engine, '\r');
    expect(h.engine.hasPredictions).toBe(false);
    expect(h.writes).toEqual([]);
  });

  it('does not predict wide / non-ASCII characters', () => {
    const h = createHarness({ inputSrtt: 100 });
    type(h.engine, '中'); // CJK, two columns — would desync cursor math
    expect(h.engine.hasPredictions).toBe(false);
    expect(h.writes.join('')).not.toContain('\x1b[4m');
  });
});

describe('PredictiveEchoEngine — adaptive re-engagement', () => {
  it('re-engages when latency climbs again after a quiet period', () => {
    const h = createHarness({ inputSrtt: 5 }); // below threshold → dormant
    type(h.engine, 'a');
    expect(h.engine.hasPredictions).toBe(false);

    h.setSrtt(100); // latency spikes back up
    type(h.engine, 'b');
    expect(h.engine.hasPredictions).toBe(true);
    expect(h.writes.join('')).toContain('\x1b[4m');
  });
});

describe('PredictiveEchoEngine — off-regime safety', () => {
  it('suspends (without stranding glyphs) when output moves to a new row', async () => {
    const h = createHarness({ inputSrtt: 100 });
    type(h.engine, 'a');
    expect(h.engine.hasPredictions).toBe(true);

    await h.engine.onServerOutput('\n'); // cursor leaves the prediction row
    expect(h.engine.hasPredictions).toBe(false);
  });

  it('rolls back on a same-row cursor retreat without erasing confirmed output', async () => {
    const h = createHarness({ inputSrtt: 100 });
    await h.model.write('hello'); // confirmed prompt; cursor at col 5
    type(h.engine, 'a'); // predicted at col 5
    expect(h.engine.hasPredictions).toBe(true);
    h.writes.length = 0;

    await h.engine.onServerOutput('\r'); // carriage return — cursor retreats
    expect(h.engine.hasPredictions).toBe(false);
    // Erased only from the predicted column (5) rightward; 'hello' intact.
    expect(h.writes.join('')).toContain('\x1b[K');
    expect(h.model.rowText(0)).toBe('hello');
  });
});

describe('PredictiveEchoEngine — explicit rollback', () => {
  it('discards predictions on rollback() (e.g. a failed send)', () => {
    const h = createHarness({ inputSrtt: 100 });
    type(h.engine, 'a');
    expect(h.engine.hasPredictions).toBe(true);
    h.writes.length = 0;

    h.engine.rollback();
    expect(h.engine.hasPredictions).toBe(false);
    expect(h.writes.join('')).toContain('\x1b[K');
  });
});

describe('PredictiveEchoEngine — seed gate', () => {
  it('does not predict until an in-flight seed has applied', async () => {
    const h = createHarness({ inputSrtt: 100 });
    const seeding = h.engine.seed(''); // seeded := false synchronously
    type(h.engine, 'a');
    expect(h.engine.hasPredictions).toBe(false);

    await seeding;
    type(h.engine, 'a');
    expect(h.engine.hasPredictions).toBe(true);
  });
});
