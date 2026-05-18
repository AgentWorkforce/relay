/**
 * Shared helpers for attach-style CLI commands (`view`, `drive`,
 * `passthrough`).
 *
 * - `captureAndRenderSnapshot` renders the agent's current visible screen
 *   so the user doesn't attach to a quiet agent and stare at a blank
 *   terminal until the next output.
 * - `prepareAttachTarget` / `pickInitialTerminalRows` / `syncInitialPtySize`
 *   / `switchInboundDeliveryModeOrAbort` / `captureInitialSnapshot` are
 *   the take-over prep steps that `drive` and `passthrough` both run on
 *   attach; centralised here so the two verbs stay in lockstep.
 */

import type { InboundDeliveryMode } from '@agent-relay/sdk';

import {
  resolveBrokerConnection,
  type BrokerConnection,
  type BrokerConnectionDeps,
  type BrokerConnectionOptions,
} from './broker-connection.js';
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

/** ----- Interactive attach prep helpers ----- */

/** Validated attach target: trimmed agent name + resolved broker connection. */
export interface AttachTarget {
  name: string;
  connection: BrokerConnection;
}

/** Dependencies for `prepareAttachTarget` — connection lookup + error sink. */
export interface PrepareAttachTargetDeps extends BrokerConnectionDeps {
  error: (...args: unknown[]) => void;
}

/**
 * Trim the agent name and resolve the broker connection (flag → env →
 * `connection.json`). Writes the appropriate error and returns `null` on
 * either failure so every interactive attach verb rejects empty or
 * unreachable targets consistently.
 */
export function prepareAttachTarget(
  agentName: string,
  options: BrokerConnectionOptions,
  deps: PrepareAttachTargetDeps
): AttachTarget | null {
  const name = agentName.trim();
  if (!name) {
    deps.error('Error: agent name is required');
    return null;
  }
  const connection = resolveBrokerConnection(options, deps);
  if (!connection) {
    deps.error(
      'Error: could not locate broker connection. Pass --broker-url, set RELAY_BROKER_URL, ' +
        'or run from a directory containing .agent-relay/connection.json.'
    );
    return null;
  }
  return { name, connection };
}

/**
 * Pick the status-line row. Prefers the LOCAL terminal's height (the
 * status line must land where the human is looking) and falls back to
 * the snapshot's PTY rows, then `undefined` so the renderer applies its
 * own default.
 */
export function pickInitialTerminalRows(
  localSize: { rows: number; cols: number } | null,
  snapshotRows: number | undefined
): number | undefined {
  if (localSize) return localSize.rows;
  if (typeof snapshotRows === 'number' && snapshotRows > 0) return snapshotRows;
  return undefined;
}

/**
 * Sync the agent's PTY to the driver's local terminal size. tmux /
 * screen / ssh all do this — without it a TUI in the agent renders into
 * the size the PTY was spawned with, ignoring the human's viewport.
 * Best-effort: a failure is annoying but not fatal. Skipped entirely
 * when `localSize` is `null` (stdout isn't a TTY).
 */
export async function syncInitialPtySize(
  connection: BrokerConnection,
  name: string,
  localSize: { rows: number; cols: number } | null,
  verb: string,
  deps: { fetch: typeof globalThis.fetch; log: (...args: unknown[]) => void }
): Promise<void> {
  if (!localSize) return;
  try {
    await createBrokerClient(connection, deps.fetch).resizePty(name, localSize.rows, localSize.cols);
  } catch (err: unknown) {
    const failure = mapBrokerSdkFailure(err);
    deps.log(
      `[${verb}] could not sync agent PTY size to local terminal (${failure.message ?? 'unknown'}); continuing`
    );
  }
}

/**
 * Read the worker's prior inbound delivery mode and flip it to
 * `targetMode`. Returns the previous mode on success so the caller can
 * restore it on detach; returns `null` (and writes an error) when the
 * flip fails so the caller bails before touching the terminal.
 *
 * Non-404 errors are surfaced as `Error: could not ${actionPhrase}:
 * ${message}` so callers pass verb-appropriate wording (e.g. "switch to
 * manual_flush mode" or "ensure passthrough session"). 404s get a
 * uniform "no agent named X" message.
 */
export async function switchInboundDeliveryModeOrAbort(
  connection: BrokerConnection,
  name: string,
  targetMode: InboundDeliveryMode,
  actionPhrase: string,
  deps: { fetch: typeof globalThis.fetch; error: (...args: unknown[]) => void }
): Promise<{ previousMode: InboundDeliveryMode | null } | null> {
  let previousMode: InboundDeliveryMode | null = null;
  try {
    previousMode = await createBrokerClient(connection, deps.fetch).getInboundDeliveryMode(name);
  } catch {
    // Best-effort — fall through with null; the caller restores to
    // `auto_inject` in that case so the queue can't grow indefinitely.
  }
  try {
    await createBrokerClient(connection, deps.fetch).setInboundDeliveryMode(name, targetMode);
    return { previousMode };
  } catch (err: unknown) {
    const failure = mapBrokerSdkFailure(err);
    if (failure.status === 404) {
      deps.error(`Error: no agent named '${name}'`);
    } else {
      deps.error(`Error: could not ${actionPhrase}: ${failure.message ?? 'unknown error'}`);
    }
    return null;
  }
}

/** Dependencies for `captureInitialSnapshot`. `captureAndRenderSnapshot`
 *  is injectable so tests can substitute a stub. */
export interface CaptureInitialSnapshotDeps extends AttachSnapshotDeps {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  captureAndRenderSnapshot?: typeof captureAndRenderSnapshot;
}

/**
 * Render the agent's current visible screen, then dispatch on the
 * outcome. Hard errors (`not_found`, `no_pty`) abort: this helper
 * best-effort restores the prior delivery mode and writes the
 * appropriate error before returning `null` so the caller bails.
 * Transient errors warn and proceed. Returns `{ snapshotRows }` on the
 * happy path so the caller can seed the status-line row fallback.
 *
 * `noPtyAction` is the verb phrase used in the no-PTY message
 * (`agent 'X' has no PTY to ${noPtyAction}`) — e.g. "drive" or
 * "attach to".
 */
export async function captureInitialSnapshot(
  connection: BrokerConnection,
  name: string,
  previousMode: InboundDeliveryMode | null,
  verb: string,
  noPtyAction: string,
  deps: CaptureInitialSnapshotDeps
): Promise<{ snapshotRows?: number } | null> {
  const render = deps.captureAndRenderSnapshot ?? captureAndRenderSnapshot;
  const snapshot = await render(
    { url: connection.url, apiKey: connection.apiKey },
    name,
    { fetch: deps.fetch, writeChunk: deps.writeChunk }
  );
  switch (snapshot.status) {
    case 'ok':
      return { snapshotRows: snapshot.rows };
    case 'not_found':
    case 'no_pty': {
      try {
        await createBrokerClient(connection, deps.fetch).setInboundDeliveryMode(
          name,
          previousMode ?? 'auto_inject'
        );
      } catch {
        // best-effort restore
      }
      const fallback =
        snapshot.status === 'not_found'
          ? `no agent named '${name}'`
          : `agent '${name}' has no PTY to ${noPtyAction}`;
      deps.error(`Error: ${snapshot.message ?? fallback}`);
      return null;
    }
    case 'unavailable':
    case 'transport_error':
      deps.log(
        `[${verb}] could not capture initial screen (${snapshot.message ?? snapshot.status}); streaming live output only`
      );
      return { snapshotRows: snapshot.rows };
  }
}
