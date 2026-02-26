# Trajectory: Fix workflow runner review blockers and high-priority issues

> **Status:** ✅ Completed
> **Confidence:** 78%
> **Started:** February 20, 2026 at 10:54 AM
> **Completed:** February 20, 2026 at 11:01 AM

---

## Summary

Applied applicable workflow review fixes on cli-uses-broker: schema property parity, README template table correction, runner execution-core refactor, and instance-scoped Relay API key handling

**Approach:** Standard approach

---

## Key Decisions

### Refactored workflow execution into runWorkflowCore

- **Chose:** Refactored workflow execution into runWorkflowCore
- **Reasoning:** execute() and resume() duplicated setup/teardown, channel wiring, status transitions, and completion/failure handling

### Stopped mutating process.env.RELAY_API_KEY

- **Chose:** Stopped mutating process.env.RELAY_API_KEY
- **Reasoning:** Global env writes leak credentials across runner instances; keep key on WorkflowRunner instance and inject only into spawned relay env

---

## Chapters

### 1. Work

_Agent: default_

- Refactored workflow execution into runWorkflowCore: Refactored workflow execution into runWorkflowCore
- Stopped mutating process.env.RELAY_API_KEY: Stopped mutating process.env.RELAY_API_KEY
