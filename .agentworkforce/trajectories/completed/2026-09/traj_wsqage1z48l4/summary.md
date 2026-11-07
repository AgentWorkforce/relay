# Trajectory: Fix fleet spawn task submission in Claude

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** September 2, 2026 at 03:08 AM
> **Completed:** September 2, 2026 at 03:36 AM

---

## Summary

Fixed Claude multiline fleet task submission with an atomic delayed Enter, honest PTY write acknowledgements, echo-race handling, Windows shim coverage, and exact base/head RelayFlow proof.

**Approach:** Standard approach

---

## Key Decisions

### Use an atomic delayed follow-up Enter for Claude multiline injections
- **Chose:** Use an atomic delayed follow-up Enter for Claude multiline injections
- **Reasoning:** Claude Code 2.1.236 reproducibly leaves a multiline brief in the composer when body and Enter arrive in one injection burst; sending the body, then one Enter as a distinct write after 250 ms submits it. The follow-up must remain inside one PTY FIFO command so terminal replies or human input cannot splice between the brief and submit.

### Raised the pending changelog heading to [Unreleased - Patch]
- **Chose:** Raised the pending changelog heading to [Unreleased - Patch]
- **Reasoning:** PR #1634 is a user-visible bug fix and AGENTS.md requires the first pending change after release to declare its SemVer level.

---

## Chapters

### 1. Work
*Agent: default*

- Use an atomic delayed follow-up Enter for Claude multiline injections.
- Raised the pending changelog heading to `[Unreleased - Patch]`.
- Exact local RelayFlow proof reproduces the 11.10.0 bug at a 0ms body/Enter boundary and validates the fixed broker at 260ms; review-driven ack handling now waits for both writes, requeues failures, and closes the echo-before-ack race.

---

## Artifacts

**Commits:** 81a2bd7dd, 32c727d09, aee898b37
**Files changed:** 7
