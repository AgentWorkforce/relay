# Trajectory: Fix exact launcher preflight and PTY isolation regression timing

> **Status:** ✅ Completed
> **Confidence:** 97%
> **Started:** September 2, 2026 at 05:22 AM
> **Completed:** September 2, 2026 at 05:22 AM

---

## Summary

Shared exact Landlock launcher construction with a bounded synchronous capability probe and synchronized the occupied outer-PTY regression through stdin so it cannot finish before the attack attempt. Verified locally and with exact Daytona 5/5 raw evidence.

**Approach:** Standard approach

---

## Key Decisions

### Share the exact privileged launcher invocation with the synchronous test capability probe
- **Chose:** Share the exact privileged launcher invocation with the synchronous test capability probe
- **Reasoning:** A sudo /bin/true probe did not establish command-specific authorization, mount namespace support, private devpts setup, privilege drop, or Landlock availability. The probe now runs the same fixed sudo/Python launcher and argv builder as production against a temporary writable root with a five-second bound.

### Hold the outer PTY until the landlocked attack attempt completes
- **Chose:** Hold the outer PTY until the landlocked attack attempt completes
- **Reasoning:** A fixed three-second holder timeout could close the PTY before the case's five-second launcher allowance elapsed. The holder now select-monitors its PTY and stdin, while the parent sends a completion byte only after the attack process has exited, then the holder drains pending PTY input before deciding.

---

## Chapters

### 1. Work
*Agent: default*

- Share the exact privileged launcher invocation with the synchronous test capability probe: Share the exact privileged launcher invocation with the synchronous test capability probe
- Hold the outer PTY until the landlocked attack attempt completes: Hold the outer PTY until the landlocked attack attempt completes
- Local formatting/syntax, focused tests, typecheck, and the full suite are green. The final exact Daytona shell exited 0 with 5 passed/68 skipped and a real DEVPTS_LANDLOCK_TESTS_PASS marker; two earlier harness attempts failed closed before tests and were not treated as evidence.

---

## Artifacts

**Commits:** 3b610ea65
**Files changed:** 2
