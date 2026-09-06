# Trajectory: Repair parentless adopted PTYs for relay #1602

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#1602 review
> **Confidence:** 97%
> **Started:** August 25, 2026 at 10:03 AM
> **Completed:** August 25, 2026 at 10:03 AM

---

## Summary

Included parentless live adopted PTYs in identity-safe reconciliation and proved the real WorkerRegistry-to-reconnect path end to end.

**Approach:** Standard approach

---

## Key Decisions

### Do not use the transient parent marker as roster eligibility
- **Chose:** Do not use the transient parent marker as roster eligibility
- **Reasoning:** The #1555 reconciler shipped before the incident but excluded parentless live handles before identity lookup. Adopted/migrated PTYs can lose that spawn metadata; the existing read-only workspace-scoped lookup, exact-name check, and immutable-ID guard are the safe eligibility boundary.

---

## Chapters

### 1. Work
*Agent: default*

- Do not use the transient parent marker as roster eligibility: Do not use the transient parent marker as roster eligibility
