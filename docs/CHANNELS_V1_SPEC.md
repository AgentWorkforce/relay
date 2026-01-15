# Channels V1 Specification

## Overview

Channels are named persistent groups for team communication. Unlike direct messages (1:1 or small informal groups), channels are larger, discoverable, navigable spaces with both humans and agents as members.

## V1 Scope

**Included:**
- Create, join, leave channels
- Named groups with optional descriptions and topics
- Sidebar navigation (show member channels only, alphabetical)
- Command palette (show all channels, searchable)
- Browse channels view (discover public channels)
- Messages with threads and pinning support
- Unread count badges
- Archivable channels
- Admin-only member removal and channel deletion

**Not Included (V2):**
- Channel bots/automations
- Private channels (public only in V1)
- Channel muting
- Advanced permissions (all admins have same permissions)
- Channel permissions per user
- Scheduled messages or workflows

## Data Model

### Channel Entity
```typescript
interface Channel {
  id: string (UUID)
  name: string (required, unique, lowercase, alphanumeric+dash)
  description?: string (optional, <500 chars)
  topic?: string (optional, <200 chars, appears in sidebar)
  created_at: number (unix ms)
  created_by: string (user_id)
  archived_at?: number (unix ms, null if active)
  member_count: number
  unread_count: number (per user)
  last_message_at?: number (unix ms)
}

// Example
{
  id: "ch_a1b2c3d4",
  name: "engineering",
  description: "Engineering team discussions and updates",
  topic: "Building great software",
  created_at: 1704067200000,
  created_by: "user_khaliqgant",
  member_count: 12,
  last_message_at: 1704153600000
}
```

### Channel Member Entity
```typescript
interface ChannelMember {
  channel_id: string
  user_or_agent_id: string (user ID or agent ID)
  member_type: 'human' | 'agent'
  joined_at: number (unix ms)
  is_admin?: boolean (default false, admins can remove members)
}
```

### Channel Message Entity
```typescript
interface ChannelMessage {
  id: string (UUID)
  channel_id: string
  user_id: string
  content: string
  created_at: number (unix ms)
  thread_id?: string (null if top-level, UUID if in thread)
  pinned_at?: number (null if not pinned, unix ms if pinned)
  pinned_by?: string (user_id who pinned)
  edited_at?: number (null if not edited)
  edited_by?: string (user_id who edited)
}
```

## API Design

### Channel Management

**Create Channel**
```
POST /api/channels
Body: {
  name: string (required, 1-80 chars, lowercase alphanumeric+dash)
  description?: string (optional, <500 chars)
  topic?: string (optional, <200 chars)
}
Response: {
  id: string
  name: string
  description?: string
  topic?: string
  created_at: number
  created_by: string
  member_count: 1
}

Permissions: Any user (except read-only members)
Errors:
  - 400: Invalid name format
  - 409: Channel name already exists
  - 403: User is read-only member
```

**Get Channel Details**
```
GET /api/channels/{channel_id}
Response: {
  id: string
  name: string
  description?: string
  topic?: string
  created_at: number
  created_by: string
  archived_at?: number
  member_count: number
  unread_count: number (for current user)
  last_message_at?: number
}

Permissions: Must be channel member
```

**List All Channels**
```
GET /api/channels?search=&sort=alphabetical&limit=100&offset=0
Query params:
  - search?: string (search name and description)
  - sort?: 'alphabetical' | 'recent' | 'activity' (default: alphabetical)
  - limit?: number (default: 100)
  - offset?: number (default: 0)

Response: {
  channels: Channel[]
  total: number
  has_more: boolean
}

Permissions: Any authenticated user (returns all public channels)
```

**List Member Channels**
```
GET /api/user/channels?sort=alphabetical
Response: Channel[] (only channels user is member of)

Permissions: Authenticated user (self only)
```

**Archive Channel**
```
POST /api/channels/{channel_id}/archive
Response: {
  id: string
  archived_at: number
}

Permissions: Admin only
Notes: Channel becomes read-only, stays in sidebar but marked as archived
```

