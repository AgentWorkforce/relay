# Trajectory: Fix Gemini Action Required auto-approval, Claude Code bypass permissions confirmation, and relay-pty binary resolution for bash installer

> **Status:** ✅ Completed
> **Task:** relay-issues-373-374
> **Confidence:** 80%
> **Started:** February 5, 2026 at 09:14 AM
> **Completed:** February 5, 2026 at 09:16 AM

---

## Summary

Fixed three issues: (1) relay-pty binary not found for bash installer users by adding ~/.agent-relay/bin/ and ~/.local/bin/ search paths, (2) Gemini Action Required prompt auto-approval when --yolo doesn't cover shell redirects/heredocs, (3) Claude Code --dangerously-skip-permissions confirmation dialog auto-acceptance. All changes include extracted helper functions with comprehensive unit tests (16 new tests, 107 total passing).

**Approach:** Standard approach

---

## Key Decisions

### Added bash installer paths (~/.agent-relay/bin/, ~/.local/bin/) to relay-pty binary search
- **Chose:** Added bash installer paths (~/.agent-relay/bin/, ~/.local/bin/) to relay-pty binary search
- **Reasoning:** Bash installer downloads relay-pty to ~/.agent-relay/bin/ but findRelayPtyBinary() never checked that path, causing binary-not-found for curl|bash users

### Used buffer-based output detection with ANSI stripping for Gemini Action Required prompts
- **Chose:** Used buffer-based output detection with ANSI stripping for Gemini Action Required prompts
- **Reasoning:** Follows existing MCP auto-approval pattern in relay-pty main.rs. Gemini prompts can fire repeatedly unlike MCP (one-shot), so added 2s cooldown between approvals.

### Used broad pattern matching for Claude Code bypass permissions confirmation
- **Chose:** Used broad pattern matching for Claude Code bypass permissions confirmation
- **Reasoning:** Exact prompt text unavailable (binary is compiled). Detecting 'bypass'+'permission' or 'dangerously' combined with yes/no/proceed/accept patterns. One-shot like MCP since it only appears at startup.

---

## Chapters

### 1. Work
*Agent: default*

- Added bash installer paths (~/.agent-relay/bin/, ~/.local/bin/) to relay-pty binary search: Added bash installer paths (~/.agent-relay/bin/, ~/.local/bin/) to relay-pty binary search
- Used buffer-based output detection with ANSI stripping for Gemini Action Required prompts: Used buffer-based output detection with ANSI stripping for Gemini Action Required prompts
- Used broad pattern matching for Claude Code bypass permissions confirmation: Used broad pattern matching for Claude Code bypass permissions confirmation
