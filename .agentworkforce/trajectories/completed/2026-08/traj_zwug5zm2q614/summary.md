# Trajectory: Implement replayable durable relay session resolution for Factory PR pointers

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#1522
> **Confidence:** 78%
> **Started:** August 17, 2026 at 11:27 AM
> **Completed:** August 17, 2026 at 11:56 AM

---

## Summary

Added the Relay CLI consumer for the existing authenticated Relayhistory session-turn journal, with no new identifier or storage. Relaycast message metadata/join remains intentionally unclaimed.

**Approach:** Standard approach

---

## Key Decisions

### Replay consumes the existing Relayhistory conversation-turns journal with Relay's emitted ai-hist UUID; stored Relayhistory auth is used only as an authenticated resolver credential, and no new ID, store, or join table is introduced.
- **Chose:** Replay consumes the existing Relayhistory conversation-turns journal with Relay's emitted ai-hist UUID; stored Relayhistory auth is used only as an authenticated resolver credential, and no new ID, store, or join table is introduced.
- **Rejected:** new replay store, new PR identifier, heuristic history lookup
- **Reasoning:** Remote relayhistory-cloud main mounts GET /v1/sessions/:sessionId/turns behind rth:read and scopes lookup by organization.

---

## Chapters

### 1. Work
*Agent: default*

- Replay consumes the existing Relayhistory conversation-turns journal with Relay's emitted ai-hist UUID; stored Relayhistory auth is used only as an authenticated resolver credential, and no new ID, store, or join table is introduced.: Replay consumes the existing Relayhistory conversation-turns journal with Relay's emitted ai-hist UUID; stored Relayhistory auth is used only as an authenticated resolver credential, and no new ID, store, or join table is introduced.
