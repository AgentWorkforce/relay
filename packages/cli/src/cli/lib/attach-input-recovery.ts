/**
 * Recovery for a lost PTY input stream, shared by `attach --mode drive` and
 * `attach --mode passthrough`.
 *
 * The SDK's `PtyInputStream` never reopens itself. Once its socket closes the
 * `closed` flag latches and every later `send()` rejects immediately with
 * `PTY input stream is closed`. That close is easy to hit and easy to miss: the
 * broker pings the *events* WebSocket every 30s but never pings the *input*
 * WebSocket, so an idle input socket is silent on the wire and any idle timeout
 * between client and broker kills it alone — the screen keeps updating while
 * input is permanently dead. A broker-side write error (PTY worker restart)
 * closes it the same way.
 *
 * Before this, both attach modes caught that rejection per keystroke, logged
 * it, and returned. Nothing tore the session down, so the line repeated for as
 * long as stdin produced bytes. There was no retry loop — the repetition was
 * 1:1 with inbound chunks, and since the keybind parser forwards every byte
 * except Ctrl+C / Ctrl+], a source TUI with mouse tracking enabled flooded the
 * terminal on pointer movement alone, with the human never touching a key.
 *
 * This turns that into one liveness event: report once, reopen with bounded
 * exponential backoff, and on exhaustion hand control back to the caller so the
 * session exits non-zero. A dead seat that looks alive is the defect; a
 * readable exit a supervisor can act on is the contract (#1419).
 */

import type { CliPtyInputStream } from './attach-drive.js';

/** Default number of reopen attempts before a lost input stream ends the session. */
export const INPUT_REOPEN_MAX_ATTEMPTS = 5;
/** Default base delay for the reopen backoff; doubles per attempt. */
export const INPUT_REOPEN_BASE_DELAY_MS = 250;
/** Ceiling on the doubled reopen delay. */
export const INPUT_REOPEN_MAX_DELAY_MS = 4_000;
/** Ceiling on one attempt's open wait and identity check. */
export const INPUT_REOPEN_ATTEMPT_TIMEOUT_MS = 15_000;

/**
 * `PtyInputStream.send()` rejects with `input_backpressure` when queued bytes
 * would exceed its high-water mark — **while the stream is open and healthy**
 * (`transport.ts:206-214`, `retryable: true`). That is flow control, not
 * transport death: tearing the socket down and reopening it would drop every
 * outstanding keystroke and re-run the identity gate, turning a slow broker
 * into a detach. Every other rejection means the stream is gone or unusable.
 */
export function isBackpressureRejection(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'input_backpressure'
  );
}

export interface InputStreamRecoveryOptions {
  /** Log prefix tag — `drive` or `passthrough`. */
  label: string;
  /** Agent name, used in the operator-facing exhaustion message. */
  name: string;
  /** Attempts before giving up. `0` disables recovery: the first loss exits. */
  maxAttempts: number;
  /** Base backoff delay in ms; doubles per attempt up to the max. */
  baseDelayMs: number;
  log: (message: string) => void;
  error: (message: string) => void;
  /** True once the session has begun tearing down; stops all recovery work. */
  isSettled: () => boolean;
  getStream: () => CliPtyInputStream | null;
  setStream: (stream: CliPtyInputStream | null) => void;
  /** Opens a replacement stream. May throw; a throw counts as a failed attempt. */
  openStream: () => CliPtyInputStream;
  /** Drop optimistic echo for keystrokes that never reached the PTY. */
  onRollback: () => void;
  /** Called when every attempt failed. Callers exit non-zero here. */
  onExhausted: () => void;
  /**
   * Proves the reopened stream reached the SAME worker process the session
   * originally attached to. Called after every successful reopen, before a
   * single byte is forwarded.
   *
   * **Required, deliberately.** The input stream is reopened *by agent name*,
   * and a name is not an identity: if the worker died and something else
   * claimed the name, a "successful" reopen would quietly route the human's
   * keystrokes into a different agent's PTY. Restarting the same agent is
   * equally wrong for input safety — keystrokes typed for the old session's
   * context would land in a fresh shell. An optional verifier is not a gate,
   * because the unsafe path is then reachable by omission.
   *
   * Must fail closed: anything other than a positive match — identity
   * unavailable, unreadable, or changed — has to return `ok: false` so the
   * session exits loudly instead of reattaching on a guess. Throwing is also
   * treated as a refusal; a verifier that cannot answer has not said yes.
   */
  verifyIdentity: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * Ceiling on a single reopen attempt's open and identity-verify waits.
   * Without it a stalled socket or a hung broker call parks the session in
   * recovery forever, so neither the attempt count nor the non-zero exhaustion
   * exit is actually bounded. Defaults to
   * {@link INPUT_REOPEN_ATTEMPT_TIMEOUT_MS}.
   */
  attemptTimeoutMs?: number;
}

