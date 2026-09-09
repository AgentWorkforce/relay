# Trajectory: Make raw MCP fleet spawns wait for broker readiness

> **Status:** ✅ Completed
> **Task:** relay#1603
> **Confidence:** 92%
> **Started:** August 23, 2026 at 07:44 PM
> **Completed:** August 23, 2026 at 07:54 PM

---

## Summary

Made raw MCP fleet spawns request broker verification, wait for terminal readiness, reject missing ready proof, and surface early exits; added CLI and broker regressions plus changelog.

**Approach:** Standard approach

---

## Key Decisions

### Use an explicit top-level verify_ready action flag instead of synthesizing a harness config
- **Chose:** Use an explicit top-level verify_ready action flag instead of synthesizing a harness config
- **Reasoning:** Readiness is an invocation contract, and injecting a PTY harness config could change CLI command/session semantics; the broker already has the readiness state machine and now accepts the flag alongside existing harness metadata.

---

## Chapters

### 1. Work
*Agent: default*

- Use an explicit top-level verify_ready action flag instead of synthesizing a harness config: Use an explicit top-level verify_ready action flag instead of synthesizing a harness config
