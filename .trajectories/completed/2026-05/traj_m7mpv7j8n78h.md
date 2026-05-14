# Trajectory: Address Relay PR 826 review feedback

> **Status:** ✅ Completed
> **Confidence:** 86%
> **Started:** May 8, 2026 at 05:17 PM
> **Completed:** May 8, 2026 at 05:24 PM

---

## Summary

Addressed PR 826 feedback by making deterministic repair opt-in, preserving failed gate cwd for repair agents, routing GitHub root exports through the local SDK surface, cleaning review-noted markdown/trajectory text, and updating the PR body test plan.

**Approach:** Standard approach

---

## Key Decisions

### Run repair agents from the failed gate resolved cwd
- **Chose:** Run repair agents from the failed gate resolved cwd
- **Reasoning:** The repair agent must see and edit the same filesystem context as the deterministic command that failed, especially when a step uses cwd or workdir overrides.

### Make deterministic gate repair opt-in in Relay SDK
- **Chose:** Make deterministic gate repair opt-in in Relay SDK
- **Reasoning:** PR feedback correctly identified that default repairRetries=2 would silently add LLM repair attempts, cost, and file mutation risk to existing workflows. Ricky-generated workflows can still opt in explicitly.

---

## Chapters

### 1. Work
*Agent: default*

- Run repair agents from the failed gate resolved cwd: Run repair agents from the failed gate resolved cwd
- Make deterministic gate repair opt-in in Relay SDK: Make deterministic gate repair opt-in in Relay SDK
- PR feedback fixes are scoped: deterministic repair now requires explicit repairRetries, repair agents inherit the failed gate cwd, docs and trajectory comments are cleaned up, and the PR body now has a checkbox test plan.
