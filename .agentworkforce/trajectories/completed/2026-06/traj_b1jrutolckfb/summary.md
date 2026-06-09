# Trajectory: Workspace-level event stream via relaycast 2.5.1

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** June 3, 2026 at 08:27 AM
> **Completed:** June 9, 2026 at 04:04 PM

---

## Summary

Fixed four broker delivery-durability defects: unverified timeout-fallback acks now distinct from verified successes (events + throttle), graceful shutdown persists non-empty pending deliveries, pending map persisted on every mutation via dirty-tracking store, queue-cap evictions emit delivery_dropped events. 709 unit tests pass, clippy clean.

**Approach:** Standard approach

---

## Key Decisions

### Port PR 888 telemetry lessons to current split

- **Chose:** Port PR 888 telemetry lessons to current split
- **Reasoning:** User requested Relaycast request attribution, install/update events, and MCP action-call telemetry while preserving UA-like harness values.

### Added DeliveryOutcome::Unverified for timeout-fallback acks

- **Chose:** Added DeliveryOutcome::Unverified for timeout-fallback acks
- **Reasoning:** Fallback ack must stay (re-injection deliberately disabled to avoid duplicates) but unverified deliveries must not feed the throttle's success streak; a neutral variant breaks the streak without backing off

### PendingDeliveryStore wrapper with DerefMut dirty tracking

- **Chose:** PendingDeliveryStore wrapper with DerefMut dirty tracking
- **Reasoning:** Free delivery helpers take &mut HashMap across many call sites; a Deref/DerefMut wrapper marks dirty on any mutable coercion so the event loop persists after every mutating event with zero call-site churn

### Kept --persist flag default-off

- **Chose:** Kept --persist flag default-off
- **Reasoning:** The flag also gates state files, lock/PID files, MCP config injection mode, and lease-based ephemeral shutdown; flipping it would change far more than delivery durability and break ephemeral one-shot SDK sessions

### Skipped dedup-cache persistence

- **Chose:** Skipped dedup-cache persistence
- **Reasoning:** Optional per task; would add restart-replay dedup but bloats the diff beyond delivery semantics

---

## Chapters

### 1. Work

_Agent: default_

- events.connect() falls back to the relaycast 2.5 workspace stream when no agent client; fixes relay#1031 so workspace relay.addListener streams. Bumped @relaycast/sdk to ^2.5.1. Also fixed pre-existing vitest-4 constructor-mock breakage in agent-relay.test.ts (main 'Test' workflow was red).: events.connect() falls back to the relaycast 2.5 workspace stream when no agent client; fixes relay#1031 so workspace relay.addListener streams. Bumped @relaycast/sdk to ^2.5.1. Also fixed pre-existing vitest-4 constructor-mock breakage in agent-relay.test.ts (main 'Test' workflow was red).
- Port PR 888 telemetry lessons to current split: Port PR 888 telemetry lessons to current split
- Added DeliveryOutcome::Unverified for timeout-fallback acks: Added DeliveryOutcome::Unverified for timeout-fallback acks
- PendingDeliveryStore wrapper with DerefMut dirty tracking: PendingDeliveryStore wrapper with DerefMut dirty tracking
- Kept --persist flag default-off: Kept --persist flag default-off
- Skipped dedup-cache persistence: Skipped dedup-cache persistence

---

## Artifacts

**Commits:** 7e9a44ab, 6b67acfc, 8f39248f, d8247f70, 1301a319, d67f6de6, b11c257e, ad9dbe41, 6eef2da3, bc6b9826, eb55a2b7, 8f4db312, ac43ef4b, a14f65f9, d8d00e2c, 58d7f729, 7f2392d7, 6df294fc, b17be37e, 1433c47e, c7811469, 80e42410, aaa65c91, f4ff7e02, 1cb41cff, d18bd284, a5ce5aae, 0a651273, 767f954b, 9c6d2229, 51ee3852, 235a7507, 9959deed, eb9dc4c2, 00a2c436, f48136a6
**Files changed:** 197
