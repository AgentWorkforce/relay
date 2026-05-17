# Trajectory: Fix headless orchestrator worktree CLI E2E issues

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** May 15, 2026 at 01:44 PM
> **Completed:** May 15, 2026 at 01:51 PM

---

## Summary

Fixed a headless CLI worktree E2E failure where orphan cleanup could match and terminate the caller shell when its command line contained both the worktree path and agent-relay-broker. Added robust ps parsing so down/up orphan cleanup only targets actual agent-relay-broker executables, added a regression test, refreshed build, reran the skills PR worktree CLI lifecycle end to end, and documented cleanup of generated .agent-relay/.mcp.json artifacts in the headless orchestrator skill.

**Approach:** Standard approach

---

## Key Decisions

### Investigate failed worktree E2E before editing

- **Chose:** Investigate failed worktree E2E before editing
- **Reasoning:** The documented skill command failed in a real skills PR worktree with stale connection metadata and STOPPED status; need distinguish environmental port collision from CLI/doc defects before changing guidance.

### Fixed orphan cleanup process matching

- **Chose:** Fixed orphan cleanup process matching
- **Reasoning:** The worktree E2E harness was killed by agent-relay down --force because orphan cleanup grepped ps output for projectRoot and agent-relay-broker anywhere in the command line; shell wrappers can contain both strings without being broker processes. The fix parses ps output and only targets commands whose executable basename is agent-relay-broker.

---

## Chapters

### 1. Work

_Agent: default_

- Investigate failed worktree E2E before editing: Investigate failed worktree E2E before editing
- Fixed orphan cleanup process matching: Fixed orphan cleanup process matching
- Worktree E2E now passes after fixing orphan cleanup false-positive process matching. The CLI scenario leaves .agent-relay/ and .mcp.json as expected runtime artifacts, so verification worktrees need cleanup before status checks.
