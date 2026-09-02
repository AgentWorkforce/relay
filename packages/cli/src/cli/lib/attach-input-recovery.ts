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

import { Buffer } from 'node:buffer';

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
 * Maximum input retained during one outage. A human can type comfortably for
 * the complete retry window, while a runaway paste or mouse-report stream
 * cannot grow memory without bound.
 */
export const INPUT_REPLAY_BUFFER_MAX_BYTES = 64 * 1024;

/**
 * `PtyInputStream.send()` rejects with `input_backpressure` when queued bytes
 * would exceed its high-water mark — **while the stream is open and healthy**
 * (`transport.ts:206-214`, `retryable: true`). That is flow control, not
 * transport death: tearing the socket down and reopening it would drop every
 * outstanding keystroke and re-run the identity gate, turning a slow broker
 * into a detach. See {@link isWriteTimeoutRejection} for the other rejection
 * that must not trigger a teardown; every remaining rejection means the
 * stream is gone or unusable.
 */
export function isBackpressureRejection(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'input_backpressure'
  );
}

/**
 * `PtyInputStream.send()` rejects with `worker_timeout` when the broker's
 * `write_pty` ack for THAT ONE keystroke didn't arrive before
 * `PTY_INPUT_ACK_TIMEOUT` (broker `api.rs`). That does not mean the worker is
 * dead: a confirmed-dead worker is reaped independently and surfaces as
 * `worker_disappeared`, and the broker keeps this WebSocket open for
 * `worker_timeout` specifically (`pty_input_error_is_connection_fatal`,
 * `listen_api.rs`) because a busy-but-alive coding agent that hasn't drained
 * its stdin yet produces the exact same "no ack yet" as a wedged one — the
 * broker has no other liveness signal to tell them apart. Tearing the whole
 * input stream down and reconnecting over one slow ack is what produced the
 * self-healing "input stream lost / reconnected after 1 attempt(s)" flap
 * reported in relay#1544.
 *
 * Critically, a late ack is not a failed write: the broker's `write_all()`
 * onto the PTY master is still blocking and pending when the ack times out,
 * and it very likely completes once the busy child drains its stdin — the
 * keystroke lands anyway. Rolling back the optimistic echo here would show
 * the operator input vanishing right before it executes, a UI lie that is
 * worse than the flap this module exists to fix and that the operator cannot
 * recover from (they cannot tell whether it is safe to retype). So this code
 * must NOT roll back the echo. Only a *confirmed* write failure — a different
 * error code entirely — may roll it back, and that already falls through to
 * {@link createInputStreamRecovery}'s default `recover()` path below.
 */
export function isWriteTimeoutRejection(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'worker_timeout'
  );
}

/**
 * `PtyInputStream.send()` rejects with `pty_write_queue_full` when the worker
 * refused THAT ONE write because relay-pty's bounded drainer queue is full
 * (`WRITE_QUEUE_DEPTH`, `crates/relay-pty/src/pty.rs`). The child is alive and
 * the socket is healthy — the drainer is parked in `write_all` behind a child
 * that has momentarily stopped reading its stdin, which is the normal state of
 * a TUI harness mid-tool-call.
 *
 * This must not enter recovery. Reconnecting cannot drain the queue — it
 * empties when the child resumes reading, not when a new socket opens — so a
 * teardown here produced exactly one flap per keystroke for as long as the
 * agent stayed busy (`input stream lost … / reconnected after 1 attempt(s)`,
 * relay#1597). The broker keeps the connection open for this code for the same
 * reason (`pty_input_error_is_connection_fatal`, `listen_api.rs`).
 *
 * Unlike {@link isWriteTimeoutRejection} this IS a confirmed refusal: the byte
 * was never enqueued and will never reach the child, so the optimistic echo has
 * to come back off the screen. Note the queue is shared with terminal-query
 * replies, injected messages and auto-responder writes, so the operator whose
 * keystroke is refused is usually not the one who filled it — the message must
 * not blame their typing speed.
 */
export function isWriteRefusedRejection(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'pty_write_queue_full'
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
  /** Reset caller-owned decoder state when buffered input is discarded. */
  onBufferedInputDiscarded?: () => void;
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
  /** Deterministic test seam for the bounded outage-input buffer. */
  bufferLimitBytes?: number;
}

function describeSendError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

