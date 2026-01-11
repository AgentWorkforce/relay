# Channels V1 Phase 2 - Task Dependencies

**Author:** ChannelsFeatures Agent
**Date:** 2026-01-10
**Related:** [Phase 2 Design Document](./channels-v1-phase2-design.md)

## Task Dependency Graph

```
Task 5 (Search) ─────────────────────────┐
       │                                  │
       ▼                                  │
Task 6 (Filtering) ──────────────────────┤
                                          │
Task 7 (Analytics) ──────────────────────┼──► Task 10 (Dashboard)
                                          │
Task 8 (Notifications) ──────────────────┤
                                          │
Task 9 (Reactions) ──────────────────────┘
```

## Dependency Details

### Task 5: Full-Text Search
**Dependencies:** None (foundation task)
**Blocks:** Task 6

| Dependency | Type | Reason |
|------------|------|--------|
| Phase 1 `channelMessages` table | Hard | Search indexes built on existing message table |

**Schema Changes Required:**
- Add `search_vector` column to `channel_messages`
- Create GIN index for full-text search

---

### Task 6: Message Search and Filtering
**Dependencies:** Task 5
**Blocks:** None

| Dependency | Type | Reason |
|------------|------|--------|
| Task 5 search infrastructure | Hard | Filtering extends search with additional parameters |
| `mentions` array column | Soft | Already exists, just needs GIN index |

**Why Task 5 First:**
- Filter API builds on search API (`/search?q=...&from=...&after=...`)
- Reuses `ts_query` infrastructure from Task 5
- UI components share search result rendering

---

### Task 7: Channel Analytics
**Dependencies:** None (independent track)
**Blocks:** Task 10

| Dependency | Type | Reason |
|------------|------|--------|
| Existing `channelMessages` table | Hard | Analytics aggregates message data |
| Background job infrastructure | Soft | Uses existing cron/job system or adds new |

**Schema Changes Required:**
- New `channel_stats_hourly` table
- New `channel_stats_daily` table
- Aggregation cron job

---

### Task 8: Notification System
**Dependencies:** None (independent track)
**Blocks:** None

| Dependency | Type | Reason |
|------------|------|--------|
| WebSocket infrastructure | Hard | Real-time notification delivery |
| `mentions` parsing in messages | Soft | Triggers mention notifications |
| User preferences | Internal | Part of Task 8 itself |

**Schema Changes Required:**
- New `notifications` table
- New `notification_preferences` table
- WebSocket event handlers

**Note:** Task 8 enhances Task 6's mention filtering but doesn't block it.

---

### Task 9: Message Reactions
**Dependencies:** None (independent track)
**Blocks:** None

| Dependency | Type | Reason |
|------------|------|--------|
| Existing `channelMessages` table | Hard | Reactions reference messages |

**Schema Changes Required:**
- New `message_reactions` table
- Message response enrichment

**Parallelization Note:** Task 9 is fully independent and can be implemented in parallel with Tasks 5-8.

---

### Task 10: Admin Dashboard
**Dependencies:** Task 7
**Blocks:** None

| Dependency | Type | Reason |
|------------|------|--------|
| Task 7 analytics tables | Hard | Dashboard displays analytics data |
| Task 7 aggregation jobs | Hard | Data must exist to display |
| Existing React dashboard | Soft | Extends existing component structure |

**Why Task 7 First:**
- Dashboard is pure UI over analytics data
- Without aggregated stats, dashboard shows empty charts
- API endpoints from Task 7 power dashboard components

---

## Approved Implementation Order

```
Week N:   Task 5 (Search)        ─┐
Week N+1: Task 7 (Analytics)      ├─ Can overlap
Week N+1: Task 9 (Reactions)     ─┘
Week N+2: Task 8 (Notifications)
Week N+3: Task 6 (Filtering)      ── Needs Task 5 complete
Week N+4: Task 10 (Dashboard)     ── Needs Task 7 complete
```

## Parallel Development Opportunities

**Safe to parallelize:**
- Task 5 + Task 7 + Task 9 (all independent)
- Task 8 can start while Task 5 in progress

**Must be sequential:**
- Task 5 → Task 6 (filtering extends search)
- Task 7 → Task 10 (dashboard needs analytics data)

## Database Migration Order

Migrations should be applied in this order to avoid conflicts:

1. **Task 5 migration:** Add search_vector to channel_messages
2. **Task 7 migration:** Create channel_stats_hourly, channel_stats_daily
3. **Task 8 migration:** Create notifications, notification_preferences
4. **Task 9 migration:** Create message_reactions

All migrations are additive (new columns/tables) and do not conflict.

## API Endpoint Dependencies

| Endpoint | Task | Depends On |
|----------|------|------------|
| `GET /search` | 5 | - |
| `GET /messages/search` | 6 | Task 5 `/search` |
| `GET /analytics` | 7 | - |
| `GET /analytics/overview` | 7 | - |
| `GET /notifications` | 8 | - |
| `POST /notifications/preferences` | 8 | - |
| `POST /messages/:id/reactions` | 9 | - |
| `GET /admin/analytics/*` | 10 | Task 7 analytics |

## Risk Mitigation

**Risk:** Task 5 delays block Task 6
**Mitigation:** Task 6 UI can be built with mock data while Task 5 API completes

**Risk:** Task 7 delays block Task 10
**Mitigation:** Dashboard skeleton/layout can be built while analytics jobs run

**Risk:** Schema migrations conflict
**Mitigation:** All migrations are additive, reviewed before merge, use IF NOT EXISTS

---

*Document created for implementation planning. Update as dependencies change.*
