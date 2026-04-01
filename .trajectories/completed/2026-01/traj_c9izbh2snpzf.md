# Trajectory: Fix sshd startup for Codex tunnel

> **Status:** ✅ Completed
> **Confidence:** 62%
> **Started:** January 7, 2026 at 05:17 PM
> **Completed:** January 7, 2026 at 05:17 PM

---

## Summary

Set workspace image to run entrypoint as root so sshd starts for Codex tunnel

**Approach:** Standard approach

---

## Key Decisions

### Run workspace image as root for sshd
- **Chose:** Run workspace image as root for sshd
- **Reasoning:** entrypoint sshd block only runs as root; we drop to workspace via gosu so app still non-root

---

## Chapters

### 1. Work
*Agent: default*

- Run workspace image as root for sshd: Run workspace image as root for sshd
