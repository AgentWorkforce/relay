# Task 4: Channel Messages API - Complete Specification

## Overview

Task 4 is the **critical path blocker** for Channels V1 integration. This task requires implementing the Messages API routes that expose the already-implemented database layer to the frontend.

**Status:** ChannelsBackend has completed all database queries and types. This task requires adding the Express routes.

**Estimated Time:** 2-3 hours

**Dependencies:** None (database layer is complete)

**Blocks:** ChannelsUI and ChannelsFeatures integration testing

## Current State

### ✅ Already Complete
- `src/cloud/db/schema.ts` - Full schema with 4 tables
- `src/cloud/db/migrations/0012_nervous_thundra.sql` - Migration file
- `src/cloud/db/drizzle.ts` - All database queries (lines 1832+):
  - `channelMessageQueries.findById()`
  - `channelMessageQueries.findByChannelId()`
  - `channelMessageQueries.findPinned()`
  - `channelMessageQueries.findThread()`
  - `channelMessageQueries.create()`
  - `channelMessageQueries.update()`
  - `channelMessageQueries.pin()`
  - `channelMessageQueries.unpin()`
- `src/cloud/api/channels.ts` - Channel CRUD and membership APIs (lines 1-782)

### ❌ Need to Add
- Messages API routes (5 endpoint families)
- Schema migration for `topic` and `lastActivityAt` columns
- Response mapping layer for type conversions
- Integration with channel read state tracking

## API Endpoints to Implement

All endpoints should be added to `src/cloud/api/channels.ts` and use the existing channelsRouter.

### 1. GET /api/workspaces/:workspaceId/channels/:channelId/messages

**Purpose:** Fetch messages in a channel with pagination support.

**Request Parameters:**
```typescript
{
  before?: string;   // Message ID cursor for pagination (load messages before this ID)
  limit?: number;    // Number of messages to return (default 50, max 200)
  threadId?: string; // If provided, only fetch replies to this thread
}
```

**Response:**
```typescript
interface GetMessagesResponse {
  messages: Array<{
    id: string;
    channelId: string;
    from: string;              // Sender name
    fromEntityType: 'user' | 'agent';
    fromAvatarUrl?: string;
    content: string;
    timestamp: string;          // ISO 8601 timestamp
    editedAt?: string;
    threadId?: string;          // If this is a reply
    threadSummary?: {           // If this message has replies
      id: string;
      replyCount: number;
      participants: string[];
      lastReplyAt: string;
      lastReplyPreview?: string;
    };
    mentions?: string[];
    isPinned?: boolean;
    isRead: boolean;
  }>;
  hasMore: boolean;            // Whether there are more messages to load
  unread: {
    count: number;
    firstUnreadMessageId?: string;
    lastReadTimestamp?: string;
  };
}
```

**Logic:**
1. Verify user has access to workspace and channel
2. Check if private channel - verify user is member
3. Fetch messages using `db.channelMessages.findByChannelId()` with pagination
4. If threadId provided, fetch thread replies instead
5. **IMPORTANT:** Map response fields:
   - `sender_name` (DB) → `from` (API)
   - `sender_type` (DB) → `fromEntityType` (API)
   - `body` (DB) → `content` (API)
   - `created_at` (DB) → `timestamp` (API)
6. Include unread state from `channel_read_state` table
7. Return messages in chronological order (oldest first in response, but reverse in UI)

**Example Query:**
```bash
curl "http://localhost:3000/api/workspaces/ws-123/channels/ch-456/messages?limit=50&before=msg-100"
```

---

### 2. POST /api/workspaces/:workspaceId/channels/:channelId/messages

**Purpose:** Send a new message to a channel.

**Request Body:**
```typescript
{
  content: string;            // Message text (required)
  threadId?: string;          // If replying in a thread
  attachmentIds?: string[];   // Not required for Phase 1
}
```

**Response:**
```typescript
{
  message: {
    id: string;
    channelId: string;
    from: string;
    fromEntityType: 'user' | 'agent';
    content: string;
    timestamp: string;
    threadId?: string;
    isRead: boolean;
  }
}
```

