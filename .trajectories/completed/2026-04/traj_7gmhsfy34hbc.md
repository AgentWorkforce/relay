# Trajectory: Improve standalone smoke script binary validation

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** April 10, 2026 at 03:41 PM
> **Completed:** April 10, 2026 at 03:47 PM

---

## Summary

Updated ci-standalone smoke script to validate CLI and broker binaries before invocation, enable startup debug for smoke/cleanup CLI calls, preserve early broker startup failures, and shorten broker readiness diagnostics.

**Approach:** Standard approach

---

## Key Decisions

### Preflight binary validation before smoke temp setup

- **Chose:** Preflight binary validation before smoke temp setup
- **Reasoning:** The script must fail before any CLI invocation when the CLI or broker path is missing or not executable, and installing the cleanup trap only after validation avoids cleanup calling an invalid CLI.

### Preserve broker startup failure signal

- **Chose:** Preserve broker startup failure signal
- **Reasoning:** The up smoke now records an early nonzero up command exit and fails with the captured diagnostic excerpt instead of discarding the wait status.

---

## Chapters

### 1. Work

_Agent: default_

- Preflight binary validation before smoke temp setup: Preflight binary validation before smoke temp setup
- Preserve broker startup failure signal: Preserve broker startup failure signal
