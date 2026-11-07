# Trajectory: Add fleet spawn worker cwd support

> **Status:** ✅ Completed
> **Task:** 1540
> **Confidence:** 92%
> **Started:** August 17, 2026 at 05:33 AM
> **Completed:** August 17, 2026 at 06:57 AM

---

## Summary

Added fleet spawn --cwd and explicit worker_cwd action plumbing through targeted and automatic placement, validated absolute directories on the selected node, separated persona registry cwd naming, and added live-process plus rejection coverage.

**Approach:** Standard approach

---

## Key Decisions

### Use worker_cwd as the Fleet action field while keeping CLI --cwd ergonomic and preserving cwd as a deprecated persona-registry alias
- **Chose:** Use worker_cwd as the Fleet action field while keeping CLI --cwd ergonomic and preserving cwd as a deprecated persona-registry alias
- **Reasoning:** The existing MCP cwd means registry lookup, so a distinct wire field prevents silent misplacement; automatic placement carries it in metadata because the upstream spawn schema strips unknown top-level fields.

---

## Chapters

### 1. Work
*Agent: default*

- Use worker_cwd as the Fleet action field while keeping CLI --cwd ergonomic and preserving cwd as a deprecated persona-registry alias: Use worker_cwd as the Fleet action field while keeping CLI --cwd ergonomic and preserving cwd as a deprecated persona-registry alias
- Fleet CLI, MCP, Fleet DSL, and broker now carry an explicit worker_cwd; live process and missing-path tests pass across the broker boundary
