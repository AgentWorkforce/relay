# Trajectory: Swift SDK: threads (thread fetch + reply) for TS participant SDK parity (#1150)

> **Status:** ✅ Completed
> **Task:** 1150
> **Confidence:** 80%
> **Started:** June 23, 2026 at 06:56 PM
> **Completed:** June 23, 2026 at 06:56 PM

---

## Summary

Added AgentClient.thread(\_:limit:) and reply(to:message:) plus RelayThread type to AgentRelaySDK (Swift), wired to GET/POST /v1/messages/{id}/replies, with 3 unit tests. Could not run swift build locally (proxy blocks download.swift.org); relied on existing patterns. CI swift-test job will validate.

**Approach:** Standard approach

---

## Key Decisions

### Reused relaycast gateway REST endpoints: GET/POST /v1/messages/{id}/replies

- **Chose:** Reused relaycast gateway REST endpoints: GET/POST /v1/messages/{id}/replies
- **Reasoning:** Inspected @relaycast/sdk@4.1.6 dist (agent.js thread/reply) to match exact paths and the {parent,replies} response shape the TS participant SDK consumes

---

## Chapters

### 1. Work

_Agent: default_

- Reused relaycast gateway REST endpoints: GET/POST /v1/messages/{id}/replies: Reused relaycast gateway REST endpoints: GET/POST /v1/messages/{id}/replies
