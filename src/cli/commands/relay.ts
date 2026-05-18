/**
 * `agent-relay relay <name>` — read-write attach in relay mode.
 *
 * The broker auto-injects inbound relay messages into the agent's PTY
 * while the human also types; both writers race. That's the point —
 * relay mode is for observe-and-occasionally-nudge sessions while the
 * broker does its coordination thing. For exclusive deterministic
 * control with no auto-inject, use `drive` instead.
 *
 * On attach, ensures the worker is in `relay` mode (it's the broker
 * default, but if someone left a `drive` session the worker may be in
 * `human` mode — `relay` flips it back for the session's duration and
 * restores the prior mode on detach). On detach, restores the prior
 * mode and leaves the agent running.
 *
 * The session loop (snapshot-on-attach, raw stdin, resize forwarding,
 * detach keybind, Ctrl+C-as-detach safety alias) mirrors the shape of
 * `drive.ts` minus the pending-queue UI and `Ctrl+G` flush binding
 * (there's no queue in relay mode). `drive.ts` is the more
 * heavily-commented version of the shared shape; this module
 * duplicates rather than abstracts because the trimmed surface is
 * small enough that an extra layer of indirection would cost more
 * clarity than it saves.
 */

import { Buffer } from 'node:buffer';

import { Command } from 'commander';
import WebSocket from 'ws';

import {
  captureAndRenderSnapshot,
  type AttachSnapshotConnection,
  type AttachSnapshotDeps,
} from '../lib/attach.js';
import {
  defaultStateDir,
  readConnectionFileFromDisk,
  resolveBrokerConnection,
  toWsUrl,
} from '../lib/broker-connection.js';
import { defaultExit, runSignalHandler } from '../lib/exit.js';
import { getSessionMode, resizeWorker, sendInput, setSessionMode, type SessionMode } from './drive.js';

type ExitFn = (code: number) => never;

/** Minimal WebSocket surface we depend on — same shape as `drive`'s. */
export interface RelayWebSocket {
  on(event: 'open', listener: () => void): unknown;
  on(event: 'message', listener: (data: WebSocket.RawData) => void): unknown;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  close(code?: number, reason?: string): void;
}

export type RelayWebSocketFactory = (url: string, headers: Record<string, string>) => RelayWebSocket;

export interface RelaySignalRegistrar {
  (signal: NodeJS.Signals, handler: () => void | Promise<void>): void;
}

export interface RelayStdin {
  setRawMode?: (mode: boolean) => unknown;
  isTTY?: boolean;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  off?(event: 'data', listener: (chunk: Buffer) => void): unknown;
  removeListener?(event: 'data', listener: (chunk: Buffer) => void): unknown;
}

export interface RelayTerminal {
  getSize(): { rows: number; cols: number } | null;
  onResize(handler: () => void): () => void;
}

export interface RelayDependencies {
  readConnectionFile: (stateDir: string) => unknown;
  getDefaultStateDir: () => string;
  env: NodeJS.ProcessEnv;
  createWebSocket: RelayWebSocketFactory;
  writeChunk: (chunk: string) => void;
  onSignal: RelaySignalRegistrar;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
  fetch: typeof globalThis.fetch;
  captureAndRenderSnapshot: (
    connection: AttachSnapshotConnection,
    agentName: string,
    deps: AttachSnapshotDeps
  ) => ReturnType<typeof captureAndRenderSnapshot>;
  stdin: RelayStdin;
  terminal: RelayTerminal;
}

function withDefaults(overrides: Partial<RelayDependencies> = {}): RelayDependencies {
  return {
    readConnectionFile: readConnectionFileFromDisk,
    getDefaultStateDir: defaultStateDir,
    env: process.env,
    createWebSocket: (url, headers) => new WebSocket(url, { headers }) as RelayWebSocket,
    writeChunk: (chunk) => {
      process.stdout.write(chunk);
    },
    onSignal: (signal, handler) => {
      process.on(signal, () => runSignalHandler(handler));
    },
    log: (...args: unknown[]) => console.error(...args),
    error: (...args: unknown[]) => console.error(...args),
    exit: defaultExit,
    fetch: (input, init) => fetch(input, init),
    captureAndRenderSnapshot,
    stdin: process.stdin as RelayStdin,
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
    ...overrides,
  };
}

