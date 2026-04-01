# Trajectory: Rename Rust binary to agent-relay-broker and clean up TS CLI legacy patterns

> **Status:** ✅ Completed
> **Confidence:** 89%
> **Started:** February 20, 2026 at 11:51 AM
> **Completed:** February 21, 2026 at 10:14 PM

---

## Summary

Fixed dashboard spawn failure by removing --no-spawn from CLI dashboard launch args; added regression test.

**Approach:** Standard approach

---

## Key Decisions

### Removed --no-spawn for dashboard launch

- **Chose:** Removed --no-spawn for dashboard launch
- **Reasoning:** In integrated dashboard builds, --no-spawn disables RelayAdapter creation, causing /api/spawn to return broker-mode adapter errors.

---

## Chapters

### 1. Work

_Agent: default_

- Removed --no-spawn for dashboard launch: Removed --no-spawn for dashboard launch
