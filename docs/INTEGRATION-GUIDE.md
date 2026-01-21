# Agent Infrastructure Integration Guide

How to integrate agent-relay, claude-mem, and agent-trajectories into a cohesive stack.

---

## The Stack at a Glance

```
┌─────────────────────────────────────────────────────────────────┐
│  YOUR AGENT (Claude Code, Codex, Gemini, etc.)                 │
├─────────────────────────────────────────────────────────────────┤
│                         │                                       │
│            ┌────────────┴────────────┐                         │
│            ▼                         ▼                         │
│  ┌─────────────────┐      ┌─────────────────┐                  │
│  │  CLAUDE-MEM     │      │  AGENT-RELAY    │                  │
│  │  (Observations) │      │  (Messaging)    │                  │
│  │                 │      │                 │                  │
│  │  • Tool calls   │      │  • ->relay: <<< │                  │
│  │  • Concepts     │      │  • Broadcasting │                  │
│  │  • Sessions     │      │  • Persistence  │                  │
│  └────────┬────────┘      └────────┬────────┘                  │
│           │                        │                           │
│           └──────────┬─────────────┘                           │
│                      ▼                                         │
│           ┌─────────────────────┐                              │
│           │  AGENT-TRAJECTORIES │                              │
│           │  (Narratives)       │                              │
│           │                     │                              │
│           │  • Task stories     │                              │
│           │  • Decisions        │                              │
│           │  • Retrospectives   │                              │
│           │  • Workspace        │                              │
│           └─────────────────────┘                              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Phase 0: Current State (What Exists)

### agent-relay (✅ Ready)

**What it does:** Real-time agent-to-agent messaging via Unix sockets.

**Installation:**
```bash
npm install -g agent-relay
```

**Usage:**
```bash
# Start daemon
agent-relay up

# Wrap agent
agent-relay -n Alice claude
```

**What it provides for integration:**
```typescript
import { StoredMessage, MessageQuery, StorageAdapter } from 'agent-relay';

// Query messages for a time range
const messages = await storage.getMessages({
  sinceTs: startTime,
  order: 'asc'
});
```

### claude-mem (✅ Exists, needs integration)

**What it does:** Captures tool observations with semantic concepts.

**Installation:**
```bash
# Clone and setup
git clone https://github.com/thedotmack/claude-mem
cd claude-mem
bun install
```

**How it works:**
- Hooks into Claude Code lifecycle (SessionStart, PostToolUse, SessionEnd)
- Stores observations in SQLite + Chroma (vector search)
- Provides `mem-search` skill for natural language queries

**What it provides for integration:**
- Tool call history with semantic tags
- Session continuity
- Concept-based search

---

## Phase 1: Install claude-mem

### Step 1.1: Clone and Configure

```bash
# From your project root
git clone https://github.com/thedotmack/claude-mem .claude-mem

# Install dependencies
cd .claude-mem
bun install

# Start the worker service
bun run start
```

### Step 1.2: Configure Claude Code Hooks

Add to your `~/.claude/settings.json` (or project `.claude/settings.json`):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "command": "node .claude-mem/hooks/session-start.js",
        "timeout": 5000
      }
    ],
    "PostToolUse": [
      {
        "command": "node .claude-mem/hooks/post-tool-use.js",
        "timeout": 3000
      }
    ],
    "SessionEnd": [
      {
        "command": "node .claude-mem/hooks/session-end.js",
        "timeout": 5000
      }
    ]
  }
}
```

### Step 1.3: Verify It's Working

```bash
# Start a Claude Code session
claude

# Do some work...

# Check the web viewer
open http://localhost:37777
```

You should see observations being captured.

---

## Phase 2: Create agent-trajectories

### Step 2.1: Initialize the Project

```bash
# Create new repo
mkdir agent-trajectories
cd agent-trajectories
npm init -y

# Install dependencies
npm install better-sqlite3 commander uuid
npm install -D typescript @types/node @types/better-sqlite3 vitest
```

### Step 2.2: Project Structure

```
agent-trajectories/
├── src/
│   ├── core/
│   │   ├── types.ts           # Trajectory, Chapter, Event types
│   │   ├── schema.ts          # JSON schema for .trajectory format
│   │   └── trajectory.ts      # Trajectory class
│   │
│   ├── storage/
│   │   ├── file-storage.ts    # .trajectories/ directory
│   │   └── sqlite-storage.ts  # SQLite for indexing
│   │
│   ├── adapters/
│   │   ├── adapter.ts         # TaskSourceAdapter interface
│   │   ├── beads.ts           # Beads integration
│   │   ├── github.ts          # GitHub Issues integration
│   │   ├── linear.ts          # Linear integration
│   │   └── plain.ts           # Standalone trajectories
│   │
│   ├── integrations/
│   │   ├── relay.ts           # Import from agent-relay
│   │   └── claude-mem.ts      # Import from claude-mem
│   │
│   ├── workspace/
│   │   ├── decisions.ts       # Decision log
│   │   ├── patterns.ts        # Pattern library
│   │   └── extract.ts         # Auto-extraction
│   │
│   ├── export/
│   │   ├── markdown.ts        # Notion-style export
│   │   └── timeline.ts        # Linear-style export
│   │
│   ├── cli/
│   │   └── index.ts           # CLI commands
│   │
│   └── index.ts               # Main exports
│
├── package.json
└── tsconfig.json
```

