# Trajectory: Fix Codex GPT-5.5 E2E rough edges

> **Status:** ✅ Completed
> **Confidence:** 92%
> **Started:** May 15, 2026 at 01:59 PM
> **Completed:** May 15, 2026 at 02:12 PM

---

## Summary

Fixed Codex GPT-5.5 spawn rough edges: effective model fallback now propagates to worker state/events/API responses, CLI spawn waits for broker readiness before calling spawn, local harness spawns can skip relay prompt injection explicitly, clippy-only test hygiene warnings are resolved, and fake Codex E2E verifies old and supported catalogs.

**Approach:** Standard approach

---

## Key Decisions

### Fix CLI spawn readiness by waiting for broker session

- **Chose:** Fix CLI spawn readiness by waiting for broker session
- **Reasoning:** The observed Service Unavailable comes from the startup HTTP handler before the real API is installed, so the CLI autostart path should poll getSession instead of returning after finding the connection file.

### Return effective spawn spec from WorkerRegistry

- **Chose:** Return effective spawn spec from WorkerRegistry
- **Reasoning:** Model fallback mutates the worker spec internally; returning the effective spec lets events, persisted state, and API replies report the actual model used.

---

## Chapters

### 1. Work

_Agent: default_

- Fix CLI spawn readiness by waiting for broker session: Fix CLI spawn readiness by waiting for broker session
- Return effective spawn spec from WorkerRegistry: Return effective spawn spec from WorkerRegistry
- Implemented model metadata propagation, CLI readiness waiting, and clippy cleanup; local E2E confirmed old Codex falls back to gpt-5.4 while supported catalog keeps gpt-5.5
