# Trajectory: Run s08-lead-quality evals — opus harness, repeat=1 smoke run

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** June 14, 2026 at 10:16 AM
> **Completed:** June 14, 2026 at 12:25 PM

---

## Summary

Implemented AR-252 cloud auth hardening: atomic temp chmod rename writes, cross-process locked file-backed refresh with re-read/re-check, forced 401 refresh routing, tests, build, branch push, and PR #1128.

**Approach:** Standard approach

---

## Key Decisions

### Aligned external skills tool references to flat Agent Relay MCP names

- **Chose:** Aligned external skills tool references to flat Agent Relay MCP names
- **Reasoning:** The broker injects the MCP server with key agent-relay and exposes flat names like send_dm, add_agent, register_agent; category-expanded relaycast names in PR 77 would fail in the eval harness.

### Implemented eval-derived relay worker guidance from issue 1113

- **Chose:** Implemented eval-derived relay worker guidance from issue 1113
- **Reasoning:** Haiku, Gemini, and Droid evals require different prompt guidance: small models keep a compact relay worker skill, Gemini gets a one-line lifecycle hint, and Droid gets explicit disambiguation from native Task plus high-risk warnings.

### Use clean worktree for AR-252

- **Chose:** Use clean worktree for AR-252
- **Reasoning:** The primary checkout has unrelated dirty files, so a separate branch worktree avoids mixing user changes into the AR-252 commit.

### Harden cloud auth refresh with atomic writes and mkdir lock

- **Chose:** Harden cloud auth refresh with atomic writes and mkdir lock
- **Reasoning:** A dependency-free sibling lock directory serializes file-backed read-refresh-write across processes, while pid-scoped temp chmod+rename prevents torn auth file reads. Forced refresh is preserved for 401-triggered token rejection.

---

## Chapters

### 1. Work

_Agent: default_

- Aligned external skills tool references to flat Agent Relay MCP names: Aligned external skills tool references to flat Agent Relay MCP names
- Implemented eval-derived relay worker guidance from issue 1113: Implemented eval-derived relay worker guidance from issue 1113
- Use clean worktree for AR-252: Use clean worktree for AR-252
- Harden cloud auth refresh with atomic writes and mkdir lock: Harden cloud auth refresh with atomic writes and mkdir lock

---

## Artifacts

**Commits:** 5f066bb77, a93e2b690, 87c05f11d, a81c7950c, c354ef7ed, c9c566a36, c48693e33, 2e3668712, 1f2198736, 56aeb4be8, 0f87d23be
**Files changed:** 101