### Step 2.3: Core Types

```typescript
// src/core/types.ts

export interface Trajectory {
  id: string;
  version: 1;

  task: TaskReference;

  startedAt: string;
  completedAt?: string;
  status: 'active' | 'completed' | 'abandoned';

  agents: AgentParticipation[];
  chapters: Chapter[];
  retrospective?: Retrospective;

  commits: string[];
  filesChanged: string[];

  projectId: string;
  tags: string[];
}

export interface TaskReference {
  title: string;
  description?: string;
  source?: {
    system: string;  // 'beads' | 'linear' | 'github' | 'plain'
    id: string;
    url?: string;
  };
}

export interface Chapter {
  id: string;
  title: string;
  agentName: string;
  startedAt: string;
  endedAt?: string;
  events: TrajectoryEvent[];
}

export interface TrajectoryEvent {
  ts: number;
  type: EventType;
  content: string;
  raw?: unknown;
  significance?: 'low' | 'medium' | 'high' | 'critical';
  tags?: string[];
  source?: 'relay' | 'claude-mem' | 'manual';
}

export type EventType =
  | 'prompt'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'message_sent'
  | 'message_received'
  | 'decision'
  | 'observation'  // From claude-mem
  | 'error';

export interface Retrospective {
  summary: string;
  approach: string;
  decisions: Decision[];
  challenges: string[];
  learnings: string[];
  suggestions: string[];
  confidence: number;
}

export interface Decision {
  question: string;
  chosen: string;
  alternatives: string[];
  reasoning: string;
}
```

### Step 2.4: CLI Commands

```typescript
// src/cli/index.ts

import { Command } from 'commander';

const program = new Command();

program
  .name('trajectory')
  .description('Agent trajectory management')
  .version('1.0.0');

// Create new trajectory
program
  .command('new <title>')
  .description('Start a new trajectory')
  .option('--beads <id>', 'Link to Beads task')
  .option('--linear <id>', 'Link to Linear issue')
  .option('--github <id>', 'Link to GitHub issue')
  .action(async (title, options) => {
    // Implementation
  });

// Show current trajectory status
program
  .command('status')
  .description('Show active trajectory')
  .action(async () => {
    // Implementation
  });

// Add a chapter
program
  .command('chapter <title>')
  .description('Start a new chapter')
  .action(async (title) => {
    // Implementation
  });

// Record a decision
program
  .command('decision <title>')
  .description('Record a decision')
  .option('--chosen <choice>', 'What was chosen')
  .option('--alternatives <alts...>', 'Alternatives considered')
  .option('--reasoning <reason>', 'Why this choice')
  .action(async (title, options) => {
    // Implementation
  });

// Complete trajectory
program
  .command('complete')
  .description('Complete the active trajectory')
  .option('--retrospective', 'Prompt for retrospective')
  .action(async (options) => {
    // Implementation
  });

// Import from sources
program
  .command('import')
  .description('Import events from external sources')
  .option('--relay', 'Import from agent-relay')
  .option('--claude-mem', 'Import from claude-mem')
  .option('--since <timestamp>', 'Import since timestamp')
  .action(async (options) => {
    // Implementation
  });

// Export trajectory
program
  .command('export <id>')
  .description('Export trajectory')
  .option('--format <format>', 'Export format (markdown, json, timeline)')
  .action(async (id, options) => {
    // Implementation
  });

// Search trajectories
program
  .command('search <query>')
  .description('Search trajectories')
  .action(async (query) => {
    // Implementation
  });

program.parse();
```

---

## Phase 3: agent-relay Integration

### Step 3.1: Import Relay Messages

