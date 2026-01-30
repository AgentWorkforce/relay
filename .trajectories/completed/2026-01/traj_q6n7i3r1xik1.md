# Trajectory: Add activity-based verification for task injection

> **Status:** ✅ Completed
> **Confidence:** 80%
> **Started:** January 30, 2026 at 01:20 PM
> **Completed:** January 30, 2026 at 01:21 PM

---

## Summary

Added activity verification to injectTask() in relay-pty-orchestrator.ts. After socket confirms delivery, verifies CLI shows activity (task received patterns, thinking spinners, tool execution) within 5s. Retries up to 3 times if no activity detected. Prevents T-003-style failures where PTY delivery succeeded but CLI wasn't ready.

**Approach:** Standard approach

---

## Key Decisions

### Used activity pattern matching to verify CLI processed the task, not just PTY delivery
- **Chose:** Used activity pattern matching to verify CLI processed the task, not just PTY delivery
- **Reasoning:** T-003 failure showed PTY delivery succeeded but CLI wasn't ready. Tested Claude Code, Codex, and Droid - found universal patterns: [Pasted text], Relay message from, thinking spinners

---

## Chapters

### 1. Work
*Agent: default*

- Used activity pattern matching to verify CLI processed the task, not just PTY delivery: Used activity pattern matching to verify CLI processed the task, not just PTY delivery
