# Gastown vs Agent Relay: Deep Competitive Analysis

## Executive Summary

| Aspect | Gastown | Agent Relay |
|--------|---------|-------------|
| **Philosophy** | Complete orchestration platform | Unix-style messaging layer |
| **Language** | Go (compiled binary) | TypeScript (Node.js) |
| **GitHub Stars** | 5,913 | - |
| **Maturity** | 3,023 commits, 86 contributors | v2.0.11, active development |
| **Architecture** | Hierarchical (Mayor → Workers) | Peer-to-peer with daemon broker |
| **Agent Comm** | File-based hooks + mail CLI | Real-time socket + output parsing |
| **Latency** | Git-backed (disk I/O bound) | <5ms (Unix sockets) |

---

## 1. Scope & Ambition

### Gastown: Full Orchestration Platform
Gastown attempts to solve the **entire multi-agent coordination problem**:
- Workspace management (Towns, Rigs)
- Work tracking (Beads, Convoys, Molecules)
- Agent lifecycle (spawning, monitoring, health checks)
- Merge queue management
- Issue tracking integration
- Git worktree isolation
- Role-based agent taxonomy

**Strength**: Comprehensive, enterprise-grade solution
**Weakness**: High complexity, steep learning curve (50+ internal packages, extensive custom terminology)

### Agent Relay: Focused Messaging Layer
Agent Relay does **one thing well**: real-time agent-to-agent communication
- Message routing between CLI agents
- Lightweight spawning
- Channel-based group messaging
- Session continuity

**Strength**: Simple, composable, fast to adopt
**Weakness**: Not a complete solution—requires other tools for work tracking, merge queues, etc.

---

## 2. Agent Communication: Critical Comparison

### Gastown Communication Model

```
Mayor → gt sling → Hook (git worktree file) → Polecat reads on startup
Polecat → gt mail send → Mail queue → Recipient checks gt mail inbox
Real-time: gt nudge → tmux send-keys → Agent terminal
```

**Characteristics**:
- **File-based primary channel**: Hooks are git worktrees containing work assignments
- **Mail system**: Asynchronous message queue (`gt mail send/inbox/read`)
- **Nudge for real-time**: Uses `gt nudge` for immediate messaging
- **Hierarchical flow**: Work flows Mayor → Witness → Polecat (not truly P2P)
- **Session discovery**: `gt seance` to find/communicate with past sessions

**Latency**: Disk I/O bound (git operations, file writes)

### Agent Relay Communication Model

```
Agent stdout ("->relay:Bob hello") → Parser → Unix socket → Daemon → Injection → Target agent
```

**Characteristics**:
- **Output pattern detection**: Agents communicate by printing patterns, no CLI required
- **Real-time by default**: <5ms latency via Unix domain sockets
- **Peer-to-peer**: Any agent can message any other directly
- **Channels & topics**: Built-in group messaging (`#code-review`)
- **Sync messaging**: Request-response patterns with correlation IDs

**Latency**: <5ms (memory + socket)

### Winner: Agent Relay for Speed, Gastown for Structure

Agent Relay wins on **pure communication speed and simplicity**. Any CLI agent can participate without learning new commands—just print a pattern.

Gastown wins on **structured workflows**—the hook-based system ensures work survives crashes and restarts inherently (git-backed).

---

## 3. Agent Lifecycle Management

### Gastown
```bash
gt sling gt-abc12 myrig            # Assign work to Polecat (spawns if needed)
gt session stop myrig/alpha        # Stop agent
gt peek alpha                      # Health check
gt deacon health-state             # All agent health
```

**Features**:
- Role-based spawning (Polecat, Crew, Witness)
- Automatic work injection on spawn (Hook system)
- Health monitoring via Deacon daemon
- Session discovery and resurrection (`gt seance`)

### Agent Relay
```bash
agent-relay create-agent -n Worker claude   # Spawn wrapped agent
# Or from inside an agent:
->spawn:{"name":"Worker","cli":"claude","task":"Do X"}
```

**Features**:
- Programmatic spawning from any agent
- Shadow agents (subagent mode)
- Interactive mode for permission handling
- SPAWN_RESULT callbacks

### Winner: Gastown