**Delete Channel**
```
DELETE /api/channels/{channel_id}
Response: {success: true}

Permissions: Admin only
Notes: Deletes all messages and members. Irreversible.
```

**Update Channel**
```
PATCH /api/channels/{channel_id}
Body: {
  description?: string
  topic?: string
}
Response: Channel

Permissions: Admin only
```

### Channel Membership

**Join Channel**
```
POST /api/channels/{channel_id}/join
Response: {
  channel_id: string
  joined_at: number
}

Permissions: Any authenticated user
Errors:
  - 404: Channel not found or archived
  - 409: Already a member
```

**Leave Channel**
```
POST /api/channels/{channel_id}/leave
Response: {success: true}

Permissions: Self only (user can always leave)
```

**Get Channel Members**
```
GET /api/channels/{channel_id}/members?limit=100&offset=0
Response: {
  members: ChannelMember[]
  total: number
}

Permissions: Channel member
```

**Remove Member**
```
POST /api/channels/{channel_id}/members/{user_id}/remove
Response: {success: true}

Permissions: Admin only
```

**Add Agent to Channel** (Manual Assignment)
```
POST /api/channels/{channel_id}/members
Body: {
  user_or_agent_id: string (agent ID)
  member_type: 'agent'
}
Response: ChannelMember

Permissions: Admin only
Notes: Agents must be manually assigned by admins
```

### Channel Messages

**Post Message**
```
POST /api/channels/{channel_id}/messages
Body: {
  content: string (required)
  thread_id?: string (optional, for thread replies)
}
Response: ChannelMessage

Permissions: Channel member
```

**Get Messages**
```
GET /api/channels/{channel_id}/messages?limit=50&offset=0&unread=false
Query params:
  - limit: number (default: 50)
  - offset: number (default: 0)
  - unread: boolean (if true, only unread messages)

Response: ChannelMessage[]

Permissions: Channel member
```

**Get Thread**
```
GET /api/channels/{channel_id}/messages/{thread_id}/thread
Response: {
  parent: ChannelMessage
  replies: ChannelMessage[]
}

Permissions: Channel member
```

**Pin Message**
```
POST /api/channels/{channel_id}/messages/{message_id}/pin
Response: ChannelMessage (with pinned_at and pinned_by)

Permissions: Message author or admin
```

**Unpin Message**
```
POST /api/channels/{channel_id}/messages/{message_id}/unpin
Response: ChannelMessage (pinned_at: null)

Permissions: Message author or admin
```

**Mark as Read**
```
POST /api/channels/{channel_id}/read
Body: {
  last_read_message_id: string
}
Response: {success: true}

Permissions: Self only
```

## UI Components

### Sidebar

**Channel Section:**
```
Channels
├─ [+] Create Channel (button)
├─ 🔍 Search Channels (input, expands to browse view)
├─ engineering (unread: 3)
├─ product
├─ random
└─ archived (collapsed section)
    └─ old-project (archived)
```

**Features:**
- Show only member channels
- Display unread count badge
- Sort alphabetically (with sort dropdown: alphabetical/recent/custom)
- Create button at top
- Search expands to browse view
- Archived channels in separate collapsed section

### Channel Header

```
┌─────────────────────────────────────────┐
│ # engineering                    [⋮]     │
│ Building great software                 │
│ 12 members • Last active 2h ago         │
└─────────────────────────────────────────┘
```

**Menu (⋮) Options:**
- Archive channel (admin only)
- Delete channel (admin only)
- Members & permissions (admin only)
- Mute channel (V2)
- Leave channel
- Copy channel link
- Channel settings

### Channel View

```
┌────────────────────────────────────────┐
│ Messages (with threads, pinning):      │
│                                        │
│ 2:30 PM alice: "What's for lunch?"    │
│ 2:31 PM bob: (in thread)              │
│ 2:32 PM alice: "Pizza?"               │
│ [pinned icon] alice: "Decisions"      │
│                                        │
│ Message input box at bottom            │
└────────────────────────────────────────┘
```

