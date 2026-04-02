# Trajectory: Make spawn options docs language-aware

> **Status:** ✅ Completed
> **Confidence:** 96%
> **Started:** April 2, 2026 at 11:33 AM
> **Completed:** April 2, 2026 at 11:34 AM

---

## Summary

Made spawn options docs language-aware

**Approach:** Standard approach

---

## Key Decisions

### Use a language-aware component for spawn options tables
- **Chose:** Use a language-aware component for spawn options tables
- **Reasoning:** The docs already have a shared TypeScript/Python language context, so the options table should consume that context and show one canonical option column instead of forcing readers to scan both naming styles in every row.

---

## Chapters

### 1. Work
*Agent: default*

- Use a language-aware component for spawn options tables: Use a language-aware component for spawn options tables
