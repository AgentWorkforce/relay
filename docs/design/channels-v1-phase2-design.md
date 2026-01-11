# Channels V1 Phase 2 - Advanced Features Design

**Author:** ChannelsFeatures Agent
**Date:** 2026-01-10
**Status:** Draft - Pending Review

## Overview

This document outlines the architecture and implementation approach for Channels V1 Phase 2 features (Tasks 5-10). These advanced features build on the core channel infrastructure established in Phase 1.

### Current Infrastructure Summary

Phase 1 provides:
- **Database Schema**: `channels`, `channelMembers`, `channelMessages`, `channelReadState` tables
- **Protocol**: `CHANNEL_JOIN/LEAVE/MESSAGE/INFO/MEMBERS/TYPING` envelope types
- **API**: Full CRUD for channels, members, messages with threading and pinning
- **Read State**: Unread tracking per user/channel

---

## Task 5: Full-Text Search in Channels and Messages

### Design Decision: PostgreSQL Full-Text Search (FTS)

**Choice:** Use PostgreSQL's built-in full-text search rather than external services.

**Reasoning:**
1. **Simplicity**: No additional infrastructure to manage
2. **Cost**: No external service costs (Algolia charges per search operation)
3. **Data Locality**: No data replication needed, queries stay in-database
4. **Performance**: PostgreSQL FTS is fast for our expected scale (< 1M messages)
5. **Real-time**: Index updates happen on INSERT, no sync lag

**Trade-offs:**
- Less sophisticated ranking than Algolia/Meilisearch
- Limited language-specific features (acceptable for our use case)
- May need migration to external search at very large scale

### Schema Changes

```sql
-- Add search vector column to messages
ALTER TABLE channel_messages
ADD COLUMN search_vector tsvector
GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce(sender_name, '')), 'B') ||
  setweight(to_tsvector('english', coalesce(body, '')), 'A')
) STORED;

-- Create GIN index for fast search
CREATE INDEX idx_channel_messages_search
ON channel_messages USING GIN(search_vector);

-- Composite index for channel-scoped search
CREATE INDEX idx_channel_messages_channel_search
ON channel_messages(channel_id)
INCLUDE (search_vector);
```

### API Endpoints

```
GET /api/workspaces/:workspaceId/search
  Query params:
    - q: search query (required)
    - scope: 'all' | 'channels' | 'messages' (default: 'all')
    - channelId: limit to specific channel
    - limit: max results (default: 20, max: 100)
    - offset: pagination offset

Response:
{
  "results": {
    "channels": [...],   // Matched channel names/descriptions
    "messages": [...]    // Matched message content
  },
  "meta": {
    "query": "...",
    "totalChannels": 5,
    "totalMessages": 42
  }
}
```

### Implementation Notes

- Use `ts_headline()` for search result snippets with highlighted matches
- Implement query normalization (lowercase, trim, escape special chars)
- Add prefix matching for autocomplete: `query:*`
- Rate limit: 30 searches/minute per user

---

## Task 6: Message Search and Filtering

### Filter Capabilities

Build on Task 5 search with additional filters:

```
GET /api/workspaces/:workspaceId/channels/:channelId/messages/search
  Query params:
    - q: text search query
    - from: filter by sender ID or name
    - fromType: 'user' | 'agent'
    - before: messages before timestamp
    - after: messages after timestamp
    - hasAttachment: boolean
    - isPinned: boolean
    - inThread: threadId (replies to specific message)
    - mentions: userId (messages mentioning user)
```

### Mention Tracking Enhancement

The `mentions` array column exists but needs indexing:

```sql
-- GIN index for array containment queries
CREATE INDEX idx_channel_messages_mentions
ON channel_messages USING GIN(mentions);
```

Query pattern:
```sql
SELECT * FROM channel_messages
WHERE mentions @> ARRAY['user-uuid']::text[];
```

### Advanced Filter UI Considerations

- Date range picker for before/after
- Sender autocomplete dropdown
- Toggle buttons for hasAttachment, isPinned
- "Jump to" functionality for search results

---

## Task 7: Channel Analytics and Activity Tracking

### Key Metrics

Based on usefulness for workspace admins:

| Metric | Description | Aggregation |
|--------|-------------|-------------|
| Message Count | Total messages in channel | Per day/week/month |
| Active Members | Members who sent ≥1 message | Per day/week |
| Peak Hours | When most activity occurs | Hourly buckets |
| Thread Engagement | Reply rate on threads | Percentage |
| Top Contributors | Most active senders | By message count |
| Response Time | Time to first reply in threads | Median/avg |

### Schema Changes

```sql
-- Hourly aggregated stats (materialized for performance)
CREATE TABLE channel_stats_hourly (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  hour_bucket TIMESTAMP NOT NULL,  -- Truncated to hour
  message_count INTEGER NOT NULL DEFAULT 0,
  unique_senders INTEGER NOT NULL DEFAULT 0,
  thread_count INTEGER NOT NULL DEFAULT 0,
  reply_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(channel_id, hour_bucket)
);

CREATE INDEX idx_channel_stats_hourly_channel
ON channel_stats_hourly(channel_id, hour_bucket DESC);

-- Daily rollup for long-term trends
CREATE TABLE channel_stats_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  unique_senders INTEGER NOT NULL DEFAULT 0,
  peak_hour SMALLINT,  -- 0-23
  thread_count INTEGER NOT NULL DEFAULT 0,
  avg_thread_replies DECIMAL(5,2),
  UNIQUE(channel_id, date)
);
```

