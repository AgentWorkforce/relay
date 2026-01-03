# Proposal: CLI-Agnostic Continuity System

**Issue:** agent-relay-317
**Status:** Proposed
**Priority:** 1 (High)
**Type:** Feature Epic

## Executive Summary

Integrate session continuity and context management into Agent Relay at the **relay layer**, making it work for **any CLI** (Claude, Codex, Gemini, custom agents). This addresses context degradation without requiring CLI-specific hooks.

## Problem Statement

All LLM-based CLIs suffer from context degradation:
- **Claude Code**: Lossy compaction summaries
- **Codex CLI**: Fixed context window, no persistence
- **Gemini CLI**: Similar context limitations

For long-running agent tasks, this leads to:
- Lost architectural decisions
- Forgotten implementation details
- Repeated mistakes
- Broken continuity across sessions

## Design Principle: CLI-Agnostic

Unlike Continuous-Claude-v2 which uses Claude Code hooks, we implement continuity at the **relay layer**:

| Approach | Continuous-Claude-v2 | Agent Relay (this proposal) |
|----------|----------------------|----------------------------|
| Integration point | Claude Code hooks | Relay wrapper/protocol |
| CLI support | Claude only | Any CLI |
| Trigger mechanism | Hook events | Output patterns + relay messages |
| Context injection | Hook injection | Message injection via PTY |

## Relationship to Trajectory System (PR #38)