```typescript
// src/integrations/relay.ts

import { StoredMessage, MessageQuery } from 'agent-relay';
import { TrajectoryEvent } from '../core/types.js';

interface RelayImportOptions {
  sinceTs: number;
  untilTs?: number;
  agentName?: string;
  topic?: string;
}

export async function importFromRelay(
  storage: StorageAdapter,
  options: RelayImportOptions
): Promise<TrajectoryEvent[]> {
  const query: MessageQuery = {
    sinceTs: options.sinceTs,
    order: 'asc',
    limit: 1000
  };

  if (options.agentName) {
    query.from = options.agentName;
  }
  if (options.topic) {
    query.topic = options.topic;
  }

  const messages = await storage.getMessages(query);

  return messages
    .filter(m => !options.untilTs || m.ts <= options.untilTs)
    .map(messageToEvent);
}

function messageToEvent(msg: StoredMessage): TrajectoryEvent {
  return {
    ts: msg.ts,
    type: msg.kind === 'thinking' ? 'thinking' :
          msg.to === '*' ? 'message_sent' :
          'message_received',
    content: msg.body,
    raw: {
      from: msg.from,
      to: msg.to,
      kind: msg.kind,
      data: msg.data
    },
    significance: 'medium',
    source: 'relay'
  };
}
```

### Step 3.2: Real-time Relay Subscription

```typescript
// src/integrations/relay-listener.ts

import { RelayClient } from 'agent-relay';
import { TrajectoryCapture } from '../capture/trajectory-capture.js';

export class RelayListener {
  private client: RelayClient;
  private capture: TrajectoryCapture;

  constructor(capture: TrajectoryCapture) {
    this.capture = capture;
  }

  async connect(agentName: string): Promise<void> {
    this.client = new RelayClient({ agentName });

    this.client.on('message', (envelope) => {
      this.capture.recordEvent({
        type: envelope.from === agentName ? 'message_sent' : 'message_received',
        content: envelope.payload.body,
        raw: envelope,
        source: 'relay'
      });
    });

    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
  }
}
```

---

## Phase 4: claude-mem Integration

### Step 4.1: Query claude-mem Observations

```typescript
// src/integrations/claude-mem.ts

import { TrajectoryEvent } from '../core/types.js';

interface ClaudeMemObservation {
  id: string;
  timestamp: string;
  type: 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'change';
  content: string;
  concepts: string[];
  files?: string[];
  tokens?: number;
}

interface ClaudeMemImportOptions {
  sinceTs: number;
  untilTs?: number;
  types?: string[];
  concepts?: string[];
}

const CLAUDE_MEM_API = 'http://localhost:37777';

export async function importFromClaudeMem(
  options: ClaudeMemImportOptions
): Promise<TrajectoryEvent[]> {
  const params = new URLSearchParams({
    since: new Date(options.sinceTs).toISOString(),
  });

  if (options.untilTs) {
    params.set('until', new Date(options.untilTs).toISOString());
  }
  if (options.types?.length) {
    params.set('types', options.types.join(','));
  }
  if (options.concepts?.length) {
    params.set('concepts', options.concepts.join(','));
  }

  const response = await fetch(`${CLAUDE_MEM_API}/api/observations?${params}`);
  const observations: ClaudeMemObservation[] = await response.json();

  return observations.map(observationToEvent);
}

function observationToEvent(obs: ClaudeMemObservation): TrajectoryEvent {
  return {
    ts: new Date(obs.timestamp).getTime(),
    type: 'observation',
    content: obs.content,
    raw: obs,
    significance: mapTypeToSignificance(obs.type),
    tags: obs.concepts,
    source: 'claude-mem'
  };
}

function mapTypeToSignificance(type: string): 'low' | 'medium' | 'high' | 'critical' {
  switch (type) {
    case 'decision': return 'high';
    case 'bugfix': return 'high';
    case 'feature': return 'medium';
    case 'discovery': return 'medium';
    case 'refactor': return 'low';
    case 'change': return 'low';
    default: return 'medium';
  }
}

// Search claude-mem for relevant observations
export async function searchClaudeMem(query: string): Promise<ClaudeMemObservation[]> {
  const response = await fetch(`${CLAUDE_MEM_API}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  });

  return response.json();
}
```

### Step 4.2: Enrich Trajectories with Observations

```typescript
// src/integrations/enrichment.ts

import { Trajectory, Chapter } from '../core/types.js';
import { importFromClaudeMem } from './claude-mem.js';
import { importFromRelay } from './relay.js';

export async function enrichTrajectory(
  trajectory: Trajectory,
  relayStorage?: StorageAdapter
): Promise<Trajectory> {
  const startTs = new Date(trajectory.startedAt).getTime();
  const endTs = trajectory.completedAt
    ? new Date(trajectory.completedAt).getTime()
    : Date.now();

  // Import from claude-mem
  const claudeMemEvents = await importFromClaudeMem({
    sinceTs: startTs,
    untilTs: endTs,
    types: ['decision', 'discovery', 'bugfix']
  });

  // Import from agent-relay (if available)
  let relayEvents = [];
  if (relayStorage) {
    relayEvents = await importFromRelay(relayStorage, {
      sinceTs: startTs,
      untilTs: endTs
    });
  }

  // Merge events into chapters by timestamp
  const allEvents = [...claudeMemEvents, ...relayEvents]
    .sort((a, b) => a.ts - b.ts);

  // Distribute events to appropriate chapters
  for (const event of allEvents) {
    const chapter = findChapterForTimestamp(trajectory.chapters, event.ts);
    if (chapter) {
      chapter.events.push(event);
      chapter.events.sort((a, b) => a.ts - b.ts);
    }
  }

  return trajectory;
}

