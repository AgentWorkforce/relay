# Trajectory: Fix blank deployed /openclaw route caused by basePath route nesting

> **Status:** ✅ Completed
> **Confidence:** 97%
> **Started:** March 6, 2026 at 04:14 PM
> **Completed:** March 6, 2026 at 04:14 PM

---

## Summary

Fixed the blank deployed /openclaw route by restructuring the Next app for basePath deployment: root page now serves the landing page, /skill serves the hosted skill, and legacy nested routes redirect; verified with a successful Next.js build.

**Approach:** Standard approach
