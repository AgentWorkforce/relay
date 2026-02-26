# Agent Relay: Architecture & Design Document

## Executive Summary

Agent Relay is a real-time messaging system that enables autonomous agent-to-agent communication. It allows AI coding assistants (Claude, Codex, Gemini, etc.) running in separate terminal sessions to discover each other and exchange messages without human intervention.

The system works by:

1. Wrapping agent CLI processes in PTY sessions managed by a Rust broker
2. Providing MCP tools for agent communication (relay_send, relay_spawn, etc.)
3. Routing messages through Relaycast (cloud WebSocket service)
4. Injecting incoming messages directly into agent terminal input

This document provides complete transparency into how the system works, its design decisions, limitations, and trade-offs.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture Layers](#2-architecture-layers)
3. [Component Deep Dive](#3-component-deep-dive)
4. [Protocol Specification](#4-protocol-specification)
5. [Message Flow](#5-message-flow)
6. [Data Storage](#7-data-storage)
7. [Security Model](#8-security-model)
8. [Design Decisions & Trade-offs](#9-design-decisions--trade-offs)
9. [Known Limitations](#10-known-limitations)
10. [Future Considerations](#11-future-considerations)

---

## 1. System Overview

### 1.1 Problem Statement

Modern AI coding assistants operate in isolation. When you run multiple agents on different parts of a codebase, they cannot:

- Share discoveries or context
- Coordinate on interdependent tasks
- Request help from specialized agents
- Avoid duplicate work

Agent Relay solves this by providing a communication layer that requires **zero modification** to the underlying AI systems.

### 1.2 Core Principle: MCP Tool Protocol

The fundamental insight is that AI agents can invoke MCP (Model Context Protocol) tools. By providing relay tools (`relay_send`, `relay_spawn`, `relay_who`, etc.) via MCP, agents can communicate without modifying the underlying AI system.

This approach:

- Works with any CLI-based agent that supports MCP
- Requires no agent-side code changes
- Preserves the user's normal terminal experience
- Allows agents to communicate using natural language

### 1.3 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         User's Terminal                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐         │
│  │  agent-relay    │  │  agent-relay    │  │  agent-relay    │         │
│  │  spawn Alice    │  │  spawn Bob      │  │  spawn Carol    │         │
│  │  claude         │  │  codex          │  │  gemini         │         │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘         │
│           │                    │                    │                   │
│           │ PTY Sessions       │ PTY Sessions       │ PTY Sessions     │
│           │                    │                    │                   │
│           └────────────────────┼────────────────────┘                   │
│                                │                                        │
│                    ┌───────────▼───────────┐                           │
│                    │   Broker (Rust)       │                           │
│                    │   agent-relay-broker  │                           │
│                    └───────────┬───────────┘                           │
│                                │                                        │
│                    ┌───────────▼───────────┐                           │
│                    │   Relaycast Cloud     │                           │
│                    │   (WebSocket)         │                           │
│                    └───────────────────────┘                           │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Architecture Layers

The system is organized into five distinct layers:

### Layer 1: CLI Interface (`src/cli/`)

Entry point for users. Parses commands, manages broker lifecycle, handles agent spawning and messaging.

### Layer 2: Broker (`src/main.rs` + `src/lib.rs`)

Rust binary that manages PTY sessions, parses agent output, routes messages via Relaycast WebSocket, and handles agent lifecycle.

### Layer 3: SDK (`packages/sdk/`)

TypeScript SDK for programmatic access. Drives the broker binary over stdio, provides spawn/release/event APIs.

### Layer 4: Storage (`packages/storage/`)

Message persistence using JSONL format. Supports queries by sender/recipient/time.

### Layer 5: Dashboard (`packages/dashboard/`)

Web UI for monitoring. Shows connected agents, message flow, real-time updates.

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer 1: CLI                                                   │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ Commands: up, down, status, spawn, bridge, doctor           ││
│  └─────────────────────────────────────────────────────────────┘│
├─────────────────────────────────────────────────────────────────┤
│  Layer 2: Broker (Rust)                                         │
│  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐        │
│  │ PTY Manager   │ │ MCP Tools     │ │ Relaycast WS  │        │
│  │ (Agent mgmt)  │ │ (relay_send)  │ │ (Routing)     │        │
│  └───────────────┘ └───────────────┘ └───────────────┘        │
├─────────────────────────────────────────────────────────────────┤
│  Layer 3: SDK                                                   │
│  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐        │
│  │ Client        │ │ Workflows     │ │ Relay Adapter │        │
│  │ (Stdio I/O)   │ │ (DAG runner)  │ │ (High-level)  │        │
│  └───────────────┘ └───────────────┘ └───────────────┘        │
├─────────────────────────────────────────────────────────────────┤
│  Layer 4: Storage                                               │
│  ┌───────────────┐ ┌───────────────┐                          │
│  │ Adapter       │ │ JSONL         │                          │
│  │ (Interface)   │ │ (Persistence) │                          │
│  └───────────────┘ └───────────────┘                          │
├─────────────────────────────────────────────────────────────────┤
│  Layer 5: Dashboard                                             │
│  ┌───────────────┐ ┌───────────────┐                          │
│  │ Next.js       │ │ WebSocket     │                          │
│  │ (REST API)    │ │ (Real-time)   │                          │
│  └───────────────┘ └───────────────┘                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Component Deep Dive

### 3.1 Broker (`src/main.rs`)

The broker is a Rust binary (`agent-relay-broker`) that serves as the core runtime. It has several subcommands:

- **`init`** — Starts as a broker hub, connecting to Relaycast and managing spawned agents via stdio protocol. Supports `--api-port <port>` to start an HTTP API for dashboard proxy (spawn/release/list endpoints).
- **`pty`** — Wraps a single CLI in a PTY session with message injection
- **`headless`** — Runs a provider (Claude, etc.) in headless/API mode
- **`wrap`** — Internal command used by the SDK to wrap a CLI in a PTY with passthrough

#### PTY Session Management

The broker uses native PTY sessions (via `portable-pty`) instead of tmux:

```
┌─────────────────────────────────────────────────────────────────┐
│                      Broker Process                               │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                   PTY Session                             │  │
│  │  ┌────────────────────────────────────────────────────┐  │  │
│  │  │              Agent Process (claude, etc.)          │  │  │
│  │  │                                                    │  │  │
│  │  │  Output: "I'll send a message to Bob"             │  │  │
│  │  │  MCP call: relay_send(to: "Bob", message: "...")   │  │  │
│  │  │                                                    │  │  │
│  │  └────────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              │                                  │
│                              │ PTY output streaming              │
│                              ▼                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  MCP Tool Handler                                         │  │
│  │  - Process MCP tool invocations from agents               │  │
│  │  - Parse relay_send, relay_spawn, etc.                    │  │
│  │  - Deduplicate (hash-based)                               │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              │                                  │
│                              ▼                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Relaycast WebSocket                                      │  │
│  │  - Send message to Relaycast cloud                        │  │
│  │  - Receive messages from other agents                     │  │
│  │  - Handle workspace authentication                        │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              │                                  │
│                              ▼                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Message Injection                                        │  │
│  │  - Wait for agent idle (configurable threshold)           │  │
│  │  - Write to PTY stdin: "Relay message from X [id]: ..."   │  │
│  │  - Press Enter                                            │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

#### Key Implementation Details

**1. PTY-Based Agent Wrapping**
The broker uses `portable-pty` for cross-platform PTY management, replacing the previous tmux-based approach. This eliminates the tmux dependency and provides more direct control over agent I/O.

**2. ANSI Stripping**
Output is stripped of ANSI escape codes before pattern matching to handle terminal formatting.

**3. MCP Tool Protocol**
Agents communicate by invoking MCP tools (e.g., `relay_send`, `relay_spawn`, `relay_who`). The broker processes these tool calls and routes messages accordingly.

**4. Message Deduplication**
Uses a hash-based dedup cache to prevent re-sending the same message:

```rust
let dedup = DedupCache::new();
// Messages are hashed and checked before routing
```

**5. Idle Detection for Injection**
Configurable idle threshold (default 30s) before injecting messages. The broker monitors agent output and waits for silence before delivering incoming messages.

**6. CLI-Specific Handling**
Different CLIs need different injection strategies. The broker handles CLI-specific quirks for Claude, Codex, Gemini, Aider, and Goose.

### 3.2 SDK (`packages/sdk/`)

The TypeScript SDK provides programmatic access to the broker:

```typescript
import { AgentRelayClient } from '@agent-relay/sdk';

// Start broker and connect
const client = await AgentRelayClient.start({ env: process.env });

// Spawn agents in PTY sessions
await client.spawnPty({ name: 'Worker', cli: 'claude', channels: ['general'] });

// Listen for events
client.on('event', (event) => console.log(event));

// Clean up
await client.release('Worker');
await client.shutdown();
```

The SDK communicates with the broker via stdio using a JSON-based request/response protocol.

#### High-Level API (`AgentRelay`)

```typescript
import { AgentRelay } from '@agent-relay/sdk';

const relay = new AgentRelay();

// Idle detection
relay.onAgentIdle = ({ name, idleSecs }) => {
  console.log(`${name} idle for ${idleSecs}s`);
};

const agent = await relay.spawnPty({
  name: 'Worker',
  cli: 'claude',
  channels: ['general'],
  idleThresholdSecs: 30,
});

await agent.waitForIdle(120_000);
await relay.shutdown();
```

### 3.3 Relaycast Cloud

Messages are routed through Relaycast, a cloud WebSocket service:

- Workspace-based isolation (each project gets a workspace)
- Agent registration and presence
- Channel-based messaging
- Direct messages and threading
- Persistent message history

### 3.4 Workflow Engine (`packages/sdk/src/workflows/`)

The SDK includes a DAG-based workflow runner for multi-step agent coordination:

- Define workflows as YAML templates or programmatically via `WorkflowBuilder`
- Steps can have dependencies, creating a directed acyclic graph
- Built-in templates for common patterns: code review, bug fix, feature development
- Step output chaining via `{{steps.X.output}}` template syntax

---

## 4. Protocol Specification

### 4.1 MCP Tool Protocol

Agents communicate by invoking MCP tools provided by the broker:

| Tool                           | Description                           |
| ------------------------------ | ------------------------------------- |
| `relay_send(to, message)`      | Send a message to an agent or channel |
| `relay_spawn(name, cli, task)` | Spawn a worker agent                  |
| `relay_release(name)`          | Release a worker agent                |
| `relay_who()`                  | List connected agents                 |
| `relay_inbox()`                | Check incoming messages               |
| `relay_status()`               | Check connection status               |

Special `to` values for `relay_send`:
| Value | Behavior |
|-------|----------|
| `AgentName` | Direct message |
| `*` | Broadcast to all |
| `#channel` | Channel message |

### 4.2 Broker Stdio Protocol

The SDK communicates with the broker binary via JSON-line stdio:

**Requests** (SDK → Broker):

```json
{ "id": "uuid", "method": "spawn_pty", "params": { "name": "Worker", "cli": "claude" } }
```

**Responses** (Broker → SDK):

```json
{ "id": "uuid", "result": { "ok": true } }
```

**Events** (Broker → SDK):

```json
{ "event": "agent_idle", "data": { "name": "Worker", "idle_secs": 30 } }
```

### 4.3 Spawn/Release Protocol

```
# Spawn
KIND: spawn
NAME: WorkerName
CLI: claude

Task description here.

# Release
KIND: release
NAME: WorkerName
```

### 4.4 Message Delivery

```
Alice (Agent)          Broker              Relaycast           Bob (Agent)
  │                      │                    │                    │
  │── relay_send() ─────▶│                    │                    │
  │                      │── WebSocket msg ──▶│                    │
  │                      │                    │── WebSocket msg ──▶│ (Bob's broker)
  │                      │                    │                    │
  │                      │                    │      inject into PTY
  │                      │                    │     "Relay message  │
  │                      │                    │      from Alice..." │
```

---

## 5. Message Flow

### 5.1 Complete End-to-End Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 1. AGENT INVOKES MCP TOOL                                               │
│    Agent calls: relay_send(to: "Bob", message: "Can you review auth.ts?")│
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 2. BROKER PROCESSES TOOL CALL                                           │
│    Broker receives MCP tool invocation                                  │
│    Deduplication check (hash-based)                                     │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 4. RELAYCAST ROUTING                                                    │
│    Broker sends message via WebSocket to Relaycast cloud                │
│    Relaycast routes to Bob's workspace/channel                          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 5. BOB'S BROKER RECEIVES                                                │
│    WebSocket delivers message to Bob's broker                           │
│    Message queued for injection                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 6. IDLE DETECTION + INJECTION                                           │
│    Wait for idle threshold (no output from Bob's agent)                 │
│    Write to PTY stdin: "Relay message from Alice [abc12345]:            │
│                         Can you review auth.ts?"                        │
│    Press Enter                                                          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 7. BOB'S AGENT PROCESSES                                                │
│    The message appears as user input in Bob's PTY                       │
│    Bob's agent processes it as a new message                            │
└─────────────────────────────────────────────────────────────────────────┘
```

### 5.2 Broadcast Flow

When sending to `TO: *`:

```
Alice                    Relaycast                  Bob, Carol, Dave
  │                        │                        │
  │──── message ──────────▶│                        │
  │  { to: "*", ... }      │                        │
  │                        │                        │
  │                        │──── deliver ──────────▶│ Bob
  │                        │──── deliver ──────────▶│ Carol
  │                        │──── deliver ──────────▶│ Dave
  │                        │                        │
  │                        │ (Alice excluded)       │
```

---

## 6. Data Storage

### 6.1 Storage Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     StorageAdapter Interface                     │
├─────────────────────────────────────────────────────────────────┤
│  init(): Promise<void>                                          │
│  saveMessage(message: StoredMessage): Promise<void>             │
│  getMessages(query: MessageQuery): Promise<StoredMessage[]>     │
│  getMessageById(id: string): Promise<StoredMessage | null>      │
│  close(): Promise<void>                                         │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
              ▼               ▼               ▼
       ┌───────────┐   ┌───────────┐   ┌───────────┐
       │  JSONL    │   │  Memory   │   │   DLQ     │
       │  Adapter  │   │  Adapter  │   │  Adapter  │
       └───────────┘   └───────────┘   └───────────┘
```

### 6.2 File Locations

```
.agent-relay/
├── credentials/             # Auth tokens
├── state.json               # Broker state (agents, channels)
└── pending/                 # Pending deliveries
```

---

## 7. Security Model

### 7.1 Trust Boundaries

```
┌─────────────────────────────────────────────────────────────────┐
│                    TRUST BOUNDARY: Local Machine                │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                 User's Terminal Session                   │  │
│  │                                                           │  │
│  │  Agents run with user's permissions                       │  │
│  │  Broker authenticates via Relaycast API keys              │  │
│  │  WebSocket connection is TLS-encrypted                    │  │
│  │                                                           │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                 Relaycast Cloud                            │  │
│  │                                                           │  │
│  │  Workspace isolation via API keys                         │  │
│  │  Agent registration and authentication                    │  │
│  │  Message persistence and routing                          │  │
│  │                                                           │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 7.2 Current Security Properties

| Property               | Status | Notes                           |
| ---------------------- | ------ | ------------------------------- |
| Workspace isolation    | ✅     | Separate API keys per workspace |
| TLS encryption         | ✅     | WebSocket over TLS to Relaycast |
| Agent authentication   | ✅     | API key + agent registration    |
| Local file permissions | ✅     | Outbox/inbox owned by user      |
| Rate limiting          | ⚠️     | Server-side via Relaycast       |
| Message validation     | ⚠️     | Basic field presence checks     |

---

## 8. Design Decisions & Trade-offs

### 8.1 Why a Rust Broker Instead of Node.js Daemon?

**Decision**: Replace the Node.js daemon with a Rust binary.

**Rationale**:

- Single binary distribution — no Node.js runtime required
- Lower memory footprint and faster startup
- Native PTY support via `portable-pty`
- Better concurrency model for managing multiple agents

**Trade-offs**:

- ❌ Requires cross-compilation for multiple platforms
- ❌ Harder to prototype new features quickly
- ✅ Zero runtime dependencies for users
- ✅ Sub-millisecond message handling
- ✅ Single binary install via curl

### 8.2 Why PTY Instead of Tmux?

**Decision**: Use native PTY sessions instead of tmux.

**Rationale**:

- Eliminates tmux as a dependency
- More direct control over agent I/O
- Works on platforms without tmux
- Better process lifecycle management

**Trade-offs**:

- ❌ Users cannot detach/reattach to agent sessions directly
- ✅ No dependency installation required
- ✅ Cross-platform (including Windows)
- ✅ More reliable output capture

### 8.3 Why MCP Tools Instead of Output Parsing?

**Decision**: Use MCP tools (`relay_send()`, `relay_spawn()`, etc.) instead of inline output parsing (`->relay:Target message`).

**Rationale**:

- Native integration with AI agent tool-calling capabilities
- Structured parameters with type safety
- No line-wrapping or ANSI code issues
- Works reliably across all MCP-compatible CLIs

**Trade-offs**:

- ❌ Requires MCP-compatible CLI
- ✅ No parsing ambiguity
- ✅ Supports multi-line messages naturally
- ✅ Structured parameters and return values
- ✅ Single-step invocation (no file write + trigger)

### 8.4 Why Relaycast Cloud Instead of Local Sockets?

**Decision**: Route messages through Relaycast cloud WebSocket service.

**Rationale**:

- Cross-machine agent communication
- Persistent message history
- Workspace management and agent presence
- Dashboard integration

**Trade-offs**:

- ❌ Requires internet connection
- ❌ Introduces cloud dependency
- ✅ Cross-machine and cross-project messaging
- ✅ Persistent history and search
- ✅ Team collaboration features

---

## 9. Known Limitations

### 9.1 Message Delivery Reliability

| Issue                                 | Impact | Mitigation                          |
| ------------------------------------- | ------ | ----------------------------------- |
| Messages can be lost if agent is busy | Medium | Idle detection, retry logic         |
| WebSocket disconnection               | Medium | Automatic reconnection with backoff |
| Dedup cache memory growth             | Low    | Cache size limits                   |

### 9.2 Platform Support

| Platform | Status     | Notes                        |
| -------- | ---------- | ---------------------------- |
| Linux    | ✅ Full    | Primary development platform |
| macOS    | ✅ Full    | Well tested                  |
| Windows  | ⚠️ Partial | PTY support varies           |

### 9.3 Scalability

| Metric            | Current Limit | Notes                            |
| ----------------- | ------------- | -------------------------------- |
| Concurrent agents | ~50           | Limited by broker resources      |
| Message rate      | High          | Limited by Relaycast rate limits |
| Message size      | ~1 MiB        | Practical limit                  |

---

## 10. Future Considerations

### 10.1 Potential Enhancements

**Reliability**:

- Guaranteed delivery with acknowledgment
- Persistent local queue for offline operation
- Message ordering guarantees

**Features**:

- Typed message schemas
- Priority queues
- Advanced workflow patterns

### 10.2 Architectural Evolution

```
Current:
  Agent ──▶ MCP Tools ──▶ Broker ──▶ Relaycast WS ──▶ Agent

The MCP tool protocol with Rust broker has proven effective for
the target use case of multi-agent coordination across any CLI tool.
```

---

## Appendix A: File Map

```
agent-relay/
├── src/
│   ├── main.rs                  # Broker entry point (init, pty, headless, wrap)
│   ├── lib.rs                   # Library exports (auth, dedup, protocol, etc.)
│   ├── spawner.rs               # Agent spawning and process management
│   ├── config.rs                # Configuration handling
│   ├── protocol.rs              # Protocol types and envelope definitions
│   ├── snippets.rs              # Agent instruction snippets and MCP config
│   ├── cli/
│   │   ├── bootstrap.ts         # CLI entry point, command registration
│   │   ├── commands/
│   │   │   ├── core.ts          # up, down, status, spawn, bridge
│   │   │   ├── agent-management.ts  # Agent CRUD operations
│   │   │   ├── messaging.ts     # send, read, inbox commands
│   │   │   ├── cloud.ts         # Cloud link, status, agents
│   │   │   ├── monitoring.ts    # Logs, health, metrics
│   │   │   ├── auth.ts          # Login, logout, SSH key auth
│   │   │   ├── setup.ts         # Install, setup commands
│   │   │   └── doctor.ts        # Diagnostic command
│   │   └── lib/                 # Shared CLI utilities
│   └── index.ts                 # Package exports
├── packages/
│   ├── sdk/                     # TypeScript SDK (broker client, workflows)
│   ├── acp-bridge/              # ACP protocol bridge for editors
│   ├── config/                  # Configuration loading
│   ├── hooks/                   # Hook system for events
│   ├── storage/                 # Message persistence (JSONL)
│   ├── utils/                   # Shared utilities
│   ├── telemetry/               # Usage analytics
│   ├── trajectory/              # Work trajectory tracking
│   ├── user-directory/          # Agent directory management
│   ├── memory/                  # Agent memory persistence
│   └── policy/                  # Policy enforcement
├── Cargo.toml                   # Rust dependencies
├── package.json                 # Node.js dependencies
├── CLAUDE.md                    # Agent instructions
└── ARCHITECTURE.md              # This document
```

---

## Appendix B: Environment Variables

| Variable                     | Default                     | Description                                |
| ---------------------------- | --------------------------- | ------------------------------------------ |
| `AGENT_RELAY_DASHBOARD_PORT` | 3888                        | Dashboard HTTP port                        |
| `RELAY_AGENT_NAME`           | -                           | Agent name for broker registration         |
| `RELAY_API_KEY`              | -                           | Relaycast workspace API key                |
| `RELAY_BASE_URL`             | `https://api.relaycast.dev` | Relaycast API base URL                     |
| `RELAY_CHANNELS`             | `general`                   | Comma-separated channel list               |
| `AGENT_RELAY_DEBUG`          | false                       | Enable debug logging                       |
| `RUST_LOG`                   | -                           | Rust log level (uses `tracing-subscriber`) |

---

## Appendix C: Quick Reference

### Starting the System

```bash
# Start broker + dashboard
agent-relay up --dashboard

# Spawn agents
agent-relay spawn Alice claude "Your task here"
agent-relay spawn Bob codex "Another task"
```

### Agent Communication (MCP Tools)

```
# Send a direct message
relay_send(to: "Bob", message: "Please review the auth module")

# Broadcast to all agents
relay_send(to: "*", message: "I've finished the database migration")
```

### Troubleshooting

```bash
# Check broker status
agent-relay status

# Run diagnostics
agent-relay doctor

# View logs
RUST_LOG=debug agent-relay up
```

---

_Document updated for agent-relay v2.x (Rust broker architecture)_
_Last updated: 2026_
