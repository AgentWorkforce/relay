/**
 * Flush `process.stdout` / `process.stderr` before a hard exit.
 *
 * Why this exists: Node's stdio writes are only synchronous for files and for
 * POSIX TTYs. Pipes and sockets are **asynchronous on macOS**, so a
 * `process.exit()` in the same tick as a `console.log()` throws away whatever
 * is still buffered. The visible symptom is a command that prints fine in a
 * terminal and prints *nothing* when piped or captured with `$(...)` — the
 * `--json` payload disappears, and so does the error text that would have
 * explained why the command failed.
 *
 * Every exit path that goes through a real `process.exit(code)` should await
 * {@link exitAfterFlush} instead, which drains both streams first. The drain
 * is bounded by a timeout so a stalled reader can never wedge the exit.
 */

/** Minimal writable surface we need; keeps the helper testable. */
export interface FlushableStream {
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
  readonly destroyed?: boolean;
  readonly writableEnded?: boolean;
}

/** How long to wait for a single stream to drain before giving up on it. */
export const DEFAULT_FLUSH_TIMEOUT_MS = 2_000;

export interface FlushOptions {
  /** Streams to drain. Defaults to `[process.stdout, process.stderr]`. */
  streams?: (FlushableStream | undefined)[];
  /** Per-stream drain budget. Defaults to {@link DEFAULT_FLUSH_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * Resolve once everything already written to `stream` has reached the OS.
 *
 * A zero-length write is queued behind the pending chunks, so its completion
 * callback fires only after those chunks have been written — which is exactly
 * the signal we lack on platforms where stdio is asynchronous. Errors (a
 * closed pipe, for instance) resolve too: we are on our way out either way.
 */
export function flushStream(
  stream: FlushableStream | undefined,
  timeoutMs: number = DEFAULT_FLUSH_TIMEOUT_MS
): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!stream || typeof stream.write !== 'function' || stream.destroyed || stream.writableEnded) {
      resolve();
      return;
    }

    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(settle, timeoutMs);
    // Never let the flush watchdog be the reason the process stays alive.
    timer.unref?.();

    try {
      stream.write('', () => settle());
    } catch {
      settle();
    }
  });
}

/** Drain stdout and stderr concurrently. Never rejects. */
export async function flushStdio(options: FlushOptions = {}): Promise<void> {
  const streams = options.streams ?? [process.stdout, process.stderr];
  const timeoutMs = options.timeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
  await Promise.all(streams.map((stream) => flushStream(stream, timeoutMs)));
}

export interface ExitAfterFlushOptions extends FlushOptions {
  /** Injectable for tests; defaults to the real `process.exit`. */
  exit?: (code: number) => never;
}

/**
 * Drain stdio, then exit with `code`.
 *
 * Returns `Promise<never>` because the default `exit` does not return; the
 * declared return type keeps call sites from needing an unreachable `return`.
 */
export async function exitAfterFlush(code: number, options: ExitAfterFlushOptions = {}): Promise<never> {
  await flushStdio(options);
  const exit = options.exit ?? ((value: number) => process.exit(value));
  return exit(code);
}