function describeSendError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export interface InputStreamRecovery {
  /**
   * True when `stream` is present and not known-dead. Callers check this
   * *before* sending, so a dead stream costs one liveness event instead of one
   * rejected promise (and one log line) per keystroke. A type predicate so the
   * caller's handle narrows to non-null on the sending path.
   */
  isUsable(stream: CliPtyInputStream | null): stream is CliPtyInputStream;
  /** True while a reopen is in flight. */
  isRecovering(): boolean;
  /** Begin recovery. No-ops if already recovering or settled. */
  recover(reason: string): void;
  /**
   * Classify a rejected `send()`. Backpressure is flow control on a healthy
   * stream and only costs the optimistic echo; everything else is treated as
   * transport loss and enters recovery. Callers route every send rejection
   * here rather than assuming loss.
   */
  handleSendFailure(error: unknown): void;
  /** Clears the backpressure latch so a later episode reports again. */
  noteSendSuccess(): void;
  /** Cancel a pending backoff timer (detach mid-recovery). */
  cancel(): void;
}

export function createInputStreamRecovery(options: InputStreamRecoveryOptions): InputStreamRecovery {
  const {
    label,
    name,
    maxAttempts,
    baseDelayMs,
    log,
    error,
    isSettled,
    getStream,
    setStream,
    openStream,
    onRollback,
    onExhausted,
    verifyIdentity,
  } = options;

  const attemptTimeoutMs = options.attemptTimeoutMs ?? INPUT_REOPEN_ATTEMPT_TIMEOUT_MS;

  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Resolves the pending backoff wait on cancel. Clearing the timer alone left
   * that promise permanently unresolved, so the recovery loop never finished,
   * `inFlight` never cleared, and `isRecovering()` stayed true forever — detach
   * cleanup could not complete.
   */
  let releaseBackoff: (() => void) | null = null;
  /** True once a backpressure episode has been reported; reset on the next good send. */
  let backpressureReported = false;

  const cancel = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    // Wake the loop so it observes `isSettled()` and unwinds, rather than
    // parking on a timer that will never fire.
    releaseBackoff?.();
    releaseBackoff = null;
  };

  /**
   * Rejects with a timeout rather than waiting forever. `waitUntilOpen()` and
   * the identity check both cross the network; neither is bounded by this
   * helper otherwise, and an unbounded await makes `maxAttempts` a fiction.
   */
  const withDeadline = async <T>(work: Promise<T>, what: string): Promise<T> => {
    let handle: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          handle = setTimeout(
            () => reject(new Error(`${what} timed out after ${attemptTimeoutMs}ms`)),
            attemptTimeoutMs
          );
          handle.unref?.();
        }),
      ]);
    } finally {
      if (handle !== undefined) clearTimeout(handle);
    }
  };

  const isUsable = (stream: CliPtyInputStream | null): stream is CliPtyInputStream =>
    stream !== null && stream.closed !== true;

  const closeQuietly = (stream: CliPtyInputStream, why: string): void => {
    try {
      stream.close(1000, why);
    } catch {
      // best effort
    }
  };

  const noteSendSuccess = (): void => {
    backpressureReported = false;
  };

  const handleSendFailure = (sendError: unknown): void => {
    if (isBackpressureRejection(sendError)) {
      // Flow control on a healthy stream. The keystroke did not reach the PTY,
      // so the optimistic echo still has to come off the screen — but the
      // socket is fine and must not be torn down. Report once per episode:
      // per-keystroke reporting here would rebuild the exact flood this module
      // exists to remove.
      onRollback();
      if (!backpressureReported) {
        backpressureReported = true;
        log(
          `[${label}] input is arriving faster than ${name} can accept it; dropping keystrokes until it catches up.`
        );
      }
      return;
    }
    recover(describeSendError(sendError));
  };

  const recover = (reason: string): void => {
    if (isSettled() || inFlight) return;

    // Drop the dead handle first: `isUsable()` then short-circuits every chunk
    // that arrives mid-recovery, which is what actually silences the flood.
    const dead = getStream();
    setStream(null);
    try {
      dead?.close(1000, `${label} client replacing input stream`);
    } catch {
      // best effort — already closed in the common case
    }
    onRollback();

    if (maxAttempts <= 0) {
      error(
        `[${label}] input stream lost (${reason}); reconnect is disabled. ` +
          `Detaching — ${name} is still running; reattach to resume.`
      );
      onExhausted();
      return;
    }

    // One line for the outage, not one per keystroke.
    log(`[${label}] input stream lost (${reason}); reconnecting…`);

    /**
     * One reopen attempt. `'settled'` means the session went away mid-attempt,
     * `'retry'` a transport failure worth another go, and `'rejected'` a
     * replacement that opened but could not be vouched for — which must not be
     * retried, because a replaced worker does not become the original one on a
     * later attempt.
     *
     * `attemptReopen` owns `replacement` on **every** exit path. `openStream()`
     * creates the socket eagerly, so any return that does not hand it to
     * `setStream` must close it or leak a live WebSocket with no owner — which
     * can also keep the process alive after a clean detach.
     */
    const attemptReopen = async (attempt: number): Promise<'opened' | 'retry' | 'rejected' | 'settled'> => {
      let replacement: CliPtyInputStream | null = null;
      try {
        replacement = openStream();
        await withDeadline(replacement.waitUntilOpen(), 'input stream open');
      } catch {
        // Stay quiet between attempts. The human saw one line when the outage
        // started and sees exactly one more when it resolves either way;
        // narrating each failed retry would rebuild the flood.
        if (replacement) closeQuietly(replacement, `${label} client abandoning attempt`);
        return 'retry';
      }
      if (isSettled()) {
        closeQuietly(replacement, `${label} client exiting`);
        return 'settled';
      }

      // The socket is open, but "open" only proves the name resolved. Do not
      // hand the human's keystrokes to it until it is the same worker.
      //
      // The type makes `verifyIdentity` mandatory; this enforces it at runtime
      // too. A JS caller, a partial test double, or a future refactor that
      // drops the field must not silently reach the unguarded path — the whole
      // point is that reattaching by name is unsafe without a check.
      if (typeof verifyIdentity !== 'function') {
        closeQuietly(replacement, `${label} client rejected replacement`);
        error(
          `[${label}] input stream reopened but no worker identity verifier was supplied, ` +
            `so it cannot be shown to be the same worker. Refusing to forward input. ` +
            `Detaching; reattach to ${name} to continue.`
        );
        return 'rejected';
      }

      // A verifier that throws or stalls has not said yes, so both collapse
      // into the same refusal rather than escaping and stranding the session
      // with no stream and no exit.
      const verdict = await withDeadline(verifyIdentity(), 'worker identity check').catch(
        (verifyError: unknown) => ({
          ok: false as const,
          reason:
            verifyError instanceof Error
              ? `identity check failed: ${verifyError.message}`
              : `identity check failed: ${String(verifyError)}`,
        })
      );
      if (isSettled()) {
        closeQuietly(replacement, `${label} client exiting`);
        return 'settled';
      }
      if (!verdict.ok) {
        closeQuietly(replacement, `${label} client rejected replacement`);
        error(
          `[${label}] input stream reopened but it is not the same worker (${verdict.reason}). ` +
            `Refusing to forward input — your keystrokes would go somewhere you did not attach to. ` +
            `Detaching; reattach to ${name} to continue.`
        );
        return 'rejected';
      }

      setStream(replacement);
      log(`[${label}] input stream reconnected after ${attempt} attempt(s)`);
      return 'opened';
    };

    inFlight = (async () => {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (isSettled()) return;
        const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), INPUT_REOPEN_MAX_DELAY_MS);
        await new Promise<void>((resolve) => {
          releaseBackoff = resolve;
          timer = setTimeout(resolve, delay);
          timer.unref?.();
        });
        timer = null;
        releaseBackoff = null;
        if (isSettled()) return;

        const outcome = await attemptReopen(attempt);
        if (outcome === 'opened' || outcome === 'settled') return;
        if (outcome === 'rejected') {
          onExhausted();
          return;
        }
      }
      if (isSettled()) return;
      error(
        `[${label}] input stream could not be reopened after ${maxAttempts} attempts (${reason}). ` +
          `Detaching — ${name} is still running; reattach to resume.`
      );
      onExhausted();
    })().finally(() => {
      inFlight = null;
    });
  };

  return {
    isUsable,
    isRecovering: () => inFlight !== null,
    recover,
    handleSendFailure,
    noteSendSuccess,
    cancel,
  };
}
