# Trajectory: Expose safe structured failure details in cloud status

> **Status:** ✅ Completed
> **Task:** #1741
> **Confidence:** 95%
> **Started:** September 23, 2026 at 05:39 PM
> **Completed:** September 23, 2026 at 06:12 PM

---

## Summary

Added safe structured workflow failure details to human cloud status, with regression coverage for malformed and sensitive content.

**Approach:** Standard approach

---

## Key Decisions

### Keep #1741 CLI-only and render only validated structural failure fields
- **Chose:** Keep #1741 CLI-only and render only validated structural failure fields
- **Reasoning:** The status API already returns the raw object, so presentation belongs in cloud status; allowlisting avoids exposing arbitrary provider or agent content.

---

## Chapters

### 1. Work
*Agent: default*

- Keep #1741 CLI-only and render only validated structural failure fields: Keep #1741 CLI-only and render only validated structural failure fields