/** ----- WS message classification ----- */

function isStringObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Discriminated union of broker events the `relay` client cares about.
 *  No `delivery_queued` / `agent_pending_drained` — there's no queue in
 *  relay mode, so those events (which the broker doesn't emit for
 *  relay-mode workers anyway) would be `other`. */
export type RelayWsEvent = { kind: 'worker_stream'; chunk: string } | { kind: 'other' };

/**
 * Inspect a single WebSocket frame and classify it relative to the
 * agent we're following. Non-matching / malformed frames return
 * `{ kind: 'other' }` so the caller can ignore them cheaply.
 */
export function classifyWsEvent(rawMessage: string, agentName: string): RelayWsEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    return { kind: 'other' };
  }
  if (!isStringObject(parsed)) return { kind: 'other' };
  if (parsed.name !== agentName) return { kind: 'other' };
  if (parsed.kind === 'worker_stream') {
    const chunk = parsed.chunk;
    if (typeof chunk !== 'string') return { kind: 'other' };
    return { kind: 'worker_stream', chunk };
  }
  return { kind: 'other' };
}

/** ----- Keybind state machine ----- */

export interface RelayKeybindOutcome {
  forward: Buffer;
  actions: RelayKeybindAction[];
}

export type RelayKeybindAction = 'detach' | 'toggle_help';

/**
 * Stateful parser for the relay client's keybind vocabulary. Smaller
 * than `drive`'s because there's no queue to flush — no `Ctrl+G`
 * binding.
 *
 * Semantics:
 *   - `Ctrl+C` (0x03)    → emit `detach`, never forwarded.
 *   - `Ctrl+B` (0x02)    → swallow, arm the prefix state.
 *     Next byte:
 *       - 'd' / 'D' / 0x04 (Ctrl+D) → emit `detach`.
 *       - '?'                       → emit `toggle_help`.
 *       - anything else             → forward `Ctrl+B` + the byte so
 *                                     TUI apps using `Ctrl+B` themselves
 *                                     aren't deprived.
 */
export class RelayKeybindParser {
  private pendingPrefix = false;

  feed(chunk: Buffer): RelayKeybindOutcome {
    const forward: number[] = [];
    const actions: RelayKeybindAction[] = [];

    for (const byte of chunk) {
      if (this.pendingPrefix) {
        this.pendingPrefix = false;
        if (byte === 0x44 /* 'D' */ || byte === 0x64 /* 'd' */ || byte === 0x04 /* Ctrl+D */) {
          actions.push('detach');
          continue;
        }
        if (byte === 0x3f /* '?' */) {
          actions.push('toggle_help');
          continue;
        }
        forward.push(0x02);
        forward.push(byte);
        continue;
      }
      if (byte === 0x03 /* Ctrl+C */) {
        actions.push('detach');
        continue;
      }
      if (byte === 0x02 /* Ctrl+B */) {
        this.pendingPrefix = true;
        continue;
      }
      forward.push(byte);
    }

    return { forward: Buffer.from(forward), actions };
  }

  reset(): void {
    this.pendingPrefix = false;
  }
}

/** ----- Status line rendering ----- */

/**
 * Render the bottom-of-terminal status line for `relay`. Same
 * save/restore-cursor trick as `drive`, no pending counter (there
 * isn't one in relay mode).
 */
export function renderStatusLine(opts: {
  agentName: string;
  mode: SessionMode;
  showHelp: boolean;
  rows?: number;
}): string {
  const row = Math.max(opts.rows ?? 24, 1);
  const help = opts.showHelp ? ' | Ctrl+B D detach | Ctrl+B ? hide help' : ' | Ctrl+B D detach';
  const text = `[relay ${opts.agentName} | mode=${opts.mode}${help}]`;
  return `\x1b7\x1b[${row};1H\x1b[2K\x1b[7m${text}\x1b[0m\x1b8`;
}

