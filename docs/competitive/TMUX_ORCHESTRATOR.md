# Tmux-Orchestrator vs Agent Relay: Competitive Analysis

A comprehensive comparison of tmux-based multi-agent orchestration approaches.

---

## Executive Summary

| Dimension | Tmux-Orchestrator | Agent Relay |
|-----------|-------------------|-------------|
| **Primary Language** | Python (80.5%) + Shell (19.5%) | TypeScript/Node.js |
| **Core Philosophy** | Autonomous scheduling ("self-triggering agents") | Real-time messaging ("peer-to-peer communication") |
| **Communication** | tmux send-keys with timing delays | Unix socket + PTY injection |
| **Agent Hierarchy** | Fixed 3-tier (Orchestrator→PM→Engineer) | Flexible (any structure) |
| **State Management** | Git commits + context notes | SQLite + optional cloud sync |
| **Scaling Target** | Multi-project, multi-team | Single project (~50 agents) |
| **Complexity** | Low (~5 scripts) | Moderate (6 architectural layers) |
| **Setup** | Manual tmux session creation | `npm install`, daemon auto-start |

**Key Finding:** Tmux-Orchestrator pioneered the concept of 24/7 autonomous Claude agents using tmux persistence, but relies on manual shell scripting for coordination. Agent Relay provides a more sophisticated communication layer while maintaining the tmux foundation.

---

## 1. Architectural Philosophy

### Tmux-Orchestrator: "The Factory Model"

Tmux-Orchestrator treats multi-agent coordination as an **industrial process** with rigid role separation:

```
┌─────────────────────────────────────────────────────────────┐
│                    ORCHESTRATOR (1)                          │
│           • Global coordination across projects              │
│           • Knowledge sharing between teams                  │
│           • High-level progress monitoring                   │
└─────────────────────────┬───────────────────────────────────┘
                          │
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
┌───────────────┐ ┌───────────────┐ ┌───────────────┐
│   PROJECT     │ │   PROJECT     │ │   PROJECT     │
│   MANAGER     │ │   MANAGER     │ │   MANAGER     │
│  (per repo)   │ │  (per repo)   │ │  (per repo)   │
└───────┬───────┘ └───────┬───────┘ └───────┬───────┘
        │                 │                 │
   ┌────┴────┐       ┌────┴────┐       ┌────┴────┐
   ▼         ▼       ▼         ▼       ▼         ▼
┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐
│ ENG  │ │ ENG  │ │ ENG  │ │ ENG  │ │ ENG  │ │ ENG  │
└──────┘ └──────┘ └──────┘ └──────┘ └──────┘ └──────┘
```

**Core Principles:**
1. **Role Specialization** - Each tier has distinct responsibilities
2. **Context Window Management** - Hierarchy prevents single-agent overload
3. **Autonomous Scheduling** - Agents trigger their own check-ins
4. **Persistent Execution** - Work continues when developers disconnect

### Agent Relay: "The Postal Service Model"

Agent Relay treats coordination as a **communication problem** with flexible topology:

```
┌─────────────────────────────────────────────────────────────┐
│                      DAEMON (Router)                         │
│              Unix Socket + WebSocket Server                  │
└─────────────────────────┬───────────────────────────────────┘
                          │
   ┌──────────────────────┼──────────────────────┐
   │                      │                      │
   ▼                      ▼                      ▼
┌──────────┐       ┌──────────┐          ┌──────────┐
│  Agent A │ ←───→ │  Agent B │ ←──────→ │  Agent C │
│  (Lead)  │       │ (Worker) │          │ (Worker) │
└──────────┘       └──────────┘          └──────────┘
       ↑                                       │
       └───────────────────────────────────────┘
              Direct peer-to-peer messaging
```

**Core Principles:**
1. **Any Topology** - Roles defined by convention, not enforcement
2. **Direct Communication** - Agents message each other without intermediaries
3. **Zero Modification** - Works with unmodified CLI agents
4. **Real-Time Messaging** - <5ms latency via Unix socket

---

## 2. Communication Mechanisms

### Tmux-Orchestrator: Shell Script + Timing

**Primary tool: `send-claude-message.sh`**

```bash
#!/bin/bash
# Usage: ./send-claude-message.sh session:window "message"
TARGET=$1
MESSAGE=$2

tmux send-keys -t "$TARGET" "$MESSAGE"
sleep 0.5  # Critical delay for message parsing
tmux send-keys -t "$TARGET" Enter
```

**Characteristics:**
- Shell-based, simple to understand
- Fixed timing delays (0.5s between message and Enter)
- Target format: `session_name:window_index`
- No message queuing or delivery confirmation
- No persistence of message history

**Self-scheduling with notes:**

```bash
# schedule_with_note.sh [minutes] "[actionable instruction]"
./schedule_with_note.sh 30 "Review PR and update status"
```

