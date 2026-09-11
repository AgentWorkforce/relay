/**
 * `agent-relay fleet agent list` — fleet-wide agent list.
 *
 * Answers "which agents are running on which node, right now?" without the
 * operator having to already know the node. See relay#1553 for the gap.
 *
 * Reads the maps it can from where the CLI runs:
 * - **Local broker** (this machine): both `/api/spawned` (the live PTY map)
 *   and `/api/fleet-inventory` (the snapshot the broker publishes to the
 *   engine via `inventory.sync`). Joining these on `WorkerName` exposes the
 *   workers-vs-inventory divergence documented in relay#1539.
 * - **Every other node in the workspace**: names carried in a reserved node
 *   capability on the broker's normal heartbeat, joined against that same
 *   heartbeat's `activeAgents` count so partial inventory is labelled degraded.
 * - **Relaycast agent registry** (`agents.list()`): joined against the local
 *   broker rows to flag registry gaps and to surface roster-only identities
 *   that have no node placement anywhere (a distinct section).
 *
 * The rendered table is the primary user contract; JSON mirrors it verbatim.
 * Callers should never assume a row's absence proves the agent is not
 * running — a row's PRESENCE column names exactly which maps saw it.
 */

import type { HarnessDriverClient } from '@agent-relay/harness-driver';
import type { FleetInventoryAgent, ListAgent } from '@agent-relay/harness-driver';

import type { RelayNode } from '@agent-relay/sdk';

export { collectWithRetry } from '../lib/collect-with-retry.js';

/** Roster entry as returned by `agents.list()`; only the fields we consume. */
export interface RosterAgent {
  name: string;
  status?: string;
  lastSeenAt?: string;
  metadata?: Record<string, unknown> | null;
}

import type { RemoteLiveAgent } from '../lib/fleet-live-agents.js';

export type { RemoteLiveAgent, RemoteLiveAgentRead } from '../lib/fleet-live-agents.js';
export { LIVE_AGENT_CAPABILITY_NAME, readRemoteLiveAgents } from '../lib/fleet-live-agents.js';

/** What each fleet node contributed to the render. */
export interface FleetNodeContribution {
  /** Node record from `nodes.list()`. */
  node: RelayNode;
  /** True when this row came from the local broker's HTTP surface. */
  isLocal: boolean;
  /** `/api/spawned` result — only present for the local broker when it succeeded. */
  liveAgents?: ListAgent[];
  /** `/api/fleet-inventory` result — only present for the local broker when it succeeded. */
  inventoryAgents?: FleetInventoryAgent[];
  /** Broker-owned live WorkerNames returned in heartbeat capabilities. */
  remoteAgents?: RemoteLiveAgent[];
  /** Non-null when some heartbeat names could not be decoded safely. */
  remoteWarning?: string;
  /** Non-null when the remote node does not expose a usable live-name heartbeat. */
  remoteError?: string;
  /**
   * Non-null when the live-worker read failed. A `liveError` alone still
   * produces per-agent rows (from `inventoryAgents`) so the local machine
   * never falls back to a bare error row unless BOTH halves fail.
   */
  liveError?: string;
  /**
   * Non-null when the inventory read failed (missing route on an old broker,
   * `success:false` from the runtime channel, transport failure). Handled
   * independently from `liveError`: partial rows still render, and the
   * presence column marks inventory as unknown rather than lying about it.
   */
  inventoryError?: string;
  /**
   * Non-null when this node's contribution failed entirely (both halves, or a
   * remote node that could not be reached). Distinct from `liveError` /
   * `inventoryError` which are per-half diagnostics.
   */
  error?: string;
  /** True when the contribution was produced only after a retry. */
  retried?: boolean;
}

/**
 * Membership tuple across the three surfaces this command reads. Values
 * ending in `?` mark that a surface was unqueryable rather than confirmed
 * empty — inheriting the third-state discipline of the whole command down
 * to the row so a partial read can never be misread as a confirmed
 * divergence.
 */
export type Presence =
  | 'live+inventory+roster'
  | 'live+inventory'
  | 'live+roster'
  | 'inventory+roster'
  | 'live only'
  | 'inventory only'
  | 'roster only'
  | 'live only (inventory?)'
  | 'inventory only (live?)'
  | 'empty (inventory?)'
  | 'empty (live?)'
  | 'remote live'
  | 'remote live+roster'
  | 'remote stale (control plane unavailable)'
  | 'count only'
  | 'count only (degraded)';

