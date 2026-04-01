# Trajectory: Review PR comments, decide which matter, implement the necessary fixes

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** March 6, 2026 at 02:22 PM
> **Completed:** March 6, 2026 at 02:26 PM

---

## Summary

Triaged PR review comments for OpenClaw poll fallback, fixed the real gateway bugs, aligned the docs, and added regression coverage for RECOVERING_WS and 429 backoff behavior.

**Approach:** Standard approach

---

## Key Decisions

### Fixed real PR findings: RECOVERING_WS must process WS events, 429 fallback must avoid double jitter, docs must match transport health/defaults, and gateway logging/cursor persistence now validate untrusted values.

- **Chose:** Fixed real PR findings: RECOVERING_WS must process WS events, 429 fallback must avoid double jitter, docs must match transport health/defaults, and gateway logging/cursor persistence now validate untrusted values.
- **Reasoning:** These comments point to concrete behavior mismatches or cheap hardening improvements; the remaining noise is static-analysis around intentional cursor persistence.

---

## Chapters

### 1. Work

_Agent: default_

- Fixed real PR findings: RECOVERING_WS must process WS events, 429 fallback must avoid double jitter, docs must match transport health/defaults, and gateway logging/cursor persistence now validate untrusted values.: Fixed real PR findings: RECOVERING_WS must process WS events, 429 fallback must avoid double jitter, docs must match transport health/defaults, and gateway logging/cursor persistence now validate untrusted values.
