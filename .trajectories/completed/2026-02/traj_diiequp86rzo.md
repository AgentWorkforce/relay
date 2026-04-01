# Trajectory: Assess relay vs rust SDK boundaries for direct SDK usage

> **Status:** ✅ Completed
> **Confidence:** 88%
> **Started:** February 26, 2026 at 07:28 PM
> **Completed:** February 26, 2026 at 07:33 PM

---

## Summary

Audited relay vs relaycast sdk-rust overlap and identified immediate relay cleanup plus SDK-first refactors for auth, registration, DM, and WS event normalization

**Approach:** Standard approach

---

## Key Decisions

### Classify relay/SDK overlap into immediate removals vs SDK-first refactors
- **Chose:** Classify relay/SDK overlap into immediate removals vs SDK-first refactors
- **Reasoning:** Some wrappers are redundant today while others need new SDK primitives (token lifecycle, normalized WS mapping) to avoid behavior regressions

---

## Chapters

### 1. Work
*Agent: default*

- Classify relay/SDK overlap into immediate removals vs SDK-first refactors: Classify relay/SDK overlap into immediate removals vs SDK-first refactors
