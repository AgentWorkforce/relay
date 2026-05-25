# Trajectory: Address PR 978 review comments

> **Status:** ✅ Completed
> **Confidence:** 86%
> **Started:** May 24, 2026 at 10:33 PM
> **Completed:** May 25, 2026 at 07:42 AM

---

## Summary

Addressed PR 978 review comments for harness adapter scoping, executable validation, SDK event/session fixes, MCP command setup, and CI failures.

**Approach:** Standard approach

---

## Key Decisions

### Scoped SDK-provided harnesses to relay/workflow instances and used temporary registry snapshots for workflow execution.

- **Chose:** Scoped SDK-provided harnesses to relay/workflow instances and used temporary registry snapshots for workflow execution.
- **Reasoning:** Review comments called out cross-instance and YAML parse leaks; explicit registerHarnessAdapter remains the opt-in global path, while instance/YAML harnesses are serialized to the broker or installed only during execution.

---

## Chapters

### 1. Work

_Agent: default_

- Scoped SDK-provided harnesses to relay/workflow instances and used temporary registry snapshots for workflow execution.: Scoped SDK-provided harnesses to relay/workflow instances and used temporary registry snapshots for workflow execution.
