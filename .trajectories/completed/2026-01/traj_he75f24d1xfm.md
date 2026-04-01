# Trajectory: Implement cloud message storage for Algolia challenge

> **Status:** ✅ Completed
> **Task:** algolia-challenge-prep
> **Confidence:** 90%
> **Started:** January 9, 2026 at 12:57 AM
> **Completed:** January 9, 2026 at 12:58 AM

---

## Summary

Added cloud message storage infrastructure for Algolia challenge. Created agent_messages table with workspace scoping, plan-based retention, and Algolia sync tracking. Extended daemon CloudSyncService to sync messages during heartbeat. Added /api/daemons/messages/sync endpoint. All 1119 tests pass.

**Approach:** Standard approach

---

## Key Decisions

### Store messages in PostgreSQL with workspace-scoped deduplication
- **Chose:** Store messages in PostgreSQL with workspace-scoped deduplication
- **Reasoning:** Messages need to be searchable via Algolia. Using workspace_id + original_id unique constraint prevents duplicates when daemons sync the same message multiple times.

### Plan-based retention policy with expires_at column
- **Chose:** Plan-based retention policy with expires_at column
- **Reasoning:** Free tier: 30 days, Pro: 90 days, Enterprise: unlimited. Using nullable expires_at column allows easy cleanup queries and different retention per plan.

### Sync messages during heartbeat cycle
- **Chose:** Sync messages during heartbeat cycle
- **Reasoning:** Daemon already sends heartbeat every 30s to cloud. Adding message sync to this cycle reuses existing infrastructure without adding new timers or connections.

### Track indexedAt for Algolia sync queue
- **Chose:** Track indexedAt for Algolia sync queue
- **Reasoning:** Separate indexedAt timestamp allows independent sync to Algolia. Messages can be stored in PostgreSQL first, then batch-indexed to Algolia without blocking the daemon sync.

### Use Drizzle inArray instead of raw SQL ANY
- **Chose:** Use Drizzle inArray instead of raw SQL ANY
- **Reasoning:** Initial implementation used raw SQL ANY syntax which may not work correctly with Drizzle parameterization. Fixed to use Drizzle's type-safe inArray helper for the markIndexed bulk update.

---

## Chapters

### 1. Work
*Agent: default*

- Store messages in PostgreSQL with workspace-scoped deduplication: Store messages in PostgreSQL with workspace-scoped deduplication
- Plan-based retention policy with expires_at column: Plan-based retention policy with expires_at column
- Sync messages during heartbeat cycle: Sync messages during heartbeat cycle
- Track indexedAt for Algolia sync queue: Track indexedAt for Algolia sync queue
- Use Drizzle inArray instead of raw SQL ANY: Use Drizzle inArray instead of raw SQL ANY
