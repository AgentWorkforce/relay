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

import type { InboundDeliveryMode } from '@agent-relay/harness-driver';

import {
  resolveBrokerConnection,
  type BrokerConnection,
  type BrokerConnectionDeps,
  type BrokerConnectionOptions,
} from './broker-connection.js';
import { createBrokerClient, mapBrokerSdkFailure } from './attach-broker.js';

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
  /**
   * Cumulative per-worker byte offset the grid had consumed when the
   * snapshot was captured. Used to reconcile the snapshot against buffered
   * `worker_stream` chunks (drop `offset <= this`, apply the rest).
   * `undefined` on brokers that predate stream-offset support.
   */
  offset?: number;
  /** Human-readable detail for error variants. */
  message?: string;
}

/**
 * Fetch a worker's current visible screen as ANSI reproduction bytes and
 * write them to the caller's output.
 *
 * The attach clients open and subscribe to the WebSocket event stream
 * *first*, buffer incoming `worker_stream` chunks, then call this to paint
 * the snapshot, and finally reconcile the buffer against the snapshot's
 * `offset` (see {@link StreamSyncBuffer}). That ordering closes the gap
 * between the snapshot and the live stream: no output emitted around attach
 * time is lost, and the per-worker byte offset lets the client drop exactly
 * the chunks the snapshot already reflects so nothing is double-applied.
 *
 * On brokers that don't report an `offset`, the clients fall back to
 * snapshot-authoritative behaviour (paint the snapshot, discard chunks that
 * arrived before it), which trades a tiny gap for no duplication — the same
 * bias the pre-offset code had.
 *
 * @returns A status describing the outcome. `ok` means the screen was
 * rendered; other variants carry a message the caller can surface. `offset`
 * is populated on `ok` when the broker reports one.
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
  const offset = typeof obj.offset === 'number' ? obj.offset : undefined;
  const cursorRaw = Array.isArray(obj.cursor) ? obj.cursor : undefined;
  const cursor: [number, number] | undefined =
    cursorRaw &&
    cursorRaw.length === 2 &&
    typeof cursorRaw[0] === 'number' &&
    typeof cursorRaw[1] === 'number'
      ? [cursorRaw[0], cursorRaw[1]]
      : undefined;

  return { status: 'ok', rows, cols, cursor, offset };
}

/**
 * Reconciles a visible-screen snapshot with the live `worker_stream` byte
 * stream so an attaching client neither loses nor double-applies output
 * around attach time.
 *
 * Usage (subscribe-first):
 *
 *   1. Open + subscribe the event WS. Feed every `worker_stream` chunk to
 *      {@link push} as it arrives, applying the chunk only when `push`
 *      returns `true`.
 *   2. Fetch and paint the snapshot.
 *   3. Call {@link reconcile} with the snapshot's `offset`. Apply the
 *      returned chunks in order. From then on, `push` returns `true` for
 *      every chunk (live pass-through).
 *
 * Correlation rule: the snapshot reflects every byte with offset `<=`
 * `snapshotOffset`. A buffered chunk carries the cumulative byte offset at
 * its *end*; if that end offset is `<=` the snapshot offset the chunk is
 * already on screen and is dropped, otherwise it is applied.
 *
 * The snapshot offset is retained as a post-reconcile *watermark*: once
 * buffering ends, {@link push} keeps suppressing any live frame whose end
 * offset is `<=` the watermark. This closes a broker-side race — the PTY
 * reader advances `consumed_offset` and the grid *before* the decoded chunk
 * reaches the broadcast queue, so a chunk with `offset <= snapshotOffset`
 * can still arrive *after* the client reconciles. Offsets are cumulative and
 * monotonic, so the watermark drops exactly those already-painted stragglers
 * without touching genuinely new output.
 */
export class StreamSyncBuffer {
  private buffering = true;
  private readonly buffered: Array<{ chunk: string; offset?: number }> = [];
  /**
   * Post-reconcile suppression watermark: the snapshot offset the grid had
   * already painted. `undefined` until {@link reconcile} runs with a defined
   * offset (or forever, on brokers without offset support / after
   * {@link flushAll}), in which case no post-reconcile suppression happens.
   */
  private watermark: number | undefined = undefined;

  /**
   * Record a live `worker_stream` chunk. Returns `true` when the caller
   * should apply the chunk immediately, `false` when the chunk must be held
   * or dropped. While buffering, the chunk is retained for {@link reconcile}.
   * After reconcile, a chunk whose end offset is `<=` the snapshot watermark
   * is a late-arriving straggler the snapshot already painted and is
   * suppressed (see the class docstring's race note); everything else passes
   * through live.
   */
  push(chunk: string, offset: number | undefined): boolean {
    if (this.buffering) {
      this.buffered.push({ chunk, offset });
      return false;
    }
    // Live pass-through, minus stragglers the snapshot already reflects.
    if (this.watermark !== undefined && offset !== undefined && offset <= this.watermark) {
      return false;
    }
    return true;
  }

  /**
   * Reconcile the buffered chunks against the painted snapshot's offset and
   * return the chunks to apply, in order. Switches to live pass-through and
   * arms the post-reconcile watermark (see {@link push}).
   *
   * When `snapshotOffset` is `undefined` (broker without offset support) all
   * buffered chunks are discarded: they arrived before the snapshot was
   * painted, so dropping them matches the snapshot-authoritative fallback
   * and avoids double-painting what the snapshot already shows. No watermark
   * is armed in that case — there is no offset to compare live frames to.
   */
  reconcile(snapshotOffset: number | undefined): string[] {
    const out: string[] = [];
    if (snapshotOffset !== undefined) {
      for (const item of this.buffered) {
        // Drop chunks the snapshot already reflects; apply the rest. A chunk
        // with no offset (mixed/legacy frame) is applied rather than risk
        // silently dropping live output.
        if (item.offset !== undefined && item.offset <= snapshotOffset) continue;
        out.push(item.chunk);
      }
    }
    this.watermark = snapshotOffset;
    this.buffered.length = 0;
    this.buffering = false;
    return out;
  }

  /**
   * Return every buffered chunk unchanged and switch to live pass-through.
   * Used when no snapshot was painted (transient snapshot failure): there is
   * nothing to reconcile against, so applying everything preserves output
   * rather than dropping the buffered live stream.
   */
  flushAll(): string[] {
    const out = this.buffered.map((item) => item.chunk);
    this.buffered.length = 0;
    this.buffering = false;
    return out;
  }

  /** True while chunks are still being buffered (before reconcile). */
  get isBuffering(): boolean {
    return this.buffering;
  }
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
        'or run from a directory containing .agentworkforce/relay/connection.json.'
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
  const snapshot = await render({ url: connection.url, apiKey: connection.apiKey }, name, {
    fetch: deps.fetch,
    writeChunk: deps.writeChunk,
  });
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
