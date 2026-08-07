import { describe, expect, it, vi } from 'vitest';

import {
  createInputStreamRecovery,
  isBackpressureRejection,
  type InputStreamRecoveryOptions,
} from './attach-input-recovery.js';
import type { CliPtyInputStream } from './attach-drive.js';

class FakeStream implements CliPtyInputStream {
  closed = false;
  closeReason?: string;
  readonly writes: string[] = [];

  constructor(private readonly openError?: Error) {}

  async waitUntilOpen(): Promise<void> {
    if (this.openError) throw this.openError;
  }

  async send(data: string): Promise<{ name: string; bytes_written: number }> {
    if (this.closed) throw new Error('PTY input stream is closed');
    this.writes.push(data);
    return { name: 'agent', bytes_written: data.length };
  }

  close(_code?: number, reason?: string): void {
    this.closed = true;
    this.closeReason = reason;
  }
}

/** Builds a recovery helper over controllable streams and records its output. */
function harness(overrides: Partial<InputStreamRecoveryOptions> = {}) {
  const logs: string[] = [];
  const errors: string[] = [];
  const opened: FakeStream[] = [];
  let current: CliPtyInputStream | null = new FakeStream();
  const first = current as FakeStream;
  let settled = false;
  let exhausted = 0;
  let rollbacks = 0;

  const recovery = createInputStreamRecovery({
    label: 'drive',
    name: 'Alice',
    maxAttempts: 2,
    baseDelayMs: 1,
    attemptTimeoutMs: 50,
    log: (m) => logs.push(m),
    error: (m) => errors.push(m),
    isSettled: () => settled,
    getStream: () => current,
    setStream: (s) => {
      current = s;
    },
    openStream: () => {
      const s = new FakeStream();
      opened.push(s);
      return s;
    },
    onRollback: () => {
      rollbacks += 1;
    },
    onExhausted: () => {
      exhausted += 1;
    },
    verifyIdentity: async () => ({ ok: true }),
    ...overrides,
  });

  return {
    recovery,
    logs,
    errors,
    opened,
    first,
    getCurrent: () => current,
    settle: () => {
      settled = true;
    },
    counts: () => ({ exhausted, rollbacks }),
  };
}

const settle = async (turns = 80): Promise<void> => {
  for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 1));
};

describe('isBackpressureRejection', () => {
  it('recognises the transport code and nothing else', () => {
    expect(isBackpressureRejection(Object.assign(new Error('x'), { code: 'input_backpressure' }))).toBe(true);
    expect(isBackpressureRejection(Object.assign(new Error('x'), { code: 'input_stream_closed' }))).toBe(
      false
    );
    expect(isBackpressureRejection(new Error('write EPIPE'))).toBe(false);
    expect(isBackpressureRejection(null)).toBe(false);
    expect(isBackpressureRejection('input_backpressure')).toBe(false);
  });
});

describe('handleSendFailure', () => {
  it('does not start recovery for backpressure, and reports it once per episode', () => {
    // Backpressure leaves the socket open and usable; recovering would close a
    // healthy stream and drop outstanding input. Fails if the stream is torn
    // down, or if fifty rejections produce fifty lines.
    const h = harness();
    const backpressure = Object.assign(new Error('over high water mark'), {
      code: 'input_backpressure',
    });

    for (let i = 0; i < 50; i++) h.recovery.handleSendFailure(backpressure);

    expect(h.recovery.isRecovering()).toBe(false);
    expect(h.getCurrent()).toBe(h.first);
    expect(h.first.closed).toBe(false);
    expect(h.logs.filter((l) => l.includes('faster than'))).toHaveLength(1);
    // Every dropped keystroke still has its optimistic echo rolled back.
    expect(h.counts().rollbacks).toBe(50);
  });

  it('reports a second episode after the stream recovers', () => {
    const h = harness();
    const backpressure = Object.assign(new Error('over'), { code: 'input_backpressure' });
    h.recovery.handleSendFailure(backpressure);
    h.recovery.noteSendSuccess();
    h.recovery.handleSendFailure(backpressure);
    expect(h.logs.filter((l) => l.includes('faster than'))).toHaveLength(2);
  });

  it('treats every other rejection as stream loss', () => {
    const h = harness();
    h.recovery.handleSendFailure(
      Object.assign(new Error('PTY input stream is closed'), { code: 'input_stream_closed' })
    );
    expect(h.recovery.isRecovering()).toBe(true);
    expect(h.logs.some((l) => l.includes('input stream lost'))).toBe(true);
  });
});

