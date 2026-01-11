# Channels V1 API Reference

Quick reference for all 21 API endpoints implemented in Task 4.

## Base URL
```
/api/workspaces/{workspaceId}/channels
```

## Authentication
All endpoints require session authentication (`requireAuth` middleware).

---

## Channel CRUD (7 endpoints)

### List Channels
```http
GET /api/workspaces/:workspaceId/channels
Query Parameters:
  - includeArchived=true|false (optional)
Response:
  {
    channels: [{
      id: string
      name: string
      description: string | null
      isPrivate: boolean
      isArchived: boolean
      memberCount: number
      createdAt: string (ISO date)
    }]
  }
```

### Get Channel Details
```http
GET /api/workspaces/:workspaceId/channels/:channelId
Response:
  {
    channel: {
      id: string
      name: string
      description: string | null
      isPrivate: boolean
      isArchived: boolean
      memberCount: number
      createdById: string
      createdAt: string
      updatedAt: string
    }
    membership: {
      role: 'owner' | 'admin' | 'member' | null
      joinedAt: string
    } | null
  }
```

### Create Channel
```http
POST /api/workspaces/:workspaceId/channels
Content-Type: application/json
Body:
  {
    name: string (1-80 chars, alphanumeric + dashes)
    description?: string (<500 chars)
    isPrivate?: boolean (default: false)
  }
Response:
  {
    channel: {
      id: string
      name: string
      description: string | null
      isPrivate: boolean
      isArchived: boolean
      memberCount: number
      createdAt: string
    }
  }
Status Codes:
  - 201 Created
  - 400 Bad Request (validation error)
  - 403 Forbidden (permission denied)
  - 409 Conflict (duplicate name)
```

### Update Channel
```http
PATCH /api/workspaces/:workspaceId/channels/:channelId
Content-Type: application/json
Body:
  {
    name?: string
    description?: string
    topic?: string
    isPrivate?: boolean
  }
Response:
  { success: true }
Status Codes:
  - 200 OK
  - 400 Bad Request
  - 403 Forbidden (not admin)
  - 404 Not Found
```

### Archive Channel
```http
POST /api/workspaces/:workspaceId/channels/:channelId/archive
Response:
  { success: true }
Status Codes:
  - 200 OK
  - 403 Forbidden (not admin)
  - 404 Not Found
```

### Unarchive Channel
```http
POST /api/workspaces/:workspaceId/channels/:channelId/unarchive
Response:
  { success: true }
Status Codes:
  - 200 OK
  - 403 Forbidden (not admin)
  - 404 Not Found
```

### Delete Channel
```http
DELETE /api/workspaces/:workspaceId/channels/:channelId
Response:
  { success: true }
Status Codes:
  - 200 OK
  - 403 Forbidden (not admin)
  - 404 Not Found
```

---

## Channel Membership (6 endpoints)

### List Channel Members
```http
GET /api/workspaces/:workspaceId/channels/:channelId/members
Query Parameters:
  - limit: number (default: 50)
  - offset: number (default: 0)
Response:
  {
    members: [{
      id: string
      name: string
      type: 'user' | 'agent'
      role: 'owner' | 'admin' | 'member'
      joinedAt: string
    }]
    total: number
  }
```

### Join Channel
```http
POST /api/workspaces/:workspaceId/channels/:channelId/join
Response:
  { success: true }
Status Codes:
  - 200 OK
  - 403 Forbidden (private channel)
  - 404 Not Found
  - 409 Conflict (already member)
```

### Leave Channel
```http
POST /api/workspaces/:workspaceId/channels/:channelId/leave
Response:
  { success: true }
Status Codes:
  - 200 OK
  - 400 Bad Request (owner cannot leave)
  - 404 Not Found
```

### Add Member
```http
POST /api/workspaces/:workspaceId/channels/:channelId/members
Content-Type: application/json
Body:
  {
    memberId: string (user or agent ID)
    memberType: 'user' | 'agent'
    role?: 'member' | 'admin' (default: 'member')
  }
Response:
  { success: true }
Status Codes:
  - 200 OK
  - 403 Forbidden (not admin)
  - 404 Not Found
  - 409 Conflict (already member)
```

### Update Member Role
```http
PATCH /api/workspaces/:workspaceId/channels/:channelId/members/:memberId
Content-Type: application/json
Body:
  {
    role: 'member' | 'admin'
  }
Response:
  { success: true }
Status Codes:
  - 200 OK
  - 403 Forbidden (not admin)
  - 404 Not Found
```

### Remove Member
```http
DELETE /api/workspaces/:workspaceId/channels/:channelId/members/:memberId
Response:
  { success: true }
Status Codes:
  - 200 OK
  - 403 Forbidden (not admin)
  - 404 Not Found
```

---

## Channel Messages (8 endpoints)

