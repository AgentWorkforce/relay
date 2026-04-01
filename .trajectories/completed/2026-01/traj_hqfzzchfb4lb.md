# Trajectory: Fix legacy outbox symlink missing in local mode

> **Status:** ✅ Completed
> **Task:** sdk-consumer-outbox-issue
> **Confidence:** 85%
> **Started:** January 23, 2026 at 11:37 PM
> **Completed:** January 23, 2026 at 11:37 PM

---

## Summary

Fixed legacy outbox symlink creation in local mode. Agents with stale instructions using /tmp/relay-outbox/ now have their writes correctly redirected to the actual outbox path via symlink.

**Approach:** Standard approach

---

## Key Decisions

### Found legacy symlink not created in local mode
- **Chose:** Found legacy symlink not created in local mode
- **Reasoning:** In local mode (no WORKSPACE_ID), _legacyOutboxPath was set to _outboxPath (same value), causing the symlink condition to be FALSE. Agents with stale instructions using /tmp/relay-outbox/ would write to a path relay-pty wasn't watching.

### Fixed by setting proper legacy path in local mode
- **Chose:** Fixed by setting proper legacy path in local mode
- **Reasoning:** Changed line 296 from '_legacyOutboxPath = this._outboxPath' to '_legacyOutboxPath = /tmp/relay-outbox/{agentName}'. Now the symlink creation condition at line 419 is TRUE and creates: /tmp/relay-outbox/{name} -> {projectRoot}/.agent-relay/outbox/{name}

---

## Chapters

### 1. Work
*Agent: default*

- Found legacy symlink not created in local mode: Found legacy symlink not created in local mode
- Fixed by setting proper legacy path in local mode: Fixed by setting proper legacy path in local mode
