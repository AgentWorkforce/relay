# Trajectory: Serialize wrap injections across PTY acknowledgements for PR 1634

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#1634
> **Confidence:** 95%
> **Started:** September 2, 2026 at 03:55 AM
> **Completed:** September 2, 2026 at 03:57 AM

---

## Summary

Serialized wrap injections across PTY acknowledgements so burst deliveries preserve reminder throttling and FIFO semantics.

**Approach:** Standard approach

---

## Key Decisions

### Keep wrap injections single-flight until each PTY write acknowledgement settles
- **Chose:** Keep wrap injections single-flight until each PTY write acknowledgement settles
- **Reasoning:** Deferring MCP reminder accounting until write confirmation is correct only if a second delivery cannot make its reminder decision during the first Claude injection's 250 ms acknowledgement window.

---

## Chapters

### 1. Work
*Agent: default*

- Keep wrap injections single-flight until each PTY write acknowledgement settles.
- The review-driven single-flight guard closes the reminder-throttle race without changing the established FIFO write shape; full broker and integration suites remain green.

---

## Artifacts

**Commits:** ab63f122b
**Files changed:** 1
