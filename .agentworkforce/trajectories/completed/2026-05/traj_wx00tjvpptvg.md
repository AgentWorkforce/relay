# Trajectory: Investigate agent-relay spawn persistence

> **Status:** ✅ Completed
> **Confidence:** 86%
> **Started:** May 13, 2026 at 12:49 PM
> **Completed:** May 13, 2026 at 12:53 PM

---

## Summary

Fixed agent-relay spawn persistence by autostarting a detached background broker for one-shot spawn commands and by treating --cwd as the spawned agent cwd rather than the broker project scope. Added a regression test for --cwd broker-scope behavior and verified with Vitest plus ESLint.

**Approach:** Standard approach

---

## Key Decisions

### Keep spawn broker scoped to invoking project

- **Chose:** Keep spawn broker scoped to invoking project
- **Reasoning:** The CLI --cwd option describes the spawned worker working directory; using it to choose the broker made agent-relay who connect to a different project scope and hide the spawned agent.

---

## Chapters

### 1. Work

_Agent: default_

- Keep spawn broker scoped to invoking project: Keep spawn broker scoped to invoking project
- Found spawn persistence failure caused by two CLI-layer issues: autostart used owned SDK brokers that shutdown in finally, and --cwd selected the broker scope instead of only the worker cwd. Patched spawn to autostart a background broker and preserve current project broker scope.
