# Trajectory: Align spawn options docs with relay startup options

> **Status:** ✅ Completed
> **Confidence:** 92%
> **Started:** April 2, 2026 at 11:52 AM
> **Completed:** April 2, 2026 at 11:53 AM

---

## Summary

Updated spawning docs to separate relay startup options from per-agent options, switched the language-aware table to show the requested TypeScript broker/client fields, and fixed markdown export/tests for the new startup variant.

**Approach:** Standard approach

---

## Key Decisions

### Split spawn docs into relay startup options and per-agent options
- **Chose:** Split spawn docs into relay startup options and per-agent options
- **Reasoning:** The user-facing page was mixing broker/client startup configuration with per-agent spawn fields. Breaking them apart lets the TypeScript/Python language toggle show the correct API names for each surface and keeps the markdown export accurate.

---

## Chapters

### 1. Work
*Agent: default*

- Split spawn docs into relay startup options and per-agent options: Split spawn docs into relay startup options and per-agent options
