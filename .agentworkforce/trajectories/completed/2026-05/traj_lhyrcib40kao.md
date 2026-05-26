# Trajectory: Address PR #914 CodeRabbit reliability review findings

> **Status:** ✅ Completed
> **Confidence:** 92%
> **Started:** May 19, 2026 at 01:52 PM
> **Completed:** May 19, 2026 at 02:07 PM

---

## Summary

Addressed PR #914 CodeRabbit reliability findings: broker teardown now emits terminal message_delivery_failed for drained deliveries, stale delivery frames are gated by event_id-aware removal, retryable write failures stay queued, SDK delivery waiters use typed terminal events, CLI env/doctor leaks are fixed, protocol is v2, fixtures/tests/changelog updated, and required validation passed.

**Approach:** Standard approach

---

## Key Decisions

### Gate terminal delivery events on event_id-aware pending removal

- **Chose:** Gate terminal delivery events on event_id-aware pending removal
- **Reasoning:** Stale worker lifecycle frames can reuse delivery_id after retry/requeue; returning the removed PendingDelivery from clear_pending_delivery_if_event_matches prevents stale frames from emitting typed terminal events or mutating worker state.

### Bump broker/SDK protocol version to 2

- **Chose:** Bump broker/SDK protocol version to 2
- **Reasoning:** Agent exit reasons, typed message delivery terminal events, idle since metadata, and blocked-on-send events changed the wire contract relative to v1 clients.

---

## Chapters

### 1. Work

_Agent: default_

- Gate terminal delivery events on event_id-aware pending removal: Gate terminal delivery events on event_id-aware pending removal
- Bump broker/SDK protocol version to 2: Bump broker/SDK protocol version to 2