### Get Messages
```http
GET /api/workspaces/:workspaceId/channels/:channelId/messages
Query Parameters:
  - limit: number (default: 50, max: 100)
  - offset: number (default: 0)
  - threadId?: string (get thread replies)
  - unread?: boolean (get only unread)
Response:
  {
    messages: [{
      id: string
      from: string (sender name)
      fromEntityType: 'user' | 'agent'
      content: string
      timestamp: string (ISO date)
      threadId?: string
      replyCount: number
      isPinned: boolean
      pinnedAt?: string
      pinnedBy?: string
    }]
    hasMore: boolean
    unread: number
  }
```

### Send Message
```http
POST /api/workspaces/:workspaceId/channels/:channelId/messages
Content-Type: application/json
Body:
  {
    content: string (required, non-empty)
    threadId?: string (optional, for thread replies)
  }
Response:
  {
    message: {
      id: string
      from: string
      fromEntityType: 'user' | 'agent'
      content: string
      timestamp: string
      threadId?: string
    }
  }
Status Codes:
  - 201 Created
  - 400 Bad Request (content required)
  - 403 Forbidden (read-only user)
  - 404 Not Found (channel or thread)
```

### Edit Message
```http
PATCH /api/workspaces/:workspaceId/channels/:channelId/messages/:messageId
Content-Type: application/json
Body:
  {
    content: string
  }
Response:
  { success: true }
Status Codes:
  - 200 OK
  - 400 Bad Request
  - 403 Forbidden (not author)
  - 404 Not Found
```

### Delete Message
```http
DELETE /api/workspaces/:workspaceId/channels/:channelId/messages/:messageId
Response:
  { success: true }
Status Codes:
  - 200 OK
  - 403 Forbidden (not author or admin)
  - 404 Not Found
```

### Get Pinned Messages
```http
GET /api/workspaces/:workspaceId/channels/:channelId/messages/pinned
Response:
  {
    messages: [{
      id: string
      from: string
      content: string
      timestamp: string
      pinnedAt: string
      pinnedBy: string
    }]
  }
```

### Pin Message
```http
POST /api/workspaces/:workspaceId/channels/:channelId/messages/:messageId/pin
Response:
  { success: true }
Status Codes:
  - 200 OK
  - 403 Forbidden (not author or admin)
  - 404 Not Found
```

### Unpin Message
```http
POST /api/workspaces/:workspaceId/channels/:channelId/messages/:messageId/unpin
Response:
  { success: true }
Status Codes:
  - 200 OK
  - 403 Forbidden (not author or admin)
  - 404 Not Found
```

---

## Read State (1 endpoint)

### Mark as Read
```http
POST /api/workspaces/:workspaceId/channels/:channelId/read
Content-Type: application/json
Body:
  {
    lastMessageId: string (optional, message UUID)
  }
Response:
  {
    unreadCount: number
  }
Status Codes:
  - 200 OK
  - 404 Not Found
```

---

## Error Response Format

All error responses follow this format:
```json
{
  "error": "Human-readable error message"
}
```

Common HTTP status codes:
- `200 OK` - Success
- `201 Created` - Resource created
- `400 Bad Request` - Validation failed
- `403 Forbidden` - Permission denied
- `404 Not Found` - Resource not found
- `409 Conflict` - Duplicate or conflict
- `500 Internal Server Error` - Server error

---

## Example Usage: Create Channel and Send Message

```javascript
// 1. Create a channel
const createResponse = await fetch(
  `/api/workspaces/${workspaceId}/channels`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'announcements',
      description: 'Important announcements',
      isPrivate: false
    })
  }
);
const { channel } = await createResponse.json();

// 2. Send a message
const messageResponse = await fetch(
  `/api/workspaces/${workspaceId}/channels/${channel.id}/messages`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: 'Welcome to announcements!'
    })
  }
);
const { message } = await messageResponse.json();

// 3. Get all messages
const messagesResponse = await fetch(
  `/api/workspaces/${workspaceId}/channels/${channel.id}/messages`
);
const { messages } = await messagesResponse.json();
```

---

## Field Mappings (Frontend ↔ Backend)

The backend returns different field names than what the frontend expects.
Map these when integrating:

| Backend Field | Frontend Field | Notes |
|---------------|----------------|-------|
| `sender_name` | `from` | Message sender display name |
| `sender_type` | `fromEntityType` | 'user' or 'agent' |
| `body` | `content` | Message text content |
| `created_at` | `timestamp` | ISO date string |
| `is_pinned` | `isPinned` | Boolean |
| `pinned_at` | `pinnedAt` | ISO date string or null |
| `pinned_by_id` | `pinnedBy` | User/agent ID |
| `thread_id` | `threadId` | Parent message ID for replies |
| `reply_count` | `replyCount` | Number of thread replies |

---

## Notes

- All dates are ISO 8601 format (e.g., "2024-01-10T15:30:45Z")
- UUIDs are used for all IDs
- Pagination is offset-based (limit + offset)
- All endpoints require workspace membership
- Admin operations require channel admin role
- Read-only users cannot send messages
