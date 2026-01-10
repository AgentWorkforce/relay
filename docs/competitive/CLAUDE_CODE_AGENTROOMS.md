# Claude Code Agentrooms vs Agent Relay: Deep Architectural Analysis

A comprehensive comparison of two multi-agent orchestration systems for Claude Code.

---

## Executive Summary

| Dimension | Claude Code Agentrooms | Agent Relay |
|-----------|------------------------|-------------|
| **Primary Stack** | TypeScript (70.9%), Deno/React/Electron | TypeScript/Node.js |
| **Core Philosophy** | Hub-and-spoke orchestration ("@mentions") | Peer-to-peer messaging ("->relay:") |
| **Authentication** | Claude CLI OAuth (no API keys) | Nango OAuth (GitHub App) |
| **Agent Communication** | HTTP REST + File-based | Output parsing + Terminal injection |
| **Deployment** | Desktop app + Web UI | CLI daemon + Dashboard |
| **State Management** | SQLite (openmemory.sqlite) | SQLite + Cloud PostgreSQL |
| **Multi-Room Support** | Single room (multi planned) | Multi-workspace native |
| **Remote Agents** | HTTP endpoints (localhost/network) | Agent spawning + Cloud sandboxes |

---

## 1. Architectural Philosophy

### Agentrooms: "The Hub-and-Spoke Model"

Agentrooms treats multi-agent coordination as a **routing and orchestration problem**. The core pattern is:

- **Orchestrator Backend** runs on port 8080 as the central hub
- **Specialized Agents** register as HTTP endpoints (localhost:8081+)
- **@mention Syntax** routes tasks to specific agents or triggers decomposition

```
User Request
    │
    ▼
┌─────────────────┐
│   Orchestrator  │ ◄── Planner API for task decomposition
│   (Port 8080)   │
└────────┬────────┘
         │
    ┌────┴────┬────────────┐
    ▼         ▼            ▼
┌───────┐ ┌───────┐   ┌───────────┐
│Agent A│ │Agent B│   │Remote Host│
│:8081  │ │:8082  │   │networked  │
└───────┘ └───────┘   └───────────┘
```

**Key Design Decisions:**

1. **API Key-Free** - Leverages Claude CLI OAuth tokens
2. **HTTP-Based** - Agents expose REST APIs
3. **File-Based Coordination** - Dependencies managed through file system
4. **Desktop-First** - Electron app with web fallback

### Agent Relay: "The Postal Service Model"

Agent Relay treats multi-agent coordination as a **communication problem**. The core insight is that AI agents already produce text output, so:

- **Output Parsing** extracts intent from `->relay:` patterns
- **Message Routing** delivers messages between agents
- **Terminal Injection** presents messages as user input

```
Agent A Output: "->relay:AgentB <<<Task complete>>>"
    │
    ▼
┌─────────────────┐
│  Relay Daemon   │ ◄── SQLite message store
│  (per-project)  │
└────────┬────────┘
         │
    ┌────┴────┬────────────┐
    ▼         ▼            ▼
┌───────┐ ┌───────┐   ┌───────────┐
│AgentB │ │AgentC │   │ Broadcast │
│wrapper│ │wrapper│   │    (*)    │
└───────┘ └───────┘   └───────────┘
```

**Key Design Decisions:**

1. **Zero Agent Modification** - Works with unmodified Claude CLI
2. **Output-Based** - Agents communicate through their natural output
3. **Peer-to-Peer** - No central orchestrator required
4. **CLI-First** - Daemon runs alongside terminal sessions

---

## 2. Agent Routing Comparison

### Agentrooms: Explicit @Mention Routing

```
User: "@frontend Please update the login component"
         │
         ▼
    ┌─────────────────────────────────────┐
    │ Direct HTTP to frontend agent       │
    │ POST http://localhost:8081/execute  │
    └─────────────────────────────────────┘

User: "Build a user authentication system"
         │
         ▼
    ┌─────────────────────────────────────┐
    │ Orchestrator decomposes task:       │
    │  1. @backend: Create auth endpoints │
    │  2. @frontend: Build login UI       │
    │  3. @database: Set up user tables   │
    └─────────────────────────────────────┘
```

**Advantages:**
- Explicit control over task routing
- Built-in task decomposition for complex requests
- Clear separation between direct and orchestrated execution

**Limitations:**
- Requires HTTP endpoint per agent
- File-based coordination for dependencies
- Single room in current version

### Agent Relay: Pattern-Based Communication

```
Agent Output: "->relay:Frontend <<<Please update the login component>>>"
                  │
                  ▼
         ┌────────────────────────────────┐
         │ Daemon parses, routes, injects │
         │ into Frontend's terminal       │
         └────────────────────────────────┘

Agent Output: "->relay:spawn Worker claude 'Build auth system'"
                  │
                  ▼
         ┌────────────────────────────────┐
         │ Daemon spawns new Claude       │
         │ instance, assigns task         │
         └────────────────────────────────┘
```

**Advantages:**
- No agent modification required
- Dynamic spawning/releasing of workers
- Native thread support for conversations
- Broadcast to all agents (`->relay:*`)

