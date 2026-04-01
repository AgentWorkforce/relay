# Trajectory: Filter _DashboardUI from Direct Messages section

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** January 16, 2026 at 11:29 AM
> **Completed:** January 16, 2026 at 11:30 AM

---

## Summary

Fixed _DashboardUI appearing in Direct Messages by adding explicit filters in server.ts (backend) and Sidebar.tsx (frontend). Created follow-up tasks agent-relay-510 and agent-relay-511 for proper centralization and naming convention standardization.

**Approach:** Standard approach

---

## Key Decisions

### Added explicit _DashboardUI filter to both backend (server.ts) and frontend (Sidebar.tsx) rather than changing prefix convention
- **Chose:** Added explicit _DashboardUI filter to both backend (server.ts) and frontend (Sidebar.tsx) rather than changing prefix convention
- **Reasoning:** Quick fix for immediate issue. Changing _DashboardUI to __DashboardUI would require updating all references across the codebase and could break existing functionality.

---

## Chapters

### 1. Work
*Agent: default*

- Added explicit _DashboardUI filter to both backend (server.ts) and frontend (Sidebar.tsx) rather than changing prefix convention: Added explicit _DashboardUI filter to both backend (server.ts) and frontend (Sidebar.tsx) rather than changing prefix convention