### Agent Relay: Pattern Detection + Unix Socket

**Primary mechanism: Output parsing**

```
Agent output: "->relay:Alice Let's discuss the API design"
              ↓ Pattern detection
         RelayClient extracts message
              ↓ Unix socket IPC
         Daemon routes to Alice
              ↓ tmux send-keys
         Alice receives via PTY injection
```

**Characteristics:**
- Pattern-based (`->relay:`) - no SDK needed
- Sub-5ms latency via Unix Domain Socket
- Message queuing and persistence
- Delivery acknowledgment
- Full message history in SQLite

**Comparison:**

| Aspect | Tmux-Orchestrator | Agent Relay |
|--------|-------------------|-------------|
| **Message Format** | Raw text | Structured envelope |
| **Latency** | ~500ms (timing delay) | <5ms |
| **Delivery Guarantee** | None | ACK/NACK |
| **History** | None | SQLite persistence |
| **Addressing** | `session:window` | Agent name |
| **Broadcast** | Manual loop | `->relay:*` |

---

## 3. Agent Lifecycle Management

### Tmux-Orchestrator: Manual with Convention

**Creating agents:**
```bash
# Create tmux session for project
tmux new-session -d -s myproject

# Launch Project Manager in window 0
tmux send-keys -t myproject:0 "claude" Enter

# PM creates Engineer in new window
# (PM runs these commands via Claude)
tmux new-window -t myproject -c /path/to/project
tmux send-keys -t myproject:1 "claude --task='Implement feature X'" Enter
```

**Self-scheduling (autonomous check-ins):**
```bash
# Agent schedules itself for 30 minutes later
./schedule_with_note.sh 30 "Check progress on feature X"
```

**Window awareness:**
```bash
# Agent discovers its own location
tmux display-message -p "#{session_name}:#{window_index}"
```

### Agent Relay: Daemon-Managed

**Creating agents:**
```bash
# Start daemon (auto if not running)
agent-relay up

# Wrap agent (auto-registers with daemon)
agent-relay wrap --name Alice claude

# Spawn from another agent
->relay:spawn Worker claude "Implement feature X"
```

**Lifecycle visibility:**
- Dashboard shows all active agents
- Presence tracking (online/offline/idle)
- Session summaries for recovery

**Comparison:**

| Aspect | Tmux-Orchestrator | Agent Relay |
|--------|-------------------|-------------|
| **Agent Creation** | Manual tmux commands | `wrap` or `spawn` command |
| **Registration** | None (implicit) | Explicit HELLO handshake |
| **Discovery** | Know window names | `agents.json` + dashboard |
| **Health Check** | Manual inspection | Heartbeat monitoring |
| **Recovery** | Context notes | Session summaries |

---

## 4. Workflow & Task Management

### Tmux-Orchestrator: Specification-Driven

**Project Specification (Markdown):**
```markdown
# Project: Auth System

## Goals
- Implement JWT authentication
- Add refresh token support

## Constraints
- Must use existing User model
- No external auth providers

## Deliverables
1. /api/login endpoint
2. /api/refresh endpoint
3. Auth middleware
4. Unit tests

## Success Criteria
- All tests pass
- No security vulnerabilities
```

**Git Discipline (Mandatory):**
- Commit every 30 minutes minimum
- Feature branches for new work
- Descriptive commit messages
- Tag stable versions

**Escalation Pattern:**
- 3 message exchanges maximum before escalation
- PM→Orchestrator for cross-project issues
- Async standups instead of meetings

### Agent Relay: Message-Based Coordination

**No built-in workflow system** - pure messaging:

```
->relay:Worker TASK: Implement /api/login endpoint

->relay:Lead STATUS: Working on login endpoint

->relay:Lead DONE: Login endpoint complete, ready for review

->relay:Reviewer REVIEW: Please check src/auth/login.ts
```

**Conventions (not enforced):**
- `TASK:` for assignments
- `STATUS:` for updates
- `DONE:` for completion
- `ACK:` for acknowledgment
- `QUESTION:` for clarification

**Comparison:**

| Aspect | Tmux-Orchestrator | Agent Relay |
|--------|-------------------|-------------|
| **Task Definition** | Markdown specs | Free-form messages |
| **Progress Tracking** | Git commits | Message history |
| **Escalation** | Fixed rules | Ad-hoc |
| **Quality Gates** | PM checklists | None built-in |
| **Audit Trail** | Git history | SQLite + optional Git |

---

## 5. Scaling & Multi-Project

### Tmux-Orchestrator: Separate Sessions

**Multi-project architecture:**
```
tmux sessions:
├── project-a (PM in :0, Engineers in :1, :2)
├── project-b (PM in :0, Engineers in :1)
└── orchestrator (Coordinates all)
```

