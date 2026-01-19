# Trajectory: Fix cloud message routing broken by commit 5569296

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** January 19, 2026 at 08:51 AM
> **Completed:** January 19, 2026 at 08:52 AM

---

## Summary

Reverted incorrect routing from commit 5569296. That commit changed FROM workspace.publicUrl TO getLocalDashboardUrl, breaking cloud mode. Fixed: wssChannels WebSocket, /api/channels/message, /api/channels/join, and channel create admin-join - all now use workspace.publicUrl with fallback to getLocalDashboardUrl for local mode.

**Approach:** Standard approach

---

## Key Decisions

### Breaking change in commit 5569296 (Jan 13) was included in v1.5.1 (Jan 16)
- **Chose:** Breaking change in commit 5569296 (Jan 13) was included in v1.5.1 (Jan 16)
- **Reasoning:** Cloud likely deployed with v1.5.1+ in last 2 days. Release date differs from actual cloud deployment.

---

## Chapters

### 1. Work
*Agent: default*

- Breaking change in commit 5569296 (Jan 13) was included in v1.5.1 (Jan 16): Breaking change in commit 5569296 (Jan 13) was included in v1.5.1 (Jan 16)
