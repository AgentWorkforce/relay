# Trajectory: Fix web build failures from complexity and no-unused-expressions lint errors

> **Status:** ✅ Completed
> **Confidence:** 97%
> **Started:** April 2, 2026 at 01:56 PM
> **Completed:** April 2, 2026 at 01:57 PM

---

## Summary

Fixed web build failures by refactoring RelayauthAnimation drawMessages under the complexity limit and replacing the FAQ toggle side-effect ternary with an explicit branch. Verified with npm run build --workspace web.

**Approach:** Standard approach

---

## Key Decisions

### Refactor drawMessages by extracting denied-state rendering instead of suppressing complexity
- **Chose:** Refactor drawMessages by extracting denied-state rendering instead of suppressing complexity
- **Reasoning:** The lint failure is local to one hot path. A helper keeps the animation behavior intact and avoids introducing eslint disables.

---

## Chapters

### 1. Work
*Agent: default*

- Refactor drawMessages by extracting denied-state rendering instead of suppressing complexity: Refactor drawMessages by extracting denied-state rendering instead of suppressing complexity
