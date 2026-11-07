# Trajectory: Bind private ptmx on device-node Linux hosts

> **Status:** ✅ Completed
> **Confidence:** 96%
> **Started:** September 2, 2026 at 05:24 AM
> **Completed:** September 2, 2026 at 05:33 AM

---

## Summary

Added a fail-closed conditional bind from private /dev/pts/ptmx to standalone /dev/ptmx device nodes, retained the no-op symlink path, pinned both branches in docs/contracts, and verified the unchanged Daytona branch with exact 5/5 raw evidence.

**Approach:** Standard approach

---

## Key Decisions

### Conditionally bind the private ptmx only on device-node hosts
- **Chose:** Conditionally bind the private ptmx only on device-node hosts
- **Reasoning:** Daytona already resolves /dev/ptmx into the freshly mounted private devpts instance, while GitHub Ubuntu retains a standalone device node. Checking samefile first preserves the symlink path; a private-namespace bind of /dev/pts/ptmx over /dev/ptmx fixes only the device-node case, and a second samefile check remains fail-closed.

---

## Chapters

### 1. Work
*Agent: default*

- Conditionally bind the private ptmx only on device-node hosts: Conditionally bind the private ptmx only on device-node hosts
- The positive privileged regression now asserts /dev/ptmx and /dev/pts/ptmx are the same device, while the source contract pins the conditional bind. Local focused/full/typecheck/docs gates pass, and exact Daytona raw evidence passed 5/5 on the pre-existing symlink branch; Ubuntu CI will exercise the device-node branch.

---

## Artifacts

**Commits:** 5342eef52
**Files changed:** 3