function findChapterForTimestamp(chapters: Chapter[], ts: number): Chapter | null {
  for (const chapter of chapters) {
    const start = new Date(chapter.startedAt).getTime();
    const end = chapter.endedAt
      ? new Date(chapter.endedAt).getTime()
      : Date.now();

    if (ts >= start && ts <= end) {
      return chapter;
    }
  }

  // Return last chapter if no match
  return chapters[chapters.length - 1] || null;
}
```

---

## Phase 5: Hook Integration

### Step 5.1: Trajectory Hooks for Claude Code

```typescript
// src/hooks/session-start.ts

import { TrajectoryStore } from '../storage/trajectory-store.js';

async function onSessionStart(): Promise<{ context?: string }> {
  const store = new TrajectoryStore();
  const active = await store.getActive();

  if (!active) {
    return {};
  }

  const context = `
## Active Trajectory

**Task:** ${active.task.title}
**Status:** ${active.status}
**Chapter:** ${active.chapters[active.chapters.length - 1]?.title || 'Starting'}

### Key Decisions So Far
${active.chapters
  .flatMap(c => c.events.filter(e => e.type === 'decision'))
  .map(d => `- ${d.content}`)
  .join('\n') || 'None yet'}

### Recent Activity
${active.chapters[active.chapters.length - 1]?.events
  .slice(-5)
  .map(e => `- [${e.type}] ${e.content.slice(0, 100)}`)
  .join('\n') || 'None'}

---
To record a decision: [[TRAJECTORY:decision]]{"title": "...", "chosen": "...", "alternatives": [...], "reasoning": "..."}[[/TRAJECTORY]]
To start a new chapter: [[TRAJECTORY:chapter]]{"title": "..."}[[/TRAJECTORY]]
`.trim();

  return { context };
}
```

### Step 5.2: Combined Hook Configuration

```json
// .claude/settings.json
{
  "hooks": {
    "SessionStart": [
      {
        "command": "node .claude-mem/hooks/session-start.js",
        "timeout": 5000
      },
      {
        "command": "npx trajectory hook:session-start",
        "timeout": 3000
      }
    ],
    "PostToolUse": [
      {
        "command": "node .claude-mem/hooks/post-tool-use.js",
        "timeout": 3000
      }
    ],
    "Stop": [
      {
        "command": "npx trajectory hook:stop",
        "timeout": 5000
      }
    ],
    "SessionEnd": [
      {
        "command": "node .claude-mem/hooks/session-end.js",
        "timeout": 5000
      },
      {
        "command": "npx trajectory hook:session-end",
        "timeout": 5000
      }
    ]
  }
}
```

### Step 5.3: Stop Hook - Prompt for Retrospective

```typescript
// src/hooks/stop.ts

import { TrajectoryStore } from '../storage/trajectory-store.js';

async function onStop(): Promise<{ decision: 'allow' | 'block'; reason?: string }> {
  const store = new TrajectoryStore();
  const active = await store.getActive();

  if (!active) {
    return { decision: 'allow' };
  }

  // Check if trajectory has a retrospective
  if (!active.retrospective) {
    return {
      decision: 'block',
      reason: `
Active trajectory "${active.task.title}" needs a retrospective before completing.

Please output a retrospective:

[[TRAJECTORY:retrospective]]
{
  "summary": "What was accomplished?",
  "approach": "How did you approach it?",
  "decisions": [
    {"question": "Key choice made", "chosen": "What you picked", "alternatives": ["Other options"], "reasoning": "Why"}
  ],
  "challenges": ["What was difficult?"],
  "learnings": ["What would you do differently?"],
  "suggestions": ["Improvements for codebase/process?"],
  "confidence": 0.85
}
[[/TRAJECTORY]]

Or run: trajectory complete --skip-retrospective
`.trim()
    };
  }

  return { decision: 'allow' };
}
```

---

## Phase 6: Putting It All Together

### Complete Setup Checklist

```bash
# 1. Install agent-relay
npm install -g agent-relay

# 2. Clone and setup claude-mem
git clone https://github.com/thedotmack/claude-mem .claude-mem
cd .claude-mem && bun install && bun run start &
cd ..

# 3. Install agent-trajectories (once published)
npm install -g agent-trajectories

