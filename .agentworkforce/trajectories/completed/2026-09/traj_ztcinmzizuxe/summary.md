# Trajectory: Address PR 1864 final subscription lifecycle review findings

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#1864
> **Confidence:** 94%
> **Started:** September 28, 2026 at 11:24 AM
> **Completed:** September 28, 2026 at 11:24 AM

---

## Summary

Made SDK inbox subscription seeding resilient to transient failures, refreshed delivery state on reconnect, triggered immediate CLI drain on connection, and added regression coverage.

**Approach:** Standard approach

---

## Key Decisions

### Keep seed-list failures non-terminal and refresh the SDK durable stream on every connected event
- **Chose:** Keep seed-list failures non-terminal and refresh the SDK durable stream on every connected event
- **Reasoning:** This preserves listener availability and immediate reconnect catch-up while keeping all Relaycast transport behavior inside @agent-relay/sdk.

---

## Chapters

### 1. Work
*Agent: default*

- Keep seed-list failures non-terminal and refresh the SDK durable stream on every connected event: Keep seed-list failures non-terminal and refresh the SDK durable stream on every connected event