**Cross-project intelligence:**
- Orchestrator shares patterns between projects
- Solutions discovered in one project applied to others
- Global learning repository (LEARNINGS.md)

### Agent Relay: Bridge Mode

**Multi-project via bridge:**
```bash
agent-relay bridge ~/auth ~/frontend ~/api
```

**Addressing:**
```
->relay:frontend:Designer Update the login UI
->relay:*:lead Question about API design
```

**Comparison:**

| Aspect | Tmux-Orchestrator | Agent Relay |
|--------|-------------------|-------------|
| **Multi-Project** | Separate tmux sessions | Bridge mode |
| **Cross-Project Messaging** | Via Orchestrator | Direct with project:agent |
| **Knowledge Sharing** | LEARNINGS.md file | Optional cloud sync |
| **Setup Complexity** | Manual session management | Single bridge command |

---

## 6. Pros & Cons

### Tmux-Orchestrator

**Pros:**
1. **Simple conceptually** - Just shell scripts and tmux
2. **24/7 autonomy** - Agents work without supervision
3. **Role clarity** - Fixed hierarchy prevents confusion
4. **Git-native** - Progress tracked via commits
5. **Zero dependencies** - Only needs tmux + Claude CLI
6. **Pioneered the approach** - Proved the concept works
7. **Multi-project coordination** - Orchestrator shares knowledge

**Cons:**
1. **No message persistence** - Lost on session end
2. **Fixed hierarchy** - Can't adapt topology
3. **Manual setup** - Each tmux session created by hand
4. **No delivery confirmation** - Hope messages arrive
5. **Timing-dependent** - 500ms delays add up
6. **No dashboard** - Inspect tmux manually
7. **Fragile scripting** - Shell edge cases break things

### Agent Relay

**Pros:**
1. **Real-time messaging** - <5ms latency
2. **Message persistence** - SQLite history
3. **Flexible topology** - Any structure works
4. **Visual dashboard** - Real-time monitoring
5. **Delivery guarantees** - ACK/NACK system
6. **Zero-config agents** - Pattern detection
7. **Bridge mode** - Multi-project coordination
8. **Session continuity** - Summaries for recovery

**Cons:**
1. **More infrastructure** - Daemon, SQLite, etc.
2. **Node.js dependency** - Heavier than shell
3. **No built-in workflows** - Pure messaging
4. **Single project default** - Bridge for multi-project
5. **No enforced discipline** - Git commits optional
6. **Learning curve** - More concepts than scripts

---

## 7. Key Learnings for Relay

### Ideas to Adopt

1. **Self-Scheduling Pattern**
   ```
   ->relay:schedule 30m "Check progress on feature X"
   ```
   - Allow agents to schedule their own check-ins
   - Persist schedules to survive restarts
   - Dashboard shows upcoming scheduled messages

2. **Enforced Git Discipline**
   - Add hooks for "commit required every 30 min"
   - Track last commit time per agent
   - Dashboard warning when overdue
   - Block new task assignment without recent commit

3. **Specification Templates**
   - Built-in project spec format
   - Parse and track deliverables
   - Link messages to spec items
   - Progress view against spec

4. **LEARNINGS.md Pattern**
   - Shared knowledge repository across agents
   - Auto-extract insights from agent conversations
   - Searchable via `->relay:learn "topic"`

5. **Escalation Rules**
   - Configurable max exchanges before escalation
   - Auto-notify lead after threshold
   - Thread-based tracking

6. **Context Notes for Scheduling**
   - When scheduling, include context summary
   - Inject context when schedule fires
   - Better continuity than raw message

### Ideas to Evaluate

1. **Fixed Hierarchy Option**
   - Optional enforcement of Orchestrator→PM→Engineer
   - Validation that messages follow hierarchy
   - Could reduce chaos in large teams

2. **Window Location Awareness**
   - Track which tmux session:window each agent is in
   - Allow `->relay:window:1` addressing
   - Useful for legacy tmux users

3. **Per-Project Sessions**
   - Separate daemon per project by default
   - Bridge only when needed
   - Simpler mental model

---

## 8. Architectural Recommendations

### Short-term Improvements

1. **Add Self-Scheduling Command**
   ```typescript
   // New pattern: ->relay:schedule TIME MESSAGE
   // Agent schedules a message to itself
   ->relay:schedule 30m "Review PR status"

   // Implementation: Store in SQLite, daemon fires at time
   interface ScheduledMessage {
     id: string;
     fireAt: number;
     to: string;
     content: string;
     context?: string;
   }
   ```

2. **Add Commit Tracking**
   ```typescript
   // Track last commit time per agent
   // Dashboard shows: "Alice: last commit 45m ago (WARNING)"
   // Optional hook: block task assignment if >60m since commit
   ```

