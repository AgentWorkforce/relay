# Trajectory: Add macOS CI smoke test for standalone agent-relay CLI

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** March 10, 2026 at 02:45 PM
> **Completed:** March 10, 2026 at 02:50 PM

---

## Summary

Added a reusable standalone lifecycle smoke script, wired it into macOS package-validation CI and publish-time standalone verification, and validated the script locally against the built CLI and broker.

**Approach:** Standard approach

---

## Key Decisions

### Add a reusable standalone lifecycle smoke script and run it in both PR macOS CI and publish-time macOS verification
- **Chose:** Add a reusable standalone lifecycle smoke script and run it in both PR macOS CI and publish-time macOS verification
- **Reasoning:** The duplicate-entrypoint bug only surfaced on the standalone CLI path. Reusing the same smoke assertions in package-validation and publish verification catches regressions before merge and again against the release artifact.

---

## Chapters

### 1. Work
*Agent: default*

- Add a reusable standalone lifecycle smoke script and run it in both PR macOS CI and publish-time macOS verification: Add a reusable standalone lifecycle smoke script and run it in both PR macOS CI and publish-time macOS verification
