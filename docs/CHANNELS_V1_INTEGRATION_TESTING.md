# Channels V1 Integration Testing Guide

Quick guide for testing the complete Channels V1 feature once all tasks are implemented.

## Pre-Testing Checklist

Before running tests, ensure:
- [ ] TypeScript compiles: `npm run build`
- [ ] Server starts: `npm start` (should run migrations automatically)
- [ ] Dashboard loads: http://localhost:3000
- [ ] You're logged in to a workspace
- [ ] No console errors in browser dev tools

## Test Scenarios

### Scenario 1: Create Channel
**Goal:** Create a new channel and verify it appears in the list

Steps:
1. Open Channels UI (from sidebar or command `/channels`)
2. Click "Create Channel"
3. Fill in:
   - Name: "test-channel"
   - Description: "Test channel for integration"
   - Visibility: Public
4. Click Create
5. Verify:
   - Channel appears in list immediately
   - Channel count increments
   - You are a member (admin role)
   - No console errors

**Expected Result:** ✅ Channel created and visible

---

### Scenario 2: Send Message
**Goal:** Send a message and verify it persists

Steps:
1. From Scenario 1, open the test-channel
2. Type message in input: "Hello from integration test"
3. Press Enter (or click Send)
4. Verify:
   - Message appears immediately
   - Message shows your name and timestamp
   - No console errors
5. Refresh the page (Cmd+R)
6. Verify:
   - Message is still there (persisted to database)
   - Message list loaded correctly

**Expected Result:** ✅ Message sent and persisted

---

### Scenario 3: Unread Tracking
**Goal:** Verify unread message counts work correctly

Steps:
1. Create a second test account (or use another user if available)
2. In Account 1, create channel "unread-test"
3. Send a message: "Test message"
4. Switch to Account 2
5. Verify:
   - Channel appears in list with unread badge showing "1"
6. Click on channel to open it
7. Verify:
   - Message displays
   - Unread badge disappears (automatically marked as read)
8. Switch back to Account 1
9. Send another message: "Second test message"
10. Switch to Account 2
11. Verify:
    - Unread badge shows "1" again (the new message)

**Expected Result:** ✅ Unread tracking works correctly

---

### Scenario 4: Membership Management
**Goal:** Verify users can join/leave channels

Steps:
1. In Account 1, create channel "membership-test" (public)
2. Switch to Account 2
3. Open Channels browser
4. Find "membership-test"
5. Click "Join"
6. Verify:
   - You're added to the channel
   - Channel appears in your sidebar
   - Member count incremented
7. Click "Leave"
8. Verify:
   - Channel removed from sidebar
   - Member count decremented
   - Opening it shows "Access denied"

**Expected Result:** ✅ Join/leave work correctly

---

### Scenario 5: Thread Replies
**Goal:** Verify threaded conversations work

Steps:
1. Open a channel with messages
2. Hover over a message
3. Click "Reply in thread"
4. Type: "This is a thread reply"
5. Send
6. Verify:
   - Reply appears under the original message
   - Original message shows reply count
   - Thread is properly linked
7. Refresh page
8. Verify:
   - Thread structure persists

**Expected Result:** ✅ Threading works correctly

---

### Scenario 6: Pin Messages
**Goal:** Verify pinning important messages

Steps:
1. Open a channel with messages
2. Hover over a message
3. Click "Pin"
4. Verify:
   - Message shows "pinned" indicator
   - Message appears at top of channel
5. Click "View pinned" or access pinned section
6. Verify:
   - Pinned message appears in pinned list
7. Click "Unpin"
8. Verify:
   - Pin indicator removed
   - Message no longer in pinned list

**Expected Result:** ✅ Pin/unpin works correctly

---

### Scenario 7: Command Palette Integration
**Goal:** Verify channel commands work

Steps:
1. Open Command Palette (Cmd+K or Ctrl+K)
2. Type: "/create-channel"
3. Verify:
   - Command appears
   - Triggers channel creation modal
