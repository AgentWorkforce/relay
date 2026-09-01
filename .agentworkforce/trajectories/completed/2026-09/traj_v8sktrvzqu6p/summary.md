# Trajectory: Seal PR 1632 broker execution inode

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#1632
> **Confidence:** 98%
> **Started:** September 1, 2026 at 09:23 PM
> **Completed:** September 1, 2026 at 09:30 PM

---

## Summary

Closed PR #1632 broker TOCTOU by replacing the unlinked file with a parent-managed exec-sealed memfd, adding fail-clear Python availability, Linux chmod/write tamper regression coverage, and documenting the review-trusted invocation boundary. Focused 64-test suite, typecheck, Prettier, syntax/diff checks, and direct Linux arm64 tamper validation pass.

**Approach:** Standard approach

---

## Key Decisions

### Execute exact-SHA brokers only from an exec-sealed memfd
- **Chose:** Execute exact-SHA brokers only from an exec-sealed memfd
- **Reasoning:** A private unlinked file remained mutable through /proc by the same-UID PR runner. A trusted Python holder now creates a memfd, applies F_SEAL_SEAL|SHRINK|GROW|WRITE|EXEC, reports the full seal mask, and holds the inode for the runner lifetime. Linux validation proved chmod and overwrite fail while the original executable still runs. The proof boundary is documented as immutable exact-SHA bytes; PR-authored argv, environment, and semantic assertions remain reviewer-trusted.

---

## Chapters

### 1. Work
*Agent: default*

- Execute exact-SHA brokers only from an exec-sealed memfd: Execute exact-SHA brokers only from an exec-sealed memfd
