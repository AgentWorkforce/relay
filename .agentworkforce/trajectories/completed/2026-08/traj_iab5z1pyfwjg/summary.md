# Trajectory: Address multi-membership budget review on PR 1568

> **Status:** ✅ Completed
> **Task:** relay#1562
> **Confidence:** 92%
> **Started:** August 18, 2026 at 12:31 PM
> **Completed:** August 18, 2026 at 12:36 PM

---

## Summary

Added a 44-second aggregate handshake cap with remaining-budget retries, covered the two-membership 24s plus 19.75s schedule, and split the changelog impacts. Full broker tests and scoped Clippy pass.

**Approach:** Standard approach

---

## Key Decisions

### Cap aggregate handshake time at 44 seconds
- **Chose:** Cap aggregate handshake time at 44 seconds
- **Reasoning:** Membership scaling can make the default exceed the verified 45s harness deadline. A 44s broker cap preserves the single-membership 3x12s behavior, lets multi-membership retries use the remaining budget instead of disappearing entirely, and leaves 1s for the broker error to reach the SDK. It also bounds large membership counts and oversized env overrides that the outer SDK could never honor.

---

## Chapters

### 1. Work
*Agent: default*

- Cap aggregate handshake time at 44 seconds: Cap aggregate handshake time at 44 seconds
