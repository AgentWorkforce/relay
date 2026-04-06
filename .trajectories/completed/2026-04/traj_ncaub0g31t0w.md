# Trajectory: Fix code fence meta delimiter collision

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** April 2, 2026 at 08:47 AM
> **Completed:** April 2, 2026 at 08:49 AM

---

## Summary

Fixed code fence metadata delimiter collisions

**Approach:** Standard approach

---

## Key Decisions

### Use URLSearchParams for code fence metadata payloads
- **Chose:** Use URLSearchParams for code fence metadata payloads
- **Reasoning:** Double underscores are not escaped by encodeURIComponent, so the old delimiter-based format could corrupt filenames or labels containing __. Querystring encoding removes delimiter collisions while preserving readable tokens, and the parser stays backward-compatible with legacy payloads.

---

## Chapters

### 1. Work
*Agent: default*

- Use URLSearchParams for code fence metadata payloads: Use URLSearchParams for code fence metadata payloads
