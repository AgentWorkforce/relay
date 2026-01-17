# Trajectory: Fix Codex agent spawning failure

> **Status:** ✅ Completed
> **Task:** codex-spawn-fix
> **Confidence:** 70%
> **Started:** January 17, 2026 at 02:14 AM
> **Completed:** January 17, 2026 at 02:41 AM

---

## Summary

Fixed Codex spawning by passing task as initial prompt - Codex requires an initial prompt in TTY mode unlike Claude

**Approach:** Standard approach

---

## Key Decisions

### Use codex exec instead of codex for spawned agents
- **Chose:** Use codex exec instead of codex for spawned agents
- **Reasoning:** Codex interactive mode expects a proper terminal and shows 'attached to daemon' error in PTY. The exec subcommand is designed for headless non-interactive operation.

### Pass task as initial prompt for Codex CLI
- **Chose:** Pass task as initial prompt for Codex CLI
- **Reasoning:** Codex CLI has a TTY check that expects an initial prompt. Without a prompt, it exits or waits indefinitely. Claude waits for input but Codex needs a prompt to start.

---

## Chapters

### 1. Work
*Agent: default*

- Use codex exec instead of codex for spawned agents: Use codex exec instead of codex for spawned agents
- Pass task as initial prompt for Codex CLI: Pass task as initial prompt for Codex CLI
