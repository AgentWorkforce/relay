# Trajectory: Add RelayFlow proof for broker Cloud registration mismatch

> **Status:** ✅ Completed
> **Confidence:** 92%
> **Started:** September 3, 2026 at 01:59 PM
> **Completed:** September 3, 2026 at 02:00 PM

---

## Summary

Added and locally validated an exact-base/exact-head RelayFlow proof for node status Cloud addressability.

**Approach:** Standard approach

---

## Key Decisions

### Use an exact-checkout public CLI proof with a fake local broker and Cloud 404

- **Chose:** Use an exact-checkout public CLI proof with a fake local broker and Cloud 404
- **Reasoning:** This captures the operator-visible mismatch on base and the LOCAL-ONLY/SSH guidance on head without pretending the Cloud-only attach route is self-hostable.

---

## Chapters

### 1. Work

_Agent: default_

- Use an exact-checkout public CLI proof with a fake local broker and Cloud 404: Use an exact-checkout public CLI proof with a fake local broker and Cloud 404