export interface RenderedRow {
  node: string;
  name: string;
  cliModel: string;
  state: string;
  pending: string;
  lastActive: string;
  presence: Presence;
  /** Control-plane reachability is independent from hosted worker liveness. */
  controlPlane?: 'online' | 'offline' | 'degraded' | 'unknown';
  /** Best available evidence about workers hosted by this node. */
  workerLiveness?: 'live' | 'empty' | 'degraded' | 'unknown';
  /** Optional annotation appended by the renderer, e.g. `(retried)`. */
  note?: string;
}

function controlPlaneState(node: RelayNode): RenderedRow['controlPlane'] {
  if (node.status === 'online' && node.live === true && node.handlersLive === true) return 'online';
  if (node.status === 'offline' || node.live === false) return 'offline';
  if (node.handlersLive === false) return 'degraded';
  return 'unknown';
}

/**
 * Diagnostic input for {@link buildRows}. Kept as a plain object so tests can
 * construct it without exercising the SDK / broker transport.
 */
export interface BuildRowsInput {
  contributions: FleetNodeContribution[];
  /** Workspace registry (`agents.list()`); may be empty on failure. */
  roster: RosterAgent[];
}

export interface BuildRowsOutput {
  /** Per-node rows, sorted by (node, name). */
  perNode: RenderedRow[];
  /**
   * Roster identities not placed on any node this CLI could inspect. Rendered
   * as a distinct section so the reader knows the placement is unknown, not
   * "on some node".
   */
  unplacedRoster: RenderedRow[];
  /** Nodes that failed after retry, formatted for the error footer. */
  errors: { node: string; message: string }[];
}

const AGENT_STATE_SYMBOL: Record<string, string> = {
  working: '● working',
  idle: '○ idle',
  blocked_on_send: '◐ waiting',
};

