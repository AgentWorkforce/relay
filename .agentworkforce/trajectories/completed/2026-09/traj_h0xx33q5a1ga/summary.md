# Trajectory: Accept Relaycast context.update node frames in the broker (relay#1615)

> **Status:** ✅ Completed
> **Task:** 1615
> **Confidence:** 85%
> **Started:** September 2, 2026 at 04:39 AM
> **Completed:** September 2, 2026 at 04:42 AM

---

## Summary

Broker parses Relaycast context.update node frames via a new ServerToNode::ContextUpdate variant, surfaces Relaycast delivery problems to the sending worker as message_delivery_failed, and drops the cached Relaycast registration on agent.identity_taken_over. (Review follow-up on the same PR narrowed the surfaced event to delivery.failed only: delivery.deferred is non-terminal — it stays queued for a later available_at retry — so it is now log-only.) Verified with `cargo fmt --all --check` (clean), `cargo clippy -p agent-relay-broker --all-targets` (no warnings), and `cargo test -p agent-relay-broker`: 1047 passed / 0 failed / 4 ignored in the lib unit suite, plus 12 continuity, 1 fleet_wire_fixtures and 3 journal_lock_cli integration tests, and 0 doc-tests. RelayFlow case 1615-context-update-frames was run on both compiled arms — base (origin/main) yields outcome bug / context_update_rejected_as_invalid_frame, head yields outcome fixed / context_update_accepted_and_routed.

**Approach:** Mirror the engine's canonical context.update schema in fleet_wire (forward-compatible, no deny_unknown_fields), route the parsed frame through the existing fleet-control channel, and prove base/head behaviour with a dependency-free fake Relaycast in a RelayFlow case.

---

## Key Decisions

### Reused BrokerEvent::MessageDeliveryFailed for Relaycast delivery.failed/deferred instead of a new event kind
- **Chose:** Reused BrokerEvent::MessageDeliveryFailed for Relaycast delivery.failed/deferred instead of a new event kind
- **Reasoning:** SDK/dashboard consumers already render message_delivery_failed; a new kind would need client changes to be visible, defeating the point of surfacing the failure to the sending agent

### Reused RelaycastHttpClient::forget_agent_registration for agent.identity_taken_over
- **Chose:** Reused RelaycastHttpClient::forget_agent_registration for agent.identity_taken_over
- **Reasoning:** That cache is the state the takeover/registration paths in relaycast/ws.rs already consult; a parallel stale flag would drift

---

## Chapters

### 1. Work
*Agent: default*

- Reused BrokerEvent::MessageDeliveryFailed for Relaycast delivery.failed/deferred instead of a new event kind: Reused BrokerEvent::MessageDeliveryFailed for Relaycast delivery.failed/deferred instead of a new event kind
- Reused RelaycastHttpClient::forget_agent_registration for agent.identity_taken_over: Reused RelaycastHttpClient::forget_agent_registration for agent.identity_taken_over

---

## Commits

- `c919d2eeff0bf606a215141822571ca1fdbba5d3`

Traced range: `6d5199ff103cb5f4ff6adf0a3fa32a788646a9bc` .. `c919d2eeff0bf606a215141822571ca1fdbba5d3`

## Files Changed

- `CHANGELOG.md`
- `crates/broker/src/fleet_wire.rs`
- `crates/broker/src/node_control.rs`
- `crates/broker/src/relaycast/ws.rs`
- `crates/broker/src/runtime/fleet.rs`
- `crates/broker/src/runtime/tests.rs`
- `crates/broker/tests/fixtures/fleet-wire/context.update.json`
- `crates/broker/tests/fleet_wire_fixtures.rs`
- `tests/relayflows/cases/1615-context-update-frames/case.json`
- `tests/relayflows/cases/1615-context-update-frames/run.mjs`
