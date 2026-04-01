# Trajectory: Fix cloud channel communication issues

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** January 20, 2026 at 09:34 PM
> **Completed:** January 20, 2026 at 09:34 PM

---

## Summary

Fixed four cloud channel issues: (1) Members modal showing 0 members - cloud server now queries DB directly instead of proxying, (2) Agent invites not working - invite endpoint now syncs agents to daemon, (3) admin-remove 404 - added proxy on cloud server, (4) Agents not knowing how to reply to channels - added explicit reply instructions in message format.

**Approach:** Standard approach

---

## Key Decisions

### Cloud channel members endpoint queries database directly
- **Chose:** Cloud channel members endpoint queries database directly
- **Reasoning:** The /api/channels/:channel/members endpoint was proxying to local dashboard which uses file storage. In cloud mode, members are in PostgreSQL. Fixed by having cloud server query db.channelMembers directly.

### Agent invites sync to daemon via admin-join
- **Chose:** Agent invites sync to daemon via admin-join
- **Reasoning:** The /api/channels/invite endpoint wasn't syncing agents to daemon. Added call to /api/channels/admin-join for agent members so they receive channel messages.

### Added admin-remove proxy to cloud server
- **Chose:** Added admin-remove proxy to cloud server
- **Reasoning:** The endpoint only existed on dashboard-server, causing 404 in cloud mode. Added proxy endpoint on cloud server.

### Made channel message format explicit for agents
- **Chose:** Made channel message format explicit for agents
- **Reasoning:** Agents didn't understand to reply to channel instead of sender. Changed format to include '(reply to #channel, not sender)' hint.

---

## Chapters

### 1. Work
*Agent: default*

- Cloud channel members endpoint queries database directly: Cloud channel members endpoint queries database directly
- Agent invites sync to daemon via admin-join: Agent invites sync to daemon via admin-join
- Added admin-remove proxy to cloud server: Added admin-remove proxy to cloud server
- Made channel message format explicit for agents: Made channel message format explicit for agents
