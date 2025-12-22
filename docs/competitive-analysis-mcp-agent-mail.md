# Competitive Analysis: mcp_agent_mail vs agent-relay

## Executive Summary

| Aspect | mcp_agent_mail | agent-relay |
|--------|----------------|-------------|
| **Architecture** | MCP HTTP Server (FastAPI) | PTY Wrapper + Unix Socket |
| **Protocol** | MCP JSON-RPC over HTTP | Custom binary framing over Unix socket |
| **Storage** | SQLite + Git archive | SQLite + file-based inbox |
| **Latency** | ~50-200ms (HTTP overhead) | <5ms (local IPC) |
| **Complexity** | ~15,000+ lines Python | ~7,000 lines TypeScript |
| **Agent Integration** | Requires MCP client SDK | Zero-config (pattern detection) |
| **Persistence** | Git-backed audit trail | SQLite messages table |
| **Scale Target** | 5-50+ agents, multi-project | 5-10 agents, single project |

---

## Architecture Comparison

### mcp_agent_mail: MCP-First Design

```
┌─────────────────────────────────────────────────────────────┐
│                 Agent Clients (FastMCP)                     │
│            Claude Code, Codex, Gemini CLI, etc.             │
└────────────────────────────┬────────────────────────────────┘
                             │ HTTP JSON-RPC (MCP Protocol)
┌────────────────────────────▼────────────────────────────────┐
│            FastAPI Transport Layer                          │
│  ├─ Bearer Token / JWT / RBAC                               │
│  ├─ Rate Limiting (token bucket)                            │
│  └─ Middleware Stack                                        │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│            FastMCP Application Layer                        │
│  ├─ 40+ Tools (messaging, identity, reservations)           │
│  ├─ 20+ Resources (agents, messages, threads)               │
│  └─ Macros (workflow shortcuts)                             │
└────────────────────────────┬────────────────────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
   ┌────▼────────┐      ┌────▼────────┐      ┌────▼────────┐
   │   SQLite    │      │ Git Archive │      │   Locks     │
   │   (async)   │      │  (global)   │      │   (LRU)     │
   └─────────────┘      └─────────────┘      └─────────────┘
```

**Pros:**
- Standards-based (MCP protocol)
- Rich feature set (40+ tools)
- Git-backed audit trail
- Cross-project messaging
- Product grouping for large fleets
- File reservation system with enforcement
- Contact/permission system

**Cons:**
- HTTP overhead (~50-200ms per call)
- Requires MCP client integration
- Complex setup (Python venv, dependencies)
- Heavy resource footprint
- Overkill for simple use cases

### agent-relay: PTY-First Design

```
┌─────────────────────────────────────────────────────────────┐
│                     User Terminal                           │
│              (attached to tmux session)                     │
└────────────────────────────┬────────────────────────────────┘
                             │ tmux attach
┌────────────────────────────▼────────────────────────────────┐
│                     Tmux Session                            │
│  ├─ Agent Process (claude, codex, gemini)                   │
│  ├─ Silent Polling (capture-pane @ 200ms)                   │
│  ├─ Pattern Detection (>>relay:)                             │
│  └─ Message Injection (send-keys)                           │
└────────────────────────────┬────────────────────────────────┘
                             │ Unix Socket IPC
┌────────────────────────────▼────────────────────────────────┐
│                     Daemon (Router)                         │
│  ├─ Connection State Machine                                │
│  ├─ Message Routing (direct + broadcast)                    │
│  ├─ SQLite Persistence                                      │
│  └─ Dashboard (WebSocket)                                   │
└─────────────────────────────────────────────────────────────┘
```

**Pros:**
- Ultra-low latency (<5ms)
- Zero-config (no SDK needed)
- Works with ANY agent (pattern-based)
- Lightweight (~7k lines)
- Transparent to user (real terminal)
- Simple mental model

**Cons:**
- Single project scope
- No persistent audit trail (Git)
- No file reservation system
- No cross-project messaging
- Polling overhead (CPU)
- Limited security model

---

## Feature-by-Feature Comparison

### 1. Message Sending

