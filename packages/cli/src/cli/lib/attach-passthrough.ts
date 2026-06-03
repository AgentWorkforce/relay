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

import WebSocket from 'ws';

import {
  captureAndRenderSnapshot,
  captureInitialSnapshot,
  pickInitialTerminalRows,
  prepareAttachTarget,
  switchInboundDeliveryModeOrAbort,
  syncInitialPtySize,
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
import {
  type CliPtyInputStream,
  openPtyInputStream,
  resizeWorker,
  setInboundDeliveryMode,
  type InboundDeliveryMode,
} from './attach-drive.js';

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
  stdin: PassthroughStdin;
  terminal: PassthroughTerminal;
  /** Opens the SDK PTY input stream used for raw human keystrokes. */
  openInputStream: (connection: BrokerConnection, name: string) => CliPtyInputStream;
}

function withDefaults(overrides: Partial<PassthroughDependencies> = {}): PassthroughDependencies {
  const fetchFn: typeof globalThis.fetch = overrides.fetch ?? ((input, init) => fetch(input, init));
  return {
    readConnectionFile: readConnectionFileFromDisk,
    getDefaultStateDir: defaultStateDir,
    env: process.env,
    createWebSocket: (url, headers) => new WebSocket(url, { headers }) as PassthroughWebSocket,
    writeChunk: (chunk) => {
      process.stdout.write(chunk);
    },
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
export type PassthroughWsEvent = { kind: 'worker_stream'; chunk: string } | { kind: 'other' };

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
    return { kind: 'worker_stream', chunk };
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
export function renderStatusLine(opts: { name: string; mode: InboundDeliveryMode; rows?: number }): string {
  const row = Math.max(opts.rows ?? 24, 1);
  const text = `[passthrough ${opts.name} | delivery=${opts.mode} | Ctrl+C detach]`;
  return `\x1b7\x1b[${row};1H\x1b[2K\x1b[7m${text}\x1b[0m\x1b8`;
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
  const { previousMode } = flipResult;

  const snapshotResult = await captureInitialSnapshot(
    connection,
    name,
    previousMode,
    'passthrough',
    'attach to',
    {
      fetch: deps.fetch,
      writeChunk: deps.writeChunk,
      log: deps.log,
      error: deps.error,
      captureAndRenderSnapshot: deps.captureAndRenderSnapshot,
    }
  );
  if (!snapshotResult) return 1;

  const initialLocalSize = deps.terminal.getSize();
  let terminalRows = pickInitialTerminalRows(initialLocalSize, snapshotResult.snapshotRows);

  const paintStatus = (): void => {
    deps.writeChunk(renderStatusLine({ name, mode: 'auto_inject', rows: terminalRows }));
  };
  paintStatus();

  await syncInitialPtySize(connection, name, initialLocalSize, 'passthrough', deps);

  const wsUrl = toWsUrl(connection.url);
  const headers: Record<string, string> = {};
  if (connection.apiKey) {
    headers['X-API-Key'] = connection.apiKey;
  }

  return new Promise<number>((resolve) => {
    let settled = false;
    let rawModeWasSet = false;
    let unsubscribeResize: (() => void) | null = null;
    const parser = new PassthroughKeybindParser();
    let inputStream: CliPtyInputStream | null = null;
    const cleanupSignals: Array<() => void> = [];

    const resizeHandler = (): void => {
      const size = deps.terminal.getSize();
      if (!size) return;
      terminalRows = size.rows;
      void resizeWorker(connection, name, size.rows, size.cols, deps.fetch).then((res) => {
        if (!res.ok) {
          deps.log(`[passthrough] resize forward failed: ${res.message ?? 'unknown error'}`);
        }
      });
      paintStatus();
    };

    const stdinDataHandler = (chunk: Buffer): void => {
      const outcome = parser.feed(chunk);
      if (outcome.forward.length > 0) {
        const stream = inputStream;
        if (!stream) {
          deps.log('[passthrough] input stream is not ready');
          return;
        }
        void stream.send(outcome.forward.toString('utf-8')).catch((err: unknown) => {
          if (settled) return;
          const message = err instanceof Error ? err.message : String(err);
          deps.log(`[passthrough] input stream send failed: ${message}`);
        });
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
      rawModeWasSet = false;
    };

    const closeInputStream = (): void => {
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
      for (const cleanup of cleanupSignals.splice(0)) {
        try {
          cleanup();
        } catch {
          // best effort
        }
      }
      teardownStdin();
      closeInputStream();
      try {
        socket.close(1000, 'passthrough client exiting');
      } catch {
        // best effort
      }
      // Restore the worker's previous mode (no-op if it was already
      // auto-inject, which is the common case).
      void setInboundDeliveryMode(connection, name, previousMode ?? 'auto_inject', deps.fetch).finally(() => {
        resolve(code);
      });
    };

    const socket = deps.createWebSocket(wsUrl, headers);

    const openInputStreamAndTakeStdin = async (): Promise<void> => {
      try {
        inputStream = deps.openInputStream(connection, name);
        await inputStream.waitUntilOpen();
        if (settled) {
          closeInputStream();
          return;
        }
        if (typeof deps.stdin.setRawMode === 'function' && deps.stdin.isTTY !== false) {
          deps.stdin.setRawMode(true);
          rawModeWasSet = true;
        }
        deps.stdin.resume();
        deps.stdin.on('data', stdinDataHandler);
        unsubscribeResize = deps.terminal.onResize(resizeHandler);
      } catch (err: unknown) {
        if (settled) return;
        const message = err instanceof Error ? err.message : String(err);
        deps.error(`[passthrough] could not open PTY input stream: ${message}`);
        finish(1);
      }
    };

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const cleanup = deps.onSignal(signal, () => finish(0));
      if (typeof cleanup === 'function') cleanupSignals.push(cleanup);
    }

    socket.on('open', () => {
      void openInputStreamAndTakeStdin();
    });

    socket.on('message', (data) => {
      const text =
        typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf-8') : String(data);
      const event = classifyWsEvent(text, name);
      switch (event.kind) {
        case 'worker_stream':
          deps.writeChunk(event.chunk);
          paintStatus();
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
  options: { brokerUrl?: string; apiKey?: string; stateDir?: string },
  overrides: Partial<PassthroughDependencies> = {}
): Promise<number> {
  return runPassthroughSession(name, options, withDefaults(overrides));
}
