# Trajectory: Analyze openclaw package ownership and API boundaries

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** March 5, 2026 at 08:40 AM
> **Completed:** March 5, 2026 at 08:43 AM

---

## Summary

Completed boundary analysis for openclaw SDK vs orchestration ownership and proposed minimal public API + breaking-change set

**Approach:** Standard approach

---

## Key Decisions

### Define @relaycast/openclaw as config/types/light bridge only
- **Chose:** Define @relaycast/openclaw as config/types/light bridge only
- **Reasoning:** Current package bundles orchestration (spawn, MCP, runtime patching, setup) with bridge concerns; split reduces dependency footprint and circular architecture risk.

---

## Chapters

### 1. Work
*Agent: default*

- Define @relaycast/openclaw as config/types/light bridge only: Define @relaycast/openclaw as config/types/light bridge only