| Feature | mcp_agent_mail | agent-relay |
|---------|----------------|-------------|
| **API** | `send_message()` tool call | `>>relay:Name message` pattern |
| **Broadcast** | `to=["*"]` | `>>relay:*` |
| **Attachments** | Yes (images, files) | No |
| **Threading** | Yes (`thread_id`) | No |
| **Markdown** | Full GFM support | Plain text |
| **Images** | Auto-convert to WebP, inline | Not supported |

**Winner: mcp_agent_mail** - Rich message format with attachments and threading.

### 2. Agent Discovery

| Feature | mcp_agent_mail | agent-relay |
|---------|----------------|-------------|
| **Registration** | Explicit `register_agent()` | Auto on HELLO handshake |
| **Directory** | `resource://agents/{project}` | `agents.json` file |
| **Metadata** | Program, model, task, capabilities | Name only |
| **Cross-project** | Contact request system | Not supported |

**Winner: mcp_agent_mail** - Richer agent metadata and cross-project discovery.

### 3. Message Persistence

| Feature | mcp_agent_mail | agent-relay |
|---------|----------------|-------------|
| **Primary** | SQLite (async, WAL mode) | SQLite |
| **Backup** | Git archive (audit trail) | None |
| **Search** | FTS (full-text search) | Basic queries |
| **History** | Permanent | Session-based |

**Winner: mcp_agent_mail** - Git-backed audit trail is powerful for compliance.

### 4. Security

| Feature | mcp_agent_mail | agent-relay |
|---------|----------------|-------------|
| **Auth** | Bearer token, JWT, RBAC | Unix socket permissions |
| **Rate Limiting** | Token bucket (memory/Redis) | None |
| **Contact Policy** | open/auto/contacts_only/block_all | None |
| **Encryption** | TLS (transport) | None (local only) |

**Winner: mcp_agent_mail** - Production-grade security model.

### 5. File Coordination

| Feature | mcp_agent_mail | agent-relay |
|---------|----------------|-------------|
| **Reservations** | Yes (exclusive/shared, TTL) | No |
| **Enforcement** | Pre-commit hooks | None |
| **Build Slots** | Yes (long-running tasks) | No |
| **Conflict Detection** | Advisory + block mode | None |

**Winner: mcp_agent_mail** - Critical for multi-agent file editing.

### 6. Latency & Performance

| Feature | mcp_agent_mail | agent-relay |
|---------|----------------|-------------|
| **Message Latency** | ~50-200ms | <5ms |
| **Connection** | HTTP (stateless) | Unix socket (persistent) |
| **Overhead** | JSON-RPC parsing | Binary framing |
| **Memory** | Higher (Python, FastAPI) | Lower (Node.js) |

**Winner: agent-relay** - 10-40x faster message delivery.

### 7. Developer Experience

| Feature | mcp_agent_mail | agent-relay |
|---------|----------------|-------------|
| **Setup** | Python venv, pip install, .env | npm install, single binary |
| **Integration** | MCP client required | Pattern in stdout |
| **Learning Curve** | Steep (40+ tools) | Minimal (>>relay:) |
| **Debugging** | Structured logging, metrics | Dashboard + logs |

**Winner: agent-relay** - Much simpler to get started.

### 8. Observability

| Feature | mcp_agent_mail | agent-relay |
|---------|----------------|-------------|
| **Metrics** | Tool call counts, latency, errors | Basic connection status |
| **Resources** | 20+ queryable resources | agents.json |
| **Logging** | Structured (structlog + rich) | Console output |
| **Dashboard** | None (resources only) | Web UI with live updates |

**Mixed** - mcp_agent_mail has richer metrics, agent-relay has visual dashboard.

---

## Key Insights & Learnings

### What mcp_agent_mail Does Better

1. **Git-Backed Audit Trail**
   - Every message committed to Git
   - Full history, diff-able, recoverable
   - Compliance-friendly

2. **File Reservation System**
   - Advisory locks with TTL
   - Pre-commit hook enforcement
   - Build slots for long tasks
   - Critical for preventing conflicts

3. **Cross-Project Messaging**
   - Contact request system
   - Product grouping
   - Multi-repo coordination

4. **Rich Message Format**
   - Attachments (images, files)
   - Threading (thread_id)
   - Full GFM markdown
   - Auto image processing

5. **Security Model**
   - JWT + RBAC
   - Rate limiting
   - Contact policies
   - Per-agent capabilities