Gastown's lifecycle management is more mature with health monitoring, automatic recovery, and structured role taxonomy.

---

## 4. State Persistence & Recovery

### Gastown
- **Git worktrees**: All work state lives in git—survives anything
- **Beads ledger**: JSONL-based issue/task tracking
- **Hooks**: Persistent work queues (git-backed files)
- **Seance**: Query past sessions for context

**Recovery**: Near-perfect. Work is in git, not memory.

### Agent Relay
- **SQLite storage**: Message history, session state
- **Continuity layer**: Save/load agent context
- **Resume tokens**: Reconnect and replay missed messages
- **Trajectory recording**: Decision trail for audit

**Recovery**: Good but not as robust as git-backed storage.

### Winner: Gastown

Git-backed persistence is fundamentally more resilient. Agent Relay's SQLite can corrupt; Gastown's git worktrees can be recovered from any clone.

---

## 5. Work Coordination

### Gastown
```
Convoy (work order) → Contains Beads (issues) → Slung to Polecats → Merge Queue → Refinery
```

**Features**:
- **Convoys**: Batch multiple issues into coordinated work units
- **Beads**: Git-backed issue tracking with dependencies
- **Formulas**: TOML workflow templates
- **Merge Queue**: Automated integration with conflict resolution
- **Attribution**: Every commit tracks which agent did the work

### Agent Relay
No built-in work tracking. Assumes external tools (GitHub Issues, Linear, etc.) for task management.

**Features**:
- **Consensus mechanism**: Multi-agent voting (built but not prominently featured)
- **Channels**: Group coordination via topics

### Winner: Gastown (decisively)

Gastown is a complete project management system. Agent Relay is a communication layer only.

---

## 6. Developer Experience

### Gastown Setup
```bash
# Install Go 1.23+, Git 2.25+, Beads 0.44.0+, SQLite3
go install github.com/steveyegge/gastown/cmd/gt@latest
gt install ~/gt
# Learn: Mayor, Deacon, Witness, Polecat, Crew, Dog, Rig, Hook, Bead, Convoy, Formula, Molecule...
```

**Learning curve**: Steep. 15+ new concepts, hierarchical role system, custom terminology.

### Agent Relay Setup
```bash
npm install -g agent-relay
agent-relay up
agent-relay create-agent claude
# Print "->relay:Bob hello" in any agent to message Bob
```

**Learning curve**: Minimal. Output patterns + daemon.

### Winner: Agent Relay

Agent Relay can be productive in minutes. Gastown requires significant investment to understand the conceptual model.

---

## 7. Multi-Runtime Support

| Runtime | Gastown | Agent Relay |
|---------|---------|-------------|
| Claude | ✅ | ✅ |
| Codex | ✅ | ✅ |
| Gemini | ✅ | ✅ |
| Cursor | ✅ | ✅ (via MCP) |
| Custom CLI | ✅ | ✅ |

Both support the major AI runtimes equally.

---

## 8. Enterprise Features Comparison

| Feature | Gastown | Agent Relay |
|---------|---------|-------------|
| Merge Queue | ✅ Built-in | ❌ |
| Issue Tracking | ✅ Beads | ❌ |
| Health Monitoring | ✅ Deacon | ✅ Heartbeat |
| Audit Trail | ✅ Git history | ✅ Trajectory |
| Multi-Project | ✅ Rigs | ✅ Bridge mode |
| Access Control | ⚠️ Implicit via roles | ✅ Policy package |
| Cloud/SaaS | ❌ | ✅ (in development) |
| Dashboard | ✅ Web UI | ✅ Web UI |
| MCP Integration | ❌ | ✅ Native |

---

## 9. Architectural Philosophy

### Gastown: "Cathedral"
- Opinionated, complete system
- Hierarchical control (Mayor at top)
- Heavy use of custom terminology (MEOW, GUPP, NDI, Bead, Convoy, Molecule, Polecat, etc.)
- Git-first persistence
- Go binary (fast, self-contained)

### Agent Relay: "Bazaar"
- Unix philosophy (do one thing well)
- Peer-to-peer communication
- Composable with other tools
- Speed-optimized (<5ms)
- Node.js (larger ecosystem, easier contributions)