**Features:**
- Messages like DM view (threads, pinning)
- Unread separator line
- Pinned messages accessible
- Thread view (click to expand)
- Message input always visible

### Browse Channels View

```
┌──────────────────────────────────────┐
│ 🔍 Search channels...                │
│                                      │
│ engineering (12 members)             │
│ Building great software              │
│ [Join]                               │
│                                      │
│ product (8 members)                  │
│ Product roadmap and updates          │
│ [Join]                               │
│                                      │
│ random (45 members)                  │
│ Off-topic discussions                │
│ [Join]                               │
│                                      │
│ design (3 members)                   │
│ Design system and UI                 │
│ [Join]                               │
└──────────────────────────────────────┘
```

**Features:**
- Searchable list of all public channels
- Show member count
- Show description
- Join button (if not member)
- Sort options

### Command Palette Integration

**Commands:**
```
/create-channel [name] [description?]
  → Creates new channel
  → Example: /create-channel engineering Building great software

/join-channel [name]
  → Joins existing channel
  → Example: /join-channel product

/leave-channel [name]
  → Leaves channel
  → Example: /leave-channel random

/channels
  → List all channels (opens browse view)
  → Nested: type name to search

/channels search [query]
  → Search channels by name or description
```

## Sidebar Sorting

**Sort Options:**
1. **Alphabetical** (default)
   - A-Z by channel name
   - Unread channels don't float to top

2. **Recent** (V1 optional, V2 recommended)
   - Most recently active first
   - Based on last_message_at

3. **Custom** (V1 optional, V2 recommended)
   - User manually reorders via drag-drop
   - Persisted in user preferences

**Implementation Path:**
- V1: Alphabetical only
- V2: Add recent and custom sorting

## Unread Handling

**Unread State:**
- New channels default to all messages as "unread"
- User joins channel → all prior messages marked "read"
- Each new message → increments unread_count
- User opens channel → scroll to first unread
- Mark as read when user reads messages (auto or manual)

**Unread Badge:**
```
engineering (3)  ← Shows 3 unread messages
```

**Unread Separator:**
```
[Previous messages]
─────── Unread ───────
[New messages]
```

## Archiving

**Archive Behavior:**
- Channel becomes read-only
- Members can still view history
- Channel stays in sidebar (marked as archived)
- Collapsed "Archived" section
- Can unarchive (restore) if needed

**Archive API:**
```
POST /api/channels/{channel_id}/archive
POST /api/channels/{channel_id}/unarchive
```

## Implementation Phases

### Phase 1: Core Channel Management
- [ ] Database schema (channels, channel_members, channel_messages)
- [ ] Channel CRUD APIs
- [ ] Member join/leave
- [ ] Sidebar UI component
- [ ] Channel header and view
- [ ] Basic message posting and display

**Deliverable:** Can create, join, view channels with messages

### Phase 2: Advanced Features
- [ ] Threading support
- [ ] Pinning messages
- [ ] Browse channels view
- [ ] Unread count tracking
- [ ] Command palette integration
- [ ] Archive/unarchive

**Deliverable:** Full featured channels with threads, pinning, discovery

### Phase 3: Polish & Performance
- [ ] Search across channels
- [ ] Sort options (recent, custom)
- [ ] Message pagination and loading
- [ ] Channel member list UI
- [ ] Admin tools (remove members, settings)
- [ ] Permissions enforcement

**Deliverable:** Production-ready channels

## Database Schema

### Channels Table
```sql
CREATE TABLE channels (
  id UUID PRIMARY KEY,
  name VARCHAR(80) UNIQUE NOT NULL,
  description VARCHAR(500),
  topic VARCHAR(200),
  created_at BIGINT NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  archived_at BIGINT,
  UNIQUE(name_lower) -- for case-insensitive lookup
);

CREATE INDEX idx_channels_created_by ON channels(created_by);
CREATE INDEX idx_channels_archived_at ON channels(archived_at);
```

