# Train of Thought Trajectories: Design Proposal

## Executive Summary

Store the complete "trajectory" of agent work on tasks - prompts, reasoning, inter-agent messages, tool calls, decisions, and retrospectives - as first-class artifacts that travel with the code and provide long-term value for debugging, code review, onboarding, and institutional memory.

**Key principle: Platform agnostic.** Trajectories are a universal format - like Markdown for documentation. They work with any task system (Beads, Linear, Jira, GitHub Issues, plain text) and export to any reading format (Notion-like pages, Linear-like timelines, raw JSON).

---

## Vision: Notion/Linear for Agent Work

Think of trajectories as **the document layer for agent work**:

| Tool | For Humans | Trajectory Equivalent for Agents |
|------|------------|----------------------------------|
| Notion | Knowledge base, docs | Readable narrative of work |
| Linear | Issue tracking, timelines | Task progress with full context |
| Git | Version history | Decision history with reasoning |

A trajectory is a **living document** that:
- Agents write to as they work
- Humans read to understand
- Tools index for search and analysis
- Systems import/export freely

---

## Reading Experience: Multiple Views

The same trajectory data can be rendered in multiple ways for different audiences:

### Notion-style Page (Human Documentation)

A rich, readable document with collapsible sections:

```
┌─────────────────────────────────────────────────────────────────┐
│ 🛤️ Implement User Authentication                               │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                                 │
│ 📋 Summary                                                      │
│ JWT-based auth with refresh tokens. 2h 34m. Confidence: 85%    │
│                                                                 │
│ ▶ Key Decisions (3)                                            │
│ ▶ Chapters (4)                                                 │
│ ▶ Retrospective                                                │
│                                                                 │
│ 🔗 Links: ENG-456 • PR #123 • 3 commits                        │
└─────────────────────────────────────────────────────────────────┘
```

### Linear-style Timeline (Progress Tracking)

Chronological view with status:

```
┌─────────────────────────────────────────────────────────────────┐
│  ● 10:00  Started: Implement User Authentication               │
│  │                                                              │
│  ├─ 10:05  Chapter: Research existing patterns                 │
│  │         Found 3 auth approaches, chose JWT                  │
│  │                                                              │
│  ├─ 10:30  Decision: JWT over sessions                         │
│  │         "Stateless scaling requirement"                     │
│  │                                                              │
│  ├─ 11:00  Chapter: Implementation                             │
│  │         Modified 8 files                                    │
│  │                                                              │
│  ├─ 12:00  Message: @Bob review request                        │
│  │                                                              │
│  ○ 12:30  Completed with retrospective                         │
└─────────────────────────────────────────────────────────────────┘
```

### Git-integrated View (Code Review)

Embedded in PRs and commits:

```markdown
## 📍 Trajectory Context

This PR implements [ENG-456] as part of trajectory `traj_abc123`.

**Why this approach:** JWT chosen over sessions for stateless scaling.
See [full trajectory](link) for decision history.

**Agent confidence:** 85% - solid implementation, suggest load testing
the refresh token rotation.
```

### CLI View (Agent/Developer)

```bash
$ agent-relay trajectory status

Active Trajectory: traj_abc123
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Task:     Implement user authentication
Source:   linear:ENG-456
Started:  2h 34m ago
Agents:   Alice (active), Bob (reviewing)
Chapters: 4 (current: "Testing")
Decisions: 3 recorded
```

---

## The Problem

When an agent completes a task today, the only artifacts are:
1. **Code changes** - the what, but not the why
2. **Commit messages** - brief summaries
3. **PR descriptions** - static snapshots
4. **Chat logs** - ephemeral, lost when sessions end

The rich context of *how* the work happened disappears:
- Why was approach A chosen over B?
- What dead ends were explored?
- What assumptions were made?
- How did agents coordinate?
- What would the agent do differently?

This is the "train of thought trajectory" - the complete story of the work.

---

## Core Concept: Trajectories

A **trajectory** is a structured record of an agent's work on a task:

