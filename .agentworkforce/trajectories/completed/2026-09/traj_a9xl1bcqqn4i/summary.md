# Trajectory: Fix Claude folder-trust menu ordering for issue 1654

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** September 6, 2026 at 07:04 AM
> **Completed:** September 6, 2026 at 07:15 AM

---

## Summary

Added identity-based Claude folder-trust navigation, old/new layout regressions, PTY liveness coverage, and changelog entry

**Approach:** Standard approach

---

## Key Decisions

### Use rendered PTY selection state to choose Claude trust navigation
- **Chose:** Use rendered PTY selection state to choose Claude trust navigation
- **Reasoning:** Claude changed both menu ordering and default selection; explicit marker-to-label navigation supports both layouts and fails closed when selection is absent or ambiguous

---

## Chapters

### 1. Work
*Agent: default*

- Use rendered PTY selection state to choose Claude trust navigation: Use rendered PTY selection state to choose Claude trust navigation
