# Trajectory: Harden headless broker readiness semantics

> **Status:** ✅ Completed
> **Confidence:** 92%
> **Started:** May 15, 2026 at 11:46 AM
> **Completed:** May 15, 2026 at 11:59 AM

---

## Summary

Hardened headless broker startup so detached up waits for API readiness, status --wait-for distinguishes STARTING from STOPPED and exits non-zero on timeout, and docs/skills/tests now encode the readiness contract.

**Approach:** Standard approach

---

## Key Decisions

### Gate detached broker start on API readiness and report STARTING separately

- **Chose:** Gate detached broker start on API readiness and report STARTING separately
- **Reasoning:** Headless orchestrators need command success to mean usable broker, and live-process/API-unready must not be collapsed into STOPPED.

---

## Chapters

### 1. Work

_Agent: default_

- Gate detached broker start on API readiness and report STARTING separately: Gate detached broker start on API readiness and report STARTING separately
- Readiness hardening implemented and verified with focused command tests, typecheck, lint, and diff checks; remaining lint output is pre-existing complexity/depth warnings outside the new readiness helper.
