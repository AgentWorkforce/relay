# Channels V1 - Beads Task Breakdown

## Overview

10 feature tasks to implement Channels V1 as described in CHANNELS_V1_SPEC.md

## Phase 1: Core Channel Management

### Task 1: Database Schema & Migrations
**ID:** agent-relay-channels-1
**Type:** Feature
**Priority:** P1
**Phase:** 1

**Requirements:**
- [ ] Create Drizzle ORM schema for channels
  - channels table (id, name, description, topic, created_at, created_by, archived_at)
  - channel_members table (channel_id, user_or_agent_id, member_type, joined_at, is_admin)
  - channel_messages table (channel_id, user_id, content, created_at, thread_id, pinned_at)
  - channel_read_state table (channel_id, user_id, last_read_message_id, last_read_at)
- [ ] Create database migration files
- [ ] Add indexes for performance (channel_id, user_id, created_at, pinned_at)
- [ ] Add foreign key constraints
- [ ] Test schema creation and migrations

**Acceptance:**
- [ ] Schema compiles without errors
- [ ] Migrations run successfully
- [ ] All indexes created
- [ ] Foreign keys enforced
- [ ] Drizzle type generation works

**Estimated Effort:** 6 hours

---

### Task 2: Channel CRUD APIs
**ID:** agent-relay-channels-2
**Type:** Feature
**Priority:** P1
**Phase:** 1

**Requirements:**
- [ ] Implement channel creation endpoint
  - POST /api/channels
  - Validate name (1-80 chars, lowercase alphanumeric+dash)
  - Validate description (<500 chars)
  - Check permissions (not read-only)
  - Auto-add creator as member
- [ ] Implement channel retrieval endpoints
  - GET /api/channels/{id} - single channel details
  - GET /api/channels - list all public channels with search/sort
  - GET /api/user/channels - member's channels only
- [ ] Implement channel update endpoint
  - PATCH /api/channels/{id} - update description/topic (admin only)
- [ ] Implement archive endpoint
  - POST /api/channels/{id}/archive (admin only)
  - Soft-delete, keep messages readable
- [ ] Implement delete endpoint
  - DELETE /api/channels/{id} (admin only)
  - Hard-delete, irreversible
- [ ] Error handling (400 bad request, 403 forbidden, 404 not found, 409 conflict)

