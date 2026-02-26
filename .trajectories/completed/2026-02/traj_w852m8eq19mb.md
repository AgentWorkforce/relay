# Trajectory: Remove create-agent and migrate spawnPty calls to broker-sdk

> **Status:** ✅ Completed
> **Confidence:** 93%
> **Started:** February 20, 2026 at 10:27 AM
> **Completed:** February 20, 2026 at 10:35 AM

---

## Summary

Removed create-agent command path and migrated remaining CLI spawn flows to AgentRelayClient/createAgentRelayClient; all CLI command tests and typecheck pass.

**Approach:** Standard approach

---

## Key Decisions

### Migrated up/bridge/profile spawn flows to AgentRelayClient via createAgentRelayClient

- **Chose:** Migrated up/bridge/profile spawn flows to AgentRelayClient via createAgentRelayClient
- **Reasoning:** Standardizes broker access through broker-sdk client and removes legacy new AgentRelay usage

---

## Chapters

### 1. Work

_Agent: default_

- Migrated up/bridge/profile spawn flows to AgentRelayClient via createAgentRelayClient: Migrated up/bridge/profile spawn flows to AgentRelayClient via createAgentRelayClient