---

## 10. Competitive Threats & Opportunities

### Where Gastown Wins

1. **Enterprise adoption**: Complete solution, less integration work needed
2. **Reliability**: Git-backed state is essentially bulletproof
3. **Complex workflows**: Molecules, Formulas, Merge Queues for sophisticated automation
4. **Steve Yegge brand**: Famous engineer with built-in audience and credibility
5. **Attribution**: Clear tracking of which agent did what work

### Where Agent Relay Wins

1. **Speed of adoption**: Productive in 2 minutes vs. 2 hours
2. **Real-time performance**: 100x faster messaging (<5ms vs. disk I/O)
3. **Flexibility**: Works with any orchestration layer
4. **Cloud-native**: SaaS model in development
5. **MCP integration**: Native Model Context Protocol support for IDE integration
6. **Lower barrier**: No new terminology to learn—just print patterns

---

## 11. Key Terminology Comparison

| Gastown Term | Agent Relay Equivalent | Notes |
|--------------|----------------------|-------|
| Town | Project root | Workspace container |
| Rig | - | Git repo container (no equivalent) |
| Mayor | Lead agent | Primary coordinator |
| Polecat | Spawned agent | Ephemeral worker |
| Crew | - | Persistent workers (no formal concept) |
| Witness | - | Monitoring daemon (no equivalent) |
| Deacon | Daemon | Background service |
| Hook | Inbox | Work queue |
| Bead | - | Issue/task (no built-in tracking) |
| Convoy | - | Work batch (no equivalent) |
| Formula | - | Workflow template (no equivalent) |
| gt nudge | ->relay:Name | Real-time message |
| gt mail | Channels | Async messaging |
| gt sling | ->spawn | Work assignment |
| gt seance | Resume tokens | Session recovery |

---

## 12. Strategic Recommendations for Agent Relay

### Do Not Compete Directly

Gastown owns the "complete platform" space. Attempting to match feature-for-feature would require years and dilute Agent Relay's focus.

### Emphasize Complementary Use

Position Agent Relay as the **real-time communication layer** that works alongside orchestration platforms. A team could use:
- Gastown for work tracking and lifecycle management
- Agent Relay for sub-millisecond agent chatter during execution

### Double Down on Differentiators

1. **Speed**: <5ms is unmatched. For latency-sensitive scenarios (live debugging, pair programming), Agent Relay wins.

2. **Simplicity**: Keep the learning curve at 5 minutes. This is a moat.

3. **Cloud/SaaS**: Gastown is local-first. Agent Relay's cloud infrastructure positions it for hosted multi-tenant deployment.

4. **MCP Ecosystem**: Native Model Context Protocol support enables IDE integrations Gastown doesn't have.

### Watch for Convergence

If Gastown adds real-time socket communication, or Agent Relay adds work tracking, the products will collide more directly. Monitor Gastown's roadmap.

---

## Conclusion

**Gastown** is a **comprehensive orchestration platform**—the "Kubernetes of AI agents." It solves the full lifecycle: work tracking, assignment, monitoring, merging, and attribution. The git-backed architecture is genius for reliability. However, it's complex (51 internal packages, extensive custom terminology) and requires significant investment to adopt.

**Agent Relay** is a **lightweight messaging layer**—the "ZeroMQ of AI agents." It does real-time P2P communication exceptionally well (<5ms) with minimal setup. It's composable and can integrate with other systems. However, it's not a complete solution—you need external tools for work tracking and merge queues.

### Market Positioning

| Target Audience | Recommended Solution |
|-----------------|---------------------|
| Enterprise needing full orchestration | Gastown |
| Developers wanting fast agent communication | Agent Relay |
| Teams with existing project management | Agent Relay |
| Greenfield multi-agent projects | Gastown |
| Latency-sensitive applications | Agent Relay |
| Complex merge workflows | Gastown |

### Coexistence Potential: High

A sophisticated team might use **both**: Gastown for work coordination (Convoys, Beads, Merge Queue) and Agent Relay for real-time agent chatter during execution. The products address different layers of the stack.

---

*Analysis conducted: January 2026*
*Gastown version: As of commit ~3,023*
*Agent Relay version: 2.0.11*
