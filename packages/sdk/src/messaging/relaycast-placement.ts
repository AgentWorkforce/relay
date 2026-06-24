/**
 * Placement primitives for capability-routed spawns. The
 * `RelaycastMessagingClient` owns the queue/reconcile state machine; this
 * module holds the stateless pieces it builds on: the error type the queue
 * throws, the selection result shape, and the helpers that translate a chosen
 * placement into an `actions.invoke` payload.
 */
import type { RelayNode } from './types.js';

export type PlacementReconcileReason = 'no_eligible_node' | 'target_offline' | 'unmapped_repo';

export type PlacementSelection =
  | { node: RelayNode; message?: never; hardFail?: never; reason?: never; reconcileReason?: never }
  | {
      // Hard failure — thrown before any side effect; `reason` is the error code.
      node?: never;
      message: string;
      hardFail: true;
      reason: 'capability_mismatch';
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
  readonly code: 'capability_mismatch' | 'placement_queue_full' | 'placement_ttl_expired' | 'unmapped_repo';
  readonly capability: string;
  readonly node?: string;
  readonly repo?: string;
  readonly attempts: number;

  constructor(
    code: RelayPlacementError['code'],
    message: string,
    context: { capability: string; node?: string; repo?: string; attempts: number }
  ) {
    super(message);
    this.name = 'RelayPlacementError';
    this.code = code;
    this.capability = context.capability;
    this.node = context.node;
    this.repo = context.repo;
    this.attempts = context.attempts;
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
  placement: { capability: string; node: string; repo?: string; ttlMs: number }
): Record<string, unknown> {
  const payload = { ...(input ?? {}) };
  payload.capability = placement.capability;
  payload.node = placement.node;
  payload.target_node = placement.node;
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
