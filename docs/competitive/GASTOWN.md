# Gastown vs Agent Relay: Deep Architectural Analysis

A comprehensive comparison of two multi-agent orchestration systems for Claude Code.

---

## Executive Summary

| Dimension | Gastown | Agent Relay |
|-----------|---------|-------------|
| **Primary Language** | Go (99.6%) | TypeScript/Node.js |
| **Core Philosophy** | Work-centric orchestration ("hooks + molecules") | Communication-centric ("real-time messaging") |
| **State Management** | Git-backed persistent (Beads) | SQLite ephemeral + optional cloud |
| **Agent Lifecycle** | Managed (polecats spawn/die) | User-managed (wrapper only) |
| **Scaling Target** | 20-30 agents | ~50 agents |
| **Complexity** | High (38 internal packages) | Moderate (6 architectural layers) |
| **Workflow System** | Formulas → Molecules (TOML-based) | None (pure messaging) |
| **Cross-Project** | Federation with HOP protocol | Bridge mode with socket connections |

---

## 1. Architectural Philosophy

### Gastown: "The Steam Engine Model"

Gastown treats multi-agent coordination as an **industrial workflow problem**. The core metaphor is a steam engine where:

- **Hooks** are pistons that hold work
- **Agents** are workers that execute when work appears
- **The Propulsion Principle**: "If you find something on your hook, YOU RUN IT"

This creates a **push-based, autonomous execution model** where agents don't wait for confirmation—they execute immediately upon receiving work. The system prioritizes:

1. **Work persistence over agent persistence** - Work survives agent crashes
2. **Accountability** - Git-backed ledger tracks who did what
3. **Reproducibility** - Formulas define repeatable workflows

### Agent Relay: "The Postal Service Model"

Agent Relay treats multi-agent coordination as a **communication problem**. The core insight is that AI agents already produce text output, so:

- **Output parsing** extracts intent from `->relay:` patterns
- **Message routing** delivers messages between agents
- **Terminal injection** presents messages as user input

This creates a **peer-to-peer, message-passing model** where agents communicate freely. The system prioritizes:

1. **Zero agent modification** - Works with any CLI-based AI
2. **Transparency** - Users see `->relay:` commands in output
3. **Simplicity** - Just messaging, nothing else

---

## 2. Component Architecture

### Gastown's Role Hierarchy

```
┌─────────────────────────────────────────────────────────────┐
│                         TOWN                                 │
├─────────────────────────────────────────────────────────────┤
│  Mayor (Global Coordinator)                                  │
│    └── Deacon (Background Daemon)                           │
│          └── Dog (Infrastructure Helpers)                   │
├─────────────────────────────────────────────────────────────┤
│  RIG (Per-Project)                                          │
│    ├── Witness (Lifecycle Monitor)                          │
│    ├── Refinery (Merge Queue Processor)                     │
│    └── Polecats (Ephemeral Workers)                         │
│         └── Each with own git worktree                      │
├─────────────────────────────────────────────────────────────┤
│  CREW (Persistent Workers)                                  │
│    └── User-managed, long-lived, exploratory work           │
└─────────────────────────────────────────────────────────────┘
```

**38 internal packages** organized by domain:
- **Core**: boot, config, daemon, session
- **Communication**: mail, mq, protocol, feed
- **Development**: git, tmux, tui, workspace
- **Workflow**: formula, molecules, checkpoint
- **Specialized**: claude, beads, swarm, refinery

### Agent Relay's Layer Model

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 6: Dashboard (Web UI monitoring)                     │
├─────────────────────────────────────────────────────────────┤
│  Layer 5: Storage (SQLite persistence)                      │
├─────────────────────────────────────────────────────────────┤
│  Layer 4: Protocol (Wire format, envelopes)                 │
├─────────────────────────────────────────────────────────────┤
│  Layer 3: Daemon (Message broker, routing)                  │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: Wrapper (Tmux, parsing, injection)                │
├─────────────────────────────────────────────────────────────┤
│  Layer 1: CLI (User interface)                              │
└─────────────────────────────────────────────────────────────┘
```

**~15 source files** with clear responsibilities:
- CLI entry → TmuxWrapper → OutputParser → RelayClient → Daemon → Router

---

## 3. Work & State Management

### Gastown: MEOW (Molecular Expression Of Work)

Gastown introduces a sophisticated work lifecycle:

```
Formula (TOML)     →    Protomolecule    →    Molecule    →    Wisp
   "Ice-9"              "Solid"               "Liquid"         "Vapor"
 (Template)          (Frozen template)    (Active workflow)  (Ephemeral)

