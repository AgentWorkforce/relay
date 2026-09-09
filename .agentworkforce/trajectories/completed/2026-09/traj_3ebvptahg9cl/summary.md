# Trajectory: Tighten PR 1727 proof signature

> **Status:** ✅ Completed
> **Confidence:** 98%
> **Started:** September 10, 2026 at 12:22 AM
> **Completed:** September 10, 2026 at 12:22 AM

---

## Summary

Narrowed the RelayFlow base signature to the exact missing __bundled-workflow command and validated the proof contract.

**Approach:** Standard approach

---

## Key Decisions

### Require the base command name in every accepted failure form
- **Chose:** Require the base command name in every accepted failure form
- **Reasoning:** A broad unknown-command alternative could misclassify rejection of a nested argument as the expected missing internal entrypoint bug.

---

## Chapters

### 1. Work
*Agent: default*

- Require the base command name in every accepted failure form: Require the base command name in every accepted failure form
