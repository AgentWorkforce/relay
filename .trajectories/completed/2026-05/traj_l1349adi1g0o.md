# Trajectory: Fix agent relay MCP PR CI failures

> **Status:** ✅ Completed
> **Confidence:** 86%
> **Started:** May 25, 2026 at 05:42 PM
> **Completed:** May 25, 2026 at 05:42 PM

---

## Summary

Fixed the PR CI bootstrap snapshot after main added the owned agent-relay mcp command. Synced package-lock workspace versions to 7.1.1 through a clean npm install check and validated the focused bootstrap/MCP CLI test set.

**Approach:** Standard approach

---

## Key Decisions

### Updated bootstrap command expectations to include the owned mcp command

- **Chose:** Updated bootstrap command expectations to include the owned mcp command
- **Reasoning:** CI was failing because the bootstrap test expected 63 leaf commands after main introduced an mcp top-level command; the actual CLI now registers 64.

---

## Chapters

### 1. Work

_Agent: default_

- Updated bootstrap command expectations to include the owned mcp command: Updated bootstrap command expectations to include the owned mcp command
