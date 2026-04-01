# Trajectory: Fix DM routing filter in wrap.rs — allow thread replies, presence events, and conversation_id targets

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** March 25, 2026 at 05:25 PM
> **Completed:** March 25, 2026 at 05:29 PM

---

## Summary

Fixed DM routing filter and cleaned up dead code per Devin review on PR #641

**Approach:** Added explicit exceptions for empty targets, thread, dm_/conv_ prefixes. Removed unused format_injection_with_workspace.

---

## Chapters

### 1. Work
*Agent: default*

- Widen DM filter rather than restructure — add pass-through for empty targets (presence), 'thread' synthetic targets, dm_/conv_ prefixed conversation IDs. Also removed dead code: format_injection_with_workspace import and function.: Widen DM filter rather than restructure — add pass-through for empty targets (presence), 'thread' synthetic targets, dm_/conv_ prefixed conversation IDs. Also removed dead code: format_injection_with_workspace import and function.
- Expanded DM filter to allow empty targets (presence), thread synthetic target, and dm_/conv_ prefixed conversation_id fallbacks. Removed unused format_injection_with_workspace function and import.: Expanded DM filter to allow empty targets (presence), thread synthetic target, and dm_/conv_ prefixed conversation_id fallbacks. Removed unused format_injection_with_workspace function and import.
