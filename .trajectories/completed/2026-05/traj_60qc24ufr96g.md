# Trajectory: Expand workflow reliability contract matrix

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** May 8, 2026 at 05:40 PM
> **Completed:** May 8, 2026 at 05:40 PM

---

## Summary

Expanded the SDK workflow reliability contract suite from basic deterministic repair coverage to a 10-test matrix covering final hard validation repair, fan-out sibling isolation, repair-agent fallback behavior, invalid repairAgent fallback, and start-from resume context for cached step outputs. Validated with the named Vitest suite and SDK typecheck.

**Approach:** Standard approach

---

## Key Decisions

### Cover repair fallback, final validation, sibling isolation, and resume reliability
- **Chose:** Cover repair fallback, final validation, sibling isolation, and resume reliability
- **Reasoning:** These are the failure modes that let repairable workflow errors leak into terminal failures: final validation gates, fan-out sibling state, invalid/missing repair agent configuration, and start-from recovery context.

---

## Chapters

### 1. Work
*Agent: default*

- Cover repair fallback, final validation, sibling isolation, and resume reliability: Cover repair fallback, final validation, sibling isolation, and resume reliability
