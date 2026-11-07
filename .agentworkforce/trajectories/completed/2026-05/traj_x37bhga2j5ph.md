# Trajectory: Deepen broker runtime refactor for PR 906

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#875
> **Confidence:** 90%
> **Started:** May 18, 2026 at 09:42 PM
> **Completed:** May 18, 2026 at 09:50 PM

---

## Summary

Split the broker runtime beyond the init facade: run_init now bootstraps services and hands off to BrokerRuntime, which dispatches typed RuntimeEvent values to focused HTTP API, Relaycast inbound, worker-event, and maintenance handlers. Updated source-inspection contract tests to follow the new handler files and verified cargo fmt, test, and clippy for agent-relay-broker.

**Approach:** Standard approach

---

## Key Decisions

### Split broker runtime into event-loop context and event handlers

- **Chose:** Split broker runtime into event-loop context and event handlers
- **Reasoning:** The prior runtime/init split still left long-lived state and every select branch in one function. Moving state into BrokerRuntime and dispatching RuntimeEvent to HTTP API, Relaycast, worker-event, and maintenance handlers makes ownership and control flow explicit while preserving tested behavior.

---

## Chapters

### 1. Work

_Agent: default_

- Split broker runtime into event-loop context and event handlers: Split broker runtime into event-loop context and event handlers
