# Channels V1 - Remaining Implementation Tasks

**Status:** Phase 1 complete, Phase 2-3 in progress
**Last Updated:** 2026-01-10
**Branch:** `feature/channels-v1`

## High Priority (Blocking Release)

### Task 6b: Complete Channel View UI Component
**ID:** agent-relay-channels-6b
**Type:** Feature
**Priority:** P1
**Phase:** 2
**Estimated Effort:** 6 hours

**Requirements:**
- [ ] Implement message rendering with timestamps and author names
- [ ] Add thread reply counter and expand/collapse UI
- [ ] Implement auto-scroll to new messages
- [ ] Add pinned message indicator/badge
- [ ] Wire to real backend via `GET /api/channels/{id}/messages`
- [ ] Handle message pagination (50 default, limit, offset)
- [ ] Show unread separator line
- [ ] Implement message input box integration

**Acceptance Criteria:**
- [ ] Can view channel messages in chronological order
- [ ] Threads expand to show replies
- [ ] Pinned messages show indicator
- [ ] Auto-scroll works when new messages arrive
- [ ] Pagination loads more messages on scroll
- [ ] Unread separator visible between read/unread

**Dependencies:** Task 4 (Messages API complete)

---

### Task 7b: Wire Browse Channels to API
**ID:** agent-relay-channels-7b
**Type:** Feature
**Priority:** P1
**Phase:** 2
**Estimated Effort:** 3 hours

**Requirements:**
- [ ] Implement API calls in `useChannelBrowser` hook
  - GET `/api/channels` with search, pagination, sort
  - POST `/api/channels/{id}/join` when joining
  - POST `/api/channels/{id}/leave` when leaving
- [ ] Wire ChannelBrowser component to real data
- [ ] Test search functionality (debounced)
- [ ] Test pagination
- [ ] Handle join/leave button states
- [ ] Show "Already joined" badge for members

**Acceptance Criteria:**
- [ ] Can search all public channels
- [ ] Search results update in real-time (debounced 300ms)
- [ ] Pagination works correctly
- [ ] Can join channels from modal
- [ ] Joined channels show appropriate status
- [ ] No API errors on search/join/leave

**Dependencies:** Task 2 (Channel CRUD), Task 3 (Membership API)

---

## Medium Priority (Complete Phase 2)

### Task 8: Command Palette Integration
**ID:** agent-relay-channels-8
**Type:** Feature
**Priority:** P2
**Phase:** 3
**Estimated Effort:** 6 hours

**Requirements:**
- [ ] Add `/create-channel <name> [description]` command
  - Validates name format
  - Calls POST `/api/channels`
  - Navigates to new channel
  - Shows confirmation toast

- [ ] Add `/join-channel <name>` command
  - Searches for channel
  - Shows results if multiple matches
  - Calls POST `/api/channels/{id}/join`
  - Confirmation message

- [ ] Add `/leave-channel <name>` command
  - Leaves current or specified channel
  - Calls POST `/api/channels/{id}/leave`
  - Removes from sidebar

- [ ] Add `/channels` command
  - Opens browse channels modal
  - Supports nested search: `/channels search query`
  - Shows filtered results

- [ ] Implement autocomplete
  - Suggest channel names as user types
  - Show member count in suggestion
  - Show joined/not-joined status

**Acceptance Criteria:**
- [ ] All commands functional and tested
- [ ] Autocomplete works for channel names
- [ ] Error handling for invalid names
- [ ] Confirmation messages display
- [ ] Navigation works after command execution

**Dependencies:** Task 2, 3, 7

---

### Task 9b: Unread UI & Archive
**ID:** agent-relay-channels-9b
**Type:** Feature
**Priority:** P2
**Phase:** 3
**Estimated Effort:** 6 hours

**Requirements:**
- [ ] **Unread Badges**
  - Display count badge next to channel name in sidebar
  - Update in real-time as new messages arrive
  - Hide badge if unread_count === 0
  - Show different styling for channels with unread

- [ ] **Unread Separator**
  - Show "─── Unread ───" line in message view
  - Position between last read and first unread message
  - Auto-scroll to separator when opening channel

