# Trajectory: Fix PR 1712 parser correctness and linearity blockers

> **Status:** ✅ Completed
> **Task:** cloud#3463
> **Confidence:** 90%
> **Started:** September 9, 2026 at 03:24 PM
> **Completed:** September 9, 2026 at 03:41 PM

---

## Summary

Fixed PR 1712 timeout inference for expression arrows, computed methods, Unicode ASI labels, and multiline/inline Python defs; replaced quadratic arrow/lambda scope scans with near-linear sweeps; 362 Cloud and 76 CLI tests pass.

**Approach:** Standard approach

---

## Key Decisions

### Use interval scopes for expression-bodied arrows and Python lambdas
- **Chose:** Use interval scopes for expression-bodied arrows and Python lambdas
- **Reasoning:** A single delimiter sweep plus a single scope-application sweep preserves lexical shadowing while removing the repeated backward and suffix scans that caused quadratic scaling.

### Resolve Python def scopes from matched parameter delimiters and indentation
- **Chose:** Resolve Python def scopes from matched parameter delimiters and indentation
- **Reasoning:** Balanced parentheses support multiline signatures, colon-aware handling supports one-line suites, and header indentation keeps the parameter scope active across the full function body.

---

## Chapters

### 1. Work
*Agent: default*

- Use interval scopes for expression-bodied arrows and Python lambdas: Use interval scopes for expression-bodied arrows and Python lambdas
- Resolve Python def scopes from matched parameter delimiters and indentation: Resolve Python def scopes from matched parameter delimiters and indentation