```typescript
interface Trajectory {
  id: string;                    // UUID
  version: 1;                    // Schema version (for forward compat)

  // Task reference (platform-agnostic)
  task: TaskReference;

  // Timeline
  startedAt: string;             // ISO timestamp
  completedAt?: string;
  status: 'active' | 'completed' | 'abandoned';

  // Participants
  agents: AgentParticipation[];  // Who worked on this

  // The trajectory itself
  chapters: Chapter[];           // Logical segments of work

  // Synthesis
  retrospective?: Retrospective; // Agent reflection

  // Artifacts
  commits: string[];             // Git SHAs produced
  filesChanged: string[];        // Paths modified

  // Metadata
  projectId: string;
  tags: string[];                // User-defined tags
}

/**
 * Platform-agnostic task reference.
 * Trajectories work with ANY task system.
 */
interface TaskReference {
  // Human-readable
  title: string;
  description?: string;

  // External system reference (optional)
  source?: {
    system: 'beads' | 'linear' | 'jira' | 'github' | 'plain' | string;
    id: string;                  // e.g., "bd-123", "ENG-456", "GH#789"
    url?: string;                // Link to external system
  };

  // If no external system, trajectory IS the task
  // (standalone mode - like a Notion page)
}

interface Chapter {
  id: string;
  title: string;                 // "Initial exploration", "Implementation", etc.
  agentName: string;
  startedAt: string;
  endedAt?: string;

  events: TrajectoryEvent[];     // Ordered list of events
}

interface TrajectoryEvent {
  ts: number;
  type: 'prompt' | 'thinking' | 'tool_call' | 'tool_result' |
        'message_sent' | 'message_received' | 'decision' | 'error';

  // Type-specific data
  content: string;               // Human-readable summary
  raw?: unknown;                 // Full data (optional, for debugging)

  // Annotations
  significance?: 'low' | 'medium' | 'high' | 'critical';
  tags?: string[];
}

interface Retrospective {
  summary: string;               // What was accomplished
  approach: string;              // How it was done
  decisions: Decision[];         // Key decision points
  challenges: string[];          // What was hard
  learnings: string[];           // What was learned
  suggestions: string[];         // What could be improved
  confidence: number;            // 0-1, agent's confidence in solution
  timeSpent?: string;            // Duration
}

interface Decision {
  question: string;              // What was the choice?
  chosen: string;                // What was picked
  alternatives: string[];        // What was rejected
  reasoning: string;             // Why
}
```

---

## Universal File Format: `.trajectory`

Trajectories are stored as **self-contained documents** in a simple, portable format:

### File Structure

```
my-feature.trajectory.json     # Machine-readable (primary)
my-feature.trajectory.md       # Human-readable (generated)
```

Or bundled:
```
my-feature.trajectory/
├── trajectory.json            # Full data
├── README.md                  # Human summary
├── chapters/
│   ├── 01-exploration.md      # Chapter narratives
│   └── 02-implementation.md
└── artifacts/                 # Referenced files (optional)
```

### JSON Format (Primary)

```json
{
  "$schema": "https://agent-relay.dev/schemas/trajectory-v1.json",
  "version": 1,
  "id": "traj_abc123",
  "task": {
    "title": "Implement user authentication",
    "source": {
      "system": "linear",
      "id": "ENG-456",
      "url": "https://linear.app/team/issue/ENG-456"
    }
  },
  "startedAt": "2024-01-15T10:00:00Z",
  "status": "completed",
  "agents": [...],
  "chapters": [...],
  "retrospective": {...}
}
```

### Markdown Format (Human-Readable)

Auto-generated, Notion-like document:

```markdown
# 🛤️ Trajectory: Implement user authentication

> **Task:** [ENG-456](https://linear.app/team/issue/ENG-456)
> **Status:** ✅ Completed
> **Duration:** 2h 34m
> **Agents:** Alice, Bob
> **Confidence:** 85%

---

## 📋 Summary

Implemented JWT-based authentication with refresh tokens. Chose JWTs over
sessions for stateless scaling. Key challenge was fixing existing type
definitions that were incorrect.

---

## 🎯 Key Decisions

### JWT vs Sessions
- **Chose:** JWT with refresh tokens
- **Rejected:** Server-side sessions
- **Why:** Stateless scaling requirement, multi-server deployment planned

---

## 📖 Chapters

### 1. Initial Exploration (10:00 - 10:30)
Researched existing auth patterns in codebase. Found 3 different approaches
already in use. Decided to follow the pattern in `src/auth/oauth.ts`.

### 2. Implementation (10:30 - 12:00)
[Detailed narrative...]

---

## 🔄 Retrospective

**What went well:** Clean implementation, good test coverage.
**Challenges:** UserContext types were wrong, had to fix first.
**Would do differently:** Check existing types earlier in process.
```

