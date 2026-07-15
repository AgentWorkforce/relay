# Trajectory: Fix Swift AsyncStream continuation leaks for issue 1266

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** July 15, 2026 at 06:39 AM
> **Completed:** July 15, 2026 at 06:53 AM

---

## Summary

Fixed Swift SDK AsyncStream continuation leaks with cancellation cleanup, bounded buffers, lazy channel streams, disconnect generation fencing, and 129 passing regression tests

**Approach:** Standard approach

---

## Key Decisions

### Use token-keyed bounded AsyncStream registries in both Swift SDKs
- **Chose:** Use token-keyed bounded AsyncStream registries in both Swift SDKs
- **Reasoning:** Stable UUIDs plus termination tombstones close cancellation-before-registration races; bufferingNewest(256) bounds event/message queues, bufferingNewest(1) bounds state, and lazy channel streams avoid join-only queues.

### Fence Swift stream registration with disconnect generations
- **Chose:** Fence Swift stream registration with disconnect generations
- **Reasoning:** Claude review identified tombstone growth and post-disconnect registration resurrection. Cancel-aware registration tasks eliminate termination tombstones, while a lock-protected generation invalidated at disconnect rejects actor tasks scheduled by older stream epochs.

---

## Chapters

### 1. Work
*Agent: default*

- Use token-keyed bounded AsyncStream registries in both Swift SDKs: Use token-keyed bounded AsyncStream registries in both Swift SDKs
- Fence Swift stream registration with disconnect generations: Fence Swift stream registration with disconnect generations
