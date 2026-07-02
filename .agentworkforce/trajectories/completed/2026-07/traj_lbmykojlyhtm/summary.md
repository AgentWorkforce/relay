# Trajectory: Implement workspace-scoped node delivery fix

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** June 30, 2026 at 03:37 PM
> **Completed:** July 2, 2026 at 03:21 AM

---

## Summary

Broker /api/observer-token now mints idempotently: lists observer tokens, rotates an existing active token with the requested name (fresh secret, no duplicate-name 409), else creates; covered with 4 httpmock unit tests

**Approach:** Standard approach

---

## Key Decisions

### Workspace-scope auto-derived node IDs only
- **Chose:** Workspace-scope auto-derived node IDs only
- **Reasoning:** The pinned RELAY_NODE_TOKEN path must keep using the enrolled machine seed verbatim, while create_node auto-mint needs node IDs unique across workspaces for the same cwd.

### Implemented idempotent mint on RelaycastHttpClient (list -> rotate active same-name token -> else create) rather than in the runtime handler
- **Chose:** Implemented idempotent mint on RelaycastHttpClient (list -> rotate active same-name token -> else create) rather than in the runtime handler
- **Reasoning:** Keeps the /api/observer-token handler's timeout wrapping a single future, and makes the logic unit-testable with httpmock at the client layer; rotation deliberately preserves existing scopes/filters so a user-narrowed token is not silently re-widened

---

## Chapters

### 1. Work
*Agent: default*

- Workspace-scope auto-derived node IDs only: Workspace-scope auto-derived node IDs only
- Implemented idempotent mint on RelaycastHttpClient (list -> rotate active same-name token -> else create) rather than in the runtime handler: Implemented idempotent mint on RelaycastHttpClient (list -> rotate active same-name token -> else create) rather than in the runtime handler
