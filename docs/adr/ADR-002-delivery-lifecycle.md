# ADR-002: Delivery Lifecycle

## Status

Accepted

## Context

Message delivery observability was inconsistent across queueing, PTY injection, and verification. Reconnect scenarios also required deterministic replay so dashboards and SDK listeners could reconstruct state after transient disconnects.

The broker now emits delivery lifecycle events and maintains replay state in `ReplayBuffer`.

## Decision

Define the delivery lifecycle as:

- `queued`: delivery accepted for worker processing.
- `injected`: payload written (or re-written) into worker PTY input path.
- terminal status: exactly one of `verified`, `failed`, or `uncertain`.

Mapping to current event surfaces:

- `delivery_queued`
- `delivery_injected`
- terminal:
  - `delivery_verified`
  - `delivery_failed`
  - `delivery_uncertain` (reserved contract state for non-provable outcomes)

Invariant:

- Exactly one terminal status is allowed per `delivery_id`.

Replay semantics:

- Relevant broker events are sequence-annotated and retained in a bounded ring buffer (`DEFAULT_REPLAY_CAPACITY = 1000`).
- Clients reconnect with `since_seq`.
- Broker subscribes before replay and applies a replay cutoff to prevent replay/live duplication.
- If cursor is stale, broker emits `replay_gap` with `oldestAvailable` before replay payloads.

## Consequences

Positive:

- Deterministic lifecycle accounting for delivery reliability and SLOs.
- Reconnect-safe dashboards/SDK consumers with gap signaling.
- Clear contract surface for integration and parity tests.

Trade-offs:

- Additional state management and sequencing complexity in broker.
- Consumers must handle replay gaps and reserved terminal states.
