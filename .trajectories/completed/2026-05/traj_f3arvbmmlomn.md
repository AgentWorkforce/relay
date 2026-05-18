# Trajectory: Address PR feedback for headless broker reliability

> **Status:** ✅ Completed
> **Confidence:** 92%
> **Started:** May 15, 2026 at 02:09 PM
> **Completed:** May 15, 2026 at 02:15 PM

---

## Summary

Addressed PR feedback for headless broker reliability: rejected conflicting mode flags, strictly validated status wait durations, made broker readiness depend on status even if session lookup fails, tightened orphan cleanup with project-root command matching plus verified cwd fallback, normalized trajectory index paths, and validated with focused CLI tests, full build/test, lint, diff check, and live detached CLI smoke.

**Approach:** Standard approach

---

## Key Decisions

### Matched orphan brokers by resolved project path or verified process cwd

- **Chose:** Matched orphan brokers by resolved project path or verified process cwd
- **Reasoning:** PR feedback flagged basename and substring matching as unsafe; exact command-path boundaries plus lsof cwd verification preserve cleanup without killing sibling repos or shell harnesses

---

## Chapters

### 1. Work

_Agent: default_

- Matched orphan brokers by resolved project path or verified process cwd: Matched orphan brokers by resolved project path or verified process cwd
- PR feedback fixes validated with focused CLI tests, full build/test, and live detached broker smoke including orphan cleanup after deleting connection metadata
