# Trajectory: Increment 3: remove dead firehose delivery path in broker (node-only delivery)

> **Status:** ✅ Completed
> **Task:** broker-node-delivery-inc3
> **Confidence:** 85%
> **Started:** June 25, 2026 at 02:56 PM
> **Completed:** June 25, 2026 at 03:09 PM

---

## Summary

Removed dead broker-runtime firehose delivery path for node-only delivery: deleted fleet_mode_enabled field and the firehose drop, gutted handle_relaycast_message to a log-and-discard (delivery is node-only via handle_fleet_deliver), and removed now-dead firehose-only helpers (relaycast_ws_control_dedup_key, routing is_self_echo/resolve_delivery_targets/worker_names_for_dm_participants/display_target_for_dashboard/DeliveryPlan, queue_and_try_delivery, has_any_worker/has_worker_by_name_ignoring_case, dm_participants_cache field) with their tests. Kept RelaycastWsClient::run and map_ws_event because wrap mode still uses the firehose. cargo build+clippy clean; 781 tests pass.

**Approach:** Standard approach

---

## Key Decisions

### Remove fleet_mode_enabled field entirely (only reader was the firehose drop) and gut the firehose delivery: stop RelaycastWsClient connecting to /v1/ws and strip the map_ws_event injection body from handle_relaycast_message
- **Chose:** Remove fleet_mode_enabled field entirely (only reader was the firehose drop) and gut the firehose delivery: stop RelaycastWsClient connecting to /v1/ws and strip the map_ws_event injection body from handle_relaycast_message
- **Reasoning:** fleet_mode_enabled's sole reader is the firehose drop at relaycast_events.rs:77-85; node delivery (Inc2) is the only delivery path. Keep WsControl plumbing (Publish loopback / Subscribe / Unsubscribe / Shutdown) since it is sent from many call sites and Publish/agent.state loopback is already a no-op; only remove the workspace-WS connection + raw-event pump + message injection.

### Kept RelaycastWsClient::run and map_ws_event intact
- **Chose:** Kept RelaycastWsClient::run and map_ws_event intact
- **Reasoning:** wrap mode (agent-relay-broker wrap) shares connect_relay -> MultiWorkspaceSession -> RelaycastWsClient::run -> ws_inbound_rx and legitimately uses the firehose for single-agent PTY injection; removing the WS connection would break wrap. Scope limited to the broker fleet runtime firehose consumer.

---

## Chapters

### 1. Work
*Agent: default*

- Remove fleet_mode_enabled field entirely (only reader was the firehose drop) and gut the firehose delivery: stop RelaycastWsClient connecting to /v1/ws and strip the map_ws_event injection body from handle_relaycast_message: Remove fleet_mode_enabled field entirely (only reader was the firehose drop) and gut the firehose delivery: stop RelaycastWsClient connecting to /v1/ws and strip the map_ws_event injection body from handle_relaycast_message
- Kept RelaycastWsClient::run and map_ws_event intact: Kept RelaycastWsClient::run and map_ws_event intact
