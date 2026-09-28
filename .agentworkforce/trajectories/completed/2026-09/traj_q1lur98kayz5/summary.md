# Trajectory: Implement headless on-relay listener for #1863 Part A

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#1863
> **Confidence:** 90%
> **Started:** September 28, 2026 at 08:11 AM
> **Completed:** September 28, 2026 at 08:15 AM

---

## Summary

Added the npx-runnable agent-relay on-relay command with Relaycast registration, direct-node listening, durable exactly-once delivery draining, Codex/Claude injection, docs, and tests.

**Approach:** Standard approach

---

## Key Decisions

### Expose a top-level on-relay command through the existing agent-relay npm bin
- **Chose:** Expose a top-level on-relay command through the existing agent-relay npm bin
- **Reasoning:** npx agent-relay@latest on-relay is the smallest public surface consistent with the current CLI package and needs no second package or binary

### Use the Agent Relay SDK for registration and durable delivery transitions, with a ported direct-node WebSocket
- **Chose:** Use the Agent Relay SDK for registration and durable delivery transitions, with a ported direct-node WebSocket
- **Reasoning:** The SDK already owns Relaycast request normalization, while its realtime agent client auto-acks delivery frames before local injection; the desktop protocol requires HTTP ack only after durable injection

### Persist an in-flight delivery barrier before invoking Codex or Claude
- **Chose:** Persist an in-flight delivery barrier before invoking Codex or Claude
- **Reasoning:** A crash or ambiguous write must never run the teammate's prompt twice; recovered in-flight deliveries are terminally failed as in doubt instead of resent

---

## Chapters

### 1. Work
*Agent: default*

- Expose a top-level on-relay command through the existing agent-relay npm bin: Expose a top-level on-relay command through the existing agent-relay npm bin
- Use the Agent Relay SDK for registration and durable delivery transitions, with a ported direct-node WebSocket: Use the Agent Relay SDK for registration and durable delivery transitions, with a ported direct-node WebSocket
- Persist an in-flight delivery barrier before invoking Codex or Claude: Persist an in-flight delivery barrier before invoking Codex or Claude
- Headless listener, durable exactly-once ledger, SDK registration/draining, direct node socket, and first-party Codex/Claude injection are implemented. Focused tests/build/package validation pass; full monorepo suite has 13 unrelated baseline/environment failures among 3,567 tests.
