# Channels V1 Integration Guide for UI Teams

## Overview

This guide is for **ChannelsUI** and **ChannelsFeatures** teams. You've built excellent mock components - now we'll integrate them with the real backend API.

**Timeline:** Starts once ChannelsBackend completes Task 4 (Messages API)

**Effort:** 2-3 hours for full integration

**Success:** All components working with real backend data, full E2E test passing

## Current State

### What You Have (✅ Complete)
- `src/dashboard/react-components/channels/` - All UI components:
  - `ChannelSidebarV1.tsx` - Channel list and selection
  - `ChannelHeader.tsx` - Channel info header
  - `ChannelMessageList.tsx` - Message display and threading
  - `MessageInput.tsx` - Message input and sending
  - `ChannelViewV1.tsx` - Main channel view container
  - `ChannelDialogs.tsx` - Modals for creation, editing, member management
  - `ChannelBrowser.tsx` - Browse/discover channels view
  - `ChannelAdminPanel.tsx` - Admin member management
- `src/dashboard/react-components/hooks/` - All custom hooks:
  - `useChannelBrowser.ts` - Browse channels logic
  - `useChannelCommands.ts` - Command palette integration
  - `useChannelAdmin.ts` - Admin operations
  - And more...
- `src/dashboard/react-components/channels/mockApi.ts` - Mock API service
- `src/dashboard/react-components/channels/types.ts` - Complete type definitions

### What Backend Has (✅ Complete)
- Database schema (4 tables with indexes)
- All database queries
- Channel CRUD APIs
- Membership APIs
- **Messages API routes** (being completed as Task 4)

### What's Left (⚠️ In Progress)
1. Backend: Complete Task 4 (Messages API routes) ← **Blocking point**
2. UI Teams: Swap mock API for real API calls
3. All Teams: Integration testing

## Phase 2B: UI Integration Steps

### Step 1: Wait for Task 4 Completion

ChannelsBackend must complete:
- ✅ GET /api/workspaces/:workspaceId/channels/:channelId/messages
- ✅ POST /api/workspaces/:workspaceId/channels/:channelId/messages
- ✅ POST /api/workspaces/:workspaceId/channels/:channelId/read
- ✅ PIN/UNPIN message endpoints
- ✅ Schema migrations (topic, lastActivityAt)

**Check list:** See `docs/TASK_4_MESSAGES_API.md` for complete specification

---

### Step 2: Create Real API Service Module

Once Task 4 is complete, create `src/dashboard/react-components/channels/api.ts`:

```typescript
/**
 * Real API service for Channels V1
 * Replaces mockApi.ts for production use
 */

import type {
  Channel,
  ChannelMessage,
  ListChannelsResponse,
  GetChannelResponse,
  GetMessagesResponse,
  SendMessageRequest,
  SendMessageResponse,
} from './types';

// Get workspace ID from context/props (usually from useSession or similar)
function getWorkspaceId(): string {
  // This depends on your app's context - adjust as needed
  // For now, we'll pass it as a parameter to each function
  throw new Error('Implement getWorkspaceId() from your app context');
}

/**
 * List all channels for current user
 */
export async function listChannels(workspaceId: string): Promise<ListChannelsResponse> {
  const response = await fetch(
    `/api/workspaces/${workspaceId}/channels`,
    { method: 'GET' }
  );
  if (!response.ok) throw new Error(`Failed to list channels: ${response.status}`);
  return response.json();
}

/**
 * Get channel details and members
 */
export async function getChannel(
  workspaceId: string,
  channelId: string
): Promise<GetChannelResponse> {
  const response = await fetch(
    `/api/workspaces/${workspaceId}/channels/${channelId}`,
    { method: 'GET' }
  );
  if (!response.ok) throw new Error(`Failed to get channel: ${response.status}`);

  const data = await response.json();

  // IMPORTANT: Map backend response to frontend types
  return {
    channel: mapChannelFromBackend(data.channel),
    members: data.members || [],
  };
}

/**
 * Get messages in a channel
 */
export async function getMessages(
  workspaceId: string,
  channelId: string,
  options?: { before?: string; limit?: number; threadId?: string }
): Promise<GetMessagesResponse> {
  const params = new URLSearchParams();
  if (options?.before) params.append('before', options.before);
  if (options?.limit) params.append('limit', String(options.limit));
  if (options?.threadId) params.append('threadId', options.threadId);

  const url = `/api/workspaces/${workspaceId}/channels/${channelId}/messages${
    params.toString() ? '?' + params.toString() : ''
  }`;

  const response = await fetch(url, { method: 'GET' });
  if (!response.ok) throw new Error(`Failed to get messages: ${response.status}`);

  const data = await response.json();

  // Map messages from backend format to frontend format
  return {
    messages: data.messages.map(mapMessageFromBackend),
    hasMore: data.hasMore,
    unread: data.unread,
  };
}

/**
 * Send a message
 */
export async function sendMessage(
  workspaceId: string,
  channelId: string,
  request: SendMessageRequest
): Promise<SendMessageResponse> {
  const response = await fetch(
    `/api/workspaces/${workspaceId}/channels/${channelId}/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    }
  );

  if (!response.ok) throw new Error(`Failed to send message: ${response.status}`);

  const data = await response.json();

  return {
    message: mapMessageFromBackend(data.message),
  };
}

