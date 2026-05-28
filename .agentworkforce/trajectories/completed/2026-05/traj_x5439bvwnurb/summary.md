# Trajectory: Keep OpenClaw adapter in core simplification PR

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** May 28, 2026 at 04:04 PM
> **Completed:** May 28, 2026 at 04:15 PM

---

## Summary

Restored @agent-relay/openclaw as an optional adapter, moved its managed spawn bridge to @agent-relay/driver, refreshed package docs and lockfile, and validated package tests/build plus core build.

**Approach:** Standard approach

---

## Key Decisions

### Keep OpenClaw as an optional adapter
- **Chose:** Keep OpenClaw as an optional adapter
- **Reasoning:** OpenClaw still serves as a useful adapter, but any managed spawn implementation belongs behind @agent-relay/driver so the core SDK remains messaging/delivery/actions focused.

---

## Chapters

### 1. Work
*Agent: default*

- Keep OpenClaw as an optional adapter: Keep OpenClaw as an optional adapter
