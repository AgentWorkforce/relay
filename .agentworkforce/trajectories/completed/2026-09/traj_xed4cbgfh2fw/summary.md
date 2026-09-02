# Trajectory: Bound echo verification to post-submission output for PR 1634

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#1634
> **Confidence:** 93%
> **Started:** September 2, 2026 at 04:06 AM
> **Completed:** September 2, 2026 at 04:17 AM

---

## Summary

Scoped worker and wrap echo verification to monotonic post-submission output, preserved ack-race confirmation, reset retry boundaries, added trim/stale-echo regressions, and hardened the Claude RelayFlow proof against split PTY frames with an explicit composer/task-handler model.

**Approach:** Standard approach

---

## Key Decisions

### Use monotonic PTY-output byte offsets shared by worker and wrap verification
- **Chose:** Use monotonic PTY-output byte offsets shared by worker and wrap verification
- **Reasoning:** Each delivery must only match output observed after its own submit boundary, including output that races ahead of the write acknowledgement; retained-tail trimming advances an absolute base offset so stale identical echoes cannot verify a new delivery.

---

## Chapters

### 1. Work
*Agent: default*

- Chose monotonic PTY-output byte offsets shared by worker and wrap verification.
- Late review feedback is implemented across both injection paths and the deterministic RelayFlow proof. Focused and full broker suites, strict clippy, proof parser tests, and the worktree-built end-to-end case are green.

---

## Artifacts

**Commits:** befbea623
**Files changed:** 6
