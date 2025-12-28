# Dashboard V2 Architecture Plan

## Overview

Migrate from vanilla TypeScript to Next.js with enhanced fleet control capabilities.
Inspired by AI Maestro's hierarchical naming and color coding system.

## Key Features

### 1. Fleet Overview
- Multi-server visualization with expandable project cards
- Agent cards with real-time status indicators
- Hierarchical grouping based on agent naming (e.g., `backend-api`, `frontend-ui`)

### 2. Agent Status Cards
- Color-coded by project/role hierarchy
- Status badge (online/offline/busy)
- Unread message indicator (red dot, iPhone-style)
- Current task summary from [[SUMMARY]] blocks
- Quick actions: message, spawn similar, view trajectory

### 3. Task Assignment UI
- Drag-and-drop task assignment to agents
- Integration with beads task system
- Visual dependency graph
- Priority indicators (P1-P4 color coding)

### 4. Trajectory Viewer
- Timeline visualization of agent decisions
- Expandable decision nodes
- Context diff viewer
- Replay capability

### 5. Decision Queue
- Pending decisions requiring human input
- Priority-sorted list
- One-click approve/reject
- Bulk actions

## Color Coding System

### Hierarchical Colors (from agent name prefix)
```
backend-*    → Blue (#1264a3)
frontend-*   → Purple (#7c3aed)
infra-*      → Orange (#ea580c)
lead-*       → Green (#2bac76)
test-*       → Teal (#0d9488)
(default)    → Gray (#6b7280)
```

### Status Colors
```
online       → Green dot
offline      → Gray dot
busy         → Yellow dot
error        → Red dot
attention    → Red badge overlay
```

## Tech Stack

### Frontend
- Next.js 14 (App Router)
- React Server Components where applicable
- Tailwind CSS for styling
- Framer Motion for animations
- React Query for data fetching
- WebSocket for real-time updates

### State Management
- Zustand for client state
- React Query for server state
- WebSocket context for real-time

## Directory Structure

```
src/dashboard-v2/
├── app/
│   ├── layout.tsx
│   ├── page.tsx              # Main dashboard
│   ├── fleet/
│   │   └── page.tsx          # Fleet overview
│   ├── agent/[name]/
│   │   └── page.tsx          # Agent detail view
│   ├── trajectory/
│   │   └── page.tsx          # Trajectory viewer
│   └── decisions/
│       └── page.tsx          # Decision queue
├── components/
│   ├── layout/
│   │   ├── Sidebar.tsx
│   │   ├── Header.tsx
│   │   └── CommandPalette.tsx
│   ├── agents/
│   │   ├── AgentCard.tsx
│   │   ├── AgentList.tsx
│   │   └── AgentStatus.tsx
│   ├── fleet/
│   │   ├── FleetOverview.tsx
│   │   ├── ProjectCard.tsx
│   │   └── ServerStatus.tsx
│   ├── messages/
│   │   ├── MessageList.tsx
│   │   ├── MessageComposer.tsx
│   │   └── ThreadPanel.tsx
│   ├── tasks/
│   │   ├── TaskBoard.tsx
│   │   ├── TaskCard.tsx
│   │   └── TaskAssignment.tsx
│   ├── trajectory/
│   │   ├── Timeline.tsx
│   │   ├── DecisionNode.tsx
│   │   └── ContextDiff.tsx
│   └── decisions/
│       ├── DecisionQueue.tsx
│       └── DecisionCard.tsx
├── hooks/
│   ├── useWebSocket.ts
│   ├── useAgents.ts
│   ├── useMessages.ts
│   └── useFleet.ts
├── lib/
│   ├── api.ts
│   ├── colors.ts            # Color coding logic
│   └── hierarchy.ts         # Agent name parsing
└── types/
    └── index.ts
```

## API Endpoints Needed

### Existing (keep)
- `GET /ws` - WebSocket for real-time updates
- `POST /api/send` - Send message
- `POST /api/spawn` - Spawn agent
- `GET /api/spawned` - List spawned agents
- `DELETE /api/spawned/:name` - Release agent

### New (for v2)
- `GET /api/trajectory/:agent` - Agent decision history
- `GET /api/decisions` - Pending decisions queue
- `POST /api/decisions/:id/resolve` - Resolve a decision
- `GET /api/tasks` - Beads integration for task list
- `POST /api/tasks/:id/assign` - Assign task to agent

## Implementation Phases

### Phase 1: Foundation (Current Sprint)
- [ ] Set up Next.js project structure
- [ ] Implement color coding system
- [ ] Create basic layout components
- [ ] Port existing WebSocket logic

### Phase 2: Core Features
- [ ] Agent cards with hierarchy grouping
- [ ] Enhanced message view
- [ ] Fleet overview page
- [ ] Real-time status updates

### Phase 3: Advanced Features
- [ ] Trajectory viewer
- [ ] Decision queue
- [ ] Task assignment UI
- [ ] Beads integration

### Phase 4: Polish
- [ ] Animations and transitions
- [ ] Keyboard shortcuts
- [ ] Mobile responsiveness
- [ ] Performance optimization

## Migration Strategy

1. Build v2 alongside existing dashboard
2. New route: `/v2` or separate port during development
3. Feature parity checkpoint before switching
4. Gradual rollout with feature flags