6. **Agent Metadata**
   - Program, model, task description
   - Capabilities tracking
   - Last active timestamps

### What agent-relay Does Better

1. **Zero Configuration**
   - No SDK needed
   - Works with any agent
   - Pattern-based detection

2. **Ultra-Low Latency**
   - <5ms vs 50-200ms
   - Unix socket IPC
   - Binary framing

3. **Transparent UX**
   - User stays in real terminal
   - No proxy/wrapper visible
   - Native tmux experience

4. **Simplicity**
   - ~7k lines vs ~15k+ lines
   - Single mental model
   - Easy to understand

5. **Visual Dashboard**
   - Real-time agent status
   - Message history
   - WebSocket updates

---

## Recommended Improvements for agent-relay

### High Priority

1. **Add File Reservation System** (from mcp_agent_mail)
   - Advisory locks with TTL
   - `>>relay:lock src/**/*.ts` pattern
   - Pre-commit hook integration
   - Critical for multi-agent file editing

2. **Add Message Threading**
   - `>>relay:Bob [thread:feature-123] message`
   - Group related messages
   - Better context tracking

3. **Add Git Audit Trail**
   - Optional commit of messages to repo
   - `.agent-relay/messages/` directory
   - Recoverable history

4. **Add Agent Metadata**
   - Track program, model, task
   - Store in agents.json
   - Better agent discovery

### Medium Priority

5. **Add Message Attachments**
   - `>>relay:Bob [attach:path/to/file]`
   - Inline small files
   - Reference large files

6. **Add Cross-Project Messaging**
   - `>>relay:Bob@other-project message`
   - Contact request system
   - Product grouping

7. **Add Rate Limiting**
   - Prevent message flooding
   - Per-agent limits
   - Backpressure handling

8. **Add Message Search**
   - FTS on stored messages
   - `agent-relay search "query"`
   - Filter by agent, time, topic

### Lower Priority

9. **Add Security Model**
   - Optional authentication
   - Agent capabilities
   - Contact policies

10. **Add Workflow Macros**
    - `>>relay:macro:start-session`
    - Bundle common patterns
    - Reduce boilerplate

---

## Architecture Recommendations

### Hybrid Approach

Consider a **hybrid architecture** that combines the best of both:

```
┌─────────────────────────────────────────────────────────────┐
│                     User Terminal                           │
│              (attached to tmux session)                     │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│               PTY Wrapper (fast path)                       │
│  ├─ Pattern Detection (>>relay:)                             │
│  ├─ Message Injection                                       │
│  └─ Direct daemon IPC (<5ms)                                │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│                     Enhanced Daemon                         │
│  ├─ Message Router (existing)                               │
│  ├─ File Reservation Manager (NEW)                          │
│  ├─ Git Archive Writer (NEW, optional)                      │
│  ├─ Agent Metadata Store (NEW)                              │
│  └─ SQLite + FTS (enhanced)                                 │
└─────────────────────────────────────────────────────────────┘
```

### Key Design Principles

1. **Keep Zero-Config Core** - Pattern-based detection is the killer feature
2. **Add Opt-In Features** - File locks, Git archive as flags
3. **Maintain Low Latency** - Don't add HTTP layer
4. **Progressive Enhancement** - Simple default, powerful when needed

---

## Conclusion

**mcp_agent_mail** is a feature-rich, production-grade system designed for enterprise-scale multi-agent coordination. It excels at security, compliance, and cross-project workflows.

**agent-relay** is an elegantly simple, ultra-fast system designed for rapid prototyping and real-time collaboration. It excels at developer experience and low latency.

The ideal path forward for agent-relay is to **selectively adopt** the most valuable features from mcp_agent_mail (file reservations, threading, Git audit) while **preserving** its core strengths (zero-config, low latency, simplicity).

---

## Action Items

| Priority | Item | Effort | Impact |
|----------|------|--------|--------|
| P0 | Add file reservation system | Medium | High |
| P0 | Add message threading | Low | Medium |
| P1 | Add Git audit trail (optional) | Medium | High |
| P1 | Add agent metadata | Low | Medium |
| P2 | Add message attachments | Medium | Medium |
| P2 | Add cross-project messaging | High | Medium |
| P3 | Add rate limiting | Low | Low |
| P3 | Add message search (FTS) | Medium | Medium |