describe('identity verification is mandatory', () => {
  it('refuses the reopen when no verifier is supplied', async () => {
    // The type requires it; this proves the runtime refuses too, so a JS
    // caller or a partial double cannot reach the unguarded path. Fails if the
    // replacement is adopted — that is the keystroke-misrouting hole.
    const h = harness({
      verifyIdentity: undefined as unknown as InputStreamRecoveryOptions['verifyIdentity'],
    });

    h.recovery.recover('stream closed');
    await settle();

    expect(h.getCurrent()).toBeNull();
    expect(h.counts().exhausted).toBe(1);
    expect(h.errors.some((e) => e.includes('no worker identity verifier was supplied'))).toBe(true);
    // The socket it opened was closed rather than left live and unowned.
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0].closed).toBe(true);
  });

  it('refuses when the verifier throws, instead of stranding the session', async () => {
    const h = harness({
      verifyIdentity: async () => {
        throw new Error('broker unreachable');
      },
    });

    h.recovery.recover('stream closed');
    await settle();

    expect(h.getCurrent()).toBeNull();
    expect(h.counts().exhausted).toBe(1);
    expect(h.errors.some((e) => e.includes('identity check failed: broker unreachable'))).toBe(true);
  });

  it('refuses when the verifier stalls past the attempt timeout', async () => {
    // Without a deadline a hung broker call parks the session in recovery
    // forever, so neither the attempt count nor the non-zero exit is bounded.
    const h = harness({
      attemptTimeoutMs: 20,
      verifyIdentity: () => new Promise(() => {}),
    });

    h.recovery.recover('stream closed');
    await settle(120);

    expect(h.counts().exhausted).toBe(1);
    expect(h.errors.some((e) => e.includes('timed out'))).toBe(true);
  });
});

describe('stream ownership on every exit path', () => {
  it('closes the replacement when the open attempt fails', async () => {
    const failing: FakeStream[] = [];
    const h = harness({
      openStream: () => {
        const s = new FakeStream(new Error('refused'));
        failing.push(s);
        return s;
      },
    });

    h.recovery.recover('stream closed');
    await settle();

    // Two attempts, both abandoned — neither socket may be left unowned.
    expect(failing).toHaveLength(2);
    expect(failing.every((s) => s.closed)).toBe(true);
    expect(h.counts().exhausted).toBe(1);
  });

  it('closes the replacement when the session settles during verification', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness({
      verifyIdentity: async () => {
        await gate;
        return { ok: true };
      },
    });

    h.recovery.recover('stream closed');
    await settle(20);
    expect(h.opened).toHaveLength(1);

    h.settle(); // user detaches mid-verification
    release?.();
    await settle(20);

    // Teardown can't see this stream (it was never handed over), so the attempt
    // itself has to close it or it leaks a live socket.
    expect(h.opened[0].closed).toBe(true);
    expect(h.getCurrent()).toBeNull();
  });
});

describe('cancel', () => {
  it('ends the recovery loop instead of leaving it permanently recovering', async () => {
    // Clearing the timer alone left the backoff promise unresolved forever, so
    // `inFlight` never cleared and detach cleanup could not complete.
    const h = harness({ baseDelayMs: 10_000 });

    h.recovery.recover('stream closed');
    expect(h.recovery.isRecovering()).toBe(true);

    h.settle();
    h.recovery.cancel();
    await settle(20);

    expect(h.recovery.isRecovering()).toBe(false);
    // Cancellation is not a failure: no exhaustion exit, no new socket.
    expect(h.counts().exhausted).toBe(0);
    expect(h.opened).toHaveLength(0);
  });
});

describe('recover', () => {
  it('adopts a verified replacement and announces it once', async () => {
    const verify = vi.fn(async () => ({ ok: true as const }));
    const h = harness({ verifyIdentity: verify });

    h.recovery.recover('stream closed');
    await settle();

    expect(h.getCurrent()).toBe(h.opened[0]);
    expect(h.opened[0].closed).toBe(false);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(h.logs.filter((l) => l.includes('reconnected'))).toHaveLength(1);
    expect(h.first.closed).toBe(true); // the dead handle was released
  });
});
