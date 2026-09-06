# Trajectory: Require complete verified-spawn success contract

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#1603
> **Confidence:** 96%
> **Started:** August 24, 2026 at 01:44 AM
> **Completed:** August 24, 2026 at 01:45 AM

---

## Summary

Hardened verified raw spawn completion to require spawned=true and ready=true, with regressions for missing and false spawn confirmation; focused tests and typecheck pass.

**Approach:** Standard approach

---

## Key Decisions

### Require both spawned and ready on terminal success
- **Chose:** Require both spawned and ready on terminal success
- **Reasoning:** The broker success contract is conjunctive; either flag alone can be malformed or legacy output and must not be reported as a verified spawn.

---

## Chapters

### 1. Work
*Agent: default*

- Require both spawned and ready on terminal success: Require both spawned and ready on terminal success