class InputRecoveryDeadlineError extends Error {
  constructor(
    readonly operation: string,
    timeoutMs: number
  ) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = 'InputRecoveryDeadlineError';
  }
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
  /** Begin recovery, or append input when recovery is already active. No-ops if settled. */
  recover(reason: string, input?: string): void;
  /**
   * Classify a rejected `send()`. Three codes never enter recovery:
   * `input_backpressure` is flow control on a healthy stream and only costs
   * the optimistic echo; `pty_write_queue_full` is the worker refusing one
   * write while its drainer queue is full, which also only costs the echo; and
   * `worker_timeout` is a late ack on a write that may still land, so it costs
   * nothing — no rollback, no recovery. Every other rejection is treated as
   * transport loss and enters recovery, which does roll back. Callers route
   * every send rejection here rather than assuming loss.
   */
  handleSendFailure(error: unknown): void;
  /** Buffer decoded input while the stream is down for identity-gated replay. */
  bufferInput(input: string): void;
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
  const onBufferedInputDiscarded = options.onBufferedInputDiscarded ?? (() => undefined);

  const attemptTimeoutMs = options.attemptTimeoutMs ?? INPUT_REOPEN_ATTEMPT_TIMEOUT_MS;
  const bufferLimitBytes = Math.max(0, options.bufferLimitBytes ?? INPUT_REPLAY_BUFFER_MAX_BYTES);

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
  /** True once a write-timeout episode has been reported; reset on the next good send. */
  let writeTimeoutReported = false;
  /** True once a write-refused episode has been reported; reset on the next good send. */
  let writeRefusedReported = false;
  let bufferedInput: string[] = [];
  let bufferedBytes = 0;
  let overflowDiscardedBytes = 0;
  let bufferOverflowed = false;
  let candidateStream: CliPtyInputStream | null = null;

  const resetBufferedInput = (): void => {
    bufferedInput = [];
    bufferedBytes = 0;
    overflowDiscardedBytes = 0;
    bufferOverflowed = false;
  };

  /**
   * Clear everything retained for this outage and return the byte count for an
   * operator-facing diagnostic. Overflow deliberately poisons all not-yet-sent
   * input: replaying only a prefix of a paste could execute a different,
   * truncated command.
   */
  const discardBufferedInput = (): number => {
    const discarded = bufferedBytes + overflowDiscardedBytes;
    resetBufferedInput();
    onBufferedInputDiscarded();
    return discarded;
  };

  const discardedMessage = (discarded: number): string =>
    discarded > 0 ? ` Discarded ${discarded} buffered bytes; none were forwarded.` : '';

  const appendBufferedInput = (input: string): void => {
    if (input.length === 0) return;
    const bytes = Buffer.byteLength(input, 'utf8');
    if (bufferOverflowed) {
      overflowDiscardedBytes += bytes;
      return;
    }
    if (bufferedBytes + bytes > bufferLimitBytes) {
      overflowDiscardedBytes = bufferedBytes + bytes;
      bufferedInput = [];
      bufferedBytes = 0;
      bufferOverflowed = true;
      log(
        `[${label}] outage input exceeded the ${bufferLimitBytes}-byte safety limit; ` +
          `all input still buffered will be discarded rather than replaying a truncated command.`
      );
      return;
    }
    bufferedInput.push(input);
    bufferedBytes += bytes;
  };

  const bufferInput = (input: string): void => {
    if (inFlight === null || isSettled()) return;
    appendBufferedInput(input);
  };

  const cancel = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    // Wake the loop so it observes `isSettled()` and unwinds, rather than
    // parking on a timer that will never fire.
    releaseBackoff?.();
    releaseBackoff = null;
    resetBufferedInput();
    try {
      candidateStream?.close(1000, `${label} client exiting`);
    } catch {
      // best effort
    }
    candidateStream = null;
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
            () => reject(new InputRecoveryDeadlineError(what, attemptTimeoutMs)),
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

  /** Replay only after identity verification, preserving byte order and buffer safety. */
  const replayBufferedInput = async (
    replacement: CliPtyInputStream
  ): Promise<{
    outcome: 'ready' | 'retry' | 'settled';
    replayedBytes: number;
    uncertainBytes: number;
    discardedBytes: number;
  }> => {
    let replayedBytes = 0;
    let uncertainBytes = 0;
    let discardedBytes = 0;
    while (!bufferOverflowed && bufferedInput.length > 0) {
      if (isSettled()) {
        resetBufferedInput();
        return { outcome: 'settled', replayedBytes, uncertainBytes, discardedBytes };
      }
      // Send one snapshot so input appended while this await is in flight
      // remains queued behind it. This preserves the human's byte order.
      const replayCount = bufferedInput.length;
      const replayPayload = bufferedInput.slice(0, replayCount).join('');
      const replayBytes = Buffer.byteLength(replayPayload, 'utf8');
      // Move this complete snapshot out of the live queue before awaiting.
      // New stdin can then append independently without corrupting counts.
      bufferedInput.splice(0, replayCount);
      bufferedBytes -= replayBytes;
      try {
        await withDeadline(replacement.send(replayPayload), 'buffered input replay');
      } catch (replayError) {
        if (isSettled()) {
          resetBufferedInput();
          return { outcome: 'settled', replayedBytes, uncertainBytes, discardedBytes };
        }
        if (isWriteTimeoutRejection(replayError)) {
          // The broker may still deliver this write. Retrying it would risk a
          // duplicate command, so treat the uncertain write as consumed just
          // as the live-input path does.
          uncertainBytes += replayBytes;
          continue;
        } else if (replayError instanceof InputRecoveryDeadlineError) {
          // The local deadline cannot tell whether the stream accepted this
          // payload. Never retry it, and discard everything behind it so a
          // command suffix cannot execute without its prefix.
          uncertainBytes += replayBytes;
          discardedBytes += discardBufferedInput();
          break;
        } else if (isBackpressureRejection(replayError) || isWriteRefusedRejection(replayError)) {
          // Both codes prove the socket is healthy but this payload was not
          // accepted. Discard it and everything queued behind it as one
          // unit: replaying only the suffix could execute a different,
          // truncated command.
          discardedBytes += replayBytes + discardBufferedInput();
          break;
        } else {
          // A fatal send error can arrive after transmission began. Retry the
          // connection, but never these bytes: the current payload may still
          // land, and replaying it could execute the command twice. Discard
          // everything behind it so no suffix executes without its prefix.
          uncertainBytes += replayBytes;
          discardedBytes += discardBufferedInput();
          return { outcome: 'retry', replayedBytes, uncertainBytes, discardedBytes };
        }
      }
      replayedBytes += replayBytes;
    }

    if (bufferOverflowed) discardedBytes += discardBufferedInput();
    else resetBufferedInput();
    return { outcome: 'ready', replayedBytes, uncertainBytes, discardedBytes };
  };

  const noteSendSuccess = (): void => {
    backpressureReported = false;
    writeTimeoutReported = false;
    writeRefusedReported = false;
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
    if (isWriteRefusedRejection(sendError)) {
      // Confirmed refusal on a healthy stream: roll the optimistic echo back
      // (the byte will never reach the child) but keep the socket. Report once
      // per episode — the cause persists for as long as the agent is busy, so
      // per-keystroke reporting would rebuild the flood this module removes.
      onRollback();
      if (!writeRefusedReported) {
        writeRefusedReported = true;
        log(
          `[${label}] ${name} is not reading input right now (busy); that keystroke was dropped. ` +
            `The session is still attached — retry once it is idle.`
        );
      }
      return;
    }
    if (isWriteTimeoutRejection(sendError)) {
      // This one write's ack didn't arrive in time — the worker may just be
      // busy, not dead (relay#1544). The transport already kept the socket
      // open for this exact code, so recovering here would manufacture the
      // reconnect this module exists to avoid. A late ack is not a failed
      // write either: the broker's write to the PTY is still pending and
      // very likely lands once the worker drains its stdin, so do NOT roll
      // back the optimistic echo — doing so would erase input right before
      // it executes, with no way for the operator to tell it happened. Only
      // a confirmed write failure (a distinct error code) may roll it back,
      // and that already falls through to `recover()` below.
      if (!writeTimeoutReported) {
        writeTimeoutReported = true;
        log(`[${label}] ${name} did not confirm a keystroke in time (worker busy); it may still land.`);
      }
      return;
    }
    // This rejected write is delivery-ambiguous: it may already have crossed
    // the socket before the fatal error arrived. Do not put it in the replay
    // buffer and risk executing it twice. Only input observed after recovery
    // begins is known not to have been sent and is eligible for replay.
    recover(describeSendError(sendError));
  };

  const recover = (reason: string, input?: string): void => {
    if (isSettled()) return;
    if (inFlight) {
      if (input !== undefined) appendBufferedInput(input);
      return;
    }

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
    if (input !== undefined) appendBufferedInput(input);

    if (maxAttempts <= 0) {
      error(
        `[${label}] input stream lost (${reason}); reconnect is disabled. ` +
          `Detaching — ${name} is still running; reattach to resume.` +
          discardedMessage(discardBufferedInput())
      );
      onExhausted();
      return;
    }

    // One line for the outage, not one per keystroke.
    log(`[${label}] input stream lost (${reason}); reconnecting…`);
    let replayedAcrossAttempts = 0;
    let uncertainAcrossAttempts = 0;
    let discardedAcrossAttempts = 0;

    const uncertainMessage = (): string =>
      uncertainAcrossAttempts > 0
        ? ` ${uncertainAcrossAttempts} buffered bytes were sent once but not confirmed; they may still land.`
        : '';

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
        candidateStream = replacement;
        await withDeadline(replacement.waitUntilOpen(), 'input stream open');
      } catch {
        // Stay quiet between attempts. The human saw one line when the outage
        // started and sees exactly one more when it resolves either way;
        // narrating each failed retry would rebuild the flood.
        if (replacement) closeQuietly(replacement, `${label} client abandoning attempt`);
        candidateStream = null;
        return 'retry';
      }
      if (isSettled()) {
        closeQuietly(replacement, `${label} client exiting`);
        candidateStream = null;
        resetBufferedInput();
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
        candidateStream = null;
        const discarded = discardedAcrossAttempts + discardBufferedInput();
        error(
          `[${label}] input stream reopened but no worker identity verifier was supplied, ` +
            `so it cannot be shown to be the same worker. Refusing to forward input. ` +
            `Detaching; reattach to ${name} to continue.` +
            discardedMessage(discarded) +
            uncertainMessage()
        );
        return 'rejected';
      }

      // A verifier that throws or stalls has not said yes, so both collapse
      // into the same refusal rather than escaping and stranding the session
      // with no stream and no exit.
      //
      // `verifyIdentity()` is invoked inside the promise chain, not as an
      // argument to it: the type permits a non-`async` function, and a
      // synchronous throw evaluated in the argument position would escape
      // before `.catch()` was ever attached — skipping the refusal, the
      // exhaustion exit, and the close below.
      const verdict = await withDeadline(
        Promise.resolve().then(() => verifyIdentity()),
        'worker identity check'
      ).catch((verifyError: unknown) => ({
        ok: false as const,
        reason:
          verifyError instanceof Error
            ? `identity check failed: ${verifyError.message}`
            : `identity check failed: ${String(verifyError)}`,
      }));
      if (isSettled()) {
        closeQuietly(replacement, `${label} client exiting`);
        candidateStream = null;
        resetBufferedInput();
        return 'settled';
      }
      if (!verdict.ok) {
        closeQuietly(replacement, `${label} client rejected replacement`);
        candidateStream = null;
        const discarded = discardedAcrossAttempts + discardBufferedInput();
        error(
          `[${label}] input stream reopened but it is not the same worker (${verdict.reason}). ` +
            `Refusing to forward input — your keystrokes would go somewhere you did not attach to. ` +
            `Detaching; reattach to ${name} to continue.` +
            discardedMessage(discarded) +
            uncertainMessage()
        );
        return 'rejected';
      }

      // A positive identity verdict is the hard safety gate. Nothing buffered
      // during the outage may reach `replacement.send()` above this point.
      const replay = await replayBufferedInput(replacement);
      replayedAcrossAttempts += replay.replayedBytes;
      uncertainAcrossAttempts += replay.uncertainBytes;
      discardedAcrossAttempts += replay.discardedBytes;
      if (replay.outcome === 'settled' || isSettled()) {
        closeQuietly(replacement, `${label} client exiting`);
        candidateStream = null;
        resetBufferedInput();
        return 'settled';
      }
      if (replay.outcome === 'retry') {
        closeQuietly(replacement, `${label} client abandoning failed replay`);
        candidateStream = null;
        return 'retry';
      }
      setStream(replacement);
      candidateStream = null;
      // Say plainly that the session survived. A recovered flap and a fatal
      // disconnect previously read the same to a human — both were red lines
      // that named a failure and stopped — so operators read a working session
      // as a crash (relay#1597).
      log(
        `[${label}] input stream reconnected after ${attempt} attempt(s) — ${name} is still attached ` +
          `and usable.` +
          (replayedAcrossAttempts > 0
            ? ` Replayed ${replayedAcrossAttempts} buffered bytes after verifying the worker identity.`
            : '') +
          uncertainMessage() +
          (discardedAcrossAttempts > 0
            ? ` Discarded ${discardedAcrossAttempts} buffered bytes that could not be replayed safely.`
            : '')
      );
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
          `Detaching — ${name} is still running; reattach to resume.` +
          discardedMessage(discardedAcrossAttempts + discardBufferedInput()) +
          uncertainMessage()
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
    bufferInput,
    noteSendSuccess,
    cancel,
  };
}
