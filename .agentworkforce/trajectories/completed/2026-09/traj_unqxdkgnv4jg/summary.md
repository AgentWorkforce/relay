# Trajectory: Finish PR #1864 CI and review threads

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#1864
> **Confidence:** 92%
> **Started:** September 28, 2026 at 08:32 AM
> **Completed:** September 28, 2026 at 09:18 AM

---

## Summary

Finalized PR #1864 on-relay locking: portable cross-process lock, brokerless tests, expected contention suppression, fail-closed startup validation, and lock-directory hardening.

**Approach:** Standard approach

---

## Key Decisions

### Use server-side inbox deferral for transient injection failures and strict registration for new on-relay identities
- **Chose:** Use server-side inbox deferral for transient injection failures and strict registration for new on-relay identities
- **Reasoning:** Deferral removes retrying items from the finite FIFO window so newer deliveries can progress; strict registration prevents silently rotating an active agent token while --token remains the explicit reuse path.

### Use the repository's portable lock-directory pattern for on-relay ledgers
- **Chose:** Use the repository's portable lock-directory pattern for on-relay ledgers
- **Reasoning:** It preserves cross-process serialization without requiring an optional broker binary, makes plain Node install tests representative, and allows startup to fail closed on real lock errors while treating bounded contention as expected.

---

## Chapters

### 1. Work
*Agent: default*

- Use server-side inbox deferral for transient injection failures and strict registration for new on-relay identities: Use server-side inbox deferral for transient injection failures and strict registration for new on-relay identities
- Scoped on-relay fixes are pushed, all 17 review threads are answered and resolved, Veto passes, and replacement CI is running; the previously failing Windows ACL job now passes.
- Use the repository's portable lock-directory pattern for on-relay ledgers: Use the repository's portable lock-directory pattern for on-relay ledgers
- PR feedback converged on portable ledger locking; focused CLI tests, TypeScript, build, package validation, and Veto review pass. The full repository suite has eight unrelated broker/fleet failures, so no out-of-scope changes are warranted.

---

## Artifacts

**Commits:** e9df0bdc0, 6f86ed6bb, 3c6c4c466, 3e551eef6
**Files changed:** 6
