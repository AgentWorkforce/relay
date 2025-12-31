# Proposal: Continuous Claude Integration

**Issue:** agent-relay-317
**Status:** Proposed
**Priority:** 1 (High)
**Type:** Feature Epic

## Executive Summary

Integrate the context management and session continuity system from [Continuous-Claude-v2](https://github.com/parcadei/Continuous-Claude-v2) into Agent Relay. This addresses Claude Code's lossy context compaction problem by implementing explicit state preservation across sessions.

## Problem Statement

Claude Code's automatic context compaction degrades information fidelity over repeated cycles. Each compaction loses nuance and detail. For long-running agent tasks, this leads to:
- Lost architectural decisions
- Forgotten implementation details
- Repeated mistakes
- Broken continuity across sessions

## Continuous-Claude-v2 Core Concepts

### Philosophy: "Clear, Don't Compact"

Instead of relying on lossy summarization, the system:
1. Explicitly saves state before context fills up
2. Clears context completely (`/clear`)
3. Reloads from external files with full fidelity

### Key Components

| Component | Purpose | Persistence |
|-----------|---------|-------------|
| **Ledgers** | Within-session state snapshots | Ephemeral (current session) |
| **Handoffs** | Cross-session transfer documents | Permanent |
| **Artifact Index** | Searchable SQLite+FTS5 database | Permanent |
| **Hooks** | Lifecycle event handlers | Configuration |

### Session Lifecycle

```
SessionStart → Working → PreCompact → Clear → Resume
      ↑                                          |
      └──────────────────────────────────────────┘
```

### Hooks System (6 event types)

| Hook | Trigger | Function |
|------|---------|----------|
| SessionStart | resume/clear/compact | Load ledger, surface learnings |
| PreToolUse | file edits | Validation preflight |
| PreCompact | before context reset | Auto-generate handoff |
| UserPromptSubmit | every message | Skill suggestions, context warnings |
| PostToolUse | after tool execution | Track modifications, index artifacts |
| SessionEnd | session close | Cleanup, learning extraction |

### File Structure

```
thoughts/
├── ledgers/              # Within-session continuity
│   └── CONTINUITY_CLAUDE-*.md
├── shared/
│   ├── handoffs/         # Cross-session transfers
│   │   └── task-*.md
│   └── plans/            # Implementation roadmaps
│       └── plan-*.md
.claude/
└── cache/
    └── artifact-index/   # SQLite+FTS5 search index
        └── context.db
```

## Integration Proposal

### Phase 1: Core Continuity System

**Goal:** Enable session persistence for relay-connected agents

#### 1.1 Directory Structure

Add to relay workspace initialization:

```typescript
// src/workspace/continuity.ts
interface ContinuityPaths {
  ledgers: string;      // thoughts/ledgers/
  handoffs: string;     // thoughts/shared/handoffs/
  plans: string;        // thoughts/shared/plans/
  artifactDb: string;   // .claude/cache/artifact-index/context.db
}

function initializeContinuityDirs(workspacePath: string): ContinuityPaths
```

#### 1.2 Ledger System

```typescript
// src/continuity/ledger.ts
interface Ledger {
  sessionId: string;
  agentName: string;
  currentGoals: string[];
  completedWork: string[];
  keyDecisions: Decision[];
  uncertainItems: string[];  // Prefixed with "UNCONFIRMED:"
  now: string;               // Single current focus
  updatedAt: Date;
}

class LedgerManager {
  loadLedger(agentName: string): Ledger | null;
  saveLedger(ledger: Ledger): void;
  markUncertain(item: string): void;
}
```

#### 1.3 Handoff System

```typescript
// src/continuity/handoff.ts
interface Handoff {
  id: string;
  agentName: string;
  taskDescription: string;
  fileReferences: FileRef[];  // path + line numbers
  recentDecisions: Decision[];
  nextSteps: string[];
  contextSize: number;        // % when created
  createdAt: Date;
}

class HandoffManager {
  createHandoff(agent: string, context: HandoffContext): Handoff;
  loadLatestHandoff(agent: string): Handoff | null;
  indexHandoff(handoff: Handoff): void;  // Add to FTS index
}
```

### Phase 2: Artifact Index (SQLite + FTS5)

**Goal:** Searchable cross-session knowledge

#### 2.1 Schema

```sql
-- Handoffs table
CREATE TABLE handoffs (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  task_description TEXT,
  file_references TEXT,  -- JSON array
  decisions TEXT,        -- JSON array
  next_steps TEXT,       -- JSON array
  context_size INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- FTS5 index for full-text search
CREATE VIRTUAL TABLE handoffs_fts USING fts5(
  task_description,
  decisions,
  next_steps,
  content=handoffs,
  content_rowid=rowid
);

-- Learnings table (optional Braintrust-style)
CREATE TABLE learnings (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  agent_name TEXT,
  category TEXT,  -- 'pattern', 'mistake', 'insight'
  content TEXT,
  created_at DATETIME
);

CREATE VIRTUAL TABLE learnings_fts USING fts5(
  content,
  content=learnings,
  content_rowid=rowid
);
```

#### 2.2 Search API

```typescript
// src/continuity/artifact-index.ts
class ArtifactIndex {
  constructor(dbPath: string);

  // Handoff operations
  indexHandoff(handoff: Handoff): void;
  searchHandoffs(query: string, limit?: number): Handoff[];
  getHandoffsByAgent(agent: string): Handoff[];

  // Learning operations (Phase 3)
  addLearning(learning: Learning): void;
  searchLearnings(query: string): Learning[];
  getLearningsForContext(keywords: string[]): Learning[];
}
```

### Phase 3: Hook Integration

**Goal:** Automatic continuity via Claude Code hooks

#### 3.1 Session Start Hook

```typescript
// hooks/session-start-continuity.ts
async function onSessionStart(event: SessionStartEvent) {
  const agent = getCurrentAgentName();

  // Load ledger
  const ledger = ledgerManager.loadLedger(agent);
  if (ledger) {
    injectContext(`## Session Continuity\n${formatLedger(ledger)}`);
  }

  // Surface relevant learnings
  const learnings = artifactIndex.getLearningsForContext(
    extractKeywords(event.initialPrompt)
  );
  if (learnings.length > 0) {
    injectContext(`## Relevant Learnings\n${formatLearnings(learnings)}`);
  }
}
```

#### 3.2 Pre-Compact Hook

```typescript
// hooks/pre-compact-continuity.ts
async function onPreCompact(event: PreCompactEvent) {
  const agent = getCurrentAgentName();

  // Auto-generate handoff
  const handoff = handoffManager.createHandoff(agent, {
    currentContext: event.context,
    recentFiles: event.modifiedFiles,
    decisions: extractDecisions(event.context)
  });

  // Index for searchability
  artifactIndex.indexHandoff(handoff);

  // Notify via relay
  sendRelayMessage('*', `[HANDOFF] ${agent} created handoff: ${handoff.id}`);
}
```

#### 3.3 Post-Tool-Use Hook

```typescript
// hooks/post-tool-use-tracker.ts
async function onPostToolUse(event: PostToolUseEvent) {
  if (event.tool === 'Edit' || event.tool === 'Write') {
    // Track file modifications for handoff context
    trackFileModification(event.filePath, event.lineNumbers);
  }
}
```

### Phase 4: Dashboard Integration

**Goal:** Visualize continuity state in dashboard

#### 4.1 Components

```typescript
// Ledger viewer
interface LedgerViewerProps {
  agentName: string;
  ledger: Ledger | null;
  onRefresh: () => void;
}

