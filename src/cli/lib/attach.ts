/**
 * Shared helpers for attach-style CLI commands.
 *
 * Every attach verb (`view`, `drive`, `relay`) needs to render the agent's
 * *current* visible screen before it starts streaming live updates —
 * otherwise the user attaches to a quiet agent and stares at a blank
 * terminal until the agent happens to produce more output. This module
 * wraps the broker's snapshot endpoint so each verb gets that for one line
 * of code.
 */

import { createBrokerClient, mapBrokerSdkFailure } from './sdk-client.js';

/** Connection metadata used to call the broker's snapshot endpoint. */
export interface AttachSnapshotConnection {
  /** Broker base URL (no trailing slash). */
  url: string;
  /** Optional API key — added as an `X-API-Key` header if present. */
  apiKey?: string;
}

/** Dependencies for `captureAndRenderSnapshot` — injected so tests don't hit
 *  the network. */
export interface AttachSnapshotDeps {
  /** Native `fetch` by default; swapped out by tests. */
  fetch: typeof globalThis.fetch;
  /** Where the ANSI bytes get written. Typically `process.stdout.write`. */
  writeChunk: (chunk: string) => void;
}

/** Outcome of a snapshot capture. Callers decide whether to bail or continue
 *  on each variant — `view` aborts on `not_found` / `no_pty`, warns and
 *  continues on `unavailable` / `transport_error`. */
export interface AttachSnapshotResult {
  status: 'ok' | 'not_found' | 'no_pty' | 'unavailable' | 'transport_error';
  /** Grid dimensions as reported by the broker, if the call succeeded. */
  rows?: number;
  cols?: number;
  /** Cursor position `[row, col]`, 1-indexed, if the call succeeded. */
  cursor?: [number, number];
  /** Human-readable detail for error variants. */
  message?: string;
}

/**
 * Fetch a worker's current visible screen as ANSI reproduction bytes and
 * write them to the caller's output. Callers should invoke this BEFORE
 * subscribing to the WebSocket event stream so the user sees the agent's
 * current state before live deltas start arriving.
 *
 * There is a tiny window between the snapshot capture and the live stream
 * starting in which the agent's output could be missed (≤10ms in practice).
 * Most TUI agents repaint heavily so the next update overwrites anything
 * lost; subscribe-first + buffer + drain would close the gap at the cost
 * of risking double-application of bytes that arrive in both the snapshot
 * and the buffered stream, which is the worse failure mode for TUIs.
 *
 * @returns A status describing the outcome. `ok` means the screen was
 * rendered; other variants carry a message the caller can surface.
 */
export async function captureAndRenderSnapshot(
  connection: AttachSnapshotConnection,
  agentName: string,
  deps: AttachSnapshotDeps
): Promise<AttachSnapshotResult> {
  let body: unknown;
  try {
    body = await createBrokerClient(connection, deps.fetch).snapshot(agentName, 'ansi');
  } catch (err: unknown) {
    const failure = mapBrokerSdkFailure(err);
    if (failure.status === 404) {
      return { status: 'not_found', message: `no agent named '${agentName}'` };
    }
    if (failure.status === 409) {
      return {
        status: 'no_pty',
        message: `agent '${agentName}' has no PTY (headless worker — nothing to view)`,
      };
    }
    if (failure.status === 0 || failure.status === 200) {
      return { status: 'transport_error', message: failure.message };
    }
    return { status: 'unavailable', message: `snapshot returned HTTP ${failure.status}` };
  }

  if (typeof body !== 'object' || body === null) {
    return { status: 'transport_error', message: 'snapshot response was not an object' };
  }
  const obj = body as Record<string, unknown>;
  const screen = obj.screen;
  if (typeof screen !== 'string') {
    return { status: 'transport_error', message: "snapshot response missing 'screen' field" };
  }

  // Snapshot bytes are mostly ASCII (escape sequences) plus the cell
  // characters which are valid Unicode codepoints (alacritty stores
  // chars, not bytes). UTF-8 round-trips cleanly.
  const decoded = Buffer.from(screen, 'base64').toString('utf-8');
  deps.writeChunk(decoded);

  const rows = typeof obj.rows === 'number' ? obj.rows : undefined;
  const cols = typeof obj.cols === 'number' ? obj.cols : undefined;
  const cursorRaw = Array.isArray(obj.cursor) ? obj.cursor : undefined;
  const cursor: [number, number] | undefined =
    cursorRaw &&
    cursorRaw.length === 2 &&
    typeof cursorRaw[0] === 'number' &&
    typeof cursorRaw[1] === 'number'
      ? [cursorRaw[0], cursorRaw[1]]
      : undefined;

  return { status: 'ok', rows, cols, cursor };
}
