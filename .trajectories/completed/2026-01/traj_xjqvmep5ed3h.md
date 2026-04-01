# Trajectory: Fix update-workspaces GitHub Action job

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** January 8, 2026 at 10:02 AM
> **Completed:** January 8, 2026 at 10:02 AM

---

## Summary

Fixed update-workspaces job: 1) Changed condition to check direct dependency result instead of success() which fails on skipped upstream jobs 2) Set skipRestart:false so idle workspaces restart immediately

**Approach:** Standard approach

---

## Key Decisions

### Changed job condition from success() to explicit needs check
- **Chose:** Changed job condition from success() to explicit needs check
- **Reasoning:** success() checks entire dependency chain including build-base which is often skipped. Changed to always() + needs.build-and-push.result == 'success' to only check direct dependency

### Changed skipRestart from true to false
- **Chose:** Changed skipRestart from true to false
- **Reasoning:** With skipRestart:true, running workspaces without active agents would only update config but not restart. Since no agents = no work to disrupt, should restart immediately to apply new image

---

## Chapters

### 1. Work
*Agent: default*

- Changed job condition from success() to explicit needs check: Changed job condition from success() to explicit needs check
- Changed skipRestart from true to false: Changed skipRestart from true to false