// Handoff browser
interface HandoffBrowserProps {
  agentName?: string;  // Filter by agent
  searchQuery?: string;
  onSelect: (handoff: Handoff) => void;
}

// Context meter (like Continuous-Claude's StatusLine)
interface ContextMeterProps {
  percentage: number;  // 0-100
  // Green <60%, Yellow 60-79%, Red ≥80%
}
```

#### 4.2 API Endpoints

```typescript
// GET /api/continuity/:agent/ledger
// GET /api/continuity/:agent/handoffs
// GET /api/continuity/search?q=<query>
// POST /api/continuity/:agent/handoff
// GET /api/continuity/:agent/learnings
```

### Phase 5: Multi-Agent Orchestration (Advanced)

**Goal:** Plan → Validate → Implement workflow

```typescript
// Orchestration patterns from Continuous-Claude
interface AgentOrchestration {
  planAgent: {
    role: 'Creates implementation plans';
    output: 'thoughts/shared/plans/*.md';
  };
  validateAgent: {
    role: 'RAG-validates against precedent';
    input: 'plan + artifact index search';
  };
  implementAgent: {
    role: 'Executes plan with TDD';
    output: 'code + handoff on completion';
  };
}
```

## Implementation Roadmap

### Milestone 1: Foundation (Core)
- [ ] Directory structure initialization
- [ ] Ledger read/write operations
- [ ] Handoff creation and loading
- [ ] Basic markdown formatting

### Milestone 2: Persistence (Storage)
- [ ] SQLite database setup
- [ ] FTS5 index creation
- [ ] Handoff indexing
- [ ] Search API

### Milestone 3: Automation (Hooks)
- [ ] SessionStart hook
- [ ] PreCompact hook
- [ ] PostToolUse tracker
- [ ] Context percentage detection

### Milestone 4: Visibility (Dashboard)
- [ ] Context meter component
- [ ] Ledger viewer
- [ ] Handoff browser
- [ ] Search interface

### Milestone 5: Intelligence (Advanced)
- [ ] Learning extraction
- [ ] Pattern recognition
- [ ] Orchestration workflows

## Files to Create/Modify

### New Files
```
src/continuity/
├── index.ts
├── ledger.ts
├── handoff.ts
├── artifact-index.ts
└── hooks/
    ├── session-start.ts
    ├── pre-compact.ts
    └── post-tool-use.ts

src/dashboard/react-components/
├── ContextMeter.tsx
├── LedgerViewer.tsx
└── HandoffBrowser.tsx
```

### Modified Files
```
src/workspace/index.ts      # Add continuity initialization
src/daemon/server.ts        # Add continuity API endpoints
src/cli/index.ts            # Add continuity commands
```

## Dependencies

- `better-sqlite3` (already in project)
- No new dependencies required

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Disk space from handoffs | Auto-archive old handoffs, configurable retention |
| FTS index size | Periodic optimization, configurable max entries |
| Hook performance | Async operations, debouncing |
| Breaking existing workflows | Opt-in via config flag initially |

## Success Metrics

1. Agents can resume work after `/clear` without context loss
2. Search finds relevant past decisions in <100ms
3. Context degradation eliminated across 10+ compaction cycles
4. Dashboard shows real-time continuity status

## References

- [Continuous-Claude-v2 README](https://github.com/parcadei/Continuous-Claude-v2)
- [Continuous-Claude-v2 Onboarding](https://github.com/parcadei/Continuous-Claude-v2/blob/main/CLAUDE_ONBOARDING.md)
- [Claude Code Hooks Documentation](https://docs.anthropic.com/en/docs/claude-code/hooks)
