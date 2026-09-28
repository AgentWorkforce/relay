# Trajectory: Refactor PR 1864 to reuse Relaycast SDK transport

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#1864
> **Confidence:** 92%
> **Started:** September 28, 2026 at 10:40 AM
> **Completed:** September 28, 2026 at 11:00 AM

---

## Summary

Refactored on-relay to consume Relaycast SDK transport, added SDK subscription lifecycle ownership hooks, extracted reusable coding-session injection and durable delivery modules, updated docs/tests/changelog, and validated the changed surfaces.

**Approach:** Standard approach

---

## Key Decisions

### Use RelaycastMessagingClient.inbox.subscribe as the sole realtime transport
- **Chose:** Use RelaycastMessagingClient.inbox.subscribe as the sole realtime transport
- **Reasoning:** The SDK already owns direct-node token minting, node registration, heartbeats, reconnect, durable delivery listing, and ack/fail/defer; the CLI only needs a stream wakeup plus its local pre-injection ledger.

---

## Chapters

### 1. Work
*Agent: default*

- Use RelaycastMessagingClient.inbox.subscribe as the sole realtime transport: Use RelaycastMessagingClient.inbox.subscribe as the sole realtime transport
- Transport duplication removed: the CLI now delegates direct-node connection, reconnect, streaming, and delivery transitions to the SDK; injection and durable at-most-once state are isolated as reusable CLI library modules. Focused tests, full SDK tests, typecheck, build, lint, formatting, and Veto review pass; unrelated root-suite failures were reproduced outside the changed surfaces.
