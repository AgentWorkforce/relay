# Trajectory: Add 'relay skills add' command with TUI to install the /orchestrate skill

> **Status:** ✅ Completed
> **Confidence:** 83%
> **Started:** June 27, 2026 at 04:21 AM
> **Completed:** June 27, 2026 at 04:22 AM

---

## Summary

Added 'agent-relay skills add': fetches agentrelay.com/skill.md and installs the /orchestrate skill per-harness, project or global, via interactive TUI or flags. 29 tests, typecheck + build green.

**Approach:** Standard approach

---

## Chapters

### 1. Work
*Agent: default*

- Per-harness install registry mapping claude/codex/cursor/gemini/opencode to native command/skill paths; Gemini rendered as TOML, Codex/OpenCode get body-only prompts, Claude/Cursor keep full frontmatter: Per-harness install registry mapping claude/codex/cursor/gemini/opencode to native command/skill paths; Gemini rendered as TOML, Codex/OpenCode get body-only prompts, Claude/Cursor keep full frontmatter
- Dependency-free keypress TUI (selectScope + multi-select selectHarnesses) instead of adding a prompt lib; non-interactive shells use --global/--local/--harness/--all flags: Dependency-free keypress TUI (selectScope + multi-select selectHarnesses) instead of adding a prompt lib; non-interactive shells use --global/--local/--harness/--all flags
