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

---

## Artifacts

**Commits:** 05badc8e751c10904b46a936f330affbc0c25d73, ca7e50c0b6ffd656b3e441997385a5eedf75d9ff, 2f27a8c6672af5cb65bdf382ab6014ad5dfef202
**Files changed:** 7
