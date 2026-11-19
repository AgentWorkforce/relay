# Trajectory: Fix Cursor session upload identity

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** November 19, 2026 at 11:15 AM
> **Completed:** November 19, 2026 at 11:16 AM

---

## Summary

CursorCli now uses its existing cursor source to join desktop upload records. Added regression coverage; targeted relay-node test passes and Veto diff review passes. Desktop companion fix and release follow separately.

**Approach:** Standard approach

---

## Key Decisions

### Map CursorCli to cursor:<id> via its existing source()
- **Chose:** Map CursorCli to cursor:<id> via its existing source()
- **Reasoning:** Local Cursor transcripts are already cataloged as cursor; returning no key separates relay rows from their selectable upload records. Preserve selection policy and leave other harness mappings unchanged.

---

## Chapters

### 1. Initial work
*Agent: codex-cursor-upload*

- Map CursorCli to cursor:<id> via its existing source(): Map CursorCli to cursor:<id> via its existing source()