- [ ] **Auto-Mark as Read**
  - Call POST `/api/channels/{id}/read` when:
    - User scrolls to latest message
    - User opens channel (after 2s delay)
  - Clear unread badge after marking

- [ ] **Archive UI**
  - Archive button in channel menu (admin only)
  - Confirmation dialog before archiving
  - Move archived channels to "Archived" collapsible section
  - Show archived badge/styling
  - Unarchive button (admin only)

- [ ] **Delete UI**
  - Delete button in channel menu (admin only)
  - Confirmation dialog with warning text
  - Remove channel from sidebar immediately
  - Show success toast

**Acceptance Criteria:**
- [ ] Unread count accurate and updates in real-time
- [ ] Unread separator shows correctly
- [ ] Auto-mark as read works on scroll and channel open
- [ ] Archive moves channel to archived section
- [ ] Delete removes channel with confirmation
- [ ] Permissions enforced (admin only for archive/delete)

**Dependencies:** Task 4 (read state API), Task 2 (archive endpoints)

---

## Low Priority (Complete Phase 3)

### Task 10: Admin Tools & Member Management
**ID:** agent-relay-channels-10
**Type:** Feature
**Priority:** P3
**Phase:** 3
**Estimated Effort:** 8 hours

**Requirements:**
- [ ] **Members List View**
  - Display all channel members in modal/sidebar
  - Show member type (human/agent badge)
  - Show join date
  - Pagination (20 members per page)
  - GET `/api/channels/{id}/members` integration

- [ ] **Remove Member** (admin only)
  - "Remove" button next to each member
  - Confirmation dialog before removal
  - Call POST `/api/channels/{id}/members/{user_id}/remove`
  - Member list updates immediately
  - Success toast

- [ ] **Add Agent to Channel** (admin only)
  - "Add member" button in channel menu
  - Search/select agent from list
  - Call POST `/api/channels/{id}/members` with agent ID
  - Agent appears in member list with badge

- [ ] **Channel Settings View** (admin only)
  - Edit description (PATCH `/api/channels/{id}`)
  - Edit topic
  - View and manage members
  - Archive/delete options
  - Show creation metadata (created_by, created_at)

- [ ] **Permission Enforcement**
  - Only show admin buttons if user is admin
  - Gray out buttons for non-admins with tooltip
  - Proper error handling (403 Forbidden)

**Acceptance Criteria:**
- [ ] Member list displays with all metadata
- [ ] Can remove members (admin only, with confirmation)
- [ ] Can add agents to channels (admin only)
- [ ] Settings view functional for admins
- [ ] Permissions enforced correctly
- [ ] All changes reflected in real-time

**Dependencies:** Task 2, 3 (membership APIs), Task 6 (channel view)

---

## Testing & QA

### Integration Testing Checklist
- [ ] Can create channel → appears in sidebar → can post message
- [ ] Can join channel → see messages → can leave
- [ ] Search works with special characters
- [ ] Threading: Create thread → expand → see replies
- [ ] Pinning: Pin message → show indicator → unpin works
- [ ] Unread: New messages increment count → mark as read → count resets
- [ ] Archive: Archive channel → moves section → can unarchive
- [ ] Delete: Delete channel → confirmation → removed from sidebar
- [ ] Admin: Remove member → appears in browse but not sidebar
- [ ] Performance: <200ms to load channel, <100ms to post message

### Browser Testing
- [ ] Desktop (Chrome, Firefox, Safari)
- [ ] Tablet (responsive sidebar collapse)
- [ ] Mobile (full vertical layout)

---

## Notes for Next Session

1. **Dependency Chain:** Tasks 6 & 7 can be done in parallel, Tasks 8-10 depend on earlier work
2. **Team Recommendation:** Frontend specialist for Tasks 6-10 (all UI-focused)
3. **Backend Testing:** Message reactions API needs integration test before marking Task 9 complete
4. **Performance:** Consider pagination strategy for large channels (>1000 messages)
5. **Real-time Updates:** Sidebar unread counts need to update without full page refresh (may need websockets)

---

**Remaining Total Effort:** ~29 hours
**Recommended Team:** 1 frontend + 1 backend for integration testing
**Target Completion:** End of Week 2 (2026-01-24)
