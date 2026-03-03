# Trajectory: Fix dashboard thread replies endpoint and dashboard startup crash handling

> **Status:** ✅ Completed
> **Confidence:** 87%
> **Started:** March 3, 2026 at 08:38 AM
> **Completed:** March 3, 2026 at 09:04 AM

---

## Summary

Implemented proxy-mode thread replies endpoints, added thread propagation through dashboard send strategies, and confirmed runtime no longer returns missing-route 404 for /api/messages/:id/replies; also updated local binary discovery to prefer sibling relay-dashboard in dev workspaces.

**Approach:** Standard approach

---

## Key Decisions

### Added proxy-mode thread replies routes and thread-aware send plumbing in relay-dashboard
- **Chose:** Added proxy-mode thread replies routes and thread-aware send plumbing in relay-dashboard
- **Reasoning:** agent-relay up uses proxy-server.ts, and /api/messages/:id/replies was missing there, causing 404 for thread operations

### Prefer sibling relay-dashboard build by default when present
- **Chose:** Prefer sibling relay-dashboard build by default when present
- **Reasoning:** in local multi-repo development, this avoids stale global dashboard binaries and ensures agent-relay up uses the actively edited dashboard server

---

## Chapters

### 1. Work
*Agent: default*

- Added proxy-mode thread replies routes and thread-aware send plumbing in relay-dashboard: Added proxy-mode thread replies routes and thread-aware send plumbing in relay-dashboard
- Prefer sibling relay-dashboard build by default when present: Prefer sibling relay-dashboard build by default when present

---

## Artifacts

**Commits:** fe273eef
**Files changed:** 9