This proposal is designed to **complement** the trajectory system (PR #38), not replace it:

| System | Scope | Focus |
|--------|-------|-------|
| **Trajectory** | Within-session | Decision tracking, PDERO phases |
| **Continuity** | Cross-session | State persistence, context reload |

### How They Work Together

```
┌─────────────────────────────────────────────────────────────┐
│                    Agent Work Session                        │
├─────────────────────────────────────────────────────────────┤
│  TRAJECTORY (within-session, fine-grained)                  │
│  ├─ Plan phase: "Implement auth"                            │
│  ├─ Design phase: "Use JWT + refresh tokens"                │
│  ├─ Execute phase: [decisions, tool calls, code]            │
│  ├─ Review phase: "Tests pass"                              │
│  └─ Observe phase: "Performance good"                       │
│                         │                                   │
│                         ▼ (on completion or context limit)  │
│  CONTINUITY (cross-session, coarse-grained)                 │
│  └─ Handoff auto-generated from trajectory                  │
│     ├─ Summary: trajectory.summary                          │
│     ├─ Decisions: trajectory.decisions[]                    │
│     ├─ Phase: trajectory.currentPhase                       │
│     └─ Next steps: derived from PDERO state                 │
└─────────────────────────────────────────────────────────────┘
```

### Integration Points

1. **Trajectory completion → Auto-handoff**
   - When `trail complete` is called, auto-generate a handoff
   - Include trajectory summary, decisions, learnings

2. **Hooks system shared**
   - Use trajectory's hooks (PR #38) for continuity triggers
   - `onAgentStop` → save ledger
   - `onMessageSent` → update ledger

3. **Memory adapters optional backend**
   - Continuity can optionally use trajectory's memory adapters
   - Default: SQLite + FTS5 (local, searchable)
   - Optional: supermemory.ai (cloud, semantic search)

4. **PDERO phases inform ledger**
   - Ledger's `currentTask` maps to trajectory's current phase
   - Decisions from trajectory populate ledger's `keyDecisions`

### Non-Overlapping Responsibilities

| Trajectory Handles | Continuity Handles |
|-------------------|-------------------|
| PDERO phase transitions | Cross-session state reload |
| Decision recording | Handoff document creation |
| `trail` CLI integration | Context injection on spawn |
| Fine-grained step tracking | FTS5 searchable history |

## Core Concepts

### Philosophy: "Clear, Don't Compact"

Instead of relying on lossy summarization:
1. Explicitly save state before context fills up
2. Clear/restart the agent with fresh context
3. Inject continuity context on startup

### Key Components

| Component | Purpose | Persistence |
|-----------|---------|-------------|
| **Ledgers** | Within-session state snapshots | Per-agent, ephemeral |
| **Handoffs** | Cross-session transfer documents | Permanent, searchable |
| **Artifact Index** | SQLite+FTS5 knowledge base | Permanent |
| **Continuity Protocol** | Relay message extensions | N/A |
| **Trajectory Bridge** | Integration with PR #38 | Via hooks |

## Integration Architecture

### Layer 1: Output Pattern Detection

Extend the existing `->relay:` pattern system:

```
# Agent requests handoff creation
->continuity:save <<<
Current task: Implementing auth module
Completed: User model, JWT utils
Next: Login endpoint
Key decision: Using refresh tokens
>>>

# Agent requests context reload
->continuity:load

# Agent marks uncertainty
->continuity:uncertain "API rate limit handling unclear"
```

**Implementation:** Extend `src/wrapper/parser.ts`

```typescript
interface ContinuityCommand {
  type: 'save' | 'load' | 'uncertain' | 'search';
  content?: string;
  query?: string;
}

function parseContinuityCommand(output: string): ContinuityCommand | null;
```

### Layer 2: Relay Protocol Extensions

Add continuity message types to the protocol:

```typescript
// src/protocol/types.ts
type MessageType =
  | 'MESSAGE'
  | 'ACK'
  | 'NACK'
  // New continuity types
  | 'CONTINUITY_SAVE'      // Agent saves state
  | 'CONTINUITY_LOAD'      // Agent requests context
  | 'CONTINUITY_SEARCH'    // Agent searches history
  | 'CONTINUITY_INJECT';   // Daemon injects context

interface ContinuitySavePayload {
  agentName: string;
  ledger: Ledger;
  createHandoff: boolean;
}

interface ContinuityInjectPayload {
  agentName: string;
  context: string;  // Markdown to inject
}
```

### Layer 3: Wrapper-Level Automation

The `TmuxWrapper` monitors agents and handles continuity:

```typescript
// src/wrapper/tmux-wrapper.ts additions

class TmuxWrapper {
  private continuityManager: ContinuityManager;

  // Monitor output for continuity patterns
  private handleOutput(output: string) {
    const cmd = parseContinuityCommand(output);
    if (cmd) {
      this.handleContinuityCommand(cmd);
    }
  }

  // Inject context on agent spawn
  async spawnAgent(config: AgentConfig) {
    await this.startTmuxSession();

    // Load and inject continuity context
    const context = await this.continuityManager.getStartupContext(config.name);
    if (context) {
      await this.injectMessage(context);
    }

    await this.startAgentProcess(config);
  }

  // Auto-save before agent restart
  async restartAgent(agentName: string, reason: string) {
    // Save current state
    await this.continuityManager.autoSave(agentName, reason);

    // Restart with fresh context
    await this.killAgent(agentName);
    await this.spawnAgent({ name: agentName, ... });
  }
}
```

### Layer 4: Continuity Manager

Central service managing state persistence:

```typescript
// src/continuity/manager.ts
class ContinuityManager {
  private ledgerStore: LedgerStore;
  private handoffStore: HandoffStore;
  private artifactIndex: ArtifactIndex;

  // Get context to inject on agent startup
  async getStartupContext(agentName: string): Promise<string | null> {
    const ledger = await this.ledgerStore.load(agentName);
    const handoff = await this.handoffStore.getLatest(agentName);
    const learnings = await this.artifactIndex.getRelevantLearnings(agentName);

    if (!ledger && !handoff) return null;

    return this.formatStartupContext({ ledger, handoff, learnings });
  }

  // Save agent state (called via relay protocol or output pattern)
  async save(agentName: string, content: string, createHandoff: boolean) {
    const ledger = this.parseLedger(content);
    await this.ledgerStore.save(agentName, ledger);

    if (createHandoff) {
      const handoff = this.createHandoff(agentName, ledger);
      await this.handoffStore.save(handoff);
      await this.artifactIndex.index(handoff);
    }
  }

  // Auto-save triggered by wrapper (restart, crash, etc.)
  async autoSave(agentName: string, reason: string) {
    // Request state from agent via injected prompt
    // Or save last known state from ledger
  }

  // Search across all handoffs
  async search(query: string): Promise<Handoff[]> {
    return this.artifactIndex.search(query);
  }
}
```

## Data Structures

### Ledger (Within-Session)

```typescript
interface Ledger {
  agentName: string;
  sessionId: string;
  cli: string;  // 'claude' | 'codex' | 'gemini' | string

  // State
  currentTask: string;
  completed: string[];
  inProgress: string[];
  blocked: string[];

  // Decisions & Context
  keyDecisions: Decision[];
  uncertainItems: string[];  // Things to verify
  fileContext: FileRef[];    // Recently touched files

  updatedAt: Date;
}
```

### Handoff (Cross-Session)

```typescript
interface Handoff {
  id: string;
  agentName: string;
  cli: string;

  // Content
  summary: string;
  taskDescription: string;
  completedWork: string[];
  nextSteps: string[];

  // References
  fileReferences: FileRef[];
  decisions: Decision[];
  relatedHandoffs: string[];  // Links to previous handoffs

  // Metadata
  createdAt: Date;
  triggerReason: 'manual' | 'auto_restart' | 'context_limit' | 'crash';
}
```

### File Structure

```
.agent-relay/
├── continuity/
│   ├── ledgers/
│   │   ├── Alice.json       # Per-agent current state
│   │   └── Bob.json
│   ├── handoffs/
│   │   ├── Alice/
│   │   │   ├── 2025-12-31-auth-module.md
│   │   │   └── 2025-12-30-user-model.md
│   │   └── Bob/
│   │       └── 2025-12-31-api-endpoints.md
│   └── artifact-index.db    # SQLite + FTS5
```

## Agent Instructions (CLI-Agnostic)

Add to agent system prompts via CLAUDE.md / agent config:

```markdown
# Session Continuity

You have access to a continuity system that preserves your work across sessions.

## Saving State

When you want to save your current progress (recommended before long operations):

\```
->continuity:save <<<
Current task: [what you're working on]
Completed: [what's done]
In progress: [what's partially done]
Next steps: [what comes next]
Key decisions: [important choices made]
Uncertain: [things to verify]
Files: [key files with line numbers]
>>>
\```

## Loading Previous Context

To load your previous session state:
\```
->continuity:load
\```

## Searching History

To search past handoffs and decisions:
\```
->continuity:search "authentication patterns"
\```

The relay system will inject context automatically on session start.
```

## Dashboard Integration

### Components

```typescript
// Context meter showing agent "freshness"
interface AgentContextMeterProps {
  agentName: string;
  hasLedger: boolean;
  lastHandoff: Date | null;
  handoffCount: number;
}

// Handoff browser with search
interface HandoffBrowserProps {
  agentName?: string;
  onSelect: (handoff: Handoff) => void;
  onInject: (handoff: Handoff, targetAgent: string) => void;
}

// Ledger viewer showing current agent state
interface LedgerViewerProps {
  agentName: string;
  ledger: Ledger | null;
  onRefresh: () => void;
  onCreateHandoff: () => void;
}
```

### API Endpoints

```typescript
// Continuity API routes
router.get('/continuity/:agent/ledger', getLedger);
router.post('/continuity/:agent/ledger', saveLedger);
router.get('/continuity/:agent/handoffs', getHandoffs);
router.post('/continuity/:agent/handoff', createHandoff);
router.get('/continuity/search', searchHandoffs);
router.post('/continuity/:agent/inject', injectContext);
```

## CLI Commands

```bash
# View agent's current ledger
agent-relay continuity ledger Alice

# List handoffs for an agent
agent-relay continuity handoffs Alice

# Search all handoffs
agent-relay continuity search "authentication"

# Manually create handoff for agent
agent-relay continuity save Alice --reason "manual checkpoint"

# Inject context into running agent
agent-relay continuity inject Alice --handoff <handoff-id>

# Clear continuity data for agent
agent-relay continuity clear Alice
```

## Implementation Roadmap

### Milestone 1: Core Infrastructure
- [ ] `ContinuityManager` class
- [ ] `LedgerStore` with JSON file backend
- [ ] `HandoffStore` with markdown files
- [ ] Directory structure initialization

### Milestone 2: Protocol Integration
- [ ] Output pattern parser (`->continuity:` commands)
- [ ] Protocol message types
- [ ] Router handling for continuity messages

### Milestone 3: Wrapper Integration
- [ ] Context injection on spawn
- [ ] Auto-save on restart/crash
- [ ] Output monitoring for continuity patterns

### Milestone 4: Artifact Index
- [ ] SQLite + FTS5 schema
- [ ] Handoff indexing
- [ ] Search API

### Milestone 5: Dashboard & CLI
- [ ] `AgentContextMeter` component
- [ ] `HandoffBrowser` component
- [ ] `LedgerViewer` component
- [ ] CLI commands

### Milestone 6: Advanced Features
- [ ] Cross-agent context sharing
- [ ] Learning extraction
- [ ] Automatic context limit detection

## Trajectory Bridge (PR #38 Integration)

### Bridge Implementation

```typescript
// src/continuity/trajectory-bridge.ts
import { getTrajectoryStatus, type CompleteTrajectoryOptions } from '../trajectory/integration.js';
import type { HookContext } from '../hooks/types.js';

/**
 * Bridge between trajectory system and continuity system.
 * Automatically creates handoffs from trajectory data.
 */
export class TrajectoryBridge {
  constructor(
    private continuityManager: ContinuityManager,
    private hookRegistry: HookRegistry
  ) {
    this.registerHooks();
  }

  private registerHooks() {
    // When trajectory completes, create handoff
    this.hookRegistry.register('onTrajectoryComplete', async (ctx, data) => {
      const handoff = await this.createHandoffFromTrajectory(
        ctx.agentId,
        data.trajectory
      );
      await this.continuityManager.saveHandoff(handoff);
    });

    // When agent stops, save ledger with trajectory context
    this.hookRegistry.register('onAgentStop', async (ctx) => {
      const trajectoryStatus = await getTrajectoryStatus();
      if (trajectoryStatus.active) {
        await this.continuityManager.saveLedger(ctx.agentId, {
          currentPhase: trajectoryStatus.phase,
          trajectoryId: trajectoryStatus.trajectoryId,
        });
      }
    });
  }

  async createHandoffFromTrajectory(
    agentName: string,
    trajectory: TrajectoryData
  ): Promise<Handoff> {
    return {
      id: generateId(),
      agentName,
      cli: trajectory.agent || 'unknown',
      summary: trajectory.summary || '',
      taskDescription: trajectory.task?.title || '',
      completedWork: trajectory.completedSteps || [],
      nextSteps: this.deriveNextSteps(trajectory),
      fileReferences: trajectory.filesModified || [],
      decisions: trajectory.decisions || [],
      relatedHandoffs: [],
      createdAt: new Date(),
      triggerReason: 'trajectory_complete',
      // Trajectory-specific fields
      trajectoryId: trajectory.id,
      pderoPhase: trajectory.currentPhase,
      confidence: trajectory.confidence,
      learnings: trajectory.learnings,
    };
  }
}
```

### Handoff Extended for Trajectory

```typescript
interface Handoff {
  // ... existing fields ...

  // Trajectory integration (optional, present if from trajectory)
  trajectoryId?: string;
  pderoPhase?: PDEROPhase;
  confidence?: number;
  learnings?: string[];
}
```

## Files to Create/Modify

### New Files
```
src/continuity/
├── index.ts
├── manager.ts
├── ledger-store.ts
├── handoff-store.ts
├── artifact-index.ts
├── parser.ts              # Continuity command parsing
├── formatter.ts           # Context formatting for injection
└── trajectory-bridge.ts   # Integration with PR #38

src/dashboard/react-components/
├── AgentContextMeter.tsx
├── LedgerViewer.tsx
└── HandoffBrowser.tsx
```

### Modified Files
```
src/wrapper/parser.ts       # Add continuity pattern parsing
src/wrapper/tmux-wrapper.ts # Add continuity handling
src/protocol/types.ts       # Add continuity message types
src/daemon/router.ts        # Handle continuity messages
src/daemon/server.ts        # Add continuity API endpoints
src/cli/index.ts            # Add continuity commands
src/hooks/registry.ts       # Register continuity hooks (PR #38)
```

## CLI Support Matrix

| Feature | Claude | Codex | Gemini | Custom |
|---------|--------|-------|--------|--------|
| Output pattern detection | ✅ | ✅ | ✅ | ✅ |
| Context injection | ✅ | ✅ | ✅ | ✅ |
| Auto-save on restart | ✅ | ✅ | ✅ | ✅ |
| Manual save command | ✅ | ✅ | ✅ | ✅ |
| Handoff search | ✅ | ✅ | ✅ | ✅ |

## Success Metrics

1. **CLI-agnostic**: Works with Claude, Codex, Gemini without modification
2. **Seamless restarts**: Agents resume work after restart within 1 message
3. **Searchable history**: Find past decisions in <100ms
4. **Zero data loss**: No state lost across 10+ restart cycles
5. **Dashboard visibility**: Real-time continuity status for all agents

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Output parsing fragility | Well-defined patterns, fuzzy matching |
| Context injection timing | Wait for agent ready signal |
| Storage growth | Auto-archive, configurable retention |
| Cross-CLI compatibility | Test matrix, fallback behaviors |

## References

- [Continuous-Claude-v2](https://github.com/parcadei/Continuous-Claude-v2)
- [Agent Relay Architecture](../ARCHITECTURE.md)
- [Relay Protocol Spec](../protocol/README.md)
- [Trajectory Integration PR #38](https://github.com/AgentWorkforce/relay/pull/38)
- [Agent Trajectories Package](https://github.com/steveyegge/agent-trajectories)