### Analytics Collection Strategy

**Choice:** Async background job aggregation (not real-time triggers)

**Reasoning:**
- Message INSERT should stay fast
- Hourly aggregation is sufficient for analytics use case
- Reduces database load during high activity

**Implementation:**
- Cron job runs every hour to aggregate previous hour's stats
- Daily job rolls up hourly stats into daily table
- Keep 90 days of hourly data, indefinite daily data

### API Endpoints

```
GET /api/workspaces/:workspaceId/channels/:channelId/analytics
  Query params:
    - period: 'day' | 'week' | 'month' | 'quarter'
    - metric: 'messages' | 'members' | 'engagement'

GET /api/workspaces/:workspaceId/analytics/overview
  (Aggregated stats across all channels)
```

---

## Task 8: Notification System for Mentions and Replies

### Notification Events

| Event Type | Trigger | Recipients |
|------------|---------|------------|
| `mention` | @user in message | Mentioned user(s) |
| `reply` | Reply to your message | Original message sender |
| `channel_invite` | Added to private channel | Invited user |
| `thread_activity` | Activity in thread you're in | Thread participants |

### Design Decision: WebSocket + Database Persistence

**Choice:** Hybrid approach - real-time WebSocket delivery with database fallback

**Reasoning:**
1. WebSocket provides instant delivery when user is online
2. Database persistence ensures no missed notifications when offline
3. Enables notification history and mark-as-read functionality

### Schema Changes

```sql
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,  -- mention, reply, channel_invite, thread_activity
  -- Source reference
  channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
  message_id UUID REFERENCES channel_messages(id) ON DELETE CASCADE,
  -- Content
  title VARCHAR(255) NOT NULL,
  body TEXT,
  actor_id UUID,  -- Who triggered this notification
  actor_name VARCHAR(255),
  -- State
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  read_at TIMESTAMP,
  is_dismissed BOOLEAN NOT NULL DEFAULT FALSE,
  -- Timestamps
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_user_unread
ON notifications(user_id, is_read, created_at DESC)
WHERE is_read = FALSE;

-- User preferences
CREATE TABLE notification_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Global settings
  mentions_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  replies_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  thread_activity_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  -- Per-channel overrides (JSONB for flexibility)
  channel_overrides JSONB DEFAULT '{}',
  -- Delivery preferences
  email_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  email_digest_frequency VARCHAR(20) DEFAULT 'never',  -- never, daily, weekly
  -- Quiet hours
  quiet_hours_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  quiet_hours_start TIME,
  quiet_hours_end TIME,
  quiet_hours_timezone VARCHAR(50) DEFAULT 'UTC',
  UNIQUE(user_id)
);
```

### Delivery Flow

```
Message with @mention created
        ↓
[Message INSERT trigger / app layer]
        ↓
Create notification record in DB
        ↓
Push to WebSocket if user connected
        ↓
If offline, notification waits in DB
        ↓
On reconnect, client fetches unread notifications
```

### API Endpoints

```
GET  /api/notifications
GET  /api/notifications/unread/count
POST /api/notifications/:id/read
POST /api/notifications/read-all
GET  /api/notifications/preferences
PUT  /api/notifications/preferences
```

### WebSocket Events

```typescript
// Server -> Client
{
  type: 'NOTIFICATION',
  payload: {
    id: 'uuid',
    type: 'mention',
    title: 'Alice mentioned you in #general',
    body: '...check out this @you implementation...',
    channelId: 'uuid',
    messageId: 'uuid',
    createdAt: '2026-01-10T12:00:00Z'
  }
}
```

---

## Task 9: Message Reactions and Emojis

### Design Decision: Simple Emoji Picker with Standard Set

**Choice:** Curated emoji set (not full Unicode) with custom reaction support

**Reasoning:**
1. Standard reactions cover 95% of use cases: 👍 👎 ❤️ 😄 🎉 👀 🚀 💯
2. Reduces UI complexity (no massive emoji picker)
3. Consistent rendering across platforms
4. Fast: small set enables efficient counting/display

### Schema Changes

```sql
CREATE TABLE message_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji VARCHAR(20) NOT NULL,  -- Emoji character or shortcode
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(message_id, user_id, emoji)  -- One reaction per emoji per user
);

CREATE INDEX idx_message_reactions_message
ON message_reactions(message_id);

-- For "who reacted" queries
CREATE INDEX idx_message_reactions_message_emoji
ON message_reactions(message_id, emoji);
```

### API Endpoints

```
POST   /api/workspaces/:workspaceId/channels/:channelId/messages/:messageId/reactions
  Body: { "emoji": "👍" }

DELETE /api/workspaces/:workspaceId/channels/:channelId/messages/:messageId/reactions/:emoji

GET    /api/workspaces/:workspaceId/channels/:channelId/messages/:messageId/reactions
  Response: {
    "reactions": {
      "👍": { "count": 5, "users": ["alice", "bob", ...], "hasReacted": true },
      "🎉": { "count": 2, "users": [...], "hasReacted": false }
    }
  }
```