# 4. Configure hooks
cat > .claude/settings.json << 'EOF'
{
  "hooks": {
    "SessionStart": [
      {"command": "node .claude-mem/hooks/session-start.js", "timeout": 5000},
      {"command": "npx trajectory hook:session-start", "timeout": 3000}
    ],
    "PostToolUse": [
      {"command": "node .claude-mem/hooks/post-tool-use.js", "timeout": 3000}
    ],
    "Stop": [
      {"command": "npx trajectory hook:stop", "timeout": 5000}
    ],
    "SessionEnd": [
      {"command": "node .claude-mem/hooks/session-end.js", "timeout": 5000},
      {"command": "npx trajectory hook:session-end", "timeout": 5000}
    ]
  }
}
EOF

# 5. Start the relay daemon
agent-relay up

# 6. Start working!
agent-relay -n Alice claude
```

### Typical Workflow

```bash
# Start a task
trajectory new "Implement user authentication" --linear ENG-456

# Work in Claude Code...
# - claude-mem captures tool observations automatically
# - agent-relay captures messages automatically
# - You can add decisions manually via [[TRAJECTORY:decision]]

# Check status
trajectory status

# Start a new chapter when switching focus
trajectory chapter "Testing"

# When done, complete with retrospective
trajectory complete

# View the result
trajectory export ENG-456 --format markdown
```

### Data Flow Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        AGENT SESSION                             │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│   Agent works...                                                 │
│        │                                                         │
│        ├──────────────────┬───────────────────┐                 │
│        ▼                  ▼                   ▼                 │
│   ┌─────────┐      ┌───────────┐      ┌────────────┐           │
│   │ Tool    │      │ ->relay:   │      │[[TRAJECTORY│           │
│   │ Calls   │      │ messages  │      │ :decision]]│           │
│   └────┬────┘      └─────┬─────┘      └──────┬─────┘           │
│        │                 │                   │                  │
│        ▼                 ▼                   ▼                  │
│   ┌─────────┐      ┌───────────┐      ┌────────────┐           │
│   │claude-  │      │agent-relay│      │agent-      │           │
│   │mem      │      │SQLite     │      │trajectories│           │
│   │SQLite + │      │           │      │.trajectory/│           │
│   │Chroma   │      │           │      │            │           │
│   └────┬────┘      └─────┬─────┘      └──────┬─────┘           │
│        │                 │                   │                  │
│        └────────────┬────┴───────────────────┘                  │
│                     ▼                                           │
│           ┌─────────────────┐                                   │
│           │ trajectory      │                                   │
│           │ complete        │                                   │
│           │                 │                                   │
│           │ Enriches with:  │                                   │
│           │ - relay msgs    │                                   │
│           │ - claude-mem    │                                   │
│           │   observations  │                                   │
│           └────────┬────────┘                                   │
│                    ▼                                            │
│           ┌─────────────────┐                                   │
│           │ .trajectory.json│                                   │
│           │ .trajectory.md  │                                   │
│           │                 │                                   │
│           │ Complete story  │                                   │
│           │ of the work     │                                   │
│           └─────────────────┘                                   │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Summary: What Each Piece Does

| Component | Captures | Storage | Query |
|-----------|----------|---------|-------|
| **agent-relay** | Agent messages | SQLite | By time, sender, topic |
| **claude-mem** | Tool observations | SQLite + Chroma | Semantic search |
| **agent-trajectories** | Task narratives | Files + SQLite | By task, decision, pattern |

| Component | Hooks | Real-time | Export |
|-----------|-------|-----------|--------|
| **agent-relay** | Stop (inbox check) | Yes (sockets) | JSON |
| **claude-mem** | All lifecycle | No | JSON |
| **agent-trajectories** | Start, Stop, End | Optional | Markdown, JSON, Timeline |

---

---

## Advanced Features

### StatelessLeadCoordinator

The StatelessLeadCoordinator enables hierarchical agent teams where a lead agent reads from Beads and assigns tasks to workers. This enables crash-resilient coordination where any agent can take over as lead.

**Key Principles:**
- **Stateless**: Lead is a coordinator, not a state holder
- **Beads as truth**: Beads JSONL is the single source of truth for task state
- **Failover-ready**: Any agent can become lead by reading from Beads
- **Lease-based**: Tasks have time-limited leases to handle worker crashes

**Basic Usage:**

```typescript
import { StatelessLeadCoordinator, createStatelessLead } from 'agent-relay/resiliency';

// Quick setup with defaults
const lead = createStatelessLead(
  '.beads',           // beadsDir
  'Lead',             // agentName
  'lead-001',         // agentId
  {
    sendRelay: async (to, message) => {
      // Send task via relay
      await relayClient.send(to, message);
    },
    getAvailableWorkers: async () => {
      // Return workers not currently assigned
      return ['Worker1', 'Worker2', 'Worker3'];
    },
  }
);