/** ----- Main session runner ----- */

/**
 * Open a `relay` session. Resolves with the exit code the CLI should
 * propagate. Cleans up its own stdin raw-mode and best-effort restores
 * the worker's previous session mode on any exit path.
 */
export async function runRelaySession(
  agentName: string,
  options: { brokerUrl?: string; apiKey?: string; stateDir?: string },
  deps: RelayDependencies
): Promise<number> {
  if (!agentName.trim()) {
    deps.error('Error: agent name is required');
    return 1;
  }

  const connection = resolveBrokerConnection(options, deps);
  if (!connection) {
    deps.error(
      'Error: could not locate broker connection. Pass --broker-url, set RELAY_BROKER_URL, ' +
        'or run from a directory containing .agent-relay/connection.json.'
    );
    return 1;
  }

  // Remember the worker's prior mode so we can restore on detach.
  // `null` means we couldn't read it (broker hiccup or worker missing);
  // we default the restore target to `relay` in that case (which is
  // also our preferred final state).
  const previousMode = await getSessionMode(connection, agentName, deps.fetch);

  // If the worker is in `human` mode (e.g. someone left a `drive`
  // session), flip it back to `relay` for the duration of our session.
  // This matches the verb's intent: `agent-relay relay alice` means
  // "watch alice in relay mode". If the worker is already in `relay`
  // we still issue the PUT — it's idempotent on the broker and gives
  // us an early hard-failure on missing-agent before we touch the
  // terminal.
  const flip = await setSessionMode(connection, agentName, 'relay', deps.fetch);
  if (!flip.ok) {
    if (flip.status === 404) {
      deps.error(`Error: no agent named '${agentName}'`);
    } else {
      deps.error(
        `Error: could not ensure '${agentName}' is in relay mode: ${flip.message ?? 'unknown error'}`
      );
    }
    return 1;
  }

  const snapshot = await deps.captureAndRenderSnapshot(
    { url: connection.url, apiKey: connection.apiKey },
    agentName,
    { fetch: deps.fetch, writeChunk: deps.writeChunk }
  );
  switch (snapshot.status) {
    case 'ok':
      break;
    case 'not_found':
      await setSessionMode(connection, agentName, previousMode ?? 'relay', deps.fetch);
      deps.error(`Error: ${snapshot.message ?? `no agent named '${agentName}'`}`);
      return 1;
    case 'no_pty':
      await setSessionMode(connection, agentName, previousMode ?? 'relay', deps.fetch);
      deps.error(`Error: ${snapshot.message ?? `agent '${agentName}' has no PTY to relay`}`);
      return 1;
    case 'unavailable':
    case 'transport_error':
      deps.log(
        `[relay] could not capture initial screen (${snapshot.message ?? snapshot.status}); streaming live output only`
      );
      break;
  }

  let showHelp = false;

  const initialLocalSize = deps.terminal.getSize();
  let terminalRows: number | undefined =
    initialLocalSize?.rows ??
    (typeof snapshot.rows === 'number' && snapshot.rows > 0 ? snapshot.rows : undefined);

  const paintStatus = (): void => {
    deps.writeChunk(renderStatusLine({ agentName, mode: 'relay', showHelp, rows: terminalRows }));
  };
  paintStatus();

  if (initialLocalSize) {
    const initialResize = await resizeWorker(
      connection,
      agentName,
      initialLocalSize.rows,
      initialLocalSize.cols,
      deps.fetch
    );
    if (!initialResize.ok) {
      deps.log(
        `[relay] could not sync agent PTY size to local terminal (${initialResize.message ?? 'unknown'}); continuing`
      );
    }
  }

  const wsUrl = toWsUrl(connection.url);
  const headers: Record<string, string> = {};
  if (connection.apiKey) {
    headers['X-API-Key'] = connection.apiKey;
  }

  return new Promise<number>((resolve) => {
    let settled = false;
    let rawModeWasSet = false;
    let unsubscribeResize: (() => void) | null = null;
    const parser = new RelayKeybindParser();

    const resizeHandler = (): void => {
      const size = deps.terminal.getSize();
      if (!size) return;
      terminalRows = size.rows;
      void resizeWorker(connection, agentName, size.rows, size.cols, deps.fetch).then((res) => {
        if (!res.ok) {
          deps.log(`[relay] resize forward failed: ${res.message ?? 'unknown error'}`);
        }
      });
      paintStatus();
    };

    const stdinDataHandler = (chunk: Buffer): void => {
      const outcome = parser.feed(chunk);
      if (outcome.forward.length > 0) {
        void sendInput(connection, agentName, outcome.forward.toString('utf-8'), deps.fetch).then((res) => {
          if (!res.ok) {
            deps.log(`[relay] input send failed: ${res.message ?? 'unknown error'}`);
          }
        });
      }
      for (const action of outcome.actions) {
        switch (action) {
          case 'detach':
            finish(0);
            return;
          case 'toggle_help':
            showHelp = !showHelp;
            paintStatus();
            break;
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

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      teardownStdin();
      try {
        socket.close(1000, 'relay client exiting');
      } catch {
        // best effort
      }
      // Restore the worker's previous mode (no-op if it was already
      // relay, which is the common case).
      void setSessionMode(connection, agentName, previousMode ?? 'relay', deps.fetch).finally(() => {
        resolve(code);
      });
    };

    const socket = deps.createWebSocket(wsUrl, headers);

    deps.onSignal('SIGINT', () => finish(0));
    deps.onSignal('SIGTERM', () => finish(0));

    socket.on('open', () => {
      deps.log(`[relay] relaying ${agentName} via ${connection.url} (Ctrl+B D to detach)`);
      try {
        if (typeof deps.stdin.setRawMode === 'function' && deps.stdin.isTTY !== false) {
          deps.stdin.setRawMode(true);
          rawModeWasSet = true;
        }
        deps.stdin.resume();
        deps.stdin.on('data', stdinDataHandler);
        unsubscribeResize = deps.terminal.onResize(resizeHandler);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        deps.error(`[relay] could not enable raw input mode: ${message}`);
        finish(1);
      }
    });

    socket.on('message', (data) => {
      const text =
        typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf-8') : String(data);
      const event = classifyWsEvent(text, agentName);
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
      deps.error(`[relay] WebSocket error: ${err.message}`);
    });

    socket.on('close', (code: number, reason: Buffer) => {
      if (settled) return;
      const reasonText = reason && reason.length > 0 ? reason.toString('utf-8') : '';
      if (code === 1000 || code === 1005) {
        finish(0);
      } else {
        deps.error(`[relay] connection closed (code: ${code}${reasonText ? `, reason: ${reasonText}` : ''})`);
        finish(1);
      }
    });
  });
}

/** Register `agent-relay relay <name>` on the supplied commander program. */
export function registerRelayCommands(program: Command, overrides: Partial<RelayDependencies> = {}): void {
  const deps = withDefaults(overrides);

  program
    .command('relay')
    .description(
      'Watch a running agent in relay mode: broker auto-injects inbound relay messages while you type alongside (last-writer-wins)'
    )
    .argument('<name>', 'Agent name to relay')
    .option('--broker-url <url>', 'Broker base URL (overrides RELAY_BROKER_URL and connection.json)')
    .option('--api-key <key>', 'Broker API key (overrides RELAY_BROKER_API_KEY and connection.json)')
    .option('--state-dir <dir>', 'Directory containing connection.json (default: .agent-relay/)')
    .action(async (name: string, options: { brokerUrl?: string; apiKey?: string; stateDir?: string }) => {
      const code = await runRelaySession(name, options, deps);
      if (code !== 0) {
        deps.exit(code);
      }
    });
}
