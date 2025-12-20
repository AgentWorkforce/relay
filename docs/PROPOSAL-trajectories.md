# Train of Thought Trajectories: Design Proposal

## Executive Summary

Store the complete "trajectory" of agent work on tasks - prompts, reasoning, inter-agent messages, tool calls, decisions, and retrospectives - as first-class artifacts that travel with the code and provide long-term value for debugging, code review, onboarding, and institutional memory.

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
  taskId: string;                // Beads task ID (bd-xxx)
  taskTitle: string;             // Human-readable title

  // Timeline
  startedAt: string;             // ISO timestamp
  completedAt?: string;

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
  version: number;               // Schema version
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

### New Table: `trajectories`

```sql
CREATE TABLE trajectories (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,           -- Beads task ID
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

### 4. Beads Integration

Link trajectories to beads tasks:

```typescript
// When agent runs: bd update <id> --status=in_progress
trajectoryCapture.startTrajectory(taskId, taskTitle);

// When agent runs: bd close <id>
trajectoryCapture.endTrajectory();
promptForRetrospective();  // Ask agent to reflect
```

---

## Retrospectives

Encourage agents to reflect by:

### 1. Automatic Prompting

When an agent completes a task (closes a beads issue), inject:

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
- Add trajectory storage schema
- Implement basic capture in wrapper
- CLI: `trajectory start`, `trajectory status`, `trajectory complete`

### Phase 2: Integration
- Beads integration (auto-start on `bd update --status=in_progress`)
- Message capture from router
- Retrospective prompting

### Phase 3: Export & Search
- Markdown export
- Full-text search
- Git integration

### Phase 4: Intelligence
- Auto-summarization (use LLM to summarize long trajectories)
- Decision extraction (identify decisions from conversation)
- Cross-trajectory analysis

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
