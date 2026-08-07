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
   * originally attached to, and is called after every successful reopen.
   *
   * This gate exists because the input stream is reopened *by agent name*, and
   * a name is not an identity: if the worker died and something else claimed
   * the name, a "successful" reopen would quietly route the human's keystrokes
   * into a different agent's PTY. Restarting the same agent is equally wrong
   * for input safety — keystrokes typed for the old session's context would
   * land in a fresh shell.
   *
   * Must fail closed: anything other than a positive match — identity
   * unavailable, unreadable, or changed — has to return `ok: false` so the
   * session exits loudly instead of reattaching on a guess.
   */
  verifyIdentity?: () => Promise<{ ok: true } | { ok: false; reason: string }>;
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
  /** Cancel a pending backoff timer (detach mid-recovery). */
  cancel(): void;
}

export function createInputStreamRecovery(
  options: InputStreamRecoveryOptions
): InputStreamRecovery {
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

  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const isUsable = (stream: CliPtyInputStream | null): stream is CliPtyInputStream =>
    stream !== null && stream.closed !== true;

  const recover = (reason: string): void => {
    if (isSettled() || inFlight) return;

    // Drop the dead handle first: `isDead()` then short-circuits every chunk
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

    const closeQuietly = (stream: CliPtyInputStream, why: string): void => {
      try {
        stream.close(1000, why);
      } catch {
        // best effort
      }
    };

    /**
     * One reopen attempt. `'settled'` means the session went away mid-attempt,
     * `'retry'` a transport failure worth another go, and `'rejected'` a
     * replacement that opened but could not be vouched for — which must not be
     * retried, because a replaced worker does not become the original one on a
     * later attempt.
     */
    const attemptReopen = async (
      attempt: number
    ): Promise<'opened' | 'retry' | 'rejected' | 'settled'> => {
      let replacement: CliPtyInputStream;
      try {
        replacement = openStream();
        await replacement.waitUntilOpen();
      } catch {
        // Stay quiet between attempts. The human saw one line when the outage
        // started and sees exactly one more when it resolves either way;
        // narrating each failed retry would rebuild the flood.
        return 'retry';
      }
      if (isSettled()) {
        closeQuietly(replacement, `${label} client exiting`);
        return 'settled';
      }

      // The socket is open, but "open" only proves the name resolved. Do not
      // hand the human's keystrokes to it until it is the same worker.
      if (verifyIdentity) {
        const verdict = await verifyIdentity();
        if (isSettled()) return 'settled';
        if (!verdict.ok) {
          closeQuietly(replacement, `${label} client rejected replacement`);
          error(
            `[${label}] input stream reopened but it is not the same worker (${verdict.reason}). ` +
              `Refusing to forward input — your keystrokes would go somewhere you did not attach to. ` +
              `Detaching; reattach to ${name} to continue.`
          );
          return 'rejected';
        }
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
          timer = setTimeout(resolve, delay);
          timer.unref?.();
        });
        timer = null;
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
    cancel,
  };
}
