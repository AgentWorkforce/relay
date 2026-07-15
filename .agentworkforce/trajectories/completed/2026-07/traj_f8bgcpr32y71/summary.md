# Trajectory: Add --wk shorthand for --workspace-key on SDK commands

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** July 15, 2026 at 06:57 PM
> **Completed:** July 15, 2026 at 06:57 PM

---

## Summary

Added --wk alias for --workspace-key via preAction hook in addSdkOptions

**Approach:** Standard approach

---

## Key Decisions

### Fold --wk into workspaceKey via a Commander preAction hook in addSdkOptions

- **Chose:** Fold --wk into workspaceKey via a Commander preAction hook in addSdkOptions
- **Reasoning:** Single choke point normalizes the alias for every reader; Commander v12 can't alias two long flags to one attribute

---

## Chapters

### 1. Work

_Agent: default_

- Fold --wk into workspaceKey via a Commander preAction hook in addSdkOptions: Fold --wk into workspaceKey via a Commander preAction hook in addSdkOptions
