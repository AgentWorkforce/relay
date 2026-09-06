# Trajectory: Harden PR 1606 exact RelayFlow proof runner

> **Status:** ✅ Completed
> **Task:** [PR-1606](https://github.com/AgentWorkforce/relay/pull/1606)
> **Confidence:** 96%
> **Started:** August 26, 2026 at 02:28 AM
> **Completed:** August 26, 2026 at 02:28 AM

---

## Summary

Made the PR 1606 external RelayFlow harness install platform-specific optional build packages and fail closed when its checkout does not match RELAY_PR_PROOF_TARGET_SHA.

**Approach:** Reproduced the esbuild platform-binary failure, retained the external public MCP stdio harness, added exact-target verification, and preserved deterministic base-bug/head-fixed signatures.

---

## Key Decisions

### Install optional platform packages and assert the checked-out target SHA
- **Chose:** Install optional platform packages and assert the checked-out target SHA
- **Reasoning:** The external proof runner must build the exact base or head checkout reliably; omitting optional packages removed esbuild's platform binary, and the SHA assertion prevents accidentally proving a stale tree.

---

## Chapters

### 1. Initial work
*Agent: relay-bug-pr-proof-coordinator-0825*

- Install optional platform packages and assert the checked-out target SHA: Install optional platform packages and assert the checked-out target SHA

---

## Artifacts

**Commits:** 3bbe4f9aa
**Files changed:** 2
