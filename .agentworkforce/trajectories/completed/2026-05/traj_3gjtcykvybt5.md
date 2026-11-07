# Trajectory: Fix PR CI failures

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** May 15, 2026 at 01:24 PM
> **Completed:** May 15, 2026 at 01:25 PM

---

## Summary

Fixed PR CI failures by keeping generated model output in raw codegen form, excluding the generated registry from Prettier, and addressing the clippy ptr_arg warning.

**Approach:** Standard approach

---

## Key Decisions

### Ignore generated registry output in Prettier

- **Chose:** Ignore generated registry output in Prettier
- **Reasoning:** CI validates raw codegen output, while lint-staged had formatted the generated TypeScript file after codegen. Ignoring the generated output keeps the committed file identical to npm run codegen:models.

---

## Chapters

### 1. Work

_Agent: default_

- Ignore generated registry output in Prettier: Ignore generated registry output in Prettier
