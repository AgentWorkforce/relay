# Trajectory: Implement @mention CTA for inviting users not in channel

> **Status:** ✅ Completed
> **Task:** channel-mention-invite
> **Confidence:** 85%
> **Started:** January 28, 2026 at 09:40 PM
> **Completed:** January 28, 2026 at 09:53 PM

---

## Summary

Implemented @mention channel invite API: checkMentionMembership, sendMentionInvite, getMentionInvites, respondToMentionInvite, processMentionInvites in channels/api.ts. Added full type definitions in channels/types.ts. Created useMentionInvite hook with polling, invite accept/decline, and extractMentions utility. All exported from hooks/index.ts and channels/index.ts. Uses localStorage fallback when server endpoints return 404.

**Approach:** Standard approach

---

## Key Decisions

### Architecture: Add mention invite functions to channels/api.ts as the primary API layer
- **Chose:** Architecture: Add mention invite functions to channels/api.ts as the primary API layer
- **Reasoning:** Channels API already handles channel membership (getChannelMembers, addMember, joinChannel). Adding checkMentionMembership and sendMentionInvite functions here follows the existing pattern. Notification is handled via toast system.

### Used localStorage fallback for invite persistence
- **Chose:** Used localStorage fallback for invite persistence
- **Reasoning:** Server endpoints may not exist yet (404 fallback). localStorage provides immediate functionality while daemon API endpoints are being built. Local invites merge with server invites when available.

---

## Chapters

### 1. Work
*Agent: default*

- Architecture: Add mention invite functions to channels/api.ts as the primary API layer: Architecture: Add mention invite functions to channels/api.ts as the primary API layer
- Used localStorage fallback for invite persistence: Used localStorage fallback for invite persistence
