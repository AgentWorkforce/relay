import { describe, expect, it, vi } from 'vitest';

import { exitAfterFlush, flushStdio, flushStream, type FlushableStream } from './flush-stdio.js';

/**
 * A stream that behaves the way a piped stdout does on macOS: the write is
 * accepted immediately, but only completes once the OS has taken the bytes.
 */
function deferredStream(): FlushableStream & { complete: () => void; writes: string[] } {
  const pending: (() => void)[] = [];
  const writes: string[] = [];

  return {
    writes,
    write(chunk: string, callback?: (error?: Error | null) => void): boolean {
      writes.push(chunk);
      if (callback) pending.push(() => callback(null));
      return true;
    },
    complete(): void {
      while (pending.length > 0) pending.shift()?.();
    },
  };
}

describe('flushStream', () => {
  it('waits for the pending write to complete', async () => {
    const stream = deferredStream();
    let drained = false;
    const flushed = flushStream(stream).then(() => {
      drained = true;
    });

    await Promise.resolve();
    expect(drained).toBe(false);

    stream.complete();
    await flushed;
    expect(drained).toBe(true);
  });

  it('gives up after the timeout so a stalled reader cannot wedge the exit', async () => {
    vi.useFakeTimers();
    try {
      const stream = deferredStream();
      const flushed = flushStream(stream, 50);
      await vi.advanceTimersByTimeAsync(50);
      await expect(flushed).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves without writing when there is no usable stream', async () => {
    await expect(flushStream(undefined)).resolves.toBeUndefined();

    const destroyed = { ...deferredStream(), destroyed: true };
    await flushStream(destroyed);
    expect(destroyed.writes).toEqual([]);
  });

  it('resolves when the write itself throws', async () => {
    const stream: FlushableStream = {
      write() {
        throw new Error('EPIPE');
      },
    };

    await expect(flushStream(stream)).resolves.toBeUndefined();
  });
});

describe('flushStdio', () => {
  it('drains every stream it is given', async () => {
    const out = deferredStream();
    const err = deferredStream();
    const flushed = flushStdio({ streams: [out, err] });

    out.complete();
    err.complete();

    await expect(flushed).resolves.toBeUndefined();
    expect(out.writes).toEqual(['']);
    expect(err.writes).toEqual(['']);
  });
});

describe('exitAfterFlush', () => {
  it('exits only once stdio has drained, with the requested code', async () => {
    const out = deferredStream();
    const exit = vi.fn((code: number) => code as never);

    const exited = exitAfterFlush(3, { streams: [out], exit });

    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();

    out.complete();
    await exited;
    expect(exit).toHaveBeenCalledWith(3);
  });
});