**Limitations:**
- Relies on output parsing (can miss malformed patterns)
- No built-in task decomposition
- Agents must learn the protocol

---

## 3. Authentication Architecture

### Agentrooms: Claude CLI OAuth Passthrough

```
┌──────────────────────────────────────────────┐
│                 Authentication               │
├──────────────────────────────────────────────┤
│                                              │
│  User runs: claude auth login                │
│       │                                      │
│       ▼                                      │
│  ┌──────────────┐                            │
│  │ Claude CLI   │ ◄── OAuth tokens stored    │
│  │ Token Store  │     by Anthropic          │
│  └──────┬───────┘                            │
│         │                                    │
│         ▼                                    │
│  ┌──────────────┐     ┌──────────────┐       │
│  │ Agentrooms   │────►│ Claude API   │       │
│  │ Backend      │     │ (via CLI)    │       │
│  └──────────────┘     └──────────────┘       │
│                                              │
│  ✓ No API keys needed                        │
│  ✓ Bills to existing subscription            │
│  ✓ OAuth tokens managed externally           │
└──────────────────────────────────────────────┘
```

### Agent Relay: Nango OAuth with Token Isolation

```
┌──────────────────────────────────────────────┐
│                 Authentication               │
├──────────────────────────────────────────────┤
│                                              │
│  User initiates: OAuth flow in dashboard     │
│       │                                      │
│       ▼                                      │
│  ┌──────────────┐     ┌──────────────┐       │
│  │ Nango OAuth  │◄───►│ GitHub OAuth │       │
│  │ Provider     │     │ / App        │       │
│  └──────┬───────┘     └──────────────┘       │
│         │                                    │
│         ▼                                    │
│  ┌──────────────┐     ┌──────────────┐       │
│  │ Relay Cloud  │────►│ Connection   │       │
│  │ (IDs only)   │     │ ID stored    │       │
│  └──────────────┘     └──────────────┘       │
│                                              │
│  ✓ Tokens never stored in Relay DB           │
│  ✓ Nango handles refresh automatically       │
│  ✓ GitHub App for repo access                │
└──────────────────────────────────────────────┘
```

**Key Difference:** Agentrooms piggybacks on Claude CLI's auth, making setup trivial but limiting to Claude. Agent Relay manages its own OAuth for GitHub integration but requires more setup.

---

## 4. State Management

### Agentrooms: SQLite + File Coordination

| Component | Storage |
|-----------|---------|
| Session state | `openmemory.sqlite` |
| Agent history | Filtered by working directory |
| Task coordination | File-based between agents |
| Configuration | Settings UI → local storage |

**History Caching Pattern:**
- 5-minute cache prevents API overload
- Filtered by agent working directory
- Session continuity via Claude Code SDK

### Agent Relay: Layered Storage

| Component | Local | Cloud |
|-----------|-------|-------|
| Messages | SQLite | PostgreSQL |
| Agent registry | In-memory | Redis (planned) |
| Dead letters | SQLite/PostgreSQL adapter | PostgreSQL |
| Context | Compaction + persistence | Ledger-based |

**Storage Adapter Pattern:**
```typescript
// Same interface, different backends
const dlq = createDLQAdapter({ type: 'sqlite', db });
const dlq = createDLQAdapter({ type: 'postgres', postgres: pool });
const dlq = createDLQAdapter({ type: 'memory' });
```

---

## 5. Desktop vs CLI Experience

### Agentrooms: Electron Desktop App

```
┌─────────────────────────────────────────────────────┐
│                  Agentrooms Desktop                 │
├─────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌──────────────────────────────┐  │
│  │ Agent Hub   │  │ Agent Detail View            │  │
│  │             │  │ ┌──────────────────────────┐ │  │
│  │ ┌─────────┐ │  │ │ Real-time Chat Tab      │ │  │
│  │ │@backend │ │  │ └──────────────────────────┘ │  │
│  │ ├─────────┤ │  │ ┌──────────────────────────┐ │  │
│  │ │@frontend│ │  │ │ History Tab             │ │  │
│  │ ├─────────┤ │  │ └──────────────────────────┘ │  │
│  │ │@database│ │  │                              │  │
│  │ └─────────┘ │  │                              │  │
│  └─────────────┘  └──────────────────────────────┘  │
│                                                     │
│  ┌─────────────────────────────────────────────────┐│
│  │ Orchestrator Chat (Multi-Agent Planning)       ││
│  └─────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────┘
```

**UX Features:**
- Grid display of all configured agents
- Tabbed interface for chat + history
- Request abortion for long operations
- Automatic history loading on click

### Agent Relay: Terminal + Web Dashboard

