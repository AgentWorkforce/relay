# Trajectory: Revalidate and fix SDK issue 1359

> **Status:** ✅ Completed
> **Task:** [1359](https://github.com/AgentWorkforce/relay/issues/1359)
> **Confidence:** 95%
> **Started:** November 7, 2026 at 05:25 PM
> **Completed:** November 7, 2026 at 05:28 PM

---

## Summary

Revalidated issue1359 on main 72d9858. Fixed full agent return types and synchronous actionable listener diagnostics, including agent-token and observer regressions. SDK runtime196, strict types9, SDK build/check, full repository typecheck and formatting pass. Independent first review PASS. Blocks loss isolated to upstream Relaycast transport; companion repair in progress and issue remains open.

**Approach:** Standard approach

---

## Key Decisions

### Split fixes by owning repository
- **Chose:** Split fixes by owning repository
- **Reasoning:** Relay owns agent return types and listener diagnostics. Relaycast transport drops blocks before Relay sees them and needs a companion upstream fix. Keep issue open pending upstream release integration.

---

## Chapters

### 1. Work
*Agent: default*

- Split fixes by owning repository: Split fixes by owning repository
