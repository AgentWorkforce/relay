# Trajectory: Fix cloud message routing - outbox path mismatch

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** January 19, 2026 at 09:23 AM
> **Completed:** January 19, 2026 at 09:30 AM

---

## Summary

Fixed cloud message routing by using symlinks to bridge legacy and workspace-namespaced outbox paths. Preserves multi-tenancy while keeping agent instructions simple.

**Approach:** Standard approach

---

## Key Decisions

### Root cause: getRelayInstructions() used hardcoded /tmp/relay-outbox path, but relay-pty binary used workspace-namespaced /tmp/relay/{workspaceId}/outbox path
- **Chose:** Root cause: getRelayInstructions() used hardcoded /tmp/relay-outbox path, but relay-pty binary used workspace-namespaced /tmp/relay/{workspaceId}/outbox path
- **Reasoning:** Found by comparing outbox directories on cloud workspace: legacy path had message file, workspace-namespaced path was empty

### Use symlink approach to bridge legacy and workspace-namespaced outbox paths
- **Chose:** Use symlink approach to bridge legacy and workspace-namespaced outbox paths
- **Reasoning:** PR #210 added workspace namespacing for multi-tenancy - can't simply revert. Symlinks let agents use legacy path while preserving workspace isolation.

---

## Chapters

### 1. Work
*Agent: default*

- Root cause: getRelayInstructions() used hardcoded /tmp/relay-outbox path, but relay-pty binary used workspace-namespaced /tmp/relay/{workspaceId}/outbox path: Root cause: getRelayInstructions() used hardcoded /tmp/relay-outbox path, but relay-pty binary used workspace-namespaced /tmp/relay/{workspaceId}/outbox path
- Use symlink approach to bridge legacy and workspace-namespaced outbox paths: Use symlink approach to bridge legacy and workspace-namespaced outbox paths
