# Trajectory: Address PR 1635 private devpts review feedback

> **Status:** ✅ Completed
> **Task:** PR-1635-P1
> **Confidence:** 93%
> **Started:** September 2, 2026 at 04:23 AM
> **Completed:** September 2, 2026 at 04:41 AM

---

## Summary

Replaced the racy host /dev/pts Landlock allowance with a trusted sudo-backed private devpts mount namespace, permanent privilege drop, environment/import/FD hardening, and Linux behavioral regressions proving PTY isolation and broker compatibility.

**Approach:** Standard approach

---

## Key Decisions

### Replaced the host devpts allowance with a trusted private mount namespace
- **Chose:** Replaced the host devpts allowance with a trusted private mount namespace
- **Reasoning:** An empty host /dev/pts scan had a TOCTOU window for later control PTYs. Daytona blocks unprivileged user namespaces but supports a fixed sudo-backed mount namespace; the trusted bootstrap can mount devpts newinstance, then permanently drop IDs and all capability sets before no_new_privs, Landlock, and PR execution.

### Pinned the privilege boundary with behavioral Linux regressions
- **Chose:** Pinned the privilege boundary with behavioral Linux regressions
- **Reasoning:** The suite now proves bootstrap import isolation, zero capabilities and closed descriptors, failed mount/unshare/sudo reacquisition, private PTY allocation, outer PTY non-interference, and broker immutability in a real Daytona sandbox.

---

## Chapters

### 1. Work
*Agent: default*

- Replaced the host devpts allowance with a trusted private mount namespace: Replaced the host devpts allowance with a trusted private mount namespace
- Pinned the privilege boundary with behavioral Linux regressions: Pinned the privilege boundary with behavioral Linux regressions
- The reviewer P1 exposed a real timing gap. The durable fix is namespace isolation, not a stronger timing check; exact Daytona evidence is green for all five security and compatibility regressions.

---

## Artifacts

**Commits:** 37f6376cb
**Files changed:** 3
