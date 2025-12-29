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

## Next Steps

1. **Phase 1:** Get claude-mem working in your project
2. **Phase 2:** Create agent-trajectories repo with core types
3. **Phase 3:** Add relay integration
4. **Phase 4:** Add claude-mem integration
5. **Phase 5:** Build CLI and hooks
6. **Phase 6:** Test end-to-end flow
