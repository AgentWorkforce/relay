# Channels V1 Integration Test Scenarios

**Prepared by:** ChannelsBackendLead
**Date:** 2026-01-10
**Purpose:** Integration test scenarios to validate frontend-backend integration

## 1. Channel CRUD Flows

### 1.1 Create Channel
```
Scenario: User creates a new public channel
Given: Authenticated user with workspace access
When: POST /api/workspaces/:workspaceId/channels { name: "engineering", description: "Team channel" }
Then: 201 with channel object, creator is admin member
Verify: Channel appears in list, memberCount = 1
```

```
Scenario: Duplicate channel name rejected
Given: Channel "general" exists
When: POST /api/workspaces/:workspaceId/channels { name: "general" }
Then: 409 { error: "A channel with this name already exists" }
```

```
Scenario: Invalid channel name rejected
Given: Authenticated user
When: POST with name containing spaces or special chars
Then: 400 { error: "Channel name can only contain lowercase letters, numbers, and dashes" }
```

### 1.2 List Channels
```
Scenario: List shows only accessible channels
Given: Public channel "general", private channel "secret" (user not member)
When: GET /api/workspaces/:workspaceId/channels
Then: Response includes "general", excludes "secret"
```

```
Scenario: Include archived channels
When: GET /api/workspaces/:workspaceId/channels?includeArchived=true
Then: Response includes archived channels with isArchived=true
```

### 1.3 Archive/Delete
```
Scenario: Admin archives channel
Given: User is channel admin
When: POST /api/workspaces/:workspaceId/channels/:channelId/archive
Then: 200, channel.isArchived = true
```

```
Scenario: Non-admin cannot archive
Given: User is regular member
When: POST .../archive
Then: 403 { error: "You do not have permission to archive this channel" }
```

## 2. Membership Flows

### 2.1 Join/Leave
```
Scenario: User joins public channel
Given: Public channel, user not a member
When: POST /api/workspaces/:workspaceId/channels/:channelId/join
Then: 201, user becomes member with role "member"
```

```
Scenario: Cannot join private channel
Given: Private channel, user not invited
When: POST .../join
Then: 403 { error: "Cannot join private channels. Request an invite from an admin." }
```

```
Scenario: Last admin cannot leave
Given: User is only admin in channel
When: POST .../leave
Then: 400 { error: "Cannot leave: you are the last admin. Transfer ownership first." }
```

### 2.2 Member Management
```
Scenario: Admin adds user to channel
Given: User is channel admin
When: POST .../members { memberId: "user-id", role: "member" }
Then: 201, new member added
```

```
Scenario: Admin removes member
Given: User is channel admin, target is regular member
When: DELETE .../members/:memberId
Then: 200, memberCount decremented
```

```
Scenario: Cannot demote last admin
Given: Only one admin in channel
When: PATCH .../members/:adminId { role: "member" }
Then: 400 { error: "Cannot demote: this is the last admin" }
```

## 3. Message Flows

### 3.1 Send/Edit/Delete
```
Scenario: Member sends message
Given: User is channel member with post permission
When: POST .../messages { content: "Hello world" }
Then: 201 with message object, channel lastActivityAt updated
```

```
Scenario: Read-only member cannot post
Given: User has role "read_only"
When: POST .../messages { content: "test" }
Then: 403 { error: "You do not have permission to post in this channel" }
```

```
Scenario: User edits own message
Given: User sent message earlier
When: PATCH .../messages/:messageId { content: "Updated content" }
Then: 200, message.updatedAt > createdAt
```

```
Scenario: User cannot edit others' messages
Given: Message sent by different user
When: PATCH .../messages/:messageId { content: "Hacked" }
Then: 403 { error: "You can only edit your own messages" }
```

### 3.2 Threading
```
Scenario: Reply to message creates thread
Given: Parent message exists
When: POST .../messages { content: "Reply", threadId: "parent-id" }
Then: 201, parent.replyCount incremented
```

```
Scenario: Get thread with all replies
When: GET .../messages/:threadId/thread
Then: { parent: {...}, replies: [...] } in chronological order
```

### 3.3 Pinning
```
Scenario: Admin pins message
Given: User is channel admin
When: POST .../messages/:messageId/pin
Then: 200, message.isPinned = true
```

```
Scenario: Non-admin cannot pin
When: POST .../messages/:messageId/pin (as regular member)
Then: 403 { error: "Only admins can pin messages" }
```

## 4. Read State & Unread

### 4.1 Mark as Read
```
Scenario: Mark channel as read
Given: User has unread messages
When: POST .../read
Then: 200, unreadCount resets to 0
```

```
Scenario: Mark read up to specific message
Given: 10 unread messages
When: POST .../read { lastMessageId: "msg-5" }
Then: 200, unreadCount = 5 (remaining unread)
```

## 5. Search (FTS)

### 5.1 Workspace Search
```
Scenario: Search across all accessible channels
When: GET /api/workspaces/:workspaceId/search?q=authentication
Then: Results from all channels user can access, with headlines
```

```
Scenario: Search respects private channel access
Given: Private channel with matching messages, user not member
When: GET .../search?q=secret
Then: Results exclude private channel messages
```

### 5.2 Channel Search
```
Scenario: Search within specific channel
When: GET /api/workspaces/:workspaceId/channels/:channelId/search?q=bug
Then: Results only from that channel, with headlines and rank
```

```
Scenario: Empty query rejected
When: GET .../search?q=
Then: 400 { error: "Search query (q) is required" }
```

## 6. Permission Edge Cases

### 6.1 Workspace Access
```
Scenario: Non-workspace-member denied
Given: User not in workspace
When: Any channel API call
Then: 403 { error: "Access denied" }
```

### 6.2 Channel Access
```
Scenario: Private channel access enforced
Given: Private channel, user not member
When: GET .../channels/:privateChannelId
Then: 403 { error: "Access denied to private channel" }
```

## 7. Pagination Edge Cases

### 7.1 Message Pagination
```
Scenario: Pagination with before cursor
When: GET .../messages?limit=50&before=msg-id
Then: 50 messages before the specified message
```

```
Scenario: Empty channel
When: GET .../messages (no messages exist)
Then: { messages: [], hasMore: false }
```

## 8. Error Handling

### 8.1 Not Found
```
Scenario: Channel not found
When: GET .../channels/non-existent-id
Then: 404 { error: "Channel not found" }
```

### 8.2 Validation Errors
```
Scenario: Missing required field
When: POST .../channels { } (no name)
Then: 400 { error: "Channel name is required" }
```

---

## Test Execution Checklist

- [ ] Channel CRUD (create, read, update, archive, delete)
- [ ] Membership (join, leave, add, remove, role change)
- [ ] Messages (send, edit, delete, thread, pin)
- [ ] Read state (mark read, unread counts)
- [ ] Search (workspace-wide, channel-specific)
- [ ] Permissions (admin vs member vs read-only)
- [ ] Pagination (cursor-based, empty results)
- [ ] Error responses (400, 403, 404, 409)