```
┌─────────────────────────────────────────────────────┐
│                  Terminal Session                   │
├─────────────────────────────────────────────────────┤
│  $ agent-relay start                                │
│  [relay] Daemon started on port 3579                │
│  [relay] Dashboard: http://localhost:3000           │
│                                                     │
│  $ claude                                           │
│  > Working on authentication...                     │
│  > ->relay:Backend <<<Need API endpoint>>>          │
│  [relay] Message sent to Backend                    │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│                  Web Dashboard                      │
├─────────────────────────────────────────────────────┤
│  Agents: [Lead ●] [Backend ●] [Frontend ○]          │
│                                                     │
│  Message Log:                                       │
│  ├── Lead → Backend: Need API endpoint              │
│  ├── Backend → Lead: ACK: Creating endpoint         │
│  └── Backend → Lead: DONE: /api/auth ready          │
│                                                     │
│  Workspaces: [project-a] [project-b]                │
└─────────────────────────────────────────────────────┘
```

**UX Features:**
- Works in any terminal
- Optional web dashboard for monitoring
- Multi-workspace support
- Real-time message visualization

---

## 6. Remote Agent Support

### Agentrooms: HTTP Endpoint Registration

```typescript
// Agent configuration in Settings UI
{
  name: "remote-worker",
  description: "Cloud GPU instance",
  endpoint: "http://192.168.1.100:8081",
  workingDirectory: "/remote/workspace"
}
```

**Capabilities:**
- Any HTTP-accessible endpoint
- Mac Mini farm, cloud instances
- Same API as local agents

### Agent Relay: Cloud Sandbox Integration

```typescript
// E2B sandbox spawning
->relay:spawn CloudWorker claude "Analyze large dataset"

// Worker runs in isolated sandbox
// Results returned via relay protocol
```

**Capabilities:**
- E2B sandbox integration (planned)
- Git worktree isolation per agent
- Cross-project messaging (bridge mode)

---

## 7. Feature Comparison Matrix

| Feature | Agentrooms | Agent Relay |
|---------|------------|-------------|
| **Multi-agent chat** | ✓ @mentions | ✓ ->relay: protocol |
| **Task decomposition** | ✓ Built-in planner | ✗ Manual only |
| **Agent spawning** | ✗ Pre-registered only | ✓ Dynamic spawn/release |
| **Message threading** | ✗ Not mentioned | ✓ [thread:name] syntax |
| **Consensus voting** | ✗ | ✓ Multiple strategies |
| **Dead letter queue** | ✗ | ✓ With retry logic |
| **Context compaction** | ✗ | ✓ Token-aware |
| **Message signing** | ✗ | ✓ HMAC-SHA256 |
| **Multi-workspace** | ✗ Single room | ✓ Native support |
| **Desktop app** | ✓ Electron | ✗ Web only |
| **API documentation** | ✓ Swagger | ✓ TypeDoc |
| **Cross-platform** | ✓ macOS/Win/Linux | ✓ Any Node.js |

---

## 8. When to Choose Which

### Choose Agentrooms When:

1. **GUI-First Workflow** - You prefer visual agent management
2. **Simple Setup** - Leverage existing Claude CLI auth
3. **Task Decomposition** - Need automatic planning for complex tasks
4. **Desktop Experience** - Want native app feel
5. **HTTP Agents** - Already have agents as REST services

### Choose Agent Relay When:

1. **CLI-First Workflow** - Terminal-native development
2. **Zero Modification** - Can't change agent implementations
3. **Dynamic Teams** - Need to spawn/release agents on demand
4. **Multi-Project** - Cross-repository coordination
5. **Cloud Ready** - Need PostgreSQL/Redis for scale
6. **Security Features** - Message signing, DLQ, consensus

---

## 9. Integration Opportunities

### Potential Synergies

1. **Agentrooms as Relay Frontend**
   - Use Agentrooms' GUI for agent management
   - Route messages through Relay daemon
   - Best of both: visual UI + robust messaging

2. **Shared OAuth Layer**
   - Agentrooms' Claude CLI auth for LLM
   - Relay's Nango auth for GitHub
   - Unified credential management

3. **Protocol Bridge**
   - Translate @mentions to ->relay: patterns
   - Enable Agentrooms agents to join Relay networks

---

## 10. Conclusion

**Agentrooms** excels at providing a polished desktop experience with minimal setup. Its @mention routing and built-in task decomposition make it ideal for teams who want a visual, opinionated workflow.

**Agent Relay** excels at flexibility and robustness. Its output-parsing approach works with any CLI tool, while features like consensus voting, message signing, and dead letter queues provide production-grade reliability.

The projects solve similar problems with different philosophies:
- **Agentrooms**: "Make multi-agent accessible through a beautiful UI"
- **Agent Relay**: "Make multi-agent work with zero agent changes"

---

*Analysis generated 2026-01-10*
*Based on [claude-code-by-agents](https://github.com/baryhuang/claude-code-by-agents) repository and Agent Relay source code*

## Sources

- [GitHub - baryhuang/claude-code-by-agents](https://github.com/baryhuang/claude-code-by-agents)
- [Claude Code Agentrooms - claudecode.run](https://claudecode.run/)
- [The Unwind AI - Claude Code's Hidden Multi-Agent Orchestration](https://www.theunwindai.com/p/claude-code-s-hidden-multi-agent-orchestration-now-open-source)
- [Multi-Agent Orchestration Patterns](https://sjramblings.io/multi-agent-orchestration-claude-code-when-ai-teams-beat-solo-acts/)