---

## Task Source Adapters

Trajectories are **decoupled from task systems**. Adapters translate between systems:

```typescript
interface TaskSourceAdapter {
  name: string;  // 'beads', 'linear', 'github', etc.

  // Detect if this source is available
  detect(): Promise<boolean>;

  // Get task details for trajectory
  getTask(id: string): Promise<TaskReference>;

  // Listen for task state changes (optional)
  onTaskStart?(callback: (task: TaskReference) => void): void;
  onTaskComplete?(callback: (taskId: string) => void): void;

  // Sync trajectory status back to source (optional)
  updateTaskStatus?(taskId: string, status: string): Promise<void>;
}
```

### Built-in Adapters

| Adapter | Detection | Features |
|---------|-----------|----------|
| `beads` | `.beads/` dir | Full sync, auto-start on `bd update` |
| `github` | `.git` + `gh` CLI | Link to issues/PRs |
| `linear` | `LINEAR_API_KEY` env | Two-way sync |
| `jira` | `JIRA_URL` env | Read-only (start) |
| `plain` | Always available | Manual task creation |

### Example: Standalone Mode (No External System)

```bash
# Create a trajectory without any task system
agent-relay trajectory new "Refactor payment module"

# The trajectory IS the task - like a Notion page
```

### Example: Beads Integration

```bash
# Beads task triggers trajectory automatically
bd update bd-123 --status=in_progress
# → Trajectory starts, linked to bd-123

bd close bd-123
# → Trajectory completes, retrospective prompted
```

### Example: Linear/Jira Integration

```bash
# Explicit link to external task
agent-relay trajectory start --linear ENG-456 "Implement feature"

# Or auto-detect from branch name
git checkout -b feature/ENG-456-auth
agent-relay trajectory start  # Auto-links to ENG-456
```

---

## How Trajectories Help

### 1. Code Review

**Before:** Reviewer sees a PR with 500 lines changed. Has to guess at intent.

**After:** Reviewer can:
- Read the trajectory summary
- See what alternatives were considered
- Understand why specific patterns were chosen
- Ask pointed questions based on documented decisions
- Trust the agent's confidence score

```markdown
## Trajectory Summary for bd-123

**Approach:** Used React Query instead of Redux for server state because
the codebase already has 3 different state management patterns and RQ
is isolated to this feature.

**Key Decisions:**
1. Cache invalidation: Chose optimistic updates over refetch because
   user feedback latency was the primary concern
2. Error handling: Retry 3x with exponential backoff, then show inline
   error (not toast) per UX guidelines in docs/STYLE.md

**Challenges:** The existing UserContext wasn't typed properly. Fixed
types as prerequisite work.

**Confidence:** 0.85 - Solid solution, but cache invalidation edge cases
should be tested under load.
```

### 2. Bug Diagnosis

**Scenario:** A bug is found 3 months after the feature shipped.

**Before:** Developer has to:
- Read git blame
- Guess at original intent
- Maybe find a stale PR description
- Reconstruct reasoning from scratch

**After:** Developer can:
- Query: "show me the trajectory for the commit that introduced this function"
- See the original requirements
- See what edge cases were considered (and maybe missed)
- See the agent's confidence and caveats
- Understand the context that led to this code

```bash
# Find trajectory for a specific change
agent-relay trajectory --commit abc123
agent-relay trajectory --file src/auth/session.ts --since 2024-01

# See what the agent was thinking
agent-relay trajectory bd-456 --show-thinking
```

### 3. Future Changes

**Scenario:** Need to extend a feature built by a different agent/developer.

**Before:** Start from scratch understanding the code.

