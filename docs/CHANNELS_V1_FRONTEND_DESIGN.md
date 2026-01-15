# Channels V1 Frontend Design

## Overview

This document outlines the frontend component architecture for Channels V1 features:
- Task 7: Browse Channels View
- Task 8: Command Palette Integration
- Task 10: Admin Tools & Member Management

## Type Alignment Note

Existing comprehensive types are defined in `src/dashboard/react-components/channels/types.ts`.
New components should align with these types during integration:
- `Channel` - Full channel model with visibility, status, unread counts
- `ChannelMember` - Member with entityType, role, status
- `ChannelMessage` - Messages with attachments, threads, reactions
- `ChannelMemberRole` - 'owner' | 'admin' | 'member'
- `ChannelVisibility` - 'public' | 'private'

## Component Architecture

### 1. Browse Channels View (Task 7)

**File:** `src/dashboard/react-components/ChannelBrowser.tsx`

```typescript
interface ChannelBrowserProps {
  isOpen: boolean;
  onClose: () => void;
  onJoinChannel: (channelId: string) => Promise<void>;
  currentUserId?: string;
}

interface BrowseChannel {
  id: string;
  name: string;
  description?: string;
  memberCount: number;
  isJoined: boolean;
  isPrivate: boolean;
  createdAt: string;
}
```

**Features:**
- Searchable channel list with 300ms debounce
- Pagination (20 channels per page)
- Join/Leave buttons
- Member count display
- Private channel indicator
- Loading and empty states

**Hook:** `src/dashboard/react-components/hooks/useChannelBrowser.ts`

```typescript
interface UseChannelBrowserReturn {
  channels: BrowseChannel[];
  isLoading: boolean;
  error: string | null;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  currentPage: number;
  totalPages: number;
  goToPage: (page: number) => void;
  joinChannel: (channelId: string) => Promise<void>;
  leaveChannel: (channelId: string) => Promise<void>;
  refresh: () => void;
}
```

### 2. Command Palette Integration (Task 8)

**New Commands to Add:**

| Command | Description | Category |
|---------|-------------|----------|
| `/create-channel` | Create a new channel | channels |
| `/join-channel` | Join a channel (with autocomplete) | channels |
| `/leave-channel` | Leave a channel | channels |
| `/channels` | Browse all channels | channels |

**Files to Modify:**
- `src/dashboard/react-components/CommandPalette.tsx` - Add 'channels' category
- Create `src/dashboard/react-components/ChannelCommands.tsx` for modal flows

**Autocomplete Implementation:**

```typescript
interface ChannelAutocomplete {
  query: string;
  results: Array<{
    id: string;
    name: string;
    memberCount: number;
  }>;
  onSelect: (channelId: string) => void;
}
```

### 3. Admin Tools & Member Management (Task 10)

**File:** `src/dashboard/react-components/ChannelAdminPanel.tsx`

```typescript
interface ChannelAdminPanelProps {
  channelId: string;
  isOpen: boolean;
  onClose: () => void;
  currentUserId: string;
}

interface ChannelMemberInfo {
  id: string;
  name: string;
  displayName?: string;
  avatarUrl?: string;
  role: 'admin' | 'member';
  joinedAt: string;
  isAgent: boolean;
}
```

**Components:**
- `MembersList` - Paginated member list with search
- `MemberRow` - Individual member with actions
- `ChannelSettings` - Edit description, topic
- `ConfirmationDialog` - For destructive actions

**Permission Checks:**

```typescript
function canManageChannel(userId: string, channel: ChannelInfo): boolean {
  return channel.creatorId === userId || channel.admins?.includes(userId);
}
```

## API Contracts (Expected from Backend)

### Browse Channels

```typescript
// GET /api/channels/browse?search=&page=1&limit=20
interface BrowseChannelsResponse {
  channels: BrowseChannel[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
```

### Channel Details

```typescript
// GET /api/channels/:channelId
interface ChannelDetailsResponse {
  channel: {
    id: string;
    name: string;
    description?: string;
    topic?: string;
    memberCount: number;
    isPrivate: boolean;
    createdAt: string;
    creatorId: string;
    admins: string[];
  };
  currentUserRole: 'admin' | 'member' | null;
}
```

### Channel Members

```typescript
// GET /api/channels/:channelId/members?page=1&limit=20
interface ChannelMembersResponse {
  members: ChannelMemberInfo[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
```

### Channel Operations

```typescript
// POST /api/channels
interface CreateChannelRequest {
  name: string;
  description?: string;
  isPrivate?: boolean;
}

// POST /api/channels/:channelId/join
// POST /api/channels/:channelId/leave

// DELETE /api/channels/:channelId/members/:memberId
// (Admin only)

// POST /api/channels/:channelId/agents
interface AssignAgentRequest {
  agentName: string;
}

// PATCH /api/channels/:channelId
interface UpdateChannelRequest {
  description?: string;
  topic?: string;
}
```

## UI Patterns

### Debounced Search

```typescript
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);

  return debouncedValue;
}
```

### Confirmation Dialog Pattern

```typescript
interface ConfirmationDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  confirmVariant?: 'danger' | 'primary';
  onConfirm: () => void;
  onCancel: () => void;
  isProcessing?: boolean;
}
```

### Pagination Component

```typescript
interface PaginationProps {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}
```

## Design Tokens (from existing codebase)

```css
/* Colors */
--bg-primary: #11111b
--bg-secondary: #1e1e2e
--bg-tertiary: #313244
--text-primary: #cdd6f4
--text-secondary: #a6adc8
--text-muted: #6c7086
--accent-color: #89b4fa
--accent-cyan: #00d9ff
--border-color: #313244
--error: #f38ba8
```

## Component Hierarchy

```
App
├── CommandPalette (modified)
│   ├── ChannelCommands (new)
│   │   ├── CreateChannelFlow
│   │   └── JoinChannelAutocomplete
│   └── ... existing
├── ChannelBrowser (new - modal)
│   ├── SearchInput
│   ├── ChannelList
│   │   └── ChannelCard (join button)
│   └── Pagination
├── ChannelSidebar (existing - enhanced)
│   └── ChannelAdminPanel (new - slide-over)
│       ├── ChannelSettings
│       ├── MembersList
│       │   └── MemberRow (remove, assign agent)
│       └── ConfirmationDialog
```

## Implementation Order

1. **Phase 1: Foundation**
   - `useDebounce` hook
   - `Pagination` component
   - `ConfirmationDialog` component

2. **Phase 2: Browse View (Task 7)**
   - `useChannelBrowser` hook
   - `ChannelBrowser` component
   - Integrate into App

3. **Phase 3: Command Palette (Task 8)**
   - Add 'channels' category
   - Create command implementations
   - Channel autocomplete

4. **Phase 4: Admin Tools (Task 10)**
   - `useChannelAdmin` hook
   - `ChannelAdminPanel` component
   - `MembersList` with actions

## Testing Considerations

- Unit tests for hooks (useChannelBrowser, useChannelAdmin)
- Integration tests for command palette commands
- Visual tests for responsive design
- Permission enforcement tests

## Responsive Breakpoints

- Mobile: < 768px (stack layouts, full-width modals)
- Tablet: 768px - 1024px (side panels)
- Desktop: > 1024px (multi-column)