### Message Response Enhancement

When fetching messages, include reaction summary:

```typescript
{
  id: 'uuid',
  content: '...',
  reactions: {
    '👍': { count: 5, hasReacted: true },
    '🎉': { count: 2, hasReacted: false }
  }
}
```

### Standard Emoji Set

```typescript
const STANDARD_REACTIONS = [
  { emoji: '👍', shortcode: '+1', name: 'thumbs up' },
  { emoji: '👎', shortcode: '-1', name: 'thumbs down' },
  { emoji: '❤️', shortcode: 'heart', name: 'heart' },
  { emoji: '😄', shortcode: 'smile', name: 'smile' },
  { emoji: '🎉', shortcode: 'tada', name: 'party' },
  { emoji: '👀', shortcode: 'eyes', name: 'eyes' },
  { emoji: '🚀', shortcode: 'rocket', name: 'rocket' },
  { emoji: '💯', shortcode: '100', name: 'hundred' },
  { emoji: '🤔', shortcode: 'thinking', name: 'thinking' },
  { emoji: '👏', shortcode: 'clap', name: 'clap' },
];
```

---

## Task 10: Admin Dashboard for Channel Analytics

### Design Decision: Self-Serve Dashboard within Existing React App

**Choice:** Integrate analytics views into existing dashboard, not a separate admin portal

**Reasoning:**
1. Reduces development effort (reuse existing components)
2. Consistent UX for users
3. Role-based access control already exists
4. No additional deployment/hosting

### Dashboard Views

#### 1. Workspace Analytics Overview
- Total messages this period
- Active channels
- Active users
- Message volume trend chart

#### 2. Channel Analytics Detail
- Message volume over time
- Peak activity hours heatmap
- Top contributors list
- Thread engagement metrics
- Member growth chart

#### 3. Member Analytics
- Active vs. inactive members
- Message distribution
- Response patterns

### Component Structure

```
src/dashboard/react-components/
├── analytics/
│   ├── WorkspaceAnalytics.tsx       # Overview dashboard
│   ├── ChannelAnalytics.tsx         # Per-channel detail
│   ├── charts/
│   │   ├── MessageVolumeChart.tsx   # Line chart
│   │   ├── ActivityHeatmap.tsx      # Hour/day heatmap
│   │   ├── TopContributors.tsx      # Bar chart
│   │   └── EngagementMetrics.tsx    # Stats cards
│   └── hooks/
│       └── useChannelAnalytics.ts   # Data fetching
```

### Access Control

- Workspace owners: Full analytics access
- Workspace admins: Full analytics access
- Channel admins: Analytics for their channels only
- Members: No analytics access (could add opt-in later)

---

## Implementation Dependencies

```
Task 5 (Search) ─────────────────────────────────────┐
                                                      │
Task 6 (Filtering) ──── depends on Task 5 ───────────┤
                                                      │
Task 7 (Analytics) ──────────────────────────────────┤
                                                      │
Task 8 (Notifications) ──────────────────────────────┤
                                                      │
Task 9 (Reactions) ──────────────────────────────────┤
                                                      │
Task 10 (Dashboard) ──── depends on Task 7 ──────────┘
```

**Recommended Implementation Order:**
1. Task 5 (Search) - Foundation for Task 6
2. Task 9 (Reactions) - Independent, quick win
3. Task 7 (Analytics) - Foundation for Task 10
4. Task 8 (Notifications) - Independent
5. Task 6 (Filtering) - Builds on Task 5
6. Task 10 (Dashboard) - Builds on Task 7

---

## Migration Strategy

All schema changes use `IF NOT EXISTS` for idempotency:

```sql
ALTER TABLE channel_messages
ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE INDEX IF NOT EXISTS idx_channel_messages_search
ON channel_messages USING GIN(search_vector);
```

New tables are additive and don't affect existing functionality.

---

## Questions for Lead Review

1. **Search Scale**: Is 1M messages a reasonable ceiling estimate? If we expect 10M+, should we reconsider external search?

2. **Analytics Retention**: Is 90 days hourly + indefinite daily appropriate, or should we adjust?

3. **Notification Delivery**: Should we add push notifications (web push API) in addition to WebSocket?

4. **Reaction Extensibility**: Should we allow workspace-defined custom reactions beyond the standard set?

5. **Dashboard Access**: Should we expose read-only analytics to regular members for their own activity?

---

## Summary of Architecture Decisions

| Area | Decision | Rationale |
|------|----------|-----------|
| Search | PostgreSQL FTS | Simplicity, cost, real-time indexing |
| Analytics | Background aggregation | Performance, sufficient freshness |
| Notifications | WebSocket + DB | Real-time + offline support |
| Reactions | Curated emoji set | UX simplicity, performance |
| Dashboard | Integrated views | Code reuse, consistent UX |

---

*Document ready for Lead review. Will update based on feedback before implementation begins.*
