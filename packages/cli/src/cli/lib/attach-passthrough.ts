/**
 * `agent-relay passthrough <name>` — read-write attach in passthrough session.
 *
 * The broker auto-injects inbound relay messages into the agent's PTY
 * while the human also types; both writers race. That's the point —
 * passthrough is for observe-and-occasionally-nudge sessions
 * while the broker does its coordination thing. For exclusive
 * deterministic control with no auto-inject, use `drive` instead.
 *
 * On attach, ensures the worker is in `auto_inject` delivery mode (it's the
 * broker default, but if someone left a `drive` session the worker may
 * be in `manual_flush` mode — `passthrough` flips it back for the session's
 * duration and restores the prior mode on detach). On detach, restores
 * the prior mode and leaves the agent running.
 *
 * The session loop (snapshot-on-attach, raw stdin, resize forwarding,
 * Ctrl+C detach) mirrors the shape of
 * `drive.ts` minus the pending-queue UI and manual delivery controls
 * (there's no queue in passthrough session). `drive.ts` is the more
 * heavily-commented version of the shared shape; this module
 * duplicates rather than abstracts because the trimmed surface is
 * small enough that an extra layer of indirection would cost more
 * clarity than it saves.
 */

import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

import WebSocket from 'ws';

import {
  captureAndRenderSnapshot,
  canReserveStatusLine,
  clampStatusLineText,
  createBackpressureAwareWriter,
  DETACH_CLEANUP_DEADLINE_MS,
  pickInitialTerminalCols,
  pickInitialTerminalRows,
  prepareAttachTarget,
  reserveStatusLineRow,
  renderChildScrollRegion,
  resetLocalTerminalOnDetach,
  restoreInboundDeliveryModeOnDetach,
  StatusLineController,
  StreamSyncBuffer,
  switchInboundDeliveryModeOrAbort,
  syncInitialPtySize,
  TerminalScrollRegionTracker,
  type AttachSnapshotConnection,
  type AttachSnapshotDeps,
} from '../lib/attach.js';
import {
  defaultStateDir,
  readConnectionFileFromDisk,
  toWsUrl,
  type BrokerConnection,
} from '../lib/broker-connection.js';
import { defaultExit, runSignalHandler } from '../lib/exit.js';
import { resolveFleetHint } from '../lib/fleet-hint.js';
import {
  createInputStreamRecovery,
  INPUT_REOPEN_BASE_DELAY_MS,
  INPUT_REOPEN_MAX_ATTEMPTS,
} from './attach-input-recovery.js';
import {
  type CliPtyInputStream,
  fetchWorkerIdentity,
  openPtyInputStream,
  releaseResizeOwnership,
  resizeWorker,
  type InboundDeliveryMode,
} from './attach-drive.js';
import { describeError } from './describe-error.js';
import { createPredictiveEcho, type CreatePredictiveEchoOptions } from './predictive-echo-screen.js';
import type { PredictiveEcho } from '@agent-relay/harness-driver';

type ExitFn = (code: number) => never;

/** Minimal WebSocket surface we depend on — same shape as `drive`'s. */
export interface PassthroughWebSocket {
  on(event: 'open', listener: () => void): unknown;
  on(event: 'message', listener: (data: WebSocket.RawData) => void): unknown;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  close(code?: number, reason?: string): void;
}

export type PassthroughWebSocketFactory = (
  url: string,
  headers: Record<string, string>
) => PassthroughWebSocket;

export interface PassthroughSignalRegistrar {
  (signal: NodeJS.Signals, handler: () => void | Promise<void>): void | (() => void);
}

export interface PassthroughStdin {
  setRawMode?: (mode: boolean) => unknown;
  isTTY?: boolean;
  isRaw?: boolean;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  off?(event: 'data', listener: (chunk: Buffer) => void): unknown;
  removeListener?(event: 'data', listener: (chunk: Buffer) => void): unknown;
}

export interface PassthroughTerminal {
  getSize(): { rows: number; cols: number } | null;
  onResize(handler: () => void): () => void;
}