**Acceptance:**
- [ ] Can create channels with validation
- [ ] Can retrieve channels by ID and list
- [ ] Can search channels by name/description
- [ ] Can update channel metadata (admin only)
- [ ] Can archive/unarchive channels
- [ ] Can delete channels (admin only)
- [ ] All error cases handled correctly
- [ ] Permissions enforced (read-only users can't create)

**Estimated Effort:** 8 hours

---

### Task 3: Channel Membership APIs
**ID:** agent-relay-channels-3
**Type:** Feature
**Priority:** P1
**Phase:** 1

**Requirements:**
- [ ] Implement join channel endpoint
  - POST /api/channels/{id}/join
  - Check channel exists and not archived
  - Add user as member
  - Mark all existing messages as "read" for new member
- [ ] Implement leave channel endpoint
  - POST /api/channels/{id}/leave
  - Remove user from members
  - Clean up unread state
- [ ] Implement get channel members endpoint
  - GET /api/channels/{id}/members
  - Paginated (limit, offset)
  - Include member type (human/agent)
- [ ] Implement remove member endpoint (admin only)
  - POST /api/channels/{id}/members/{user_id}/remove
- [ ] Implement add agent endpoint (admin only)
  - POST /api/channels/{id}/members
  - Add agent as member (member_type: 'agent')
  - Only admins can assign agents
- [ ] Handle member_count tracking
  - Update on join/leave
  - Keep accurate count

**Acceptance:**
- [ ] Users can join public channels
- [ ] Users can leave channels
- [ ] Can list channel members with pagination
- [ ] Admins can remove members
- [ ] Admins can assign agents to channels
- [ ] Member count stays accurate
- [ ] Permissions enforced (admin only for remove/add)

**Estimated Effort:** 8 hours

---

## Phase 2: Messaging & Advanced Features

### Task 4: Channel Messages API
**ID:** agent-relay-channels-4
**Type:** Feature
**Priority:** P1
**Phase:** 2

**Requirements:**
- [ ] Implement post message endpoint
  - POST /api/channels/{id}/messages
  - Validate content (required, non-empty)
  - Support thread_id (optional, for thread replies)
  - Only channel members can post
  - Read-only users cannot post
- [ ] Implement get messages endpoint
  - GET /api/channels/{id}/messages
  - Pagination (limit: 50 default, offset)
  - Support unread filter (?unread=true)
  - Return with timestamps
- [ ] Implement get thread endpoint
  - GET /api/channels/{id}/messages/{thread_id}/thread
  - Return parent message + all replies
  - Sorted by created_at
- [ ] Implement pin/unpin message endpoints
  - POST /api/channels/{id}/messages/{msg_id}/pin
  - POST /api/channels/{id}/messages/{msg_id}/unpin
  - Track pinned_at and pinned_by
  - Author or admin can pin/unpin
- [ ] Implement mark as read endpoint
  - POST /api/channels/{id}/read
  - Track last_read_message_id per user
  - Calculate unread_count for channel view

**Acceptance:**
- [ ] Can post messages to channels
- [ ] Can create threaded replies
- [ ] Can retrieve messages with pagination
- [ ] Can pin/unpin messages
- [ ] Unread tracking works correctly
- [ ] Permissions enforced (members only, no read-only posting)
- [ ] Thread queries return parent + replies

**Estimated Effort:** 10 hours

---

### Task 5: Sidebar UI Component
**ID:** agent-relay-channels-5
**Type:** Feature
**Priority:** P1
**Phase:** 2

**Requirements:**
- [ ] Create ChannelsSidebar React component
  - Display list of member channels (alphabetical)
  - Show unread count badge
  - "Create Channel" button at top
  - Search input (expands to browse view)
  - Archived channels in collapsible section
  - Handle loading and error states
- [ ] Implement channel selection
  - Click channel to view messages
  - Highlight currently selected channel
  - Visual feedback on hover
- [ ] Implement sorting dropdown
  - Options: alphabetical (default), recent, custom
  - V1: only alphabetical, prepare for V2 sort options
- [ ] Create Channel component (individual channel item)
  - Show name and unread count
  - Show topic in subtitle
  - Click handler to navigate
- [ ] Handle empty state
  - "No channels yet" message
  - Suggest creating or joining channels

**Acceptance:**
- [ ] Sidebar shows member channels only
- [ ] Unread count displays correctly
- [ ] Create button accessible and functional
- [ ] Search input works
- [ ] Archived section collapsible
- [ ] Channel selection updates main view
- [ ] Responsive on mobile/tablet
- [ ] Sort dropdown prepared for future options

**Estimated Effort:** 8 hours

---

### Task 6: Channel Header & View
**ID:** agent-relay-channels-6
**Type:** Feature
**Priority:** P1
**Phase:** 2

**Requirements:**
- [ ] Create ChannelHeader component
  - Display channel name with # prefix
  - Show description and topic
  - Show member count and last active time
  - Implement menu (⋮) with options
    - Archive channel (admin only)
    - Delete channel (admin only)
    - View members
    - Leave channel
    - Copy channel link
- [ ] Create ChannelView component
  - Display messages in vertical list
  - Show unread separator line
  - Render threads (click to expand/collapse)
  - Show pinned message indicator
  - Message input box at bottom
  - Auto-scroll to new messages
  - Handle loading states
- [ ] Message rendering
  - Show timestamp and author
  - Support markdown formatting (links, code)
  - Show thread reply count
  - Show pinned badge

**Acceptance:**
- [ ] Channel header displays correctly
- [ ] All metadata visible (name, description, topic, members)
- [ ] Menu options functional
- [ ] Messages display in chronological order
- [ ] Threads expandable/collapsible
- [ ] Unread separator visible
- [ ] Auto-scroll to new messages
- [ ] Message input functional
- [ ] Responsive layout

**Estimated Effort:** 10 hours

---

## Phase 3: Discovery & Polish

### Task 7: Browse Channels View
**ID:** agent-relay-channels-7
**Type:** Feature
**Priority:** P2
**Phase:** 3

**Requirements:**
- [ ] Create BrowseChannels component
  - Display searchable list of all public channels
  - Show member count, description for each
  - Join button for non-members
  - Already joined indicator for members
  - Paginated (20 channels per page)
  - Search by name/description
  - No sort in V1 (list in alphabetical)
- [ ] Implement channel search
  - Search across name and description
  - Debounced search (300ms)
  - Highlight matches
- [ ] Add to command palette
  - /channels command opens browse view
  - /channels search [query] shows filtered results
- [ ] Handle join from browse view
  - Click "Join" button
  - User added to channel
  - Confirm toast message
  - Channel appears in sidebar

**Acceptance:**
- [ ] Can search and browse all public channels
- [ ] Member count and description visible
- [ ] Can join channels from browse view
- [ ] Already-joined channels show "Joined" badge
- [ ] Search works accurately
- [ ] Pagination works
- [ ] Command palette integration functional

**Estimated Effort:** 6 hours

---

### Task 8: Command Palette Integration
**ID:** agent-relay-channels-8
**Type:** Feature
**Priority:** P2
**Phase:** 3

**Requirements:**
- [ ] Add /create-channel command
  - /create-channel <name> [description]
  - Validates name format
  - Creates channel
  - Navigates to new channel
  - Shows confirmation
- [ ] Add /join-channel command
  - /join-channel <name>
  - Searches for channel by name
  - Shows results if multiple matches
  - Joins selected channel
  - Confirmation message
- [ ] Add /leave-channel command
  - /leave-channel <name>
  - Leaves channel
  - Confirmation message
  - Removes from sidebar
- [ ] Add /channels command
  - /channels opens browse view
  - /channels search <query> filters results
  - Nested results showing channels
- [ ] Autocomplete support
  - Suggest channel names
  - Show member count in suggestion
  - Show member status (joined/not joined)

**Acceptance:**
- [ ] All commands functional
- [ ] Autocomplete works for channel names
- [ ] Error handling for invalid names
- [ ] Confirmation messages show
- [ ] Navigation works after command
- [ ] Help text available for commands

**Estimated Effort:** 6 hours

---

### Task 9: Unread Handling & Archive
**ID:** agent-relay-channels-9
**Type:** Feature
**Priority:** P2
**Phase:** 3

**Requirements:**
- [ ] Implement unread count tracking
  - Calculate unread_count for each channel per user
  - Show in sidebar badge
  - Show unread separator in message view
  - Auto-mark as read when viewing channel (scroll past messages)
  - Manual mark as read via button
- [ ] Implement archive UI
  - Archive button in channel menu (admin only)
  - Confirmation dialog before archiving
  - Archived channels move to "Archived" section in sidebar
  - Can still view archived channel messages
  - Can unarchive from menu (admin only)
- [ ] Implement delete UI
  - Delete button in channel menu (admin only)
  - Confirmation dialog with warning
  - Channel removed from sidebar immediately
  - All messages deleted (irreversible)

**Acceptance:**
- [ ] Unread count accurate and updates in real-time
- [ ] Unread separator shows in message view
- [ ] Auto-mark as read works
- [ ] Archive functionality works
- [ ] Archived channels section collapsible
- [ ] Delete functionality works (with confirmation)
- [ ] Permissions enforced (admin only)

**Estimated Effort:** 6 hours

---

### Task 10: Admin Tools & Member Management
**ID:** agent-relay-channels-10
**Type:** Feature
**Priority:** P2
**Phase:** 3

**Requirements:**
- [ ] Create Members list view
  - Show all channel members
  - Indicate member type (human/agent)
  - Show join date
  - Admin indicator
  - Paginated (20 members per page)
- [ ] Implement member removal (admin only)
  - Click "Remove" on member
  - Confirmation dialog
  - Member removed from channel
  - Removed member still sees channel in browse but not sidebar
- [ ] Implement agent assignment
  - Admin can add agents to channel
  - Via channel menu: "Add member"
  - Search and select agent
  - Confirmation
  - Agent appears in member list (agent badge)
- [ ] Create channel settings view (admin only)
  - Edit description and topic
  - View and manage members
  - Archive/delete options
  - Display created by and creation date
- [ ] Permissions enforcement
  - Only admins can remove members
  - Only admins can add agents
  - Only admins can edit description/topic
  - Only admins can delete/archive

**Acceptance:**
- [ ] Member list displays with all info
- [ ] Can remove members (admin only)
- [ ] Can add agents to channels (admin only)
- [ ] Settings view functional (admin only)
- [ ] Permissions enforced correctly
- [ ] Confirmation dialogs for destructive actions
- [ ] Member changes reflected immediately

**Estimated Effort:** 8 hours

---

## Summary (Updated 2026-01-10)

| Phase | Task | Hours | Status |
|-------|------|-------|--------|
| 1 | Database & Migrations | 6 | ✅ Complete |
| 1 | Channel CRUD | 8 | ✅ Complete |
| 1 | Channel Members | 8 | ✅ Complete |
| 2 | Messages API | 10 | ✅ Complete |
| 2 | Sidebar UI | 8 | ⚠️ 60% (needs API wiring) |
| 2 | Channel Header & View | 10 | ⚠️ 40% (needs message rendering) |
| 3 | Browse View | 6 | ⚠️ 70% (component done, API wiring needed) |
| 3 | Command Palette | 6 | ❌ Not Started |
| 3 | Unread & Archive | 6 | ⚠️ 50% (backend done, UI needed) |
| 3 | Admin Tools | 8 | ❌ Not Started |
| | **Total Completed** | **38** | |
| | **Total Remaining** | **38** | |
| | **Grand Total** | **76** | |

**Completion Status:** 50% (38/76 hours)
**Team Size Recommended:** 1-2 developers (backend testing + frontend implementation)
**Estimated Timeline to V1:** 2-3 weeks at standard velocity
**Next Priority:** Complete Task 6 (Channel View UI) and Task 7 (Browse API wiring)

## Implementation Order

**Week 1 (Phase 1):**
1. Database schema and migrations
2. Channel CRUD APIs
3. Channel membership APIs

**Week 2 (Phase 2):**
4. Channel messages API
5. Sidebar UI component
6. Channel header and view

**Week 3 (Phase 3a):**
7. Browse channels view
8. Command palette integration

**Week 4 (Phase 3b):**
9. Unread handling and archive
10. Admin tools and member management

## Dependencies

- React components for UI
- Existing API authentication and authorization
- Existing database setup (Drizzle ORM)
- Existing command palette system
- Sidebar layout (may need to refactor)

## Risks

1. **Sidebar Integration:** May require refactoring existing sidebar (DMs + channels)
2. **Real-time Updates:** Unread counts need to update in real-time (may need websockets)
3. **Thread Complexity:** Threading may be more complex than expected
4. **Performance:** Many queries for messages + unread state (may need caching)

## Mitigation

- Plan sidebar architecture early (DM + channels side-by-side)
- Consider implementing real-time with existing relay daemon
- Start with simple threading (no deep nesting)
- Add message pagination and lazy loading from start
- Cache unread counts per user

## V1 → V2 Migration Notes

When moving to V2, plan for:
- Agent automations/bots
- Private channels
- Advanced member permissions
- Channel muting
- Webhooks/integrations
- Scheduled messages

Avoid painting yourself into a corner with V1 design choices.
