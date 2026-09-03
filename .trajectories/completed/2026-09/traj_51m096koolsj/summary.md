# Trajectory: Complete local-only attach fallback guidance

> **Status:** ✅ Completed
> **Confidence:** 94%
> **Started:** September 3, 2026 at 02:04 PM
> **Completed:** September 3, 2026 at 02:04 PM

---

## Summary

Added node_not_found SSH fallback guidance, regression assertions, and RelayFlow attach coverage.

**Approach:** Standard approach

---

## Key Decisions

### Add the SSH fallback directly to node_not_found attach errors

- **Chose:** Add the SSH fallback directly to node_not_found attach errors
- **Reasoning:** Option B requires both status visibility and an actionable --node failure; a conditional hint is accurate without claiming the caller's missing Cloud name definitely exists locally.

---

## Chapters

### 1. Work

_Agent: default_

- Add the SSH fallback directly to node_not_found attach errors: Add the SSH fallback directly to node_not_found attach errors
