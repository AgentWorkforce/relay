# Trajectory: Address PR 1610 ordered liveness probe review

> **Status:** ✅ Completed
> **Task:** PR-1610
> **Confidence:** 95%
> **Started:** August 26, 2026 at 02:34 AM
> **Completed:** August 26, 2026 at 02:37 AM

---

## Summary

Preserved newer inventory probes across older acknowledgements and added an A-acknowledged/B-rejected regression.

**Approach:** Tracked inventory probe IDs in send order and covered the ordered acknowledgement/rejection sequence with a focused regression test.

---

## Key Decisions

### Track pending inventory probes in send order and drain only through the acknowledged probe
- **Chose:** Track pending inventory probes in send order and drain only through the acknowledged probe
- **Reasoning:** Relaycast serializes node control work; acknowledging A proves older probes but not newer B, whose later rejection must still force reconnect.

---

## Chapters

### 1. Work
*Agent: default*

- Track pending inventory probes in send order and drain only through the acknowledged probe: Track pending inventory probes in send order and drain only through the acknowledged probe

---

## Artifacts

**Commits:** dbdea083a
**Files changed:** 2
