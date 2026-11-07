# Trajectory: Address final PR #1567 review findings

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** August 18, 2026 at 01:26 PM
> **Completed:** August 18, 2026 at 01:30 PM

---

## Summary

Addressed final PR #1567 review findings: removed shell interpretation of TMPDIR-derived invocation log paths by passing INVOCATION_LOG through each fake child environment; constrained readiness rereading to a pre-deadline process-exit race; added a late-readiness must-fire test; redirected the background watchdog descriptors so tests do not remain attached after the smoke exits. The new timeout test failed against the unsafe reread and passed after the guard. Five consecutive focused runs passed 5/5, with bash syntax, shellcheck, Prettier, and diff checks green.

**Approach:** Standard approach

---

## Key Decisions

### Pass the fake invocation log through the environment
- **Chose:** Pass the fake invocation log through the environment
- **Reasoning:** Embedding a TMPDIR-derived path in generated Bash source leaves command substitution and backticks executable. Referencing quoted INVOCATION_LOG in the fake scripts preserves logging without interpreting the path as shell code.

### Accept post-loop readiness only after pre-deadline process exit
- **Chose:** Accept post-loop readiness only after pre-deadline process exit
- **Reasoning:** A timeout can race with readiness written during teardown. Tracking the early process-exit branch preserves the short-lived CLI fix while preventing late readiness from converting a real timeout into a passing smoke.

---

## Chapters

### 1. Work
*Agent: default*

- Pass the fake invocation log through the environment: Pass the fake invocation log through the environment
- Accept post-loop readiness only after pre-deadline process exit: Accept post-loop readiness only after pre-deadline process exit
