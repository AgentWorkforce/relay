# Beads Task: Implement NewAgentMessage Schema for Bulk Ingest

**ID:** beads-bulk-ingest-1
**Type:** Feature
**Priority:** P2
**Phase:** Deferred
**Status:** Blocked (waiting for agent messaging feature)

## Overview

The `bulk-ingest.ts` module was merged from main but depends on `NewAgentMessage` type that doesn't exist in the schema yet. This needs to be implemented to enable the bulk ingest utilities.

## Background

**What bulk-ingest does:**
- Optimized high-volume bulk insert operations for message sync
- Supports multiple strategies: multi-row INSERT, chunked inserts, streaming COPY
- Used for syncing daemon messages back to cloud (deferred feature)

**Why it's blocked:**
- Requires `NewAgentMessage` type from Drizzle schema
- Requires `agent_messages` table schema definition
- Agent messaging feature not yet fully specified

## Requirements

### Database Schema
- [ ] Create `agent_messages` table in Drizzle schema with columns:
  - `id` UUID (primary key)
  - `workspace_id` UUID (foreign key)
  - `daemon_id` UUID (foreign key)
  - `original_id` string (message ID from daemon)
  - `from_agent` string
  - `to_agent` string
  - `body` text
  - `kind` string (message type)
  - `topic` string (optional)
  - `thread` string (optional)
  - `channel` string (optional)
  - `is_broadcast` boolean
  - `is_urgent` boolean
  - `data` JSONB (optional)
  - `payload_meta` JSONB (optional)
  - `message_ts` timestamp
  - `expires_at` timestamp (optional)
  - `created_at` timestamp

### Type Exports
- [ ] Export `AgentMessage` type from schema.ts
- [ ] Export `NewAgentMessage` type from schema.ts

### Enable Bulk Ingest
- [ ] Uncomment bulk-ingest imports in `src/cloud/db/index.ts`
- [ ] Uncomment bulk object export in `db` object
- [ ] Uncomment bulk export in index.ts
- [ ] Uncomment bulk usage in `src/cloud/api/daemons.ts`

### Tests
- [ ] Unit tests for bulk insert functions
- [ ] Integration test with actual database
- [ ] Performance test for large batches (1000+ messages)

## Acceptance Criteria

- [ ] `NewAgentMessage` type exists and is properly exported
- [ ] `bulk-ingest.ts` compiles without errors
- [ ] Bulk insert operations work with real data
- [ ] No performance regression on other database operations
- [ ] All tests pass
- [ ] Documented in CONTRIBUTING.md how to use bulk ingest

## Dependencies

- Completion of agent messaging feature specification
- Database schema finalized and migrations written

## Related Files

- `src/cloud/db/bulk-ingest.ts` - Currently commented out
- `src/cloud/db/schema.ts` - Needs NewAgentMessage definition
- `src/cloud/db/index.ts` - Has TODOs for re-enabling bulk imports
- `src/cloud/api/daemons.ts` - Uses bulk operations (commented out)

## Notes

This was deferred on 2026-01-10 to focus on Channels V1 implementation. The bulk ingest feature is important for high-volume message syncing but not critical for the initial release.

### Deferred Reason
Agent messaging feature was merged from main but schema wasn't finalized, causing circular dependency with bulk-ingest module.

### Re-enabling Steps

When ready to implement:

1. Define `NewAgentMessage` type in `src/cloud/db/schema.ts`
2. Create database migration for `agent_messages` table
3. Uncomment bulk-ingest imports in `src/cloud/db/index.ts`
4. Uncomment bulk usage in `src/cloud/api/daemons.ts`
5. Add integration tests
6. Create PR and merge

## Estimated Effort

- Schema design: 2 hours
- Database migration: 1 hour
- Testing: 3 hours
- **Total: ~6 hours**

## Trail

Trail ID: (to be created when work begins)

---

**Created:** 2026-01-10
**Last Updated:** 2026-01-10
**Owner:** Lead Agent
