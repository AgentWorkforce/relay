# Trajectory: Fix remote users not visible in cloud mode

> **Status:** ✅ Completed
> **Task:** human-to-human-messaging
> **Confidence:** 85%
> **Started:** January 20, 2026 at 01:32 PM
> **Completed:** January 20, 2026 at 01:32 PM

---

## Summary

Added writeRemoteUsersFile to daemon, updated isUserOnline and getAllData in dashboard-server to check remote-users.json

**Approach:** Standard approach

---

## Key Decisions

### Write remote users to file for dashboard consumption
- **Chose:** Write remote users to file for dashboard consumption
- **Reasoning:** Follows existing pattern for remote agents (remote-agents.json), allows dashboard-server to check remote users without direct daemon access

### Add 60-second staleness check
- **Chose:** Add 60-second staleness check
- **Reasoning:** Prevents showing stale user presence data if cloud sync stops

---

## Chapters

### 1. Work
*Agent: default*

- Write remote users to file for dashboard consumption: Write remote users to file for dashboard consumption
- Add 60-second staleness check: Add 60-second staleness check