export interface PassthroughDependencies {
  readConnectionFile: (stateDir: string) => unknown;
  getDefaultStateDir: () => string;
  env: NodeJS.ProcessEnv;
  createWebSocket: PassthroughWebSocketFactory;
  writeChunk: (chunk: string) => void;
  /**
   * Tear down the backpressure-aware writer on detach: drop its pending queue
   * and unhook its `'drain'` listener so nothing flushes to stdout after the
   * session settles. Defaults to the writer created in {@link withDefaults};
   * tests that inject their own `writeChunk` can omit it (no-op).
   */
  disposeWriter?: () => void;
  onSignal: PassthroughSignalRegistrar;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
  fetch: typeof globalThis.fetch;
  captureAndRenderSnapshot: (
    connection: AttachSnapshotConnection,
    name: string,
    deps: AttachSnapshotDeps
  ) => ReturnType<typeof captureAndRenderSnapshot>;
  /**
   * Best-effort workspace lookup for improving cross-node 404 messages.
   * Defaults to `resolveFleetHint` from `fleet-hint.ts`. Tests inject a stub
   * to avoid network calls.
   */
  fleetHint?: (name: string) => Promise<string | null>;
  stdin: PassthroughStdin;
  terminal: PassthroughTerminal;
  /** Opens the SDK PTY input stream used for raw human keystrokes. */
  openInputStream: (connection: BrokerConnection, name: string) => CliPtyInputStream;
  /**
   * Builds the adaptive predictive-echo engine, or returns null to disable
   * it (degenerate terminal). Omitted by tests that want plain pass-through.
   */
  createPredictiveEcho?: (opts: CreatePredictiveEchoOptions) => PredictiveEcho | null;
  /**
   * Minimum ms between status-line repaints (coalescing window). Defaults to a
   * small positive value in production to shrink the per-chunk splice window;
   * tests set `0` for immediate, deterministic paints.
   */
  statusRepaintCoalesceMs?: number;
  /**
   * Interval (ms) at which the session re-asserts PTY resize ownership by
   * re-sending its current size (single-resizer policy, #1247). Keeps an
   * idle-but-live session from being superseded after the broker's
   * stale-owner window; the broker treats a same-size re-assert as a no-op
   * refresh (no SIGWINCH). Defaults to 60000. Set `0` to disable (tests).
   */
  ownershipReassertMs?: number;
  /**
   * How many times to reopen a dead PTY input stream before giving up and
   * exiting non-zero. Defaults to 5. Set `0` to disable recovery.
   */
  inputReopenMaxAttempts?: number;
  /** Base delay (ms) for the input-stream reopen backoff. Defaults to 250. */
  inputReopenBaseDelayMs?: number;
  /**
   * Reads the identity of the worker process behind `name`, or `null` when it
   * cannot be established. Used to reject a reopen that landed on a different
   * process. See `fetchWorkerIdentity` in attach-drive.ts.
   */
  getWorkerIdentity: (connection: BrokerConnection, name: string) => Promise<string | null>;
}

function withDefaults(overrides: Partial<PassthroughDependencies> = {}): PassthroughDependencies {
  const fetchFn: typeof globalThis.fetch = overrides.fetch ?? ((input, init) => fetch(input, init));
  const writer = createBackpressureAwareWriter(process.stdout);
  return {
    readConnectionFile: readConnectionFileFromDisk,
    getDefaultStateDir: defaultStateDir,
    env: process.env,
    createWebSocket: (url, headers) => new WebSocket(url, { headers }) as PassthroughWebSocket,
    writeChunk: writer.write,
    disposeWriter: writer.dispose,
    statusRepaintCoalesceMs: 40,
    onSignal: (signal, handler) => {
      const listener = () => runSignalHandler(handler);
      process.on(signal, listener);
      return () => process.off(signal, listener);
    },
    log: (...args: unknown[]) => console.error(...args),
    error: (...args: unknown[]) => console.error(...args),
    exit: defaultExit,
    fetch: fetchFn,
    captureAndRenderSnapshot,
    fleetHint: resolveFleetHint,
    stdin: process.stdin as PassthroughStdin,
    terminal: {
      getSize: () => {
        const stdout = process.stdout;
        if (!stdout.isTTY) return null;
        const rows = stdout.rows;
        const cols = stdout.columns;
        if (typeof rows !== 'number' || typeof cols !== 'number') return null;
        return { rows, cols };
      },
      onResize: (handler) => {
        process.stdout.on('resize', handler);
        return () => process.stdout.off('resize', handler);
      },
    },
    openInputStream: (connection, name) => openPtyInputStream(connection, name, fetchFn),
    getWorkerIdentity: (connection, name) => fetchWorkerIdentity(connection, name, fetchFn),
    createPredictiveEcho,
    ...overrides,
  };
}

/** ----- WS message classification ----- */

function isStringObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Discriminated union of broker events the `passthrough` client cares
 *  about. No `delivery_queued` / `agent_pending_drained` — there's no
 *  queue in passthrough session, so those events (which the broker doesn't
 *  emit while the worker is in `auto_inject`) would be `other`. */
export type PassthroughWsEvent =
  | { kind: 'worker_stream'; chunk: string; offset?: number }
  | { kind: 'other' };

/**
 * Inspect a single WebSocket frame and classify it relative to the
 * agent we're following. Non-matching / malformed frames return
 * `{ kind: 'other' }` so the caller can ignore them cheaply.
 */
export function classifyWsEvent(rawMessage: string, name: string): PassthroughWsEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    return { kind: 'other' };
  }
  if (!isStringObject(parsed)) return { kind: 'other' };
  if (parsed.name !== name) return { kind: 'other' };
  if (parsed.kind === 'worker_stream') {
    const chunk = parsed.chunk;
    if (typeof chunk !== 'string') return { kind: 'other' };
    const offset = typeof parsed.offset === 'number' ? parsed.offset : undefined;
    return { kind: 'worker_stream', chunk, offset };
  }
  return { kind: 'other' };
}

/** ----- Keybind state machine ----- */

export interface PassthroughKeybindOutcome {
  forward: Buffer;
  actions: PassthroughKeybindAction[];
}

export type PassthroughKeybindAction = 'detach';

/**
 * Parser for the one local control byte passthrough keeps: `Ctrl+C` detaches.
 *
 * Semantics:
 *   - `Ctrl+C` (0x03)    → emit `detach`, never forwarded.
 *   - Every other byte, including Ctrl+B and Ctrl+G, is forwarded to the agent.
 */
export class PassthroughKeybindParser {
  feed(chunk: Buffer): PassthroughKeybindOutcome {
    const forward: number[] = [];
    const actions: PassthroughKeybindAction[] = [];

    for (const byte of chunk) {
      if (byte === 0x03 /* Ctrl+C */) {
        actions.push('detach');
        break;
      }
      forward.push(byte);
    }

    return { forward: Buffer.from(forward), actions };
  }

  reset(): void {}
}

/** ----- Status line rendering ----- */

/**
 * Render the bottom-of-terminal status line for `passthrough`. Same
 * save/restore-cursor trick as `drive`, no pending counter (there
 * isn't one in passthrough session).
 */
export function renderStatusLine(opts: {
  name: string;
  mode: InboundDeliveryMode;
  rows?: number;
  /** Terminal columns — the label is truncated to fit. Defaults to 80. */
  cols?: number;
  scrollTop?: number;
  scrollBottom?: number;
  originMode?: boolean;
}): string {
  const row = Math.max(opts.rows ?? 24, 1);
  const scrollTop = Math.max(1, opts.scrollTop ?? 1);
  const scrollBottom = Math.max(scrollTop + 1, opts.scrollBottom ?? row - 1);
  const text = clampStatusLineText(
    `[passthrough ${opts.name} | delivery=${opts.mode} | Ctrl+C detach]`,
    opts.cols,
    true
  );
  const restoreOrigin = opts.originMode ? '\x1b[?6h' : '';
  return `\x1b7\x1b[?6l\x1b[r\x1b[${row};1H\x1b[2K\x1b[7m${text}\x1b[0m\x1b[${scrollTop};${scrollBottom}r${restoreOrigin}\x1b8`;
}

/** ----- Main session runner ----- */

/**
 * Open a `passthrough` session. Resolves with the exit code the CLI
 * should propagate. Cleans up its own stdin raw-mode and best-effort
 * restores the worker's previous inbound delivery mode on any exit path.
 */
