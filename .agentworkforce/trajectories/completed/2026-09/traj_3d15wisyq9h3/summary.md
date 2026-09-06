# Trajectory: Fix Claude folder-trust auto-accept for both menu orderings

> **Status:** ✅ Completed
> **Task:** 1654
> **Confidence:** 88%
> **Started:** September 6, 2026 at 03:21 PM
> **Completed:** September 6, 2026 at 03:37 PM

---

## Summary

Made Claude folder-trust handling select the affirmative row by rendered menu state; added old/new/fail-closed regression coverage and a real-PTY worker-survival test

**Approach:** Standard approach

---

## Key Decisions

### Parse Claude's rendered trust menu and navigate by affirmative label identity
- **Chose:** Parse Claude's rendered trust menu and navigate by affirmative label identity
- **Reasoning:** Claude ships both Yes-first and No-first layouts; requiring unique option rows plus one selection marker preserves fail-closed behavior and avoids confirming No

---

## Chapters

### 1. Work
*Agent: default*

- Parse Claude's rendered trust menu and navigate by affirmative label identity: Parse Claude's rendered trust menu and navigate by affirmative label identity