**After:**
- Read the trajectory to understand architectural decisions
- See what approaches were rejected (and why - so you don't repeat them)
- Understand the constraints that shaped the original design
- Build on documented reasoning rather than guessing

### 4. Institutional Memory

Over time, trajectories become a knowledge base:
- "How have we solved caching problems before?"
- "What patterns did we use for authentication?"
- "What libraries did we evaluate for X?"

```bash
# Search across all trajectories
agent-relay trajectory search "rate limiting"
agent-relay trajectory search --tag "api-design"
```

### 5. Packaging with Code

Trajectories should live **with the code**, not in a separate system:

```
project/
├── src/
├── .beads/
│   └── issues.jsonl
├── .trajectories/
│   ├── index.json              # Index of all trajectories
│   ├── bd-123.json             # Full trajectory
│   ├── bd-123.summary.md       # Human-readable summary
│   └── bd-456.json
└── README.md
```

**Git integration:**
- Trajectories are committed with the code
- They're part of the repo's history
- They can be reviewed in PRs
- They're searchable via git grep

**Alternatively**, for large repos, store only summaries in git and full trajectories in external storage (S3, database) with references:

```json
{
  "id": "bd-123",
  "summary": "...",
  "fullTrajectoryUrl": "s3://trajectories/project/bd-123.json"
}
```

---

## Storage Architecture

### Storage Backends

Trajectories support multiple storage backends:

| Backend | Use Case | Notes |
|---------|----------|-------|
| **File system** | Default, git-friendly | `.trajectories/` in repo |
| **SQLite** | Local indexing, search | Same DB as messages |
| **PostgreSQL** | Multi-user, cloud | Shared team access |
| **S3/GCS** | Archive, large teams | Cold storage for old trajectories |

### File System (Default)

```
.trajectories/
├── index.json                    # Quick lookup index
├── active/                       # In-progress trajectories
│   └── traj_abc123.json
├── completed/                    # Finished trajectories
│   ├── 2024-01/
│   │   ├── traj_def456.json
│   │   └── traj_def456.md        # Human-readable export
│   └── 2024-02/
└── archive/                      # Compressed old trajectories
```

### SQLite Schema

For search and querying:

```sql
CREATE TABLE trajectories (
  id TEXT PRIMARY KEY,
  task_source TEXT,                -- 'beads', 'linear', 'github', etc.
  task_id TEXT,                    -- External task ID (nullable for standalone)
  task_title TEXT NOT NULL,
  project_id TEXT NOT NULL,

  started_at INTEGER NOT NULL,
  completed_at INTEGER,

  -- Denormalized for queries
  agent_names TEXT,                -- JSON array
  commit_shas TEXT,                -- JSON array
  files_changed TEXT,              -- JSON array

  -- Full data
  chapters TEXT NOT NULL,          -- JSON
  retrospective TEXT,              -- JSON

  -- Metadata
  version INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_trajectories_task ON trajectories(task_id);
CREATE INDEX idx_trajectories_project ON trajectories(project_id);
CREATE INDEX idx_trajectories_started ON trajectories(started_at);
```

### New Table: `trajectory_events`

For efficient querying of individual events:

```sql
CREATE TABLE trajectory_events (
  id TEXT PRIMARY KEY,
  trajectory_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,

  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  agent_name TEXT NOT NULL,

  content TEXT NOT NULL,
  raw TEXT,                        -- Full JSON (optional)
  significance TEXT,
  tags TEXT,                       -- JSON array

  FOREIGN KEY (trajectory_id) REFERENCES trajectories(id)
);

CREATE INDEX idx_events_trajectory ON trajectory_events(trajectory_id);
CREATE INDEX idx_events_type ON trajectory_events(type);
CREATE INDEX idx_events_ts ON trajectory_events(ts);
```

### Storage Adapter Extension

```typescript
interface TrajectoryStorageAdapter extends StorageAdapter {
  // Trajectory CRUD
  saveTrajectory(trajectory: Trajectory): Promise<void>;
  getTrajectory(id: string): Promise<Trajectory | null>;
  getTrajectoryByTaskId(taskId: string): Promise<Trajectory | null>;

  // Queries
  listTrajectories(query: TrajectoryQuery): Promise<TrajectorySummary[]>;
  searchTrajectories(text: string): Promise<TrajectorySummary[]>;

  // Events (for streaming/incremental updates)
  appendEvent(trajectoryId: string, event: TrajectoryEvent): Promise<void>;
  getEvents(trajectoryId: string, since?: number): Promise<TrajectoryEvent[]>;

  // Export
  exportTrajectory(id: string, format: 'json' | 'markdown'): Promise<string>;
}
```

---

## Capture Mechanisms

### 1. Automatic Capture (Wrapper-Level)

The tmux wrapper already intercepts output. Extend it to capture:

```typescript
// In tmux-wrapper.ts
class TrajectoryCapture {
  private currentTrajectory?: Trajectory;
  private currentChapter?: Chapter;

  // Called when agent starts work on a task
  startTrajectory(taskId: string, taskTitle: string): void;

  // Called for each significant event
  recordEvent(event: Omit<TrajectoryEvent, 'ts'>): void;

  // Called when switching focus
  startChapter(title: string): void;

  // Called when task completes
  endTrajectory(): void;
}
```

### 2. Explicit Agent Output

Agents can emit structured trajectory data:

```
[[TRAJECTORY:event]]
{
  "type": "decision",
  "content": "Chose PostgreSQL over SQLite for production scaling",
  "significance": "high",
  "alternatives": ["SQLite with read replicas", "MySQL"],
  "reasoning": "Team already has PG expertise, and we need JSONB for the schema"
}
[[/TRAJECTORY]]
```

### 3. Message Integration

Inter-agent messages are automatically captured:

```typescript
// When routing a message
router.on('message', (envelope) => {
  trajectoryCapture.recordEvent({
    type: envelope.from === currentAgent ? 'message_sent' : 'message_received',
    content: envelope.payload.body,
    agentName: envelope.from,
    significance: 'medium'
  });
});
```

### 4. Task System Integration

Trajectories link to external task systems via adapters:

```typescript
// Any adapter can trigger trajectory lifecycle
taskAdapter.onTaskStart((task: TaskReference) => {
  trajectoryCapture.startTrajectory(task);
});

taskAdapter.onTaskComplete((taskId: string) => {
  trajectoryCapture.endTrajectory();
  promptForRetrospective();
});

// Example: Beads adapter watches for 'bd update/close'
// Example: Linear adapter polls API or uses webhooks
// Example: GitHub adapter watches for issue state changes
```

---

## Retrospectives

Encourage agents to reflect by:

### 1. Automatic Prompting

When an agent completes a task (via any task system or manually), inject:

```
📝 RETROSPECTIVE REQUEST

You just completed: "Implement user authentication"

Please reflect on your work by outputting a retrospective:

[[RETROSPECTIVE]]
{
  "summary": "What did you accomplish?",
  "approach": "How did you approach it?",
  "decisions": [
    {"question": "...", "chosen": "...", "alternatives": [...], "reasoning": "..."}
  ],
  "challenges": ["What was difficult?"],
  "learnings": ["What did you learn?"],
  "suggestions": ["What could be improved?"],
  "confidence": 0.85
}
[[/RETROSPECTIVE]]
```

### 2. Structured Templates

Provide templates that make it easy:

```typescript
const RETROSPECTIVE_TEMPLATE = {
  prompts: {
    summary: "Summarize what was accomplished in 1-2 sentences",
    approach: "Describe the high-level approach taken",
    decisions: "List the key decisions made and why",
    challenges: "What was unexpectedly difficult?",
    learnings: "What would you do differently next time?",
    suggestions: "Any improvements for the codebase or process?",
    confidence: "Rate your confidence in the solution (0-1)"
  }
};
```

### 3. Gamification (Optional)

- Track retrospective completion rates per agent
- Show "trajectory completeness" scores
- Surface trajectories that lack retrospectives

---

## CLI Commands

```bash
# Start tracking a task
agent-relay trajectory start bd-123 "Implement auth module"

# View current trajectory
agent-relay trajectory status

# Add a decision point manually
agent-relay trajectory decision "Chose JWT over sessions" \
  --reasoning "Stateless scaling requirements" \
  --alternatives "sessions" "oauth tokens"

# Complete and generate retrospective
agent-relay trajectory complete bd-123

# Export for code review
agent-relay trajectory export bd-123 --format markdown > trajectory.md

# Search trajectories
agent-relay trajectory search "authentication"
agent-relay trajectory list --agent Alice --since 2024-01-01

# View trajectory for a commit
agent-relay trajectory --commit abc123

# Package trajectories for PR
agent-relay trajectory bundle bd-123 bd-124 --output pr-trajectories.md
```

---

## Export Formats

### Markdown (for PRs and docs)

```markdown
# Trajectory: Implement User Authentication (bd-123)

**Duration:** 2 hours 34 minutes
**Agents:** Alice (lead), Bob (review)
**Commits:** abc123, def456
**Confidence:** 0.85

## Summary

Implemented JWT-based authentication with refresh tokens...

## Key Decisions

### 1. JWT vs Sessions
**Chose:** JWT with refresh tokens
**Rejected:** Server-side sessions
**Reasoning:** Stateless scaling requirement, multiple server deployment planned

### 2. Token Storage
**Chose:** HttpOnly cookies
**Rejected:** localStorage
**Reasoning:** XSS protection more important than API flexibility

## Challenges

- Existing UserContext types were incorrect, required fixing first
- Rate limiting middleware had race condition, refactored

## Retrospective

The implementation is solid but the refresh token rotation logic
should be tested more thoroughly under load. Consider adding
integration tests for the token refresh flow.
```

### JSON (for tooling)

Full structured format for programmatic access.

### Git Notes (experimental)

Attach trajectory summaries to commits via git notes:

```bash
git notes add -m "$(agent-relay trajectory export abc123 --format summary)" abc123
```

---

## Privacy & Security Considerations

1. **Thinking blocks:** May contain sensitive reasoning. Option to redact or summarize.

2. **Credentials:** Trajectory capture must never log secrets. Sanitize:
   - Environment variables
   - API keys
   - Passwords in commands

3. **Retention:** Configurable retention periods. Old trajectories can be:
   - Archived (compressed, moved to cold storage)
   - Summarized (keep retrospective, delete events)
   - Deleted

4. **Access control:** In multi-tenant scenarios, trajectories should respect permissions.

---

## Migration Path

### Phase 1: Foundation
- Define trajectory JSON schema (v1)
- File-based storage (`.trajectories/` directory)
- CLI: `trajectory new`, `trajectory status`, `trajectory complete`
- Manual capture via `[[TRAJECTORY:*]]` blocks

### Phase 2: Task Adapters
- Beads adapter (auto-start on `bd update --status=in_progress`)
- GitHub adapter (link to issues/PRs)
- Plain adapter (standalone trajectories)
- Adapter plugin interface for custom systems

### Phase 3: Automatic Capture
- Message capture from router
- Retrospective prompting on task complete
- SQLite indexing for search

### Phase 4: Human-Readable Layer
- Markdown export (Notion-style pages)
- Timeline view (Linear-style)
- PR/commit integration
- Trajectory viewer in dashboard

### Phase 5: Intelligence
- Auto-summarization (LLM-generated summaries)
- Decision extraction from conversation
- Cross-trajectory search and analysis
- Similarity detection ("how did we solve this before?")

---

## Open Questions

1. **Storage location:** `.trajectories/` in repo vs external database?
   - In-repo: Versioned with code, but bloats repo
   - External: Scalable, but requires infra

2. **Granularity:** How much detail to capture?
   - Every tool call? Just summaries?
   - Full thinking blocks? Summarized?

3. **Multi-agent coordination:** How to merge trajectories when agents collaborate?
   - One trajectory per task, multiple chapters per agent?
   - Separate trajectories with cross-references?

4. **Real-time vs batch:** Capture incrementally or at end?
   - Incremental: Survives crashes, but more I/O
   - Batch: Simpler, but loses data on failure

5. **Retrospective quality:** How to encourage thoughtful retrospectives?
   - Structured prompts?
   - Required fields?
   - Quality scoring?

---

## Success Metrics

1. **Adoption:** % of closed tasks with trajectories
2. **Completeness:** Avg retrospective quality score
3. **Utility:** How often trajectories are referenced in code review
4. **Bug resolution:** Time to understand bugs in code with trajectories vs without
5. **Onboarding:** Time for new developers to understand features with trajectories

---

## Conclusion

Train of thought trajectories transform ephemeral agent work into durable knowledge. By capturing the *why* alongside the *what*, we create a searchable, reviewable, portable record that:

- Makes code review meaningful
- Accelerates bug diagnosis
- Preserves institutional knowledge
- Enables learning from past work
- Builds trust in agent-generated code

The key insight is that **the trajectory is as valuable as the code**. Just as we version control source, we should version control the reasoning that produced it.
