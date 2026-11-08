/**
 * `agent-relay fleet agent list` — fleet-wide agent list.
 *
 * Answers "which agents are running on which node, right now?" without the
 * operator having to already know the node. See relay#1553 for the gap.
 *
 * Reads the maps it can from the workspace:
 * - **Every node in the workspace**: names carried in a reserved node
 *   capability on the node's normal heartbeat, joined against that same
 *   heartbeat's `activeAgents` count so partial inventory is labelled degraded.
 * - **Relaycast agent registry** (`agents.list()`): joined against the node
 *   rows to flag registry gaps and to surface roster-only identities that have
 *   no node placement anywhere (a distinct section).
 *
 * The rendered table is the primary user contract; JSON mirrors it verbatim.
 * Callers should never assume a row's absence proves the agent is not
 * running — a row's PRESENCE column names exactly which maps saw it.
 */

import type { RelayNode } from '@agent-relay/sdk';

/** Roster entry as returned by `agents.list()`; only the fields we consume. */
export interface RosterAgent {
  name: string;
  status?: string;
  lastSeenAt?: string;
  metadata?: Record<string, unknown> | null;
}

import type { RemoteLiveAgent } from '../lib/fleet-live-agents.js';
import { describeError } from '../lib/describe-error.js';

export type { RemoteLiveAgent, RemoteLiveAgentRead } from '../lib/fleet-live-agents.js';
export { LIVE_AGENT_CAPABILITY_NAME, readRemoteLiveAgents } from '../lib/fleet-live-agents.js';

/** What each fleet node contributed to the render. */
export interface FleetNodeContribution {
  /** Node record from `nodes.list()`. */
  node: RelayNode;
  /** Node-owned live WorkerNames returned in heartbeat capabilities. */
  remoteAgents?: RemoteLiveAgent[];
  /** Non-null when some heartbeat names could not be decoded safely. */
  remoteWarning?: string;
  /** Non-null when the remote node does not expose a usable live-name heartbeat. */
  remoteError?: string;
  /** Non-null when this node's contribution failed entirely (it could not be reached). */
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
  | 'roster only'
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

/** Relative "now / N minutes ago". */
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

    const count = contribution.node.activeAgents;
    const controlPlane = controlPlaneState(contribution.node);
    const hostedWorkersUnavailable = controlPlane !== 'online';
    if (contribution.remoteAgents === undefined) {
      const renderedCount =
        count === undefined ? 'active count unavailable' : `${count} agent${count === 1 ? '' : 's'} reported`;
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
        presence: hostedWorkersUnavailable ? 'remote stale (control plane unavailable)' : 'remote live',
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

  // Every row carries both axes explicitly: an unreachable node's error row
  // still reports its control-plane state, with worker liveness unknown.
  for (const row of perNode) {
    if (row.controlPlane !== undefined) continue;
    const contribution = contributionByRow.get(row);
    if (!contribution) continue;
    row.controlPlane = controlPlaneState(contribution.node);
    row.workerLiveness = 'unknown';
  }

  perNode.sort((a, b) => (a.node === b.node ? a.name.localeCompare(b.name) : a.node.localeCompare(b.node)));
  unplacedRoster.sort((a, b) => a.name.localeCompare(b.name));

  return { perNode, unplacedRoster, errors };
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

  const notes: string[] = [];
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