/**
 * Mark messages as read
 */
export async function markRead(
  workspaceId: string,
  channelId: string,
  upToTimestamp: string
): Promise<void> {
  const response = await fetch(
    `/api/workspaces/${workspaceId}/channels/${channelId}/read`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upToTimestamp }),
    }
  );

  if (!response.ok) throw new Error(`Failed to mark as read: ${response.status}`);
}

/**
 * Pin a message
 */
export async function pinMessage(
  workspaceId: string,
  channelId: string,
  messageId: string
): Promise<void> {
  const response = await fetch(
    `/api/workspaces/${workspaceId}/channels/${channelId}/messages/${messageId}/pin`,
    { method: 'POST' }
  );

  if (!response.ok) throw new Error(`Failed to pin message: ${response.status}`);
}

/**
 * Unpin a message
 */
export async function unpinMessage(
  workspaceId: string,
  channelId: string,
  messageId: string
): Promise<void> {
  const response = await fetch(
    `/api/workspaces/${workspaceId}/channels/${channelId}/messages/${messageId}/unpin`,
    { method: 'POST' }
  );

  if (!response.ok) throw new Error(`Failed to unpin message: ${response.status}`);
}

// ============================================================================
// Mapping Functions - Convert backend responses to frontend types
// ============================================================================

/**
 * Map channel from backend format to frontend format
 */
function mapChannelFromBackend(backend: any): Channel {
  return {
    id: backend.id,
    name: backend.name,
    description: backend.description,
    topic: backend.topic,
    visibility: backend.isPrivate ? 'private' : 'public',  // ← Map isPrivate → visibility
    status: backend.isArchived ? 'archived' : 'active',    // ← Map isArchived → status
    createdAt: backend.createdAt,
    createdBy: backend.createdById,
    lastActivityAt: backend.lastActivityAt,
    memberCount: backend.memberCount,
    unreadCount: 0,  // TODO: Calculate from channel_read_state
    hasMentions: false,  // TODO: Calculate from messages
    isDm: false,  // Phase 1: No DM support
  };
}

/**
 * Map message from backend format to frontend format
 */
function mapMessageFromBackend(backend: any): ChannelMessage {
  return {
    id: backend.id,
    channelId: backend.channelId,
    from: backend.from,  // Backend already provides 'from' (was senderName)
    fromEntityType: backend.fromEntityType,  // Backend provides this
    fromAvatarUrl: backend.fromAvatarUrl,
    content: backend.content,  // Backend provides 'content' (was body)
    timestamp: backend.timestamp,  // Backend provides 'timestamp' (was createdAt)
    editedAt: backend.editedAt,
    threadId: backend.threadId,
    threadSummary: backend.threadSummary,
    mentions: backend.mentions,
    isPinned: backend.isPinned,
    isRead: backend.isRead ?? true,
  };
}
```

### Step 3: Update Component Imports

In each component that uses the mock API, change:

**Before:**
```typescript
import { listChannels, getMessages, sendMessage } from './mockApi';
```

**After:**
```typescript
import { listChannels, getMessages, sendMessage } from './api';
```

### Step 4: Update Hook Integration

Check these hooks and ensure they use the new API:

- `useChannelBrowser.ts` - Uses `listChannels()` → Update ✅
- `useChannelCommands.ts` - Uses API calls → Update ✅
- `useChannelAdmin.ts` - Uses API calls → Update ✅

Example update for a hook:

```typescript
// Before (using mock)
import { listChannels, createChannel } from '../channels/mockApi';

// After (using real API)
import { listChannels, createChannel } from '../channels/api';