// Start coordinating
await lead.start();
```

**Full Configuration:**

```typescript
const lead = new StatelessLeadCoordinator({
  beadsDir: '.beads',
  agentName: 'Lead',
  agentId: 'lead-001',
  pollIntervalMs: 5000,       // How often to check for ready tasks
  heartbeatIntervalMs: 10000, // How often to write heartbeat
  leaseDurationMs: 300000,    // 5 min lease on assigned tasks
  sendRelay: async (to, message) => { /* ... */ },
  getAvailableWorkers: async () => { /* ... */ },
});
```

**Event Handling:**

```typescript
// Task assigned to worker
lead.on('assigned', ({ taskId, worker, leaseExpires }) => {
  console.log(`Assigned ${taskId} to ${worker}`);
});

// Task completed by worker
lead.on('completed', ({ taskId, worker, reason }) => {
  console.log(`${worker} completed ${taskId}`);
});

// Task blocked by worker
lead.on('blocked', ({ taskId, worker, reason }) => {
  console.log(`${taskId} blocked: ${reason}`);
});

// Lease renewed (worker still working)
lead.on('leaseRenewed', ({ taskId, worker, leaseExpires }) => {
  console.log(`Renewed lease for ${taskId}`);
});

// Error during coordination
lead.on('error', (err) => {
  console.error('Lead error:', err);
});
```

**Worker Integration:**

Workers respond to the Lead to report progress:

```typescript
// Worker receives task message from Lead:
// "TASK [task-123]: Implement user authentication\n\nDescription here..."

// Worker reports completion
await lead.completeTask('task-123', 'Worker1', 'Auth implemented');

// Worker reports blocked
await lead.blockTask('task-123', 'Worker1', 'Missing API key');

// Worker renews lease (still working on long task)
await lead.renewLease('task-123', 'Worker1');
```

**Beads Task Format:**

Tasks in `.beads/issues.jsonl`:

```json
{"id": "task-123", "title": "Implement auth", "status": "open", "priority": 1}
{"id": "task-124", "title": "Add tests", "status": "in_progress", "assignee": "Worker1", "leaseExpires": 1737500000000}
{"id": "task-125", "title": "Deploy", "status": "closed", "priority": 3}
```

**How it works:**
1. Lead polls Beads for tasks with `status: 'open'`
2. When a task is ready, Lead assigns it to an available worker
3. Lead updates Beads with `status: 'in_progress'`, assignee, and lease expiry
4. Lead sends task to worker via relay message
5. Worker completes/blocks and Lead updates Beads
6. If lead crashes, new lead reads Beads and continues (no state lost)
7. If worker crashes, lease expires and task becomes available again

**Lead Heartbeat (for failover):**

```typescript
// Check if current lead is stale (for watchdog)
const isStale = await StatelessLeadCoordinator.isLeaderStale('.beads', 30000);
if (isStale) {
  // Take over as new lead
  const newLead = createStatelessLead('.beads', 'NewLead', 'new-lead-id', callbacks);
  await newLead.start();
}
```

---

### Consensus

The Consensus mechanism enables distributed decision-making across multiple agents. Agents can propose decisions, vote, and receive results through the special `_consensus` target.

**The `_consensus` Target:**

`_consensus` is a special relay target that routes messages to the daemon's consensus engine. It's not an agent - it's a system endpoint that:
- Receives PROPOSE commands to create proposals
- Receives VOTE commands to cast votes
- Broadcasts results back to participants when consensus is reached

**Consensus Types:**
- **Majority** - Simple >50% agreement
- **Supermajority** - 2/3 or configurable threshold (default 0.67)
- **Unanimous** - All participants must approve
- **Weighted** - Votes weighted by agent role/expertise
- **Quorum** - Minimum participation required before evaluating

**Use Cases:**
- Code review approval (2+ agents approve)
- Architecture decisions (lead + majority)
- Deployment gates (all critical agents agree)
- Task assignment (weighted by expertise)

**Creating a Proposal (via Relay):**

```bash
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/propose << 'EOF'
TO: _consensus