**Logic:**
1. Verify user has access and can post (check membership role)
2. Validate content is not empty
3. Create new message using `db.channelMessages.create()`:
   ```typescript
   {
     channelId,
     senderId: userId,
     senderType: 'user',
     senderName: user.githubUsername,
     body: request.content,
     threadId: request.threadId,
     replyCount: 0,
     isPinned: false,
     createdAt: new Date(),
   }
   ```
4. If threadId provided:
   - Increment parent message's replyCount
   - Fetch parent to include in response threadSummary
5. **IMPORTANT:** Update channel's `lastActivityAt`:
   ```typescript
   await db.channels.update(channelId, { lastActivityAt: new Date() })
   ```
6. Update read state (mark as read for current user)
7. Return mapped message

**Example Request:**
```bash
curl -X POST "http://localhost:3000/api/workspaces/ws-123/channels/ch-456/messages" \
  -H "Content-Type: application/json" \
  -d '{"content": "Hello everyone!"}'
```

---

### 3. POST /api/workspaces/:workspaceId/channels/:channelId/read

**Purpose:** Mark messages as read up to a specific timestamp.

**Request Body:**
```typescript
{
  upToTimestamp: string;  // ISO 8601 timestamp - mark all messages before this as read
}
```

**Response:**
```typescript
{
  success: boolean;
  readCount: number;  // How many messages were marked as read
}
```

**Logic:**
1. Verify user has access to channel
2. Parse timestamp
3. Update or insert into `channel_read_state` table:
   ```typescript
   await db.channelReadState.upsert(
     channelId,
     userId,
     { lastReadAt: new Date(upToTimestamp) }
   )
   ```
4. Query to get unread count before marking:
   ```typescript
   SELECT COUNT(*) FROM channel_messages
   WHERE channel_id = :channelId
   AND created_at <= :timestamp
   AND is_read = false
   ```
5. Return success and count

---

### 4. POST /api/workspaces/:workspaceId/channels/:channelId/messages/:messageId/pin

**Purpose:** Pin a message to make it featured.

**Request Body:** (empty)

**Response:**
```typescript
{
  success: boolean;
  message: ChannelMessage;
}
```

**Logic:**
1. Verify user is channel admin
2. Fetch message to verify it exists in this channel
3. Call `db.channelMessages.pin(messageId, userId)`
4. Return pinned message with updated `isPinned: true`

---

### 5. POST /api/workspaces/:workspaceId/channels/:channelId/messages/:messageId/unpin

**Purpose:** Unpin a message.

**Request Body:** (empty)

**Response:**
```typescript
{
  success: boolean;
}
```

**Logic:**
1. Verify user is channel admin
2. Call `db.channelMessages.unpin(messageId)`
3. Return success

---

### 6. GET /api/workspaces/:workspaceId/channels/:channelId/messages/pinned

**Purpose:** Get all pinned messages in a channel.

**Response:**
```typescript
{
  messages: ChannelMessage[];
}
```

**Logic:**
1. Verify user has access
2. Fetch pinned messages: `db.channelMessages.findPinned(channelId)`
3. Map and return

---

## Type Mapping Rules (CRITICAL!)

When converting database responses to API responses, use these mappings:

### ChannelMessage Mapping
```typescript
// Database schema fields → Frontend API fields
{
  id: message.id,
  channelId: message.channelId,
  from: message.senderName,                    // ← senderName maps to 'from'
  fromEntityType: message.senderType,          // ← senderType stays same
  content: message.body,                        // ← body maps to 'content'
  timestamp: message.createdAt.toISOString(),  // ← createdAt maps to 'timestamp'
  editedAt: message.updatedAt?.toISOString(),
  threadId: message.threadId,
  isPinned: message.isPinned,
  isRead: true,  // TODO: Get from channel_read_state table
}
```