export function useChannelBrowser(workspaceId: string) {
  // Rest of hook stays the same - just using different import
  const [channels, setChannels] = useState<Channel[]>([]);

  useEffect(() => {
    listChannels(workspaceId)  // ← Now calls real API!
      .then(response => setChannels(response.channels))
      .catch(console.error);
  }, [workspaceId]);

  return { channels };
}
```

### Step 5: Test API Responses

Before full integration, test that responses match expected types:

```typescript
// Quick test function
async function testApiMappings() {
  const channels = await listChannels('test-workspace-id');

  // Verify structure
  if (channels.channels[0]) {
    const channel = channels.channels[0];
    console.assert(channel.visibility === 'public' || channel.visibility === 'private');
    console.assert(channel.status === 'active' || channel.status === 'archived');
    console.assert(typeof channel.memberCount === 'number');
  }

  // Verify messages
  if (channels.channels[0]) {
    const messages = await getMessages('ws-id', channels.channels[0].id);
    if (messages.messages[0]) {
      const msg = messages.messages[0];
      console.assert(typeof msg.from === 'string', 'from should be string');
      console.assert(typeof msg.content === 'string', 'content should be string');
      console.assert(typeof msg.timestamp === 'string', 'timestamp should be string');
    }
  }
}
```

---

## Step 6: Integration Testing Checklist

### Channel Operations
- [ ] List channels shows all public channels + private channels user is member of
- [ ] Create channel works with public/private option
- [ ] Archive/unarchive channel works
- [ ] Delete channel removes it from list
- [ ] Channel details load correctly
- [ ] Topic field displays (if set)
- [ ] Last activity timestamp updates

### Messaging
- [ ] Load messages shows previous messages in order
- [ ] Send message creates new message and appears in list
- [ ] Message author info displays correctly
- [ ] Pagination works (load more with cursor)
- [ ] Thread replies work (threadId tracking)
- [ ] Reply count increments on parent message
- [ ] Mark as read updates read state

### Member Management
- [ ] Add member to channel works
- [ ] Remove member from channel works
- [ ] Change member role works
- [ ] Member list shows current members
- [ ] Owner/admin role displays correctly

### Pinned Messages
- [ ] Pin message marks it
- [ ] Unpin message removes mark
- [ ] Pinned messages can be viewed separately
- [ ] Pin status persists after reload

### UI Polish
- [ ] Loading states work correctly
- [ ] Error messages display properly
- [ ] No TypeScript compilation errors
- [ ] Component styles look good with real data
- [ ] Keyboard navigation works
- [ ] Mobile responsive layout works

---

## Known Gotchas

### 1. Workspace ID Passing

The real API requires workspace ID in every call. Make sure to:
- Get workspace ID from session/context
- Pass it to all API functions
- Update hook signatures if needed

### 2. User ID for Message Author

When sending messages, the backend uses the logged-in user ID automatically. The frontend should:
- Not try to set the `from` field manually
- Trust that backend returns correct `from` and `fromAvatarUrl`

### 3. Admin vs Owner Role

- Backend has: `'admin' | 'member' | 'read_only'`
- Frontend has: `'owner' | 'admin' | 'member'`
- Mapping: In API responses, convert `admin` role to `owner` for the channel creator

### 4. Unread Count Calculation

Phase 1 doesn't fully implement unread count aggregation. You may need to:
- Calculate locally in the component
- Query `channel_read_state` separately if needed
- Or wait for Phase 2 API enhancement

---

## Communication with Backend Team

If you find issues during integration:

1. **Field mapping problems** → Check `mapChannelFromBackend()` and `mapMessageFromBackend()`
2. **Missing data** → Request in docs/CHANNELS_V1_INTEGRATION_GUIDE.md
3. **API contract changes** → Update `api.ts` mapping functions
4. **Type mismatches** → Check `src/dashboard/react-components/channels/types.ts`

---

## What ChannelsFeatures Team Should Do

Once UI integration is working:

1. **Integration Test Scenarios**
   - Run through complete user journeys
   - Test edge cases (empty channels, long messages, many members)
   - Test permission boundaries (what admins can do vs regular members)

2. **Admin Tools Testing**
   - Verify ChannelAdminPanel works with real data
   - Test member management operations
   - Test channel archival workflows

3. **Command Palette Testing**
   - Test /create, /join, /leave, /channels commands
   - Verify they update UI correctly
   - Test autocomplete suggestions

4. **End-to-End Scenarios**
   - Create → Join → Message → Reply → Pin → Archive workflow
   - Multi-user scenarios (if possible with multiple sessions)
   - Error recovery scenarios

---

## Success Criteria

- [ ] All components render without errors
- [ ] Real API calls work for all operations
- [ ] Type mappings are correct (no TS errors)
- [ ] Data persists correctly (refresh and see same data)
- [ ] All user workflows complete successfully
- [ ] Error handling works properly
- [ ] Performance is acceptable (no excessive API calls)
- [ ] Code passes linting and builds successfully

---

## Timeline

```
Phase 2A (ChannelsBackend)
  ├─ Task 4 Implementation: 2-3 hours
  ├─ Task 4 Testing: 1 hour
  └─ Code Review: 30 mins
  └─> Ready for integration

Phase 2B (ChannelsUI + ChannelsFeatures) - Parallel
  ├─ API module creation: 30 mins
  ├─ Component updates: 1 hour
  ├─ Hook integration: 1 hour
  ├─ Testing: 1-2 hours
  └─> Ready for E2E

Phase 2C (All Teams)
  ├─ E2E Integration Testing: 1-2 hours
  ├─ Bug fixes: 1 hour
  └─> Ready for Merge
```

---

## Next Steps

1. **Wait** for ChannelsBackend to complete Task 4
2. **Review** this guide and `docs/TASK_4_MESSAGES_API.md`
3. **Create** `src/dashboard/react-components/channels/api.ts` with real API calls
4. **Update** all hooks and components to use new API
5. **Test** thoroughly with real backend
6. **Report** any issues or mapping problems
7. **Submit** for final review and merge

Good luck! 🚀

