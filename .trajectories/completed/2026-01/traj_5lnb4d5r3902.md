# Trajectory: Add timeout and skip x64 macOS on PRs

> **Status:** ✅ Completed
> **Task:** PR-340
> **Confidence:** 90%
> **Started:** January 28, 2026 at 05:43 PM
> **Completed:** January 28, 2026 at 05:43 PM

---

## Summary

Added job timeouts (20min arm64, 30min x64) and skipped x64 on PRs. Split matrix job into separate jobs to enable conditional execution.

**Approach:** Standard approach

---

## Key Decisions

### Split verify-macos into arm64 and x64 jobs
- **Chose:** Split verify-macos into arm64 and x64 jobs
- **Reasoning:** Allows skipping x64 on PRs while still running it on actual publishes

### Cannot use Docker for macOS
- **Chose:** Cannot use Docker for macOS
- **Reasoning:** Apple licensing prevents running macOS in containers

---

## Chapters

### 1. Work
*Agent: default*

- Split verify-macos into arm64 and x64 jobs: Split verify-macos into arm64 and x64 jobs
- Cannot use Docker for macOS: Cannot use Docker for macOS
