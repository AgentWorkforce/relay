# Trajectory: Legacy outbox path hardcoded in AgentSwarm defaults

> **Status:** ✅ Completed
> **Task:** sdk-consumer-outbox-root-cause
> **Confidence:** 95%
> **Started:** January 23, 2026 at 11:37 PM
> **Completed:** January 23, 2026 at 11:37 PM

---

## Summary

AgentSwarm lib/defaults.js hardcodes legacy /tmp/relay-outbox path instead of using $AGENT_RELAY_OUTBOX. Relay symlink fix provides backwards compat, but proper fix is in AgentSwarm.

**Approach:** Standard approach

---

## Key Decisions

### Root cause is AgentSwarm hardcoding legacy path
- **Chose:** Root cause is AgentSwarm hardcoding legacy path
- **Reasoning:** AgentSwarm's lib/defaults.js uses 'cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/msg' instead of 'cat > $AGENT_RELAY_OUTBOX/msg'. The relay sets AGENT_RELAY_OUTBOX correctly, but AgentSwarm ignores it. Proper fix is in AgentSwarm, relay symlink fix is defensive backwards compat.

---

## Chapters

### 1. Work
*Agent: default*

- Root cause is AgentSwarm hardcoding legacy path: Root cause is AgentSwarm hardcoding legacy path
