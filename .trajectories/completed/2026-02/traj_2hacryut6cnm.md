# Trajectory: Extend sdk-ts broker client methods and relaycast utility

> **Status:** ✅ Completed
> **Confidence:** 92%
> **Started:** February 18, 2026 at 09:43 AM
> **Completed:** February 18, 2026 at 09:46 AM

---

## Summary

Added send_input, set_model, and get_metrics handlers; extended AgentSpec; added release reason logging and cwd spawn support; verified with test/clippy/build

**Approach:** Standard approach

---

## Key Decisions

### Implemented send_input and set_model by writing directly to worker stdin with flush

- **Chose:** Implemented send_input and set_model by writing directly to worker stdin with flush
- **Reasoning:** Uses existing ChildStdin channel in WorkerHandle and preserves broker->worker interactive semantics

### Implemented get_metrics using WorkerHandle.spawned_at plus Linux /proc/<pid>/statm RSS parsing

- **Chose:** Implemented get_metrics using WorkerHandle.spawned_at plus Linux /proc/<pid>/statm RSS parsing
- **Reasoning:** Provides best-effort memory metrics cross-platform while returning 0 on non-Linux

---

## Chapters

### 1. Work

_Agent: default_

- Implemented send_input and set_model by writing directly to worker stdin with flush: Implemented send_input and set_model by writing directly to worker stdin with flush
- Implemented get_metrics using WorkerHandle.spawned_at plus Linux /proc/<pid>/statm RSS parsing: Implemented get_metrics using WorkerHandle.spawned_at plus Linux /proc/<pid>/statm RSS parsing