// eslint-disable-next-line no-control-regex
const ANSI_CSI_RE = /\u001B\[[0-9;]*[A-Za-z]/g;
// C0 (U+0000-U+001F), DEL (U+007F), C1 (U+0080-U+009F), bidi overrides
// (U+202A-U+202E, U+2066-U+2069). Anything in this set is replaced so a
// broker-provided name cannot break the table layout or hide characters.
// eslint-disable-next-line no-control-regex
const UNSAFE_CTRL_RE = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;

function sanitizeCell(value: string): string {
  return value.replace(ANSI_CSI_RE, '').replace(UNSAFE_CTRL_RE, '�');
}

function renderState(state: string | undefined): string {
  if (!state) return '· unknown';
  return AGENT_STATE_SYMBOL[state] ?? `· ${state}`;
}

function renderPending(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '-';
  return String(Math.floor(value));
}

/** Relative "now / N minutes ago" — matches `node agent list --pretty`. */
function renderRelative(iso: string | undefined, now: Date): string {
  if (!iso) return 'unknown';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return 'unknown';
  const seconds = Math.max(0, Math.floor((now.getTime() - ts) / 1000));
  if (seconds < 5) return 'now';
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function cliModel(agent: ListAgent): string {
  const parts = [agent.cli ?? agent.provider ?? agent.runtime, agent.model].filter(Boolean);
  return parts.join(' / ');
}

/**
 * Join the per-node contributions with the workspace roster into rendered
 * rows. Pure function so it can be unit-tested against fixtures.
 *
 * Every reachable node yields at least one row: either a per-agent breakdown
 * or an explicitly degraded count/error row.
 * A node's absence from the output would recreate the exact ambiguity #1553
 * exists to remove, so this function refuses to drop nodes.
 */
export function buildRows(input: BuildRowsInput, now: Date): BuildRowsOutput {
  const perNode: RenderedRow[] = [];
  const errors: { node: string; message: string }[] = [];
  // Stable per-row identity: node *names* collide for unnamed nodes
  // (`(unnamed)`), so the control-plane/worker-liveness backfill below must
  // key off this object identity map instead of `row.node === contribution`.
  const contributionByRow = new Map<RenderedRow, FleetNodeContribution>();

  // Cache roster names in a Set for O(1) membership; the roster today runs to
  // 1600+ records so linear scans per row would be visible.
  const rosterNames = new Set(input.roster.map((entry) => entry.name));
  const rosterPlaced = new Set<string>();

  for (const contribution of input.contributions) {
    const nodeName = contribution.node.name || '(unnamed)';

    if (contribution.error) {
      const row: RenderedRow = {
        node: nodeName,
        name: '',
        cliModel: '',
        state: `ERROR: ${sanitizeCell(contribution.error)}`,
        pending: '-',
        lastActive: '-',
        presence: 'count only',
        ...(contribution.retried ? { note: 'retried' } : {}),
      };
      perNode.push(row);
      contributionByRow.set(row, contribution);
      errors.push({ node: nodeName, message: contribution.error });
      continue;
    }

    if (!contribution.isLocal) {
      const count = contribution.node.activeAgents;
      const controlPlane = controlPlaneState(contribution.node);
      const hostedWorkersUnavailable = controlPlane !== 'online';
      if (contribution.remoteAgents === undefined) {
        const renderedCount =
          count === undefined
            ? 'active count unavailable'
            : `${count} agent${count === 1 ? '' : 's'} reported`;
        const detail = contribution.remoteError
          ? `live-name heartbeat unavailable: ${sanitizeCell(contribution.remoteError)}`
          : 'live-name heartbeat unavailable';
        const row: RenderedRow = {
          node: nodeName,
          name: `<${renderedCount} — names unavailable: ${detail}>`,
          cliModel: '',
          state: '· remote degraded',
          pending: '-',
          lastActive: '-',
          presence: 'count only (degraded)',
          controlPlane,
          workerLiveness: 'unknown',
          note: contribution.retried ? 'retried' : 'inventory unavailable',
        };
        perNode.push(row);
        contributionByRow.set(row, contribution);
        if (contribution.remoteError) {
          errors.push({ node: nodeName, message: sanitizeCell(contribution.remoteError) });
        }
        continue;
      }

      const remoteAgents = [...contribution.remoteAgents].sort((a, b) => a.name.localeCompare(b.name));
      const mismatch = count !== undefined && count !== remoteAgents.length;
      const noteParts = [
        ...(contribution.retried ? ['retried'] : []),
        ...(contribution.remoteWarning
          ? [`${hostedWorkersUnavailable ? 'stale' : 'degraded'}: ${contribution.remoteWarning}`]
          : []),
        ...(mismatch
          ? [
              `${hostedWorkersUnavailable ? 'stale' : 'degraded'}: heartbeat reports ${count}, broker returned ${remoteAgents.length}`,
            ]
          : []),
      ];
      const note = noteParts.length > 0 ? noteParts.join('; ') : undefined;

      for (const agent of remoteAgents) {
        const inRoster = rosterNames.has(agent.name);
        if (inRoster) rosterPlaced.add(agent.name);
        const row: RenderedRow = {
          node: nodeName,
          name: sanitizeCell(agent.name),
          cliModel: '',
          state: '· remote',
          pending: '-',
          lastActive: '-',
          presence: hostedWorkersUnavailable
            ? 'remote stale (control plane unavailable)'
            : inRoster
              ? 'remote live+roster'
              : 'remote live',
          controlPlane,
          workerLiveness: hostedWorkersUnavailable ? 'unknown' : 'live',
          ...(note ? { note: sanitizeCell(note) } : {}),
        };
        perNode.push(row);
        contributionByRow.set(row, contribution);
      }

      if (remoteAgents.length === 0 && count === 0) {
        const row: RenderedRow = {
          node: nodeName,
          name: '<0 agents on this node>',
          cliModel: '',
          state: '· empty',
          pending: '-',
          lastActive: '-',
          presence: hostedWorkersUnavailable ? 'count only (degraded)' : 'remote live',
          controlPlane,
          workerLiveness: hostedWorkersUnavailable ? 'unknown' : 'empty',
          ...(note ? { note: sanitizeCell(note) } : {}),
        };
        perNode.push(row);
        contributionByRow.set(row, contribution);
      } else if (count !== undefined && count > remoteAgents.length) {
        const missing = count - remoteAgents.length;
        const row: RenderedRow = {
          node: nodeName,
          name: `<${missing} additional agent${missing === 1 ? '' : 's'} — names unavailable: broker/heartbeat mismatch>`,
          cliModel: '',
          state: hostedWorkersUnavailable ? '· remote stale' : '· remote degraded',
          pending: '-',
          lastActive: '-',
          presence: hostedWorkersUnavailable
            ? 'remote stale (control plane unavailable)'
            : 'count only (degraded)',
          controlPlane,
          workerLiveness: hostedWorkersUnavailable ? 'unknown' : 'degraded',
          ...(note ? { note: sanitizeCell(note) } : {}),
        };
        perNode.push(row);
        contributionByRow.set(row, contribution);
      } else if (remoteAgents.length === 0) {
        const row: RenderedRow = {
          node: nodeName,
          name: '<node inventory returned no names; active count unavailable>',
          cliModel: '',
          state: '· remote degraded',
          pending: '-',
          lastActive: '-',
          presence: 'count only (degraded)',
          controlPlane,
          workerLiveness: 'unknown',
          note: 'inventory/count comparison unavailable',
        };
        perNode.push(row);
        contributionByRow.set(row, contribution);
      }
      continue;
    }

    // Local broker: two-map read. Each half may have failed independently
    // (Promise.allSettled semantics upstream), so union the names we did get
    // and classify each with `?` where a surface is genuinely unknown rather
    // than confirmed empty. `?` markers propagate the third-state discipline
    // the whole command is built on down to individual rows.
    const liveKnown = contribution.liveAgents !== undefined;
    const inventoryKnown = contribution.inventoryAgents !== undefined;
    const live = new Map<string, ListAgent>();
    for (const agent of contribution.liveAgents ?? []) {
      live.set(agent.name, agent);
    }
    const inventory = new Map<string, FleetInventoryAgent>();
    for (const agent of contribution.inventoryAgents ?? []) {
      inventory.set(agent.name, agent);
    }
    const names = new Set<string>([...live.keys(), ...inventory.keys()]);

    if (!liveKnown && !inventoryKnown) {
      // Both halves failed: only now do we degrade to an ERROR row. This is
      // strictly stronger than the pre-fix behaviour, which produced an ERROR
      // row whenever EITHER half failed and threw away the surviving map.
      const combined = [contribution.liveError, contribution.inventoryError].filter(Boolean).join('; ');
      const row: RenderedRow = {
        node: nodeName,
        name: '',
        cliModel: '',
        state: `ERROR: ${sanitizeCell(combined || 'local broker unavailable')}`,
        pending: '-',
        lastActive: '-',
        presence: 'count only',
        ...(contribution.retried ? { note: 'retried' } : {}),
      };
      perNode.push(row);
      contributionByRow.set(row, contribution);
      errors.push({ node: nodeName, message: combined || 'local broker unavailable' });
      continue;
    }

    if (names.size === 0) {
      // At least one half is known-empty; if the OTHER half is unknown, say
      // so plainly rather than rendering "0 agents on this node" — a
      // partially-observed empty result is not a confirmed empty node.
      if (liveKnown && inventoryKnown) {
        const row: RenderedRow = {
          node: nodeName,
          name: '<0 agents on this node>',
          cliModel: '',
          state: '· empty',
          pending: '-',
          lastActive: '-',
          presence: 'live+inventory',
          ...(contribution.retried ? { note: 'retried' } : {}),
        };
        perNode.push(row);
        contributionByRow.set(row, contribution);
      } else {
        const missing = liveKnown ? 'inventory' : 'live';
        const row: RenderedRow = {
          node: nodeName,
          name: `<local ${missing} map unavailable — other map empty; total unknown>`,
          cliModel: '',
          state: `· ${missing}? unavailable`,
          pending: '-',
          lastActive: '-',
          presence: liveKnown ? 'empty (inventory?)' : 'empty (live?)',
          ...(contribution.retried ? { note: 'retried' } : {}),
        };
        perNode.push(row);
        contributionByRow.set(row, contribution);
      }
      continue;
    }

    const sortedNames = Array.from(names).sort();
    for (const name of sortedNames) {
      const liveEntry = live.get(name);
      const inventoryEntry = inventory.get(name);
      const inRoster = rosterNames.has(name);
      if (inRoster) rosterPlaced.add(name);

      const presence = classifyPresenceWithUncertainty(
        { present: Boolean(liveEntry), known: liveKnown },
        { present: Boolean(inventoryEntry), known: inventoryKnown },
        inRoster
      );

      const row: RenderedRow = {
        node: nodeName,
        name: sanitizeCell(name),
        cliModel: liveEntry ? sanitizeCell(cliModel(liveEntry)) : '',
        state: liveEntry ? sanitizeCell(renderState(liveEntry.current_state)) : '· inventory-only',
        pending: liveEntry ? renderPending(liveEntry.pending_messages) : '-',
        lastActive: liveEntry ? sanitizeCell(renderRelative(liveEntry.last_activity_at, now)) : '-',
        presence,
        ...(contribution.retried ? { note: 'retried' } : {}),
      };
      perNode.push(row);
      contributionByRow.set(row, contribution);
    }
  }

  // Roster-only entries: registered identities that we never saw on any node
  // this CLI can enumerate. Placement is genuinely unknown, so NODE is `?`.
  const unplacedRoster: RenderedRow[] = [];
  for (const entry of input.roster) {
    if (rosterPlaced.has(entry.name)) continue;
    unplacedRoster.push({
      node: '?',
      name: sanitizeCell(entry.name),
      cliModel: '',
      state: entry.status ? sanitizeCell(`· ${entry.status}`) : '· roster',
      pending: '-',
      lastActive: sanitizeCell(renderRelative(entry.lastSeenAt, now)),
      presence: 'roster only',
      controlPlane: 'unknown',
      workerLiveness: 'unknown',
    });
  }

  // Every row carries both axes explicitly. In particular, a local broker can
  // lose its control-plane link while its child workers continue doing useful
  // work; that must render as offline control-plane + live hosted workers.
  for (const row of perNode) {
    if (row.controlPlane !== undefined) continue;
    const contribution = contributionByRow.get(row);
    if (!contribution) continue;
    row.controlPlane = controlPlaneState(contribution.node);
    row.workerLiveness =
      contribution.liveAgents === undefined
        ? 'unknown'
        : contribution.liveAgents.length > 0
          ? 'live'
          : contribution.inventoryAgents === undefined
            ? 'unknown'
            : contribution.inventoryAgents.length > 0
              ? 'degraded'
              : 'empty';
  }

  perNode.sort((a, b) => (a.node === b.node ? a.name.localeCompare(b.name) : a.node.localeCompare(b.node)));
  unplacedRoster.sort((a, b) => a.name.localeCompare(b.name));

  return { perNode, unplacedRoster, errors };
}

function classifyPresence(live: boolean, inventory: boolean, roster: boolean): Presence {
  if (live && inventory && roster) return 'live+inventory+roster';
  if (live && inventory) return 'live+inventory';
  if (live && roster) return 'live+roster';
  if (inventory && roster) return 'inventory+roster';
  if (live) return 'live only';
  if (inventory) return 'inventory only';
  return 'roster only';
}

/**
 * Presence classifier that carries per-surface uncertainty. If one of the two
 * broker maps was unqueryable, the CLI must NOT report the surviving map's
 * membership as a divergence — an unqueryable map is unknown, not empty. The
 * `(inventory?)` / `(live?)` variants say that plainly so an operator can't
 * misread the row as the relay#1539 signature when the other surface simply
 * was not observed.
 */
function classifyPresenceWithUncertainty(
  live: { present: boolean; known: boolean },
  inventory: { present: boolean; known: boolean },
  roster: boolean
): Presence {
  if (live.known && inventory.known) {
    return classifyPresence(live.present, inventory.present, roster);
  }
  // Exactly one surface is unknown. Since names are surfaced from the union
  // of the two maps, the KNOWN half must be `present === true` for any row
  // that reaches this classifier — the branches below are still explicit for
  // defensive clarity, but the `!present` branches are unreachable via the
  // normal iteration path (a bug there would surface as a plain 'roster only'
  // rather than a silent lie).
  if (live.known) {
    return live.present ? 'live only (inventory?)' : 'roster only';
  }
  return inventory.present ? 'inventory only (live?)' : 'roster only';
}

/**
 * Render `buildRows` output as the `--pretty` table. Kept separate from
 * `buildRows` so tests can assert on the exact stdout the user sees.
 */
export function formatPretty(output: BuildRowsOutput): string {
  const rows: RenderedRow[] = [...output.perNode, ...output.unplacedRoster];
  if (rows.length === 0) return 'No agents on any reachable fleet node.';

  const columns = [
    { header: 'NODE', values: rows.map((r) => r.node) },
    { header: 'NAME', values: rows.map((r) => r.name) },
    { header: 'CLI / MODEL', values: rows.map((r) => r.cliModel) },
    { header: 'CONTROL PLANE', values: rows.map((r) => r.controlPlane ?? 'unknown') },
    { header: 'WORKERS', values: rows.map((r) => r.workerLiveness ?? 'unknown') },
    { header: 'STATE', values: rows.map((r) => r.state) },
    { header: 'PENDING', values: rows.map((r) => r.pending) },
    { header: 'LAST ACTIVE', values: rows.map((r) => r.lastActive) },
    { header: 'PRESENCE', values: rows.map((r) => (r.note ? `${r.presence} (${r.note})` : r.presence)) },
  ];
  const widths = columns.map((column) =>
    Math.max(column.header.length, ...column.values.map((value) => value.length))
  );
  const format = (values: string[]): string =>
    values
      .map((value, index) => value.padEnd(widths[index]!))
      .join('  ')
      .trimEnd();

  const table = [
    format(columns.map((column) => column.header)),
    format(columns.map((_, index) => '-'.repeat(widths[index]!))),
    ...rows.map((_row, rowIndex) => format(columns.map((column) => column.values[rowIndex]!))),
  ];

  // Legend: `○ idle` cannot separate "finished" from "working" — the
  // harnesses park at the prompt (per the #1553 cleanup census). A reader
  // who takes `idle` as "safe to release" loses evidence in a way this CLI
  // could quietly cause; the legend flags it every time the column shows.
  const hasIdle = rows.some((row) => row.state.includes('idle'));
  const notes: string[] = [];
  if (hasIdle) {
    notes.push('○ idle means the harness is at its prompt; it does NOT prove the assigned work is complete.');
  }
  if (output.perNode.some((row) => row.presence === 'remote live' || row.presence === 'remote live+roster')) {
    notes.push(
      "remote live: names come from the broker's live WorkerName set on the node heartbeat; PTY detail remains node-local."
    );
  }
  if (output.perNode.some((row) => row.presence === 'remote stale (control plane unavailable)')) {
    notes.push(
      'remote stale: names came from the last broker heartbeat while the control plane was unavailable; worker liveness is unknown.'
    );
  }
  if (rows.some((row) => row.controlPlane !== undefined || row.workerLiveness !== undefined)) {
    notes.push(
      'CONTROL PLANE reports node reachability/handler health; WORKERS reports hosted-worker evidence. Offline or degraded control plane does not prove workers are dead.'
    );
  }
  if (output.perNode.some((row) => row.presence === 'count only (degraded)')) {
    notes.push(
      'remote degraded: the heartbeat count and heartbeat-published live names could not be reconciled; names may be incomplete.'
    );
  }
  if (output.perNode.some((row) => row.presence === 'live only')) {
    notes.push(
      'live only: agent is in the broker PTY map but was not published to the engine (relay#1539 shape).'
    );
  }
  if (
    output.perNode.some(
      (row) =>
        row.presence === 'live only (inventory?)' ||
        row.presence === 'inventory only (live?)' ||
        row.presence === 'empty (inventory?)' ||
        row.presence === 'empty (live?)'
    )
  ) {
    notes.push(
      '(inventory?) / (live?): one of the local broker maps was unqueryable — treat that surface as unknown, not empty; the labelled surface is what was actually observed.'
    );
  }

  const parts = [table.join('\n')];
  if (notes.length > 0) parts.push('', ...notes.map((line) => `  ${line}`));
  if (output.errors.length > 0) {
    parts.push('', 'Per-node errors (nodes NOT dropped from the table above):');
    for (const err of output.errors) {
      parts.push(`  ${err.node}: ${err.message}`);
    }
  }
  return parts.join('\n');
}

/**
 * Result of reading the two local broker maps. Each half succeeds or fails
 * independently — `Promise.allSettled` semantics — so that an older broker
 * that has `/api/spawned` but not `/api/fleet-inventory` still contributes
 * the live worker names it can. Discarding the live map on an inventory
 * failure would recreate the exact defect this command exists to prevent
 * (the local machine's agents vanishing because one endpoint is unavailable).
 */
export interface LocalBrokerMapsResult {
  liveAgents?: ListAgent[];
  liveError?: string;
  inventoryAgents?: FleetInventoryAgent[];
  inventoryError?: string;
}

export async function readLocalBrokerMaps(client: HarnessDriverClient): Promise<LocalBrokerMapsResult> {
  const [liveOutcome, inventoryOutcome] = await Promise.allSettled([
    client.listAgents(),
    client.listFleetInventory(),
  ]);
  const result: LocalBrokerMapsResult = {};
  if (liveOutcome.status === 'fulfilled') {
    result.liveAgents = liveOutcome.value;
  } else {
    result.liveError = errorMessage(liveOutcome.reason);
  }
  if (inventoryOutcome.status === 'fulfilled') {
    result.inventoryAgents = inventoryOutcome.value.agents;
  } else {
    result.inventoryError = errorMessage(inventoryOutcome.reason);
  }
  return result;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
