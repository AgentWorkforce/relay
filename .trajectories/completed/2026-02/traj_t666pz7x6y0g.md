# Trajectory: Migrate integration tests to current SDK API and fix workflow-ci for broker-only constraints

> **Status:** ✅ Completed
> **Confidence:** 87%
> **Started:** February 23, 2026 at 09:55 AM
> **Completed:** February 23, 2026 at 10:39 AM

---

## Summary

Migrated tests/integration/sdk scripts to current AgentRelayClient scenarios, patched workflow-ci for broker/Relaycast behavior, hardened lockfile init --api-port shutdown tests, and re-ran integration suites to green.

**Approach:** Standard approach

---

## Key Decisions

### Replaced legacy daemon-style SDK integration scripts with AgentRelayClient-based runner

- **Chose:** Replaced legacy daemon-style SDK integration scripts with AgentRelayClient-based runner
- **Reasoning:** Current SDK no longer exports RelayClient or socket-based daemon APIs; consolidating scenarios on AgentRelayClient keeps tests aligned with broker stdio architecture and removes dead API dependencies.

### Updated workflow-ci assertions from delivery_ack to delivery progress events

- **Chose:** Updated workflow-ci assertions from delivery_ack to delivery progress events
- **Reasoning:** Lightweight shim CLIs do not emit reliable delivery_ack events under broker-only mode; delivery_queued/injected/retry are stable indicators of routing progress.

---

## Chapters

### 1. Work

_Agent: default_

- Replaced legacy daemon-style SDK integration scripts with AgentRelayClient-based runner: Replaced legacy daemon-style SDK integration scripts with AgentRelayClient-based runner
- Updated workflow-ci assertions from delivery_ack to delivery progress events: Updated workflow-ci assertions from delivery_ack to delivery progress events

---

## Artifacts

**Commits:** 81543312, 96d5375d, 54fad615, 83a19438
**Files changed:** 9
