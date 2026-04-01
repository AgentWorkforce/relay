# Trajectory: Redesign auto step owner as real supervisor process for PR #511

> **Status:** ✅ Completed
> **Confidence:** 89%
> **Started:** March 9, 2026 at 10:28 PM
> **Completed:** March 10, 2026 at 01:41 AM

---

## Summary

Turned auto step owners into real supervisor processes that run alongside specialists, preserve specialist output chaining, and added coverage for channel/file verification plus self-owned fallback.

**Approach:** Standard approach

---

## Key Decisions

### Run specialist and owner concurrently with worker PTY mirrored into the workflow channel
- **Chose:** Run specialist and owner concurrently with worker PTY mirrored into the workflow channel
- **Reasoning:** This keeps the specialist as the real producer of step output while giving the owner a separate process that can supervise via channel activity, file checks, and explicit follow-up messages.

---

## Chapters

### 1. Work
*Agent: default*

- Run specialist and owner concurrently with worker PTY mirrored into the workflow channel: Run specialist and owner concurrently with worker PTY mirrored into the workflow channel

---

## Artifacts

**Commits:** 7ef5f316, 5dcfc79d
**Files changed:** 4
