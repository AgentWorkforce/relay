# Trajectory: Add file permission guardrails as OS-level sandbox

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** February 1, 2026 at 07:32 AM
> **Completed:** February 1, 2026 at 07:32 AM

---

## Summary

Implemented cross-platform file permission guardrails using OS-level sandboxing (sandbox-exec on macOS, bwrap on Linux). Works with any CLI.

**Approach:** Standard approach

---

## Key Decisions

### Used sandbox-exec on macOS for kernel-level file enforcement
- **Chose:** Used sandbox-exec on macOS for kernel-level file enforcement
- **Reasoning:** Built-in, kernel-enforced, works without additional deps

### Used bubblewrap on Linux for filesystem isolation
- **Chose:** Used bubblewrap on Linux for filesystem isolation
- **Reasoning:** Widely available, mature, flexible read-only bind mounts

### CLI-agnostic wrapper approach over CLI-specific flags
- **Chose:** CLI-agnostic wrapper approach over CLI-specific flags
- **Reasoning:** User wanted consistent behavior across all CLIs, not just Claude

---

## Chapters

### 1. Work
*Agent: default*

- Used sandbox-exec on macOS for kernel-level file enforcement: Used sandbox-exec on macOS for kernel-level file enforcement
- Used bubblewrap on Linux for filesystem isolation: Used bubblewrap on Linux for filesystem isolation
- CLI-agnostic wrapper approach over CLI-specific flags: CLI-agnostic wrapper approach over CLI-specific flags
