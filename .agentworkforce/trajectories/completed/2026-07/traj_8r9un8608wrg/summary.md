# Trajectory: Fix #1247 B2

> **Status:** ✅ Completed
> **Task:** 1247
> **Confidence:** 85%
> **Started:** July 12, 2026 at 09:18 PM
> **Completed:** July 13, 2026 at 12:56 AM

---

## Summary

Reordered detach reset seq (cursor-homing before alt-leave), documented alacritty scroll_region inaccessibility, replaced to_string with stack push_u16

**Approach:** Standard approach

---

## Key Decisions

### Implemented broker-side compare-and-set (expected_mode) for delivery-mode restore instead of narrowing client-side

- **Chose:** Implemented broker-side compare-and-set (expected_mode) for delivery-mode restore instead of narrowing client-side
- **Reasoning:** Reviewer confirmed it's small; additive optional field, backward compatible; fully eliminates the read-then-restore TOCTOU rather than shrinking it

---

## Chapters

### 1. Work

_Agent: default_

- Implemented broker-side compare-and-set (expected_mode) for delivery-mode restore instead of narrowing client-side: Implemented broker-side compare-and-set (expected_mode) for delivery-mode restore instead of narrowing client-side

---

## Artifacts

**Commits:** ddc34a7, 39aa333, 5ace33b, 6a5827e, bae5c5f, b402fad, 7595b34, ec895f7, 3f92441, e782361, 83fd860, 4b46071, 4b94657, ec6f64c, 1c08f61, e2792f3, 4ff6854, 2b0ae52
**Files changed:** 28