export async function runPassthroughSession(
  agentName: string,
  options: { brokerUrl?: string; apiKey?: string; stateDir?: string },
  deps: PassthroughDependencies
): Promise<number> {
  const target = prepareAttachTarget(agentName, options, deps);
  if (!target) return 1;
  const { name, connection } = target;

  // Even when the worker is already in `auto_inject` we still issue the
  // PUT — it's idempotent on the broker and gives us an early hard
  // failure on missing-agent before we touch the terminal.
  const flipResult = await switchInboundDeliveryModeOrAbort(
    connection,
    name,
    'auto_inject',
    `ensure '${name}' is in passthrough session`,
    deps
  );
  if (!flipResult) return 1;
  const { previousMode, sessionRevision } = flipResult;

  // The mode is now flipped to `auto_inject`. If the user had an explicit
  // `agent message hold` (manual_flush) active, killing the process with Ctrl+C
  // before the session loop installs its handlers would strand the worker in
  // auto_inject, silently cancelling their hold. Register early restore-and-exit
  // handlers immediately; the loop disposes them once its own handlers are up.
  let earlyHandled = false;
  const earlyCleanups: Array<() => void> = [];
  const earlyRestore = async (): Promise<void> => {
    if (earlyHandled) return;
    earlyHandled = true;
    for (const cleanup of earlyCleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // best effort
      }
    }
    await restoreInboundDeliveryModeOnDetach(
      connection,
      name,
      previousMode,
      'auto_inject',
      sessionRevision,
      'passthrough',
      deps
    );
    deps.exit(0);
  };
  const disposeEarlySignals = (): void => {
    earlyHandled = true;
    for (const cleanup of earlyCleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // best effort
      }
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const cleanup = deps.onSignal(signal, earlyRestore);
    if (typeof cleanup === 'function') earlyCleanups.push(cleanup);
  }

  const initialLocalSize = deps.terminal.getSize();

  const wsUrl = toWsUrl(connection.url);
  const headers: Record<string, string> = {};
  if (connection.apiKey) {
    headers['X-API-Key'] = connection.apiKey;
  }

  return new Promise<number>((resolve) => {
    let settled = false;
    let rawModeWasSet = false;
    let unsubscribeResize: (() => void) | null = null;
    // Per-attach id for the single-resizer policy (#1247). See attach-drive.ts.
    const resizeSessionId = randomUUID();
    // In-flight resize requests, awaited before release on detach so a late
    // SIGWINCH resize can't re-claim after the release (detach race, #1247).
    const outstandingResizes = new Set<Promise<unknown>>();
    const trackResize = (p: Promise<unknown>): void => {
      outstandingResizes.add(p);
      void p.finally(() => outstandingResizes.delete(p));
    };
    // Periodic ownership re-assert timer (see `ownershipReassertMs`).
    let reassertTimer: ReturnType<typeof setInterval> | null = null;
    const parser = new PassthroughKeybindParser();
    // Stateful UTF-8 decoder for forwarded stdin — a multi-byte character split
    // across stdin chunks would otherwise become U+FFFD. See attach-drive.ts.
    const inputDecoder = new StringDecoder('utf8');
    let inputStream: CliPtyInputStream | null = null;
    const cleanupSignals: Array<() => void> = [];
    const isTtyOutput = initialLocalSize !== null;
    // Skip the status line entirely when stdout is not a TTY (piped output).
    let statusLineEnabled = canReserveStatusLine(initialLocalSize);
    // Subscribe-first: buffer live `worker_stream` chunks until the snapshot
    // is painted and reconciled against its per-worker offset (no lost/dup
    // output around attach time). See StreamSyncBuffer.
    const sync = new StreamSyncBuffer();
    let terminalRows = pickInitialTerminalRows(initialLocalSize, undefined);
    let terminalCols = pickInitialTerminalCols(initialLocalSize, undefined);

    // Adaptive predictive echo masks round-trip latency on remote brokers.
    // Seeded with the snapshot (after it is painted) so its confirmed model
    // matches the screen.
    let initialAgentSize = reserveStatusLineRow(initialLocalSize);
    const scrollRegion = new TerminalScrollRegionTracker(initialAgentSize?.rows ?? 1);
    let observeRenderedOutput = (_chunk: string): void => {};
    const predictiveEcho =
      deps.createPredictiveEcho?.({
        cols: initialAgentSize?.cols ?? 0,
        rows: initialAgentSize?.rows ?? 0,
        write: (chunk) => {
          deps.writeChunk(chunk);
          observeRenderedOutput(chunk);
        },
        getInputSrtt: () => inputStream?.srttMs ?? null,
      }) ?? null;

    // Tee the snapshot's painted bytes so we can seed the predictive-echo
    // model with them — its cursor must match the real screen before we
    // optimistically echo, or predicted glyphs land at the wrong position.
    let snapshotBytes = '';
    // Guard the snapshot paint on `settled`: a Ctrl+C during the snapshot HTTP
    // fetch would otherwise paint the snapshot after teardown began (the render
    // runs inside the awaited `captureAndRenderSnapshot`, past the WS guard).
    const captureWrite = (chunk: string): void => {
      if (settled) return;
      deps.writeChunk(chunk);
      snapshotBytes += chunk;
    };

    const correctSetupResize = async (baseline: { rows: number; cols: number } | null): Promise<void> => {
      const latest = reserveStatusLineRow(deps.terminal.getSize());
      if (!latest || (latest.rows === baseline?.rows && latest.cols === baseline?.cols)) return;
      const correction = resizeWorker(connection, name, latest.rows, latest.cols, deps.fetch, {
        sessionId: resizeSessionId,
      });
      trackResize(correction);
      const result = await correction;
      if (!result.ok) {
        deps.log(`[passthrough] setup resize correction failed: ${result.message ?? 'unknown error'}`);
      }
    };

    const beginSubscribedLayout = (): void => {
      unsubscribeResize ??= deps.terminal.onResize(resizeHandler);
      const currentSize = deps.terminal.getSize();
      terminalRows = pickInitialTerminalRows(currentSize, undefined);
      terminalCols = currentSize?.cols;
      statusLineEnabled = canReserveStatusLine(currentSize);
      initialAgentSize = reserveStatusLineRow(currentSize);
      if (initialAgentSize) {
        scrollRegion.setRows(initialAgentSize.rows);
        predictiveEcho?.onResize(initialAgentSize.cols, initialAgentSize.rows);
      }
      if (statusLineEnabled && initialAgentSize) {
        deps.writeChunk(renderChildScrollRegion(initialAgentSize.rows));
      }
    };

    // Boundary-held + coalesced status painter (skips non-TTY stdout).
    const statusController = new StatusLineController({
      render: () => {
        const region = scrollRegion.region;
        return renderStatusLine({
          name,
          mode: 'auto_inject',
          rows: terminalRows,
          cols: terminalCols,
          scrollTop: region.top,
          scrollBottom: region.bottom,
          originMode: scrollRegion.isOriginMode,
        });
      },
      write: deps.writeChunk,
      enabled: () => statusLineEnabled,
      coalesceMs: deps.statusRepaintCoalesceMs ?? 40,
    });
    const paintStatus = (): void => {
      statusController.request();
    };
    observeRenderedOutput = (chunk): void => {
      scrollRegion.push(chunk);
      statusController.observeOutput(chunk);
    };

    // Route server output through the predictive-echo engine (which owns
    // cursor save/restore) or straight to stdout. Repaint at safe ANSI
    // boundaries after each chunk: cursor-addressed output remains confined
    // to the smaller PTY, while this restores the row after terminal autowrap.
    const applyServerOutput = (chunk: string): void => {
      if (predictiveEcho) {
        void predictiveEcho.onServerOutput(chunk).then(
          () => {
            paintStatus();
          },
          () => {
            paintStatus();
          }
        );
      } else {
        deps.writeChunk(chunk);
        observeRenderedOutput(chunk);
        paintStatus();
      }
    };

    const resizeHandler = (): void => {
      const size = deps.terminal.getSize();
      if (!size) return;
      terminalRows = size.rows;
      terminalCols = size.cols;
      statusLineEnabled = canReserveStatusLine(size);
      const agentSize = reserveStatusLineRow(size);
      if (!agentSize) return;
      scrollRegion.setRows(agentSize.rows);
      predictiveEcho?.onResize(agentSize.cols, agentSize.rows);
      trackResize(
        resizeWorker(connection, name, agentSize.rows, agentSize.cols, deps.fetch, {
          sessionId: resizeSessionId,
        }).then((res) => {
          if (!res.ok) {
            deps.log(`[passthrough] resize forward failed: ${res.message ?? 'unknown error'}`);
          } else if (res.applied === false) {
            deps.log(
              '[passthrough] broker did not apply the reserved PTY size; using status repaint fallback'
            );
          }
        })
      );
      paintStatus();
    };

    // ---- input-stream liveness ----
    // Same defect and same contract as drive; see `attach-input-recovery.ts`.
    // Identity of the worker this session attached to; see attach-drive.ts.
    let attachedWorkerIdentity: string | null = null;
    const inputRecovery = createInputStreamRecovery({
      label: 'passthrough',
      name,
      maxAttempts: deps.inputReopenMaxAttempts ?? INPUT_REOPEN_MAX_ATTEMPTS,
      baseDelayMs: deps.inputReopenBaseDelayMs ?? INPUT_REOPEN_BASE_DELAY_MS,
      log: (message) => deps.log(message),
      error: (message) => deps.error(message),
      isSettled: () => settled,
      getStream: () => inputStream,
      setStream: (stream) => {
        inputStream = stream;
      },
      openStream: () => deps.openInputStream(connection, name),
      onRollback: () => predictiveEcho?.rollback(),
      onExhausted: () => finish(1),
      verifyIdentity: async () => {
        if (attachedWorkerIdentity === null) {
          return { ok: false, reason: 'worker identity was unavailable at attach' };
        }
        const current = await deps.getWorkerIdentity(connection, name);
        if (current === null) {
          return { ok: false, reason: 'worker identity could not be read after reconnect' };
        }
        if (current !== attachedWorkerIdentity) {
          return {
            ok: false,
            reason: `worker process changed (${attachedWorkerIdentity} → ${current})`,
          };
        }
        return { ok: true };
      },
    });

    let stdinReady = false;
    const stdinDataHandler = (chunk: Buffer): void => {
      // Raw mode starts before snapshot replay so terminal input reports cannot
      // echo. Until the predictive echo model is seeded, discard all input
      // except Ctrl+C: forwarding stale mouse/focus reports (or echoing user
      // input against an unseeded screen) would be worse than dropping it.
      if (!stdinReady) {
        if (chunk.includes(0x03)) finish(0);
        return;
      }
      const outcome = parser.feed(chunk);
      if (outcome.forward.length > 0) {
        const stream = inputStream;
        // A dead or missing stream is a liveness event, not a per-keystroke
        // error — see `attach-input-recovery.ts` (#1419). Recovery buffers the
        // decoded input and replays it only after the worker identity matches.
        //
        // Skip only the *forwarding* and fall through to the action loop:
        // Ctrl+C can share a chunk with ordinary bytes, and returning here
        // would swallow the detach mid-outage.
        if (!inputRecovery.isUsable(stream)) {
          const decoded = inputDecoder.write(outcome.forward);
          inputRecovery.recover('stream closed', decoded);
        } else {
          // Decode through the stateful UTF-8 decoder so a multi-byte character
          // split across stdin chunks is forwarded intact rather than as U+FFFD.
          const decoded = inputDecoder.write(outcome.forward);
          if (decoded.length > 0) {
            void stream.send(decoded).then(
              () => inputRecovery.noteSendSuccess(),
              (err: unknown) => {
                if (settled) return;
                inputRecovery.handleSendFailure(err);
              }
            );
          }
          predictiveEcho?.onUserInput(outcome.forward);
        }
      }
      for (const action of outcome.actions) {
        switch (action) {
          case 'detach':
            finish(0);
            return;
        }
      }
    };

    const teardownStdin = (): void => {
      try {
        if (deps.stdin.off) {
          deps.stdin.off('data', stdinDataHandler);
        } else if (deps.stdin.removeListener) {
          deps.stdin.removeListener('data', stdinDataHandler);
        }
      } catch {
        // best effort
      }
      try {
        if (rawModeWasSet && typeof deps.stdin.setRawMode === 'function') {
          deps.stdin.setRawMode(false);
        }
      } catch {
        // best effort
      }
      try {
        // Heal the local terminal on detach: the snapshot + live stream may
        // have left it in app-cursor / mouse / bracketed-paste / alt-screen
        // mode. Gate on TTY stdout (same signal as the status line).
        resetLocalTerminalOnDetach(deps.writeChunk, isTtyOutput);
      } catch {
        // best effort
      }
      try {
        deps.stdin.pause();
      } catch {
        // best effort
      }
      try {
        if (unsubscribeResize) {
          unsubscribeResize();
          unsubscribeResize = null;
        }
      } catch {
        // best effort
      }
      try {
        if (reassertTimer) {
          clearInterval(reassertTimer);
          reassertTimer = null;
        }
      } catch {
        // best effort
      }
      rawModeWasSet = false;
    };

    const closeInputStream = (): void => {
      // Cancel any pending reopen backoff so a detach mid-recovery doesn't
      // leave a timer holding a reference to a torn-down session.
      inputRecovery.cancel();
      const stream = inputStream;
      inputStream = null;
      if (!stream) return;
      try {
        stream.close(1000, 'passthrough client exiting');
      } catch {
        // best effort
      }
    };

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      // Stop the status painter before restoring cooked mode so no queued
      // repaint sprays output past detach.
      statusController.dispose();
      for (const cleanup of cleanupSignals.splice(0)) {
        try {
          cleanup();
        } catch {
          // best effort
        }
      }
      teardownStdin();
      predictiveEcho?.reset();
      closeInputStream();
      // Release resize ownership so the next client can size the shared PTY.
      // Await any in-flight resizes first so a late one can't re-claim the PTY
      // after the release lands (detach race, #1247). `teardownStdin` already
      // stopped the resize handler and re-assert timer, so nothing new is
      // enqueued past this point.
      const releasePromise = (async () => {
        try {
          if (outstandingResizes.size > 0) {
            await Promise.allSettled([...outstandingResizes]);
          }
          // Hand the reserved status row/column back in the same request, so
          // the agent's TUI is not left one row and column short.
          await releaseResizeOwnership(
            connection,
            name,
            resizeSessionId,
            deps.fetch,
            deps.terminal.getSize()
          );
        } catch {
          // Best-effort — the broker's idle-takeover net still frees ownership.
        }
      })();
      try {
        socket.close(1000, 'passthrough client exiting');
      } catch {
        // best effort
      }
      // Drop the writer's pending queue and unhook its drain listener so no
      // buffered chunk flushes to stdout after detach.
      deps.disposeWriter?.();
      // Best-effort restore: re-read and only revert if the mode is still what
      // this session set, so we don't clobber another session's change or
      // force a default when the pre-attach mode was unknown.
      //
      // Await the release alongside the restore before resolving: `resolve`
      // typically ends the process, which aborts any still-pending fetch. The
      // release awaits `outstandingResizes` first, so it would otherwise lose
      // the race to the restore and be aborted, defeating the detach-race fix.
      //
      // Bound the wait: both are best-effort HTTP round-trips that can stall if
      // the broker is down, and terminal exit must not hang on them. Resolve
      // once they settle or after DETACH_CLEANUP_DEADLINE_MS, whichever first.
      const cleanup = Promise.allSettled([
        releasePromise,
        restoreInboundDeliveryModeOnDetach(
          connection,
          name,
          previousMode,
          'auto_inject',
          sessionRevision,
          'passthrough',
          deps
        ),
      ]);
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((res) => {
        deadlineTimer = setTimeout(res, DETACH_CLEANUP_DEADLINE_MS);
      });
      void Promise.race([cleanup, deadline]).finally(() => {
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        resolve(code);
      });
    };

    const socket = deps.createWebSocket(wsUrl, headers);

    const openInputStreamAndSetRawMode = async (): Promise<void> => {
      try {
        inputStream = deps.openInputStream(connection, name);
        await inputStream.waitUntilOpen();
        if (settled) {
          closeInputStream();
          return;
        }
        // Baseline for the reopen identity gate; null makes a later reopen
        // refuse rather than guess. See attach-drive.ts.
        attachedWorkerIdentity = await deps.getWorkerIdentity(connection, name);
        if (settled) {
          closeInputStream();
          return;
        }
        // Register the temporary input handler before raw mode. Ctrl+C is an
        // ordinary byte in raw mode, so this keeps detach available while a
        // snapshot fetch or initial resize is still pending.
        deps.stdin.resume();
        deps.stdin.on('data', stdinDataHandler);
        if (typeof deps.stdin.setRawMode === 'function' && deps.stdin.isTTY !== false && !deps.stdin.isRaw) {
          deps.stdin.setRawMode(true);
          rawModeWasSet = true;
        }
      } catch (err: unknown) {
        if (settled) return;
        const message = describeError(err);
        deps.error(`[passthrough] could not open PTY input stream: ${message}`);
        finish(1);
      }
    };

    const takeStdin = (): void => {
      try {
        if (settled) return;
        stdinReady = true;
        // Periodic ownership re-assert (see `ownershipReassertMs`): keeps the
        // single-resizer lease alive on an idle-but-live session; the broker
        // no-ops a same-size re-assert (no SIGWINCH/repaint).
        const reassertMs = deps.ownershipReassertMs ?? 60_000;
        if (reassertMs > 0) {
          reassertTimer = setInterval(() => {
            const size = deps.terminal.getSize() ?? initialLocalSize;
            const agentSize = reserveStatusLineRow(size);
            if (!agentSize) return;
            trackResize(
              resizeWorker(connection, name, agentSize.rows, agentSize.cols, deps.fetch, {
                sessionId: resizeSessionId,
              }).then((res) => {
                if (!res.ok) {
                  deps.log(
                    `[passthrough] resize ownership re-assert failed: ${res.message ?? 'unknown error'}`
                  );
                }
              })
            );
          }, reassertMs);
          reassertTimer.unref?.();
        }
      } catch (err: unknown) {
        if (settled) return;
        const message = describeError(err);
        deps.error(`[passthrough] could not take terminal input: ${message}`);
        finish(1);
      }
    };

    // Runs once the event WS is subscribed: first reserve the local bottom row
    // and take over stdin before replaying the snapshot. A source TUI can
    // enable mouse/focus/alternate-scroll reporting in that replay, and
    // cooked-mode stdin would echo those reports as visible escape text. The
    // subscribed WS buffers the resize repaint for reconciliation.
    const onSubscribed = async (): Promise<void> => {
      beginSubscribedLayout();
      await openInputStreamAndSetRawMode();
      if (settled) return;
      const initialResize = syncInitialPtySize(connection, name, initialAgentSize, 'passthrough', deps, {
        sessionId: resizeSessionId,
      });
      trackResize(initialResize);
      await initialResize;
      if (settled) return;
      await correctSetupResize(initialAgentSize);
      const snapshot = await deps.captureAndRenderSnapshot(connection, name, {
        fetch: deps.fetch,
        writeChunk: captureWrite,
        fleetHint: deps.fleetHint,
      });
      if (settled) return;
      switch (snapshot.status) {
        case 'ok':
          break;
        case 'not_found':
          deps.error(`Error: ${snapshot.message ?? `no agent named '${name}'`}`);
          finish(1);
          return;
        case 'no_pty':
          deps.error(`Error: ${snapshot.message ?? `agent '${name}' has no PTY to attach to`}`);
          finish(1);
          return;
        case 'unavailable':
        case 'transport_error':
          deps.log(
            `[passthrough] could not capture initial screen (${snapshot.message ?? snapshot.status}); streaming live output only`
          );
          break;
      }
      if (predictiveEcho) {
        try {
          await predictiveEcho.seed(snapshotBytes);
        } catch (err: unknown) {
          const message = describeError(err);
          deps.log(`[passthrough] could not seed predictive echo: ${message}`);
          finish(1);
          return;
        }
        if (settled) return;
      }
      const currentLocalSize = deps.terminal.getSize();
      terminalRows = pickInitialTerminalRows(currentLocalSize, snapshot.rows);
      terminalCols = pickInitialTerminalCols(currentLocalSize, snapshot.cols);
      // Track the snapshot bytes for boundary state before the first repaint.
      scrollRegion.push(snapshotBytes);
      statusController.observeOutput(snapshotBytes);
      paintStatus();
      // Reconcile buffered chunks. On `ok`, drop what the snapshot already
      // reflects (by offset); with no offset this drops the pre-snapshot
      // buffer (snapshot-authoritative, matching the legacy behaviour). On a
      // transient snapshot failure nothing was painted, so apply everything.
      const pending = snapshot.status === 'ok' ? sync.reconcile(snapshot.offset) : sync.flushAll();
      for (const chunk of pending) applyServerOutput(chunk);
      // Input forwarding starts only after predictive echo has been seeded by
      // the snapshot. Raw mode was already enabled above, so terminal reports
      // could not echo during the setup window.
      takeStdin();
    };

    // Hand off from the early restore handlers to the fuller loop handlers.
    disposeEarlySignals();
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const cleanup = deps.onSignal(signal, () => finish(0));
      if (typeof cleanup === 'function') cleanupSignals.push(cleanup);
    }

    socket.on('open', () => {
      void onSubscribed();
    });

    socket.on('message', (data) => {
      // Drop inbound frames once teardown has begun (no output past detach).
      if (settled) return;
      const text =
        typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf-8') : String(data);
      const event = classifyWsEvent(text, name);
      switch (event.kind) {
        case 'worker_stream':
          if (sync.push(event.chunk, event.offset)) applyServerOutput(event.chunk);
          break;
        case 'other':
          break;
      }
    });

    socket.on('error', (err: Error) => {
      deps.error(`[passthrough] WebSocket error: ${err.message}`);
      finish(1);
    });

    socket.on('close', (code: number, reason: Buffer) => {
      if (settled) return;
      const reasonText = reason && reason.length > 0 ? reason.toString('utf-8') : '';
      if (code === 1000 || code === 1005) {
        finish(0);
      } else {
        deps.error(
          `[passthrough] connection closed (code: ${code}${reasonText ? `, reason: ${reasonText}` : ''})`
        );
        finish(1);
      }
    });
  });
}

/** Run a passthrough session with default dependencies. Used by `runtime agent attach --mode passthrough`. */
export function attachPassthrough(
  name: string,
  options: { brokerUrl?: string; apiKey?: string; stateDir?: string; requestTimeoutMs?: number },
  overrides: Partial<PassthroughDependencies> = {}
): Promise<number> {
  return runPassthroughSession(name, options, withDefaults(overrides));
}