PROPOSE: Approve PR #42 - Add authentication feature
TYPE: quorum
PARTICIPANTS: Security, Backend, QA
QUORUM: 2
TIMEOUT: 600000
DESCRIPTION: Review the authentication implementation for security and code quality.
Changes: src/auth/*.ts, tests/auth/*.test.ts
EOF
```
Then: `->relay-file:propose`

**Proposal Fields:**
- `PROPOSE:` (required) - Title of the proposal
- `TYPE:` - `majority`, `supermajority`, `unanimous`, `weighted`, `quorum` (default: `majority`)
- `PARTICIPANTS:` (required) - Comma-separated agent names who can vote
- `QUORUM:` - Minimum votes required (for quorum type)
- `THRESHOLD:` - Threshold for supermajority (0-1, default 0.67)
- `TIMEOUT:` - Milliseconds until expiry (default: 5 minutes)
- `DESCRIPTION:` - Detailed description (can span multiple lines)

**Voting on a Proposal (via Relay):**

```bash
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/vote << 'EOF'
TO: _consensus

VOTE prop_1737500000_abc12345 approve

Security checks passed. No vulnerabilities found.
EOF
```
Then: `->relay-file:vote`

Or as a single line:
```bash
echo "VOTE prop_1737500000_abc12345 approve Security looks good" | ...
```

**Vote Format:**
```
VOTE <proposal-id> <approve|reject|abstain> [reason]
```

**Receiving Results:**

When consensus is reached (or proposal expires), participants receive:
```
Relay message from _consensus [abc123]:

CONSENSUS RESULT: Approve PR #42 - Add authentication feature
Decision: APPROVED
Participation: 100.0%

Approve: 3 | Reject: 0 | Abstain: 0
```

**Programmatic Usage:**

```typescript
import { ConsensusIntegration, createConsensusIntegration } from 'agent-relay/daemon';

// Create with router (typically in daemon setup)
const consensus = createConsensusIntegration(router, {
  enabled: true,
  autoBroadcast: true,       // Auto-send proposals to participants
  autoResultBroadcast: true, // Auto-send results when resolved
});

// Create a proposal
const proposal = consensus.createProposal({
  title: 'Use JWT for authentication',
  description: 'JWT provides stateless auth suitable for microservices',
  proposer: 'Backend',
  consensusType: 'supermajority',
  participants: ['Backend', 'Security', 'Lead', 'Frontend'],
  threshold: 0.67,
  timeoutMs: 300000, // 5 minutes
});

// Process incoming vote (from message handler)
const result = consensus.processIncomingMessage('Security', 'VOTE prop_xxx approve Looks good');
if (result.isConsensusCommand) {
  console.log('Vote processed:', result.result);
}

// Get pending votes for an agent
const pendingVotes = consensus.getPendingVotes('Security');

// Get proposal status
const proposalStatus = consensus.getProposal(proposal.id);
console.log('Status:', proposalStatus.status); // 'pending', 'approved', 'rejected', 'expired'
```

**Consensus Engine (Lower Level):**

```typescript
import { ConsensusEngine, createConsensusEngine } from 'agent-relay/daemon';

const engine = createConsensusEngine({
  defaultTimeoutMs: 5 * 60 * 1000,
  defaultConsensusType: 'majority',
  defaultThreshold: 0.67,
  allowVoteChange: true,  // Allow re-voting before resolution
  autoResolve: true,      // Resolve when outcome is mathematically certain
});

// Create proposal
const proposal = engine.createProposal({
  title: 'Deploy to production',
  description: 'Ship v2.0',
  proposer: 'Lead',
  participants: ['Lead', 'Security', 'QA'],
  consensusType: 'unanimous',
});

// Cast votes
engine.vote(proposal.id, 'Lead', 'approve', 'All tests pass');
engine.vote(proposal.id, 'Security', 'approve', 'Security audit complete');
engine.vote(proposal.id, 'QA', 'approve', 'E2E tests pass');

// Listen for resolution
engine.on('proposal:resolved', (proposal, result) => {
  console.log(`Decision: ${result.decision}`);
  console.log(`Participation: ${(result.participation * 100).toFixed(1)}%`);
});
```

**Events:**

```typescript
engine.on('proposal:created', (proposal) => { /* new proposal */ });
engine.on('proposal:voted', (proposal, vote) => { /* vote cast */ });
engine.on('proposal:resolved', (proposal, result) => { /* consensus reached */ });
engine.on('proposal:expired', (proposal) => { /* timeout without consensus */ });
engine.on('proposal:cancelled', (proposal) => { /* proposer cancelled */ });
```

---

### Continuity

The Continuity system enables session persistence and cross-session handoffs. It preserves agent context across restarts, crashes, and context limits.

**Core Concepts:**

| Concept | Persistence | Purpose |
|---------|-------------|---------|
| **Ledger** | Ephemeral (overwritten each save) | Current session state: task, progress, decisions |
| **Handoff** | Permanent (immutable archive) | Cross-session transfer: summary, next steps, learnings |

**When to Use:**
- **Save ledger** before long-running operations (builds, tests, waiting for user)
- **Create handoff** on context limit, session end, or task completion
- **Search handoffs** to resume previous work or learn from past decisions
- **Mark uncertain** for items that need verification in future sessions

**Via Relay Messages:**

**Save Ledger (within session):**
```bash
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/continuity << 'EOF'
KIND: continuity
ACTION: save

