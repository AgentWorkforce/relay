# Trajectory: Fix PR #1825 CodeQL seal races

> **Status:** ✅ Completed
> **Confidence:** 97%
> **Started:** September 20, 2026 at 10:25 PM
> **Completed:** September 20, 2026 at 10:26 PM

---

## Summary

Removed CodeQL-reported filesystem TOCTOU windows from native-delivery seal hashing by deriving size and digest from one read buffer and handling absent source paths from the read error.

**Approach:** Standard approach