### Validation Helper
```typescript
function validateMessageResponse(msg: any): void {
  if (!msg.from || !msg.fromEntityType || !msg.content || !msg.timestamp) {
    throw new Error('Missing required message fields for API response');
  }
  // Verify field names match frontend expectations
  if (msg.senderName || msg.senderType || msg.body || msg.createdAt) {
    console.warn('Response still contains DB field names instead of API names');
  }
}
```

---

## Schema Migrations Needed

### Migration 1: Add topic column
```sql
ALTER TABLE channels ADD COLUMN IF NOT EXISTS topic VARCHAR(255);
```

### Migration 2: Add lastActivityAt column
```sql
ALTER TABLE channels ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP DEFAULT NOW();
```

**File:** `src/cloud/db/migrations/0013_add_channel_features.sql`

```sql
-- Add missing columns for Channels V1 Phase 1
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "topic" varchar(255);
--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "last_activity_at" timestamp DEFAULT now();
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_channels_last_activity" ON "channels" ("last_activity_at");
```

Then update `src/cloud/db/schema.ts` to include these columns in the Channel type:
```typescript
export const channels = pgTable('channels', {
  // ... existing fields ...
  topic: varchar('topic', { length: 255 }),
  lastActivityAt: timestamp('last_activity_at').defaultNow(),
  // ...
});
```

---

## Testing Checklist

Before submitting for review:

- [ ] GET /messages returns messages in correct order
- [ ] POST /messages creates message and updates channel.lastActivityAt
- [ ] POST /messages with threadId updates parent message.replyCount
- [ ] POST /read marks messages as read
- [ ] PIN/UNPIN endpoints work correctly
- [ ] Permission checks work (channel access, admin status)
- [ ] Response field mappings are correct (from, content, timestamp, etc.)
- [ ] Types compile without errors
- [ ] Tested with curl/Postman with real data
- [ ] Pagination works with beforeId cursor

---

## Integration with Frontend

Once this task is complete, the frontend teams will:

1. Replace `mockApi.ts` imports with real API calls
2. Update component state management to use real API responses
3. Test message loading, sending, threading, and read state
4. Verify all type contracts match

### Frontend Expectations (From types.ts)

The ChannelsUI team will expect:
- Messages in `ChannelMessage` format from type definitions
- Unread state tracking with `UnreadState` interface
- Thread summary for messages with replies
- Pin/unpin functionality
- Mark read functionality

### Known Frontend Compatibility
```typescript
// Frontend types.ts expects these fields:
interface ChannelMessage {
  id: string;              // ✅ DB has this
  channelId: string;       // ✅ DB has this
  from: string;            // ✅ Maps from senderName
  fromEntityType: EntityType;  // ✅ Maps from senderType
  content: string;         // ✅ Maps from body
  timestamp: string;       // ✅ Maps from createdAt
  threadId?: string;       // ✅ DB has this
  threadSummary?: ThreadSummary;  // ✅ Can construct from replyCount + find replies
  isPinned?: boolean;      // ✅ DB has this
  isRead: boolean;         // ⚠️  Need to query channel_read_state table
}
```

---

## Reference: Existing Code Structure

### How Channel CRUD Works (Example to follow)
See lines 86-125 in `src/cloud/api/channels.ts` for the pattern:
1. Get userId and workspaceId from request
2. Check permissions with `canViewWorkspace()` or `canManageChannels()`
3. Query using `db.channels` methods
4. Map response and send

### Database Query Pattern
See `src/cloud/db/drizzle.ts` line 1832+ for `channelMessageQueries` implementation.

All database methods are already implemented - just call them from the routes!

---

## Summary

**What you have:**
- Complete schema with 4 tables
- Complete database queries in drizzle.ts
- Complete type definitions

**What you need to add:**
- 5 new API route handlers
- Field mapping logic (senderName→from, body→content, etc.)
- Schema migration for topic/lastActivityAt
- Permission checks for message access
- Integration with channel_read_state table

**Estimated effort:** 2-3 hours

**Your mission:** Make those 5 routes production-ready so the UI teams can start integration testing!

