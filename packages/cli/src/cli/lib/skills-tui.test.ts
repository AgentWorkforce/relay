import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { selectHarnesses, selectScope } from './skills-tui.js';
import { HARNESS_TARGETS } from './skills-install.js';

/**
 * A fake stdin: an EventEmitter with the stream surface the TUI touches.
 * Tests drive it by emitting `keypress` events directly, bypassing the raw
 * byte decoder (we don't need to exercise readline's parser here).
 */
class FakeInput extends EventEmitter {
  isTTY = false;
  isRaw = false;
  setRawMode(v: boolean): this {
    this.isRaw = v;
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
}

class FakeOutput {
  buffer = '';
  write(s: string): boolean {
    this.buffer += s;
    return true;
  }
}

interface KeyPress {
  name: string;
  ctrl?: boolean;
}

/**
 * Build the `{ input, output }` pair for a picker. The picker must be invoked
 * with a freshly-constructed literal (see the call sites), so we hand back the
 * raw fakes and let each test spread them inline.
 */
function fakes(): { input: FakeInput; output: FakeOutput } {
  return { input: new FakeInput(), output: new FakeOutput() };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Emit a sequence of keypresses, yielding a macrotask between each. */
async function drive(input: FakeInput, keys: KeyPress[]): Promise<void> {
  await tick();
  await tick();
  for (const key of keys) {
    input.emit('keypress', '', key);
    await tick();
  }
}

describe('selectScope', () => {
  it('returns the highlighted choice on enter', async () => {
    const { input, output } = fakes();
    const p = selectScope({ input: input as never, output: output as never });
    await drive(input, [{ name: 'down' }, { name: 'return' }]); // move to "global", confirm
    await expect(p).resolves.toBe('global');
  });

  it('returns null when cancelled with Ctrl+C', async () => {
    const { input, output } = fakes();
    const p = selectScope({ input: input as never, output: output as never });
    await drive(input, [{ name: 'c', ctrl: true }]);
    await expect(p).resolves.toBeNull();
  });
});

describe('selectHarnesses', () => {
  it('toggles with space and confirms with enter', async () => {
    const { input, output } = fakes();
    const p = selectHarnesses(HARNESS_TARGETS, { input: input as never, output: output as never });
    await drive(input, [
      { name: 'space' }, // select first (claude)
      { name: 'down' },
      { name: 'space' }, // select second (codex)
      { name: 'return' },
    ]);
    await expect(p).resolves.toEqual(['claude', 'codex']);
  });

  it('"a" selects all, then confirm returns every id', async () => {
    const { input, output } = fakes();
    const p = selectHarnesses(HARNESS_TARGETS, { input: input as never, output: output as never });
    await drive(input, [{ name: 'a' }, { name: 'return' }]);
    await expect(p).resolves.toEqual(HARNESS_TARGETS.map((h) => h.id));
  });

  it('returns null on escape', async () => {
    const { input, output } = fakes();
    const p = selectHarnesses(HARNESS_TARGETS, { input: input as never, output: output as never });
    await drive(input, [{ name: 'escape' }]);
    await expect(p).resolves.toBeNull();
  });
});
