# Trajectory: Port PR #1103 Swift broker-parity helpers onto new AgentRelayBrokerSDK module

> **Status:** ✅ Completed
> **Task:** PR-1103
> **Confidence:** 80%
> **Started:** July 15, 2026 at 01:22 AM
> **Completed:** July 15, 2026 at 01:36 AM

---

## Summary

Ported PR #1103 broker parity onto AgentRelayBrokerSDK: 13 broker control/observability methods + Codable types, corrected wire bugs (endpoints, listAgents envelope, sessionId camelCase, crash types), query-preserving resolveAPIURL, 18 new tests, README + changelog. Pushed to claude/pr-1103-review-5bqm37.

**Approach:** Standard approach

---

## Key Decisions

### Port PR #1103 onto AgentRelayBrokerSDK module, correcting wire bugs
- **Chose:** Port PR #1103 onto AgentRelayBrokerSDK module, correcting wire bugs
- **Reasoning:** PR targeted the retired monolithic AgentRelaySDK. Verified real broker routes in crates/broker/src/listen_api.rs and TS driver packages/harness-driver/src/client.ts: sendInput=/api/input/{name}, resizePty=/api/resize/{name} (PR had /api/spawned/{name}/...), listAgents returns {agents:[]}, ListAgent.sessionId is camelCase wire key, and crash-insight types differ from PR's guesses (agent_name/exit_code/timestamp/uptime_secs/category/description + health_score).

---

## Chapters

### 1. Work
*Agent: default*

- Port PR #1103 onto AgentRelayBrokerSDK module, correcting wire bugs: Port PR #1103 onto AgentRelayBrokerSDK module, correcting wire bugs

---

## Artifacts

**Commits:** 6e305632
**Files changed:** 7
