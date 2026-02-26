# ADR-001: Canonical Send Path

## Status

Accepted

## Context

The relay program previously had routing and identity logic split across dashboard, broker, and SDK layers. This caused drift in message targeting behavior, duplicate identity heuristics, and inconsistent dashboard rendering during reconnect/replay windows.

Wave 1-4 work established broker-side canonical parsing and routing primitives:

- `EventAccessor` in `relay-cli-uses-broker/src/message_bridge.rs` for tolerant Relaycast event parsing across top-level and payload-wrapped shapes.
- `DeliveryPlan` in `relay-cli-uses-broker/src/routing.rs` for deterministic target resolution (channel fanout, direct target lookup, DM participant fallback).

## Decision

Adopt a single canonical send path:

1. Dashboard sends through broker APIs/WebSocket surfaces only.
2. Broker maps inbound Relaycast server events through `EventAccessor` into normalized `InboundRelayEvent`.
3. Broker resolves recipients with `DeliveryPlan` (`resolve_delivery_targets`), including DM participant resolution when `needs_dm_resolution` is set.
4. Broker injects to worker PTYs and emits lifecycle events.
5. Broker rebroadcasts normalized `relay_inbound` updates to dashboard listeners.

Additional routing rules in the canonical path:

- Self-echo suppression is broker-owned (`is_self_echo`).
- Event deduplication is broker-owned (event-id based).
- Dashboard is a proxy/renderer, not a routing authority.

## Consequences

Positive:

- One authority for routing decisions and identity normalization.
- Cross-repo contract tests can validate a single behavior model.
- Dashboard code stays smaller and less stateful.

Trade-offs:

- Broker becomes a stronger dependency for UI correctness.
- Parsing/routing regressions now impact all consumers and require stricter contract gates.
