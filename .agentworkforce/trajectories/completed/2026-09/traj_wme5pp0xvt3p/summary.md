# Trajectory: Raise mcp-args registration timeout for reliable Cloud RelayFlows

> **Status:** ✅ Completed
> **Confidence:** 92%
> **Started:** September 1, 2026 at 07:38 PM
> **Completed:** September 1, 2026 at 07:42 PM

---

## Summary

Raised mcp-args Relaycast registration timeout from 10s to 30s, added a deterministic bounded-timeout regression test, updated the patch changelog, and validated formatting, clippy, and the full 1,042-test broker suite.

**Approach:** Standard approach

---

## Key Decisions

### Raise the broker registration bound to 30 seconds and keep Cloud's bounded retry layer
- **Chose:** Raise the broker registration bound to 30 seconds and keep Cloud's bounded retry layer
- **Reasoning:** The live base arm registered successfully, while the head arm exhausted three identical 10-second client deadlines. A longer per-request bound addresses the actual latency boundary and avoids relying only on repeated token-rotating POSTs; 30 seconds matches the broker fleet registration allowance.

---

## Chapters

### 1. Work
*Agent: default*

- Raise the broker registration bound to 30 seconds and keep Cloud's bounded retry layer: Raise the broker registration bound to 30 seconds and keep Cloud's bounded retry layer