4. Cancel modal
5. Type: "/join-channel"
6. Verify:
   - Shows autocomplete of available channels
   - Can select and join
7. Type: "/channels"
8. Verify:
   - Opens channels browser view
9. Type: "/leave-channel"
10. Verify:
    - Leaves current channel (if in one)

**Expected Result:** ✅ All commands work

---

### Scenario 8: Permissions
**Goal:** Verify permission checks work

Steps:
1. Verify you can send messages (not read-only)
2. If you're read-only, attempt to send:
3. Verify:
   - Send button disabled or hidden
   - Cannot POST /messages
   - Error message: "You don't have permission to send messages"
4. Verify you cannot delete/edit others' messages
5. Verify you cannot promote other members without admin role

**Expected Result:** ✅ Permissions enforced

---

## Performance Checklist

- [ ] Channel list loads in < 1 second
- [ ] Sending message feels instant (< 100ms visual feedback)
- [ ] Loading 100 messages doesn't lag UI
- [ ] No memory leaks (check DevTools → Memory)
- [ ] No repeated API calls (network tab should be clean)

## Error Handling Checklist

Test these error scenarios:

1. **Network Error**
   - Unplug network
   - Try to send message
   - Verify: Error message appears, message queued or retried

2. **Invalid Channel Name**
   - Try to create channel with invalid name (spaces, caps, special chars)
   - Verify: Validation error appears before sending

3. **Permission Denied**
   - Try to delete message from another user
   - Verify: 403 error handled gracefully

4. **Server Error**
   - (If available) Break server temporarily
   - Try to send message
   - Verify: Error message, no crash

5. **Missing Data**
   - Open non-existent channel ID in URL
   - Verify: 404 error, displays "Channel not found"

## Browser Compatibility Checklist

Test in:
- [ ] Chrome/Chromium
- [ ] Firefox
- [ ] Safari
- [ ] Mobile Safari (iPad/iPhone)

Check for:
- [ ] No console errors
- [ ] All UI elements visible
- [ ] Touch interactions work (on mobile)
- [ ] Responsive design works

## Accessibility Checklist

- [ ] Can navigate with keyboard (Tab, Enter)
- [ ] Can use Command Palette without mouse
- [ ] Screen reader friendly (alt text on images)
- [ ] Color contrast sufficient
- [ ] Focus states visible

## Data Verification Checklist

1. **Database**
   - Connect to DB: `npm run db:studio`
   - Verify tables exist: channels, channel_members, channel_messages, channel_read_state
   - Verify data from tests appears in tables
   - Verify foreign keys enforced
   - Verify indexes created

2. **API Responses**
   - Messages API returns correct fields (from, content, timestamp, etc.)
   - List channels shows member count
   - Get channel returns membership info
   - Unread count is accurate

3. **State Consistency**
   - Message count matches database
   - Member count matches database
   - Unread counts are accurate
   - No duplicates in UI

## Sign-off

Once all scenarios pass:

```
[ ] ChannelsUI: Integration testing passed
[ ] ChannelsBackend: Task 5 complete and tested
[ ] ChannelsFeatures: Task 8 complete and tested
[ ] Lead: All integration tests passed
```

## Troubleshooting

### "Channel not found" error
- Check channel ID in database
- Verify workspace ID is correct
- Verify permissions in channel_members table

### Unread count wrong
- Check channel_read_state table
- Verify last_read_at is being updated on mark-read
- Verify unread calculation includes all messages after last_read_at

### Command not appearing
- Verify command is registered in CommandPalette
- Verify hook is returning correct command list
- Check browser console for errors

### Permission denied on valid operation
- Check workspace_members table for your role
- Check channel_members table for your role
- Verify session userId is correct

## Next Steps After Sign-off
1. Create PR to main branch
2. Request code review
3. Address feedback
4. Merge to main
5. Deploy to staging
6. Full QA testing
