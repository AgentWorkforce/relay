# Provider subscription reply investigation (2026-10-05)

This change implements the locally verifiable portions of `reviewed-plan.md`.
It does **not** establish that the reported GitHub writeback failure is fixed.

## Available evidence

- The incident's Relay workspace is inaccessible in this run: `agent-relay
  message inbox check` reports no workspace key. No authenticated message,
  transcript, subscription, or binding read could be made (E1–E3).
- A read-only `RelayfileControlPlaneClient({ autoStart: false })` binding read
  reports `DAEMON_UNAVAILABLE`. Stored PR globs therefore remain unverified;
  this change does not add an issue-comment glob or widen provider scope.
- Installed `@relaycast/types/dist/subscription.d.ts` declares plural `events`,
  `is_active`, and subscription configuration. It declares no delivery-attempt
  status or retry operation. Event-array support is corroborated, but the
  incident subscription's stored coverage remains unknown.
- Installed `@relayfile/client/dist/client.d.ts` exposes binding, webhook, and
  writeback-secret operations, but no ops-ledger read or retry API. The local
  client does not establish whether cloud subscription ingress uses the
  file-write ops ledger (E4 remains open).
- Installed `@relaycast/sdk/dist/agent.js` supplies `Idempotency-Key` headers for
  channel posts and thread replies, including generated keys. That proves
  transport behavior, not engine enforcement. No explicit `idempotency_key`
  tool argument is added without E5 confirmation.
- The existing changelog also records a standalone MCP double-dispatch fix in
  13.1.0. The incident was on 12.4.0; without its transcript, parallel aliases
  cannot be asserted as the incident's root cause.

## Changes and boundaries

MCP posts/replies use request replay and pending-only argument coalescing.
Native tools use a per-session pending map. Concurrent identical writes join;
settled writes, different identities, targets, options, and sessions remain
separate. MCP joins emit `agent_relay_write_coalesced` with only the tool name.
This cannot deduplicate distinct processes or sequential unkeyed retries after a
lost response.

Subscription setup reads persisted event coverage before binding, rejects
unsupported events and inactive/mismatched subscriptions, and uses the existing
journaled rollback. Missing GitHub identity authorization produces an explicit
unverified message. `--list` exposes outbound configuration with
`deliveryStatus: null`; this is not a successful delivery receipt. Its
`lastDeliverySource` distinguishes inbound control-plane reports from channel
activity inferred locally.

The deterministic tests exercise real CLI provisioning/rollback and MCP
transport against boundary fakes, plus native-tool and SDK normalization
regressions. They do not substitute a fake provider ledger for a real
GitHub inbound → fleet wake → reply → writeback integration test.

## Remaining companion verification

Read the incident binding and subscription, compare issue-comment and PR paths,
and inspect the cloud subscription writeback ingress. If ingress bypasses the
existing ops ledger, route it through that ledger using the originating Relay
message ID as the stable operation key. Expose durable failed/dead-lettered
status and retry through the control-plane client. Verify retry after both a
provider failure and a lost successful response, with one resulting GitHub
comment. Only then build the full seam test against those verified contracts.

No broker reconnect behavior changed. Existing delivery-book tests cover
cumulative ACK dedupe, seeded resume cursors, and replay of unacknowledged
manual sequences after restart in `crates/broker/src/node_control.rs`.
`duplicate_and_stale_plans_still_ack_to_stop_redelivery` in
`crates/broker/src/runtime/fleet.rs` covers ACK behavior. These are existing
coverage, not a new exact-PR end-to-end proof; Rust tests were not run here
because Cargo is unavailable.
