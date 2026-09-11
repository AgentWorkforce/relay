/**
 * Placement primitives for capability-routed spawns. The
 * `RelaycastMessagingClient` owns the queue/reconcile state machine; this
 * module holds the stateless pieces it builds on: the error type the queue
 * throws, the selection result shape, and the helpers that translate a chosen
 * placement into an `actions.invoke` payload.
 */
import type { RelayNode } from './types.js';

export type PlacementReconcileReason =
  | 'no_eligible_node'
  | 'target_offline'
  | 'unmapped_repo'
  | 'sandbox_policy_mismatch';

/**
 * Evidence state for a targeted spawn placement.
 *
 * `accepted` is an engine receipt only; it is never evidence that a worker
 * launched. `unconfirmed_may_be_running` is deliberately non-terminal from
 * the worker's perspective: the invocation may still complete after the
 * caller's confirmation budget, so retrying can duplicate work.
 */
export type RelaySpawnPlacementState = 'accepted' | 'ready' | 'unconfirmed_may_be_running' | 'failed';

export type RelaySpawnDispatchState = 'dispatched' | 'not_dispatched' | 'unknown';

// Status vocabulary a route-evidence check alone cannot classify. Kept as a
// small local set — deliberately *not* imported from the CLI's spawn
// lifecycle helper (`packages/cli/src/cli/lib/spawn-lifecycle.ts`), since the
// SDK package must not depend on CLI source to stay classification-correct.
// Both sides read the same authoritative shape (relay#1563): a node id on the
// ack/invocation is real dispatch evidence; a `pending`/`queued` status with
// no node id is not.
const DISPATCH_EVIDENT_STATUSES = new Set([
  'dispatched',
  'invoked',
  'running',
  'completed',
  'succeeded',
  'success',
]);
const NOT_DISPATCHED_STATUSES = new Set(['pending', 'queued']);

/**
 * Classify dispatch evidence from an invocation ack (or its terminal read
 * back), matching the CLI's `spawnLifecycleState`/`dispatchEvidence`
 * semantics: a `dispatchedNodeId`/`handlerNodeId` is real evidence a node
 * received the dispatch. Its absence, with a `pending`/`queued` status, means
 * the invocation never actually routed — even if the caller later observes a
 * terminal (timeout or error) outcome for it. A timeout or terminal error is
 * a fact about the *caller's* wait, not evidence that dispatch happened.
 */
export function resolveDispatchState(ack: {
  dispatchedNodeId?: string | null;
  handlerNodeId?: string | null;
  status?: string;
}): RelaySpawnDispatchState {
  if (ack.dispatchedNodeId || ack.handlerNodeId) return 'dispatched';
  const status = ack.status?.toLowerCase();
  if (status && DISPATCH_EVIDENT_STATUSES.has(status)) return 'dispatched';
  if (status && NOT_DISPATCHED_STATUSES.has(status)) return 'not_dispatched';
  return 'unknown';
}

export type PlacementSelection =
  | { node: RelayNode; message?: never; hardFail?: never; reason?: never; reconcileReason?: never }
  | {
      // Hard failure — thrown before any side effect; `reason` is the error code.
      node?: never;
      message: string;
      hardFail: true;
      reason: 'capability_mismatch' | 'sandbox_policy_mismatch';
      reconcileReason: PlacementReconcileReason;
    }
  | {
      // Retryable — queued and reconciled; only `reconcileReason` is consumed.
      node?: never;
      message: string;
      hardFail?: false;
      reason?: never;
      reconcileReason: PlacementReconcileReason;
    };

export class RelayPlacementError extends Error {
  readonly code:
    | 'capability_mismatch'
    | 'placement_queue_full'
    | 'placement_ttl_expired'
    | 'no_eligible_node'
    | 'node_unavailable'
    | 'sandbox_policy_mismatch'
    | 'unmapped_repo'
    /** The node ran the action and reported a failure. */
    | 'spawn_failed'
    /**
     * The node accepted the invocation but never reported a terminal result.
     * A node running an obsolete broker advertises `spawn:<harness>` capacity
     * and acknowledges the dispatch without launching anything, which is
     * otherwise indistinguishable from success at the requester.
     */
    | 'spawn_unconfirmed';
  readonly capability: string;
  readonly node?: string;
  readonly repo?: string;
  readonly attempts: number;
  /** Stable invocation correlation for accepted/dispatch outcomes. */
  readonly invocationId?: string;
  /** Evidence state at the point this placement returned or failed. */
  readonly state?: RelaySpawnPlacementState;
  /** Whether the engine supplied evidence that a node received the dispatch. */
  readonly dispatchState?: RelaySpawnDispatchState;
  /** Original invocation receipt, when a terminal spawn result was observed. */
  readonly receipt?: Record<string, unknown>;

  constructor(
    code: RelayPlacementError['code'],
    message: string,
    context: {
      capability: string;
      node?: string;
      repo?: string;
      attempts: number;
      invocationId?: string;
      state?: RelaySpawnPlacementState;
      dispatchState?: RelaySpawnDispatchState;
      receipt?: Record<string, unknown>;
    }
  ) {
    super(message);
    this.name = 'RelayPlacementError';
    this.code = code;
    this.capability = context.capability;
    this.node = context.node;
    this.repo = context.repo;
    this.attempts = context.attempts;
    this.invocationId = context.invocationId;
    this.state = context.state;
    this.dispatchState = context.dispatchState;
    this.receipt = context.receipt;
  }
}

export function nonEmptyPlacement(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  return trimmed;
}

export function placementActionName(capability: string): string {
  return capability.startsWith('spawn:') ? 'spawn' : capability;
}

export function placementActionInput(
  input: Record<string, unknown> | undefined,
  placement: { capability: string; node?: string; repo?: string; ttlMs: number }
): Record<string, unknown> {
  const payload = { ...(input ?? {}) };
  payload.capability = placement.capability;
  if (placement.node) {
    payload.node = placement.node;
    payload.target_node = placement.node;
  } else {
    // Automatic placement belongs to the engine. Do not let untrusted action
    // input silently convert it back into a targeted request.
    delete payload.node;
    delete payload.target_node;
  }
  if (placement.repo) payload.repo = placement.repo;
  if (placement.ttlMs > 0) {
    payload.ttl_override_ms = placement.ttlMs;
  }
  if (placement.capability.startsWith('spawn:')) {
    // The broker picks the harness from `cli`, but node eligibility was gated on
    // the `spawn:<cli>` capability. An explicit, mismatched `cli` would select a
    // harness the chosen node never advertised — reject it instead of silently
    // dispatching the wrong harness.
    const capabilityCli = placement.capability.slice('spawn:'.length);
    if (typeof payload.cli === 'string' && payload.cli !== capabilityCli) {
      throw new RelayPlacementError(
        'capability_mismatch',
        `Placement rejected: input cli "${payload.cli}" does not match capability "${placement.capability}"`,
        { capability: placement.capability, node: placement.node, repo: placement.repo, attempts: 0 }
      );
    }
    payload.cli = capabilityCli;
  }
  return payload;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
