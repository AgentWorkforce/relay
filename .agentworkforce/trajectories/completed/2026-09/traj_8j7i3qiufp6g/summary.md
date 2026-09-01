# Trajectory: Harden memfd portability and broker queue deadline

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#1632
> **Confidence:** 99%
> **Started:** September 1, 2026 at 09:45 PM
> **Completed:** September 1, 2026 at 09:47 PM

---

## Summary

Added explicit MFD_EXEC for hardened memfd policy, validated execution under vm.memfd_noexec=1, added 10-minute producer queue headroom plus explicit poll slack, and expanded/asserted the dispatcher deadline to 110 minutes. Full 2275-test suite, focused contracts, typecheck, actionlint, Prettier, syntax, and diff checks pass sequentially.

**Approach:** Standard approach

---

## Key Decisions

### Request executable memfds explicitly
- **Chose:** Request executable memfds explicitly
- **Reasoning:** Hardened Linux with vm.memfd_noexec=1 creates legacy memfds non-executable. The holder now passes MFD_EXEC (raw 0x10 fallback), then still requires F_SEAL_EXEC and all immutable content seals. A disposable PID namespace at vm.memfd_noexec=1 reported seals 0x3f and executed successfully.

### Budget independent producer scheduling skew
- **Chose:** Budget independent producer scheduling skew
- **Reasoning:** The broker producer and dispatcher are separate workflows, so the producer's 30-minute job clock may start after the resolver. The resolver now allows 10 minutes of queue/start delay plus 30 minutes execution and explicit poll slack; the dispatcher grows to 110 minutes to contain resolution, 60-minute Cloud execution, and 5-minute setup headroom.

---

## Chapters

### 1. Work
*Agent: default*

- Request executable memfds explicitly: Request executable memfds explicitly
- Budget independent producer scheduling skew: Budget independent producer scheduling skew
- A parallel full test and typecheck run raced because typecheck rebuilds package dist directories; the same full suite passed cleanly when rerun sequentially (149 files, 2275 tests).