Current task: Implementing user authentication
Completed: User model, JWT utils, Password hashing
In progress: Login endpoint, Session management
Blocked: OAuth integration (waiting for client ID)
Key decisions: Using JWT with refresh tokens
Uncertain: Rate limit handling unclear
Files: src/auth/*.ts, src/middleware/auth.ts
EOF
```
Then: `->relay-file:continuity`

**Load Previous Context (auto-loads on startup):**
```bash
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/load << 'EOF'
KIND: continuity
ACTION: load
EOF
```
Then: `->relay-file:load`

Response injected:
```markdown
## Previous Session Context

**Current Task:** Implementing user authentication

**Completed:**
- User model
- JWT utils
- Password hashing

**In Progress:**
- Login endpoint
- Session management

**Key Decisions:**
- Using JWT with refresh tokens

**Uncertain (verify these):**
- UNCONFIRMED: Rate limit handling unclear
```

**Search Past Handoffs:**
```bash
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/search << 'EOF'
KIND: continuity
ACTION: search

Query: authentication JWT tokens
EOF
```
Then: `->relay-file:search`

**Create Handoff (on task/session completion):**
```bash
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/handoff << 'EOF'
KIND: continuity
ACTION: handoff

Summary: User authentication 80% complete
Task: Implement user authentication system
Completed work:
- User model with Drizzle ORM
- JWT token generation and validation
- Password hashing with bcrypt
- Auth middleware for protected routes
Next steps:
- Complete login endpoint
- Add refresh token rotation
- Write integration tests
Key decisions:
- JWT over sessions: Stateless, scales horizontally
- Bcrypt over Argon2: Simpler, well-audited
Learnings:
- Token refresh should happen server-side
- Consider adding device fingerprinting
EOF
```
Then: `->relay-file:handoff`

**Mark Uncertainty:**
```bash
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/uncertain << 'EOF'
KIND: continuity
ACTION: uncertain

API rate limit handling unclear - needs investigation
EOF
```
Then: `->relay-file:uncertain`

**Programmatic Usage:**

```typescript
import { ContinuityManager, getContinuityManager } from 'agent-relay/continuity';

// Get singleton instance
const continuity = getContinuityManager();
await continuity.initialize();

// Save a ledger (current session state)
await continuity.saveLedger('MyAgent', {
  currentTask: 'Implementing auth',
  completed: ['User model', 'JWT utils'],
  inProgress: ['Login endpoint'],
  blocked: ['OAuth - waiting for client ID'],
  keyDecisions: [{
    decision: 'Use JWT',
    reasoning: 'Stateless, scales horizontally',
    alternatives: ['Sessions'],
    confidence: 0.9
  }],
  uncertainItems: ['Rate limit handling'],
  fileContext: [
    { path: 'src/auth/jwt.ts', description: 'Token generation' },
    { path: 'src/middleware/auth.ts', lines: [10, 50], description: 'Auth middleware' }
  ],
});

// Create a handoff (permanent record)
const handoff = await continuity.createHandoff('MyAgent', {
  summary: 'Auth 80% complete, login endpoint next',
  taskDescription: 'User authentication system',
  completedWork: ['User model', 'JWT utils', 'Middleware'],
  nextSteps: ['Complete login', 'Add refresh tokens', 'Tests'],
  learnings: ['Token refresh should be server-side'],
}, 'session_end');

// Get startup context for new session
const context = await continuity.getStartupContext('MyAgent');
if (context) {
  console.log(context.formatted); // Markdown to inject into agent
}

// Search past handoffs
const results = await continuity.searchHandoffs('authentication', {
  agentName: 'MyAgent',
  limit: 5,
  since: new Date('2025-01-01'),
});

// Add uncertain item
await continuity.addUncertainItem('MyAgent', 'Rate limit handling unclear');

// Get brief status
const status = await continuity.getBriefStatus('MyAgent');
console.log(status); // "Working on: Implementing auth | 3 completed | 1 blocked"

// List all agents with continuity data
const agents = await continuity.listAgents();
```

**Ledger Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `currentTask` | string | Current work focus |
| `completed` | string[] | Completed items |
| `inProgress` | string[] | Work in progress |
| `blocked` | string[] | Blocked items with reasons |
| `keyDecisions` | Decision[] | Decisions with reasoning |
| `uncertainItems` | string[] | Items needing verification |
| `fileContext` | FileRef[] | Relevant files |

**Handoff Triggers:**
- `manual` - Explicitly saved by agent
- `trajectory_complete` - Trail completed
- `context_limit` - Context approaching limit
- `auto_restart` - Agent restarting
- `crash` - Agent crashed
- `session_end` - Session ending normally

**Auto-Save on Exit:**

```typescript
// In wrapper shutdown handler
await continuity.autoSave('MyAgent', 'session_end', {
  summary: 'Work session completed',
  completedTasks: ['Implemented login', 'Added tests'],
});
```

---

## Next Steps

1. **Phase 1:** Get claude-mem working in your project
2. **Phase 2:** Create agent-trajectories repo with core types
3. **Phase 3:** Add relay integration
4. **Phase 4:** Add claude-mem integration
5. **Phase 5:** Build CLI and hooks
6. **Phase 6:** Test end-to-end flow
