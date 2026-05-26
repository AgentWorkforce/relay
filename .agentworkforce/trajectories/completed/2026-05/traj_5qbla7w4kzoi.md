# Trajectory: Fix issue 877

> **Status:** ✅ Completed
> **Task:** #877
> **Confidence:** 92%
> **Started:** May 18, 2026 at 11:40 PM
> **Completed:** May 18, 2026 at 11:54 PM

---

## Summary

Refactored broker Relaycast integration into the relaycast module tree with compatibility re-exports and updated runtime callers to use relay_broker::relaycast.

**Approach:** Standard approach

---

## Key Decisions

### Moved Relaycast broker integration under relaycast module tree

- **Chose:** Moved Relaycast broker integration under relaycast module tree
- **Reasoning:** Issue 877 asks for ownership cleanup without protocol changes; moving auth, websocket/http transport, event/command mapping, and multi-workspace session code under crates/broker/src/relaycast gives runtime callers a single relay_broker::relaycast boundary while compatibility shims preserve existing public paths.

---

## Chapters

### 1. Work

_Agent: default_

- Moved Relaycast broker integration under relaycast module tree: Moved Relaycast broker integration under relaycast module tree
