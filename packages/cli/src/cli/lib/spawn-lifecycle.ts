export type SpawnLifecycleState = 'accepted' | 'ready' | 'unconfirmed_may_be_running' | 'failed';
export type SpawnDispatchState = 'dispatched' | 'not_dispatched' | 'unknown';

const SUCCESS = new Set(['completed', 'succeeded', 'success']);
const FAILURE = new Set(['failed', 'error', 'cancelled', 'canceled', 'denied']);
const DISPATCHED = new Set(['dispatched', 'invoked', 'running']);
const NOT_DISPATCHED = new Set(['pending', 'queued']);

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function dispatchEvidence(value: Record<string, unknown>): SpawnDispatchState {
  const status = text(value.status)?.toLowerCase();
  if (
    text(value.dispatchedNodeId) ||
    text(value.dispatched_node_id) ||
    text(value.handlerNodeId) ||
    text(value.handler_node_id) ||
    (status !== undefined && (DISPATCHED.has(status) || SUCCESS.has(status)))
  ) {
    return 'dispatched';
  }
  if (status !== undefined && NOT_DISPATCHED.has(status)) return 'not_dispatched';
  return 'unknown';
}

export function spawnLifecycleState(value: Record<string, unknown>): SpawnLifecycleState {
  const status = text(value.status)?.toLowerCase();
  if (status && SUCCESS.has(status)) {
    const output =
      value.output !== null && typeof value.output === 'object'
        ? (value.output as Record<string, unknown>)
        : value;
    // A terminal success status without explicit launch and readiness proof is
    // a failed spawn, not a live-but-uncertain one. Genuine uncertainty is
    // reserved for non-terminal acknowledgements and confirmation timeouts.
    return output.spawned === true && output.ready === true ? 'ready' : 'failed';
  }
  if (status && FAILURE.has(status)) return 'failed';
  if (status === 'accepted') return 'accepted';
  if (status && NOT_DISPATCHED.has(status) && dispatchEvidence(value) === 'not_dispatched') return 'accepted';
  return 'unconfirmed_may_be_running';
}

// Allowlisted keys for a spawn receipt that crosses a CLI/MCP serialization
// boundary. Upstream invocation records can carry arbitrary broker/handler
// output (raw error text, task payloads, environment-derived metadata) that
// is not safe to echo back verbatim — see relay#1563. Only lifecycle
// evidence (status/ids/readiness) is allowlisted through.
const SPAWN_RECEIPT_ALLOWED_KEYS = [
  'status',
  'invocation_id',
  'invocationId',
  'dispatched_node_id',
  'dispatchedNodeId',
  'handler_node_id',
  'handlerNodeId',
] as const;

/**
 * Project an upstream spawn invocation record down to an allowlisted set of
 * lifecycle-evidence fields, dropping raw error text, task payloads, and any
 * other upstream data that should not cross a CLI/MCP serialization
 * boundary unsanitized.
 */
export function sanitizedSpawnReceipt(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SPAWN_RECEIPT_ALLOWED_KEYS) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  const output =
    value.output !== null && typeof value.output === 'object'
      ? (value.output as Record<string, unknown>)
      : undefined;
  if (output && (typeof output.spawned === 'boolean' || typeof output.ready === 'boolean')) {
    out.output = {
      ...(typeof output.spawned === 'boolean' ? { spawned: output.spawned } : {}),
      ...(typeof output.ready === 'boolean' ? { ready: output.ready } : {}),
    };
  }
  return out;
}

export function spawnPlacementReceipt(value: Record<string, unknown>): Record<string, unknown> {
  const invocationId = text(value.invocationId) ?? text(value.invocation_id);
  const dispatchedNodeId = text(value.dispatchedNodeId) ?? text(value.dispatched_node_id);
  const handlerNodeId = text(value.handlerNodeId) ?? text(value.handler_node_id);
  return {
    state: spawnLifecycleState(value),
    dispatchState: dispatchEvidence(value),
    ...(invocationId ? { invocationId } : {}),
    ...(dispatchedNodeId ? { dispatchedNodeId } : {}),
    ...(handlerNodeId ? { handlerNodeId } : {}),
  };
}
