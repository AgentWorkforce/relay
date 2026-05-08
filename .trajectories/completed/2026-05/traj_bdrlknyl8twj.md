# Trajectory: Add workflow reliability defaults and E2E matrix

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** May 8, 2026 at 07:54 PM
> **Completed:** May 8, 2026 at 08:05 PM

---

## Summary

Added Relay workflow reliability defaults, repairable builder presets, agent-step repair before retry, API-agent verification through the normal agent loop, worktree-step validation, a dedicated reliability CI job, and contract/E2E coverage for malformed artifacts, child INVALID_ARTIFACT recovery, deterministic gate repair, fan-out isolation, master-child, worktree-backed, deterministic-only, and agent-plus-gate workflow shapes.

**Approach:** Standard approach

---

## Key Decisions

### Made retry-mode workflows repair-aware by default
- **Chose:** Made retry-mode workflows repair-aware by default
- **Reasoning:** Workflow reliability is now a product contract: SDK builder workflows and raw runner configs with agents get bounded repair retries unless callers explicitly choose fail-fast, continue, or repairRetries: 0. Agent/artifact failures now invoke repair before retrying, not only deterministic gates.

---

## Chapters

### 1. Work
*Agent: default*

- Made retry-mode workflows repair-aware by default: Made retry-mode workflows repair-aware by default
