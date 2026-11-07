# Trajectory: Clarify headless app-server harness terminology

> **Status:** ✅ Completed
> **Confidence:** 88%
> **Started:** May 25, 2026 at 12:34 PM
> **Completed:** May 25, 2026 at 12:34 PM

---

## Summary

Clarified app-server as a headless harness driver instead of a separate public runtime.

**Approach:** Standard approach

---

## Key Decisions

### Collapsed app-server into headless runtime driver

- **Chose:** Collapsed app-server into headless runtime driver
- **Reasoning:** App-server and provider command workers have the same non-PTY broker capability surface; keeping app_server as a separate public runtime made docs and API shape more confusing.

---

## Chapters

### 1. Work

_Agent: default_

- Collapsed app-server into headless runtime driver: Collapsed app-server into headless runtime driver