3. **Add Context Notes to Spawn**
   ```
   ->relay:spawn Worker claude <<<
   TASK: Implement /api/login
   CONTEXT: Using JWT, see src/auth/utils.ts for helpers
   SPEC: Must pass all tests in tests/auth/
   >>>
   ```

### Medium-term Improvements

1. **Specification Tracking**
   ```yaml
   # .relay/spec.yaml
   deliverables:
     - id: login-endpoint
       description: "/api/login endpoint"
       assigned: Worker
       status: in_progress
       tests: ["tests/auth/login.test.ts"]
   ```

2. **Learning Repository Integration**
   ```
   # Auto-capture learnings from conversations
   ->relay:learn "JWT refresh tokens need 7-day expiry for mobile apps"

   # Query learnings
   ->relay:recall "JWT refresh token best practices"
   ```

3. **Escalation Rules Engine**
   ```yaml
   # .relay/escalation.yaml
   rules:
     - after: 3 messages
       if: no_resolution
       notify: lead
     - after: 30 minutes
       if: blocked
       notify: orchestrator
   ```

### Long-term Vision

**Hybrid Approach:**

```
┌─────────────────────────────────────────────────────────────┐
│            Agent Relay + Tmux-Orchestrator Hybrid            │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────┐ │
│  │         agent-relay daemon (communication)              │ │
│  │    • Real-time messaging (<5ms)                         │ │
│  │    • Message persistence                                │ │
│  │    • Dashboard monitoring                               │ │
│  └─────────────────────────────────────────────────────────┘ │
│                              │                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │         Orchestration Layer (from Tmux-Orchestrator)    │ │
│  │    • Self-scheduling system                             │ │
│  │    • Git commit enforcement                             │ │
│  │    • Specification tracking                             │ │
│  │    • Escalation rules                                   │ │
│  │    • Learning repository                                │ │
│  └─────────────────────────────────────────────────────────┘ │
│                              │                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │         tmux sessions (execution)                       │ │
│  │    • Persistent agent processes                         │ │
│  │    • Hierarchical project structure                     │ │
│  │    • 24/7 autonomous operation                          │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## 9. Solution Rankings

### Best for Each Use Case

| If you need... | Tmux-Orchestrator | Agent Relay | Winner |
|----------------|-------------------|-------------|--------|
| **24/7 autonomous operation** | Native design | Supported | Tie |
| **Real-time messaging** | ~500ms delays | <5ms | Relay |
| **Multi-project coordination** | Via Orchestrator | Bridge mode | Tie |
| **Minimal dependencies** | Just tmux + bash | Node.js daemon | Tmux |
| **Message persistence** | None | SQLite | Relay |
| **Visual monitoring** | tmux inspection | Web dashboard | Relay |
| **Delivery confirmation** | None | ACK/NACK | Relay |
| **Built-in workflows** | Spec + escalation | None | Tmux |
| **Git discipline** | Enforced by convention | Optional | Tmux |
| **Flexible topology** | Fixed 3-tier | Any structure | Relay |
| **Learning curve** | Low (shell scripts) | Moderate | Tmux |

### Overall Assessment

**Tmux-Orchestrator is better for:**
- Teams that want minimal tooling
- Projects with clear hierarchical structure
- Those prioritizing simplicity over features
- Users comfortable with shell scripting

**Agent Relay is better for:**
- Teams needing real-time coordination
- Projects requiring message history
- Users wanting visual monitoring
- Flexible team structures

---

## 10. Conclusion

Tmux-Orchestrator and Agent Relay represent two generations of tmux-based agent orchestration:

**Tmux-Orchestrator** (First Generation):
- Proved the concept of autonomous 24/7 Claude agents
- Simple shell scripts + tmux persistence
- Fixed hierarchy solves context window problem
- Git discipline ensures work is preserved
- Limited by lack of real-time communication

**Agent Relay** (Second Generation):
- Builds on the tmux foundation
- Adds real-time messaging layer
- Provides persistence and monitoring
- Enables flexible topologies
- Could benefit from workflow features

**Recommendation:**

Agent Relay should adopt key innovations from Tmux-Orchestrator:

| Priority | Feature | Effort | Impact |
|----------|---------|--------|--------|
| P0 | Self-scheduling system | Medium | High |
| P0 | Git commit tracking | Low | Medium |
| P1 | Context notes for continuity | Low | Medium |
| P1 | Specification tracking | Medium | High |
| P2 | Escalation rules engine | Medium | Medium |
| P2 | Learning repository | High | High |
| P3 | Fixed hierarchy mode | Low | Low |

The ideal future combines Agent Relay's communication sophistication with Tmux-Orchestrator's workflow discipline.

---

*Analysis generated 2026-01-04*
*Based on Tmux-Orchestrator repository (github.com/Jedward23/Tmux-Orchestrator) and Agent Relay source code*