Operations:
  cook: Formula → Protomolecule
  pour: Protomolecule → Molecule
  wisp: Create ephemeral work
  squash: Compress completed molecule to digest
  burn: Discard wisp
```

**Formulas define multi-step workflows** in TOML:
- Steps with dependencies
- Crash recovery points
- Reproducible execution paths

**Beads provides git-backed persistence**:
- Issues stored in `.beads/beads.jsonl`
- Complete audit trail
- Survives agent restarts

### Agent Relay: Message Persistence

Agent Relay has simpler state:

```
Message → SQLite → Agents.json (for dashboard)
              ↓
        SessionStorage
              ↓
        AgentSummaries (optional)
```

**Messages are ephemeral by default**:
- SQLite stores history for querying
- No built-in workflow state
- Sessions track agent lifecycle

**Optional cloud sync** for cross-machine:
- Remote agent discovery
- Cross-machine message routing

---

## 4. Communication Protocols

### Gastown Mail Protocol

Structured message types for specific purposes:

| Message Type | Purpose |
|--------------|---------|
| `POLECAT_DONE` | Worker signals completion |
| `MERGE_READY` | Work ready for integration |
| `MERGED` / `MERGE_FAILED` | Merge outcomes |
| `REWORK_REQUEST` | Conflict resolution needed |
| `WITNESS_PING` | Health monitoring |
| `HELP` | Escalation request |
| `HANDOFF` | Session continuity |

**Format**: Uppercase type prefixes, key-value pairs, markdown sections.

**Addressing**: `<rig>/<role>` for routing clarity.

### Agent Relay Protocol

General-purpose envelope system:

```typescript
interface Envelope<T> {
  v: number;           // Protocol version
  type: MessageType;   // HELLO, SEND, DELIVER, etc.
  id: string;          // UUID
  ts: number;          // Timestamp
  from?: string;       // Sender
  to?: string | '*';   // Recipient or broadcast
  topic?: string;      // Optional channel
  payload: T;          // Message content
}
```

**Message Types**: HELLO, WELCOME, SEND, DELIVER, ACK, NACK, PING, PONG, SUBSCRIBE, etc.

**Addressing**: Agent names directly, `*` for broadcast, topics for pub/sub.

---

## 5. Agent Lifecycle

### Gastown: Managed Agents

**Polecats** (ephemeral workers):
- Spawned by Witness when work appears
- Each gets own git worktree
- Automatically cleaned up when done
- Supervised for stuck/failed states

**Crew** (persistent workers):
- User-managed Claude instances
- Long-lived for exploratory work
- Own personal repository clones

**Full Stack Mode** with daemon:
- `gt start` launches supervision
- Automatic spawning based on work queue
- Health monitoring and escalation

### Agent Relay: Wrapped Agents

**TmuxWrapper** wraps any CLI:
- User starts agents manually
- Wrapper provides messaging layer
- Agent lifecycle is user's responsibility

**Bridge Mode** for orchestration:
- Architect agent coordinates multiple projects
- Can spawn/release workers
- But spawning is delegated, not managed

---

## 6. Cross-Project Coordination

### Gastown: Federation

**HOP Protocol** for distributed references:
```
hop://entity/chain/rig/issue-id
```

**Three-level entity model**:
1. Entities (persons/organizations)
2. Chains (workspaces per entity)
3. Work units (issues, tasks)

**Features**:
- Cross-workspace queries
- Agent provenance via git metadata
- Aggregation across relationships
- "Monorepo-like visibility" with autonomy

### Agent Relay: Bridge Mode

**MultiProjectClient** connects multiple daemons:
```typescript
// Connect to project daemons via Unix sockets
agent-relay bridge ~/auth ~/frontend ~/api
```

**Addressing**:
```
->relay:projectId:agent    # Specific agent in project
->relay:*:lead             # All project leads
```

**Features**:
- Architect agent perspective
- Cross-project broadcasts
- Spawn/release workers
- But simpler than federation

---

## 7. Pros & Cons

### Gastown

**Pros**:
1. **Crash-resistant** - Work persists on hooks, survives restarts
2. **Reproducible workflows** - Formulas define exact steps
3. **Git-integrated** - Full audit trail, provenance tracking
4. **Sophisticated scaling** - Designed for 20-30 agents comfortably
5. **Merge queue** - Built-in code integration workflow
6. **Federation** - True distributed coordination

**Cons**:
1. **Complexity** - 38 packages, steep learning curve
2. **Go-only** - Harder to extend for Node.js projects
3. **Opinionated** - Requires adopting Beads for issue tracking
4. **Setup overhead** - More infrastructure to run

### Agent Relay

**Pros**:
1. **Simplicity** - 6 layers, easy to understand
2. **Universal** - Works with any CLI agent unmodified
3. **Transparent** - Users see all communication
4. **TypeScript** - Easy to extend for web projects
5. **Low overhead** - Just messaging, minimal infrastructure
6. **Dashboard** - Built-in real-time monitoring UI

**Cons**:
1. **No workflow system** - Pure messaging, no task orchestration
2. **Ephemeral by default** - Work state not persistent
3. **Fragile parsing** - Output parsing can miss messages
4. **No merge queue** - Code integration is external
5. **Simple scaling** - Less sophisticated than Gastown

---

## 8. Key Learnings for Relay

### Ideas to Adopt

1. **Propulsion Principle**
   - Agents should act immediately on received work
   - Don't wait for confirmation if work is clearly assigned
   - Could add `ack_required` flag for critical messages

2. **Persistent Work Hooks**
   - Consider file-based "hook" per agent that survives restarts
   - Agent checks hook on startup, continues pending work
   - Already have inbox files—could extend to work assignments

3. **Formulas/Workflows**
   - Could add simple TOML/YAML workflow definitions
   - Multi-step task templates with dependency tracking
   - Not as complex as molecules, but structured

4. **Git Integration for Provenance**
   - Track agent actions in git metadata
   - `GIT_AUTHOR_NAME="relay/Alice"` for attribution
   - Audit trail for who did what

5. **Health Monitoring**
   - Heartbeat escalation like WITNESS_PING
   - Auto-detect stuck agents
   - Surface to dashboard with alerts

6. **Merge Queue Concept**
   - Not necessarily a full refinery
   - But workflow for "work complete, ready for integration"
   - Could trigger CI/CD or human review

### Ideas to Evaluate

1. **Beads Integration**
   - Relay already mentions Beads compatibility
   - Could formalize the integration
   - Use Beads as task queue, Relay as communication

2. **Federation Model**
   - HOP-style URIs could standardize cross-project addressing
   - More discoverable than current bridge mode
   - But adds complexity

3. **Worker Types (Polecat vs Crew)**
   - Distinguish ephemeral workers from persistent leads
   - Different lifecycle management
   - Could improve spawn/release semantics

---

## 9. Architectural Recommendations

### Short-term Improvements

1. **Add Work Persistence Layer**
   ```typescript
   // Agent hook file that survives restarts
   interface AgentHook {
     agentName: string;
     pendingWork: WorkItem[];
     lastCheckpoint: number;
   }
   ```

2. **Implement Activity Escalation**
   - If agent idle for X minutes with pending work → alert
   - Dashboard shows "stuck" indicator
   - Optional auto-notification to leads

3. **Structured Message Types**
   - Add message kinds beyond generic `message`
   - `TASK_ASSIGNED`, `WORK_COMPLETE`, `BLOCKED`, `HELP_NEEDED`
   - Enables workflow-aware routing

### Medium-term Improvements

1. **Simple Workflow Templates**
   ```yaml
   # .relay/workflows/review.yaml
   name: code-review
   steps:
     - assignee: Reviewer
       action: review_code
       on_complete: merge
     - assignee: Lead
       action: approve_merge
   ```

2. **Beads Integration Mode**
   - Read tasks from `.beads/beads.jsonl`
   - Update status via relay messages
   - Single source of truth for work

3. **Federation Lite**
   - Standardized project discovery
   - Cross-project agent registry
   - Simpler than HOP but interoperable

---

## 10. Conclusion

Gastown and Agent Relay solve the multi-agent coordination problem from different angles:

- **Gastown** is a **work orchestration system** that happens to include messaging
- **Agent Relay** is a **messaging system** that enables coordination

Both are valid approaches. The right choice depends on:

| If you need... | Choose... |
|----------------|-----------|
| Reproducible workflows | Gastown |
| Any-CLI compatibility | Agent Relay |
| Git-backed audit trail | Gastown |
| Quick prototyping | Agent Relay |
| Automatic agent lifecycle | Gastown |
| Minimal infrastructure | Agent Relay |
| Multi-org federation | Gastown |
| Real-time dashboard | Agent Relay |

**For Agent Relay specifically**, the key learnings are:

1. **Add work persistence** - Don't lose assignments on restart
2. **Consider workflow templates** - Simple YAML for multi-step tasks
3. **Improve escalation** - Detect and surface stuck agents
4. **Standardize message types** - Enable workflow-aware behavior
5. **Explore Beads integration** - Leverage existing task tracking

The systems could potentially be complementary: use Gastown for work orchestration and Relay for real-time communication between agents managed by Gas Town.

---

*Analysis generated 2026-01-02*
*Based on Gastown repository (github.com/steveyegge/gastown) and Agent Relay source code*
