# Channels V1 Integration Checklist

## Pre-Integration: Task Completion Verification

### Task 4 Completion (Backend Messages API)
- [ ] All 21 API endpoints implemented
- [ ] Database schema with 4 tables created
- [ ] Migrations 0012 & 0013 applied
- [ ] TypeScript compilation successful (0 errors in channels.ts)
- [ ] All routes registered in `src/cloud/server.ts`

**Endpoint Verification:**
- [ ] Channel CRUD: `GET /api/workspaces/:wId/channels`, `POST`, `PATCH`, `DELETE`
- [ ] Membership: `GET /members`, `POST /join`, `POST /leave`, `POST /members` (add), `DELETE`
- [ ] Messages: `GET /messages`, `POST /messages`, `GET /messages/:msgId`, `DELETE`
- [ ] Pin/Unpin: `POST /pin`, `POST /unpin`
- [ ] Read State: `POST /read` (mark as read)

### UI Integration: Task 4 Wrap-up
- [ ] `ChannelViewV1.tsx` - Real API calls for channel data
- [ ] `ChannelSidebarV1.tsx` - Real API for channel list
- [ ] `ChannelMessageList.tsx` - Real API for messages
- [ ] `MessageInput.tsx` - Real API for sending messages
- [ ] `useChannelBrowser.ts` - Real API for browsing
- [ ] All hooks updated with real API endpoints
- [ ] Mock API references removed from active code

**API Swap Verification:**
- [ ] No more `mockApi.ts` imports in active components
- [ ] All HTTP calls use correct endpoints
- [ ] Workspace ID passed correctly to API calls
- [ ] Error handling for API failures
- [ ] Loading states working correctly

### Task 5 Completion (Backend Unread State)
- [ ] Unread count calculation logic implemented
- [ ] `POST /api/workspaces/:wId/channels/:chId/read` - Mark as read endpoint
- [ ] Channel list returns `unreadCount` per channel
- [ ] Channel get returns `unreadCount` and `hasMentions`
- [ ] `channelReadState` queries implemented in drizzle.ts
- [ ] Database updates on message send (lastActivityAt)

### Task 8 Completion (Command Palette Integration)
- [ ] 4 new commands registered: `/create-channel`, `/join-channel`, `/leave-channel`, `/channels`
- [ ] Commands wired to real API calls
- [ ] Command modals functional
- [ ] Autocomplete working
- [ ] Commands appear in palette

## Integration Testing: Full Feature Test

### Basic Functionality
- [ ] Create a new channel
- [ ] Join a public channel
- [ ] See channel in sidebar
- [ ] Send a message in channel
- [ ] Message appears in real-time
- [ ] Refresh page - messages persist
- [ ] See unread count badge
- [ ] Mark channel as read - badge disappears

### User Experience
- [ ] Channels load immediately
- [ ] No console errors
- [ ] No broken UI elements
- [ ] Loading states display correctly
- [ ] Error states display correctly
- [ ] Empty states display correctly

### Membership
- [ ] Create channel → creator is admin
- [ ] User can join public channel
- [ ] User can leave channel
- [ ] Admin can invite another user
- [ ] Admin can remove member
- [ ] Admin can promote/demote member role

### Messages
- [ ] Send message with text
- [ ] Send message with mentions (prep for Task 6)
- [ ] Send message with thread reply
- [ ] Edit message (if implemented)
- [ ] Delete message (if implemented)
- [ ] Pin important message
- [ ] Pinned messages display

### Command Palette
- [ ] `/create-channel` opens modal
- [ ] `/join-channel` shows autocomplete
- [ ] `/leave-channel` leaves current channel
- [ ] `/channels` opens browse view

## Code Quality Checklist

### TypeScript
- [ ] No TypeScript errors in channels-related files
- [ ] All types properly imported
- [ ] No `any` types used
- [ ] Props interfaces properly defined

### React Components
- [ ] Named exports (not default)
- [ ] JSDoc comments on components
- [ ] Props interface defined above component
- [ ] Functional components with hooks
- [ ] No unnecessary re-renders
- [ ] useCallback used for event handlers
- [ ] useMemo used for expensive computations

### API Layer
- [ ] Consistent error handling
- [ ] Proper HTTP status codes
- [ ] Request validation
- [ ] Permission checks
- [ ] Database migrations are idempotent

### Testing
- [ ] No console warnings
- [ ] No console errors
- [ ] Browser dev tools clean
- [ ] Network requests look correct
- [ ] API responses match types

## Documentation Updates

- [ ] CHANNELS_V1_SPEC.md - Any spec changes documented
- [ ] CHANNELS_V1_INTEGRATION_GUIDE.md - Updated with real API details
- [ ] Component JSDoc comments
- [ ] API endpoint documentation

## Final Verification

### Build & Runtime
- [ ] `npm run build` completes successfully
- [ ] No TypeScript errors
- [ ] No build warnings
- [ ] Server starts without errors
- [ ] Dashboard loads without console errors

### Git
- [ ] All files staged for commit
- [ ] Commit message is clear and comprehensive
- [ ] No sensitive data in commit
- [ ] Commit only includes Channels V1 work

### PR Readiness
- [ ] Branch: `feature/channels-v1`
- [ ] Based on: `main`
- [ ] All changes tracked
- [ ] Ready for PR review

## Team Sign-off

- [ ] **ChannelsBackend**: Task 5 complete, all endpoints working
- [ ] **ChannelsUI**: Integration complete, real API functional
- [ ] **ChannelsFeatures**: Task 8 complete, commands working
- [ ] **Lead**: All integration tests passing, ready to commit

## Sign-off

- [ ] Integration Lead: _______ Date: _______
- [ ] ChannelsBackend Lead: _______ Date: _______
- [ ] ChannelsUI Lead: _______ Date: _______
- [ ] ChannelsFeatures Lead: _______ Date: _______

---

**Next Steps After Sign-off:**
1. Create PR to main
2. Request code review
3. Address review comments
4. Merge to main once approved
5. Deploy to cloud environment