### Channel Members Table
```sql
CREATE TABLE channel_members (
  id UUID PRIMARY KEY,
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_or_agent_id VARCHAR(255) NOT NULL,
  member_type VARCHAR(20) NOT NULL, -- 'human' or 'agent'
  joined_at BIGINT NOT NULL,
  is_admin BOOLEAN DEFAULT FALSE,
  UNIQUE(channel_id, user_or_agent_id)
);

CREATE INDEX idx_channel_members_channel_id ON channel_members(channel_id);
CREATE INDEX idx_channel_members_user_id ON channel_members(user_or_agent_id);
```

### Channel Messages Table
```sql
CREATE TABLE channel_messages (
  id UUID PRIMARY KEY,
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  thread_id UUID, -- NULL for top-level, UUID for thread reply
  pinned_at BIGINT,
  pinned_by UUID,
  edited_at BIGINT,
  edited_by UUID,
  FOREIGN KEY(thread_id) REFERENCES channel_messages(id) ON DELETE CASCADE
);

CREATE INDEX idx_channel_messages_channel_id ON channel_messages(channel_id);
CREATE INDEX idx_channel_messages_thread_id ON channel_messages(thread_id);
CREATE INDEX idx_channel_messages_created_at ON channel_messages(created_at);
CREATE INDEX idx_channel_messages_pinned_at ON channel_messages(pinned_at);
```

### Unread Messages Table (for tracking read state)
```sql
CREATE TABLE channel_read_state (
  id UUID PRIMARY KEY,
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  last_read_message_id UUID REFERENCES channel_messages(id),
  last_read_at BIGINT,
  UNIQUE(channel_id, user_id)
);

CREATE INDEX idx_channel_read_state_user_id ON channel_read_state(user_id);
```

## Permissions Matrix

| Action | Admin | Regular User | Read-Only User | Agent |
|--------|-------|--------------|----------------|-------|
| Create channel | ✅ | ✅ | ❌ | ❌ |
| Join channel | ✅ | ✅ | ✅ | ❌ (manual assign) |
| Leave channel | ✅ | ✅ | ✅ | ❌ (admin removes) |
| Post message | ✅ | ✅ | ❌ | ✅ (if member) |
| Pin message | ✅ | Own only | ❌ | ✅ (own only) |
| Remove member | ✅ | ❌ | ❌ | ❌ |
| Delete channel | ✅ | ❌ | ❌ | ❌ |
| Archive channel | ✅ | ❌ | ❌ | ❌ |
| View members | ✅ | ✅ | ✅ | ✅ |

## Success Criteria

- [ ] Users can create channels with name and optional description
- [ ] Users can discover and join public channels
- [ ] Channels display in sidebar (member channels only, alphabetical)
- [ ] Users can post messages and create threads
- [ ] Messages can be pinned/unpinned
- [ ] Unread counts tracked accurately
- [ ] Command palette supports create/join/search
- [ ] Browse channels view shows all public channels
- [ ] Channels can be archived (read-only)
- [ ] Agents can be manually assigned to channels
- [ ] Admin can remove members and delete channels
- [ ] Performance: <200ms to load channel view
- [ ] Performance: <100ms to post message

## Security Considerations

- **Access Control:** Verify user is channel member before returning messages
- **Admin Check:** Verify user is admin before allowing removal/deletion
- **Read-Only:** Prevent read-only users from creating channels or posting
- **Agent Assignment:** Only admins can assign agents (prevent unauthorized bot creation)
- **Message Ownership:** Only message author or admin can pin/edit/delete
- **Channel Naming:** Validate name format (lowercase alphanumeric + dash)

## Future Enhancements (V2+)

- Channel bots/automations
- Private channels
- Channel muting
- Advanced member permissions (moderator, view-only roles)
- Channel webhooks/integrations
- Scheduled messages
- Message reactions and emoji
- Channel search and filters
- Message formatting (markdown, code blocks)
- File uploads to channels
- Custom channel categories/groups
- Channel invites (email, link)

## References

- DM Routing Task: agent-relay-5604a0da (completed)
- Progress Tracker Proposal: agent-relay-90a06291 (PR #102)
