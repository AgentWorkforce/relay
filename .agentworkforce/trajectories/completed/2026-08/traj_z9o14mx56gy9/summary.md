# Trajectory: Make standalone timeout regression test ordering-based

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** August 18, 2026 at 01:41 PM
> **Completed:** August 18, 2026 at 01:42 PM

---

## Summary

Replaced the late-readiness timeout test's fixed 100ms sleep with a second-node-down handshake, added explicit before/after readiness events, proved the test fails when the production timeout guard is removed, and passed the focused suite five consecutive times plus shell and formatting checks.

**Approach:** Standard approach

---

## Key Decisions

### Gate fake readiness on the second node-down invocation
- **Chose:** Gate fake readiness on the second node-down invocation
- **Reasoning:** The first down is preflight cleanup and the second can only occur after the zero-second startup deadline while node up is still alive, so readiness ordering is deterministic and independent of scheduler timing.

---

## Chapters

### 1. Work
*Agent: default*

- Gate fake readiness on the second node-down invocation: Gate fake readiness on the second node-down invocation
