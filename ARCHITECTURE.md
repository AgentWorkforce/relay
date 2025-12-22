# Agent Relay: Architecture & Design Document

## Executive Summary

Agent Relay is a real-time messaging system that enables autonomous agent-to-agent communication. It allows AI coding assistants (Claude, Codex, Gemini, etc.) running in separate terminal sessions to discover each other and exchange messages without human intervention.

The system works by:
1. Wrapping agent CLI processes in monitored tmux sessions
2. Parsing agent output for `>>relay:` commands
3. Routing messages through a central daemon via Unix domain sockets
4. Injecting incoming messages directly into agent terminal input

This document provides complete transparency into how the system works, its design decisions, limitations, and trade-offs.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture Layers](#2-architecture-layers)
3. [Component Deep Dive](#3-component-deep-dive)
4. [Protocol Specification](#4-protocol-specification)
5. [Message Flow](#5-message-flow)
6. [State Machines](#6-state-machines)
7. [Data Storage](#7-data-storage)
8. [Security Model](#8-security-model)
9. [Design Decisions & Trade-offs](#9-design-decisions--trade-offs)
10. [Known Limitations](#10-known-limitations)
11. [Future Considerations](#11-future-considerations)

---

## 1. System Overview

### 1.1 Problem Statement

Modern AI coding assistants operate in isolation. When you run multiple agents on different parts of a codebase, they cannot:
- Share discoveries or context
- Coordinate on interdependent tasks
- Request help from specialized agents
- Avoid duplicate work

Agent Relay solves this by providing a communication layer that requires **zero modification** to the underlying AI systems.

### 1.2 Core Principle: Output Parsing, Not API Integration

The fundamental insight is that AI agents already produce text output. By monitoring that output for specific patterns (`>>relay:Target message`), we can extract communication intent without modifying the agent itself.

This approach:
- Works with any CLI-based agent
- Requires no agent-side code changes
- Preserves the user's normal terminal experience
- Allows agents to communicate using natural language

### 1.3 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         User's Terminal                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐         │
│  │  agent-relay    │  │  agent-relay    │  │  agent-relay    │         │
│  │  -n Alice       │  │  -n Bob         │  │  -n Carol       │         │
│  │  claude         │  │  codex          │  │  gemini         │         │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘         │
│           │                    │                    │                   │
│           │ Unix Socket        │ Unix Socket        │ Unix Socket       │
│           │                    │                    │                   │
│           └────────────────────┼────────────────────┘                   │
│                                │                                        │
│                    ┌───────────▼───────────┐                           │
│                    │   Relay Daemon        │                           │
│                    │   (Message Router)    │                           │
│                    └───────────┬───────────┘                           │
│                                │                                        │
│                    ┌───────────▼───────────┐                           │
│                    │   SQLite Storage      │                           │
│                    │   (Message History)   │                           │
│                    └───────────────────────┘                           │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Architecture Layers

The system is organized into six distinct layers:

### Layer 1: CLI Interface (`src/cli/`)
Entry point for users. Parses commands, manages daemon lifecycle, wraps agent processes.

### Layer 2: Agent Wrapper (`src/wrapper/`)
Monitors agent output, parses relay commands, injects incoming messages, maintains daemon connection.

### Layer 3: Daemon (`src/daemon/`)
Central message broker. Manages connections, routes messages, handles handshakes.

### Layer 4: Protocol (`src/protocol/`)
Wire format specification. Defines message types, envelope structure, framing.

### Layer 5: Storage (`src/storage/`)
Message persistence. SQLite for history, supports queries by sender/recipient/time.

### Layer 6: Dashboard (`src/dashboard/`)
Web UI for monitoring. Shows connected agents, message flow, real-time updates.

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer 1: CLI                                                   │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ Commands: up, down, status, read, wrap                     ││
│  └─────────────────────────────────────────────────────────────┘│
├─────────────────────────────────────────────────────────────────┤
│  Layer 2: Wrapper                                               │
│  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐        │
│  │ TmuxWrapper   │ │ OutputParser  │ │ RelayClient   │        │
│  │ (PTY mgmt)    │ │ (>>relay:)     │ │ (Socket I/O)  │        │
│  └───────────────┘ └───────────────┘ └───────────────┘        │
├─────────────────────────────────────────────────────────────────┤
│  Layer 3: Daemon                                                │
│  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐        │
│  │ Server        │ │ Connection    │ │ Router        │        │
│  │ (Lifecycle)   │ │ (State M/C)   │ │ (Routing)     │        │
│  └───────────────┘ └───────────────┘ └───────────────┘        │
├─────────────────────────────────────────────────────────────────┤
│  Layer 4: Protocol                                              │
│  ┌───────────────┐ ┌───────────────┐                          │
│  │ Types         │ │ Framing       │                          │
│  │ (Envelopes)   │ │ (Wire format) │                          │
│  └───────────────┘ └───────────────┘                          │
├─────────────────────────────────────────────────────────────────┤
│  Layer 5: Storage                                               │
│  ┌───────────────┐ ┌───────────────┐                          │
│  │ Adapter       │ │ SQLite        │                          │
│  │ (Interface)   │ │ (Persistence) │                          │
│  └───────────────┘ └───────────────┘                          │
├─────────────────────────────────────────────────────────────────┤
│  Layer 6: Dashboard                                             │
│  ┌───────────────┐ ┌───────────────┐                          │
│  │ Express       │ │ WebSocket     │                          │
│  │ (REST API)    │ │ (Real-time)   │                          │
│  └───────────────┘ └───────────────┘                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Component Deep Dive

### 3.1 TmuxWrapper (`src/wrapper/tmux-wrapper.ts`)

The TmuxWrapper is the most complex component. It bridges the gap between agent output and the relay system.

#### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      TmuxWrapper                                 │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                   tmux session                            │  │
│  │  ┌────────────────────────────────────────────────────┐  │  │
│  │  │              Agent Process (claude, etc.)          │  │  │
│  │  │                                                    │  │  │
│  │  │  Output: "I'll send a message to Bob"             │  │  │
│  │  │  Output: ">>relay:Bob Can you review auth.ts?"     │  │  │
│  │  │                                                    │  │  │
│  │  └────────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              │                                  │
│                              │ capture-pane (every 200ms)       │
│                              ▼                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  OutputParser                                             │  │
│  │  - Strip ANSI codes                                       │  │
│  │  - Join continuation lines                                │  │
│  │  - Extract >>relay: commands                               │  │
│  │  - Deduplicate (hash-based)                               │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              │                                  │
│                              ▼                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  RelayClient                                              │  │
│  │  - Connect to daemon                                      │  │
│  │  - Send SEND envelope                                     │  │
│  │  - Receive DELIVER envelope                               │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              │                                  │
│                              ▼                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Message Injection                                        │  │
│  │  - Wait for idle (1.5s no output)                         │  │
│  │  - tmux send-keys "Relay message from X: ..."             │  │
│  │  - Press Enter                                            │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

#### Key Implementation Details

**1. Silent Background Polling**
```typescript
// Poll every 200ms, capture scrollback
const { stdout } = await execAsync(
  `tmux capture-pane -t ${sessionName} -p -J -S - 2>/dev/null`
);
```
The `-J` flag joins wrapped lines. The `-S -` captures full scrollback history.

**2. ANSI Stripping**
```typescript
// Remove escape codes for pattern matching
return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
```

**3. Continuation Line Joining**
When TUIs wrap long lines, `>>relay:` commands can span multiple lines:
```
>>relay:Bob This is a very long message that gets
    wrapped by the terminal and continues here
```
The wrapper joins these back together.

**4. Message Deduplication**
Uses a permanent hash set to prevent re-sending the same message:
```typescript
const msgHash = `${cmd.to}:${cmd.body}`;
if (this.sentMessageHashes.has(msgHash)) return;
this.sentMessageHashes.add(msgHash);
```

**5. Idle Detection for Injection**
Waits 1.5 seconds after last output before injecting to avoid interrupting the agent:
```typescript
const timeSinceOutput = Date.now() - this.lastOutputTime;
if (timeSinceOutput < 1500) {
  setTimeout(() => this.checkForInjectionOpportunity(), 500);
  return;
}
```

**6. CLI-Specific Handling**
Different CLIs need different injection strategies:
- **Claude/Codex**: Direct `send-keys` with literal text
- **Gemini**: Uses `printf` because Gemini interprets input as shell commands

### 3.2 OutputParser (`src/wrapper/parser.ts`)

Extracts relay commands from agent output.

#### Supported Formats

**1. Inline Format (Primary)**
```
>>relay:AgentName Your message here
>>relay:* Broadcast to everyone
@thinking:AgentName Share reasoning (not displayed to user)
```

**2. Block Format (Structured)**
```
[[RELAY]]{"to":"Agent","type":"message","body":"content","data":{}}[[/RELAY]]
```

#### Pattern Matching

The parser handles real-world terminal output complexity:

```typescript
// Allow common input prefixes: >, $, %, #, bullets, etc.
const INLINE_RELAY = /^(?:\s*(?:[>$%#→➜›»●•◦‣⁃\-*⏺◆◇○□■]\s*)*)?>>relay:(\S+)\s+(.+)$/;
```

This matches:
- `>>relay:Bob hello` (plain)
- `  >>relay:Bob hello` (indented)
- `> >>relay:Bob hello` (quoted)
- `- >>relay:Bob hello` (bullet point)
- `⏺ >>relay:Bob hello` (Claude's bullet)

#### Code Fence Awareness

The parser ignores content inside code fences to prevent false positives:
```typescript
if (CODE_FENCE.test(stripped)) {
  this.inCodeFence = !this.inCodeFence;
}
if (this.inCodeFence) {
  return { command: null, output: line };
}
```

### 3.3 Daemon Server (`src/daemon/server.ts`)

The central message broker.

#### Lifecycle

```
1. Start
   └── Clean up stale socket file
   └── Create Unix domain socket
   └── Set permissions (0o600 - owner only)
   └── Write PID file
   └── Initialize storage adapter

2. Accept Connection
   └── Create Connection object
   └── Wait for HELLO
   └── Send WELCOME
   └── Register with Router

3. Route Messages
   └── Receive SEND from connection
   └── Look up target in Router
   └── Create DELIVER envelope
   └── Send to target connection
   └── Persist to storage

4. Stop
   └── Close all connections
   └── Remove socket file
   └── Remove PID file
   └── Close storage
```

#### agents.json Updates

The daemon maintains an `agents.json` file for dashboard consumption:
```typescript
private writeAgentsFile(): void {
  const agents = this.router.getAgents().map(name => ({
    name,
    cli: connection?.cli,
    connectedAt: new Date().toISOString(),
  }));
  fs.writeFileSync(agentsPath, JSON.stringify({ agents }, null, 2));
}
```

### 3.4 Connection State Machine (`src/daemon/connection.ts`)

Each client connection follows a strict state machine:

```
                    ┌─────────────┐
                    │ CONNECTING  │
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
          ┌─────────│ HANDSHAKING │─────────┐
          │         └──────┬──────┘         │
          │                │                │
          │ error          │ HELLO/WELCOME  │ error
          │                ▼                │
          │         ┌─────────────┐         │
          │         │   ACTIVE    │─────────┤
          │         └──────┬──────┘         │
          │                │                │
          │                │ BYE/error      │
          │                ▼                │
          │         ┌─────────────┐         │
          └────────▶│  CLOSING    │◀────────┘
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
                    │   CLOSED    │
                    └─────────────┘
```

#### Heartbeat Mechanism

The daemon sends PING every 5 seconds. If no PONG within 10 seconds, connection is terminated:
```typescript
if (now - this.lastPongReceived > this.config.heartbeatMs * 2) {
  this.handleError(new Error('Heartbeat timeout'));
}
```

### 3.5 Router (`src/daemon/router.ts`)

Manages agent registry and message routing.

#### Routing Logic

```typescript
route(from: RoutableConnection, envelope: Envelope<SendPayload>): void {
  const to = envelope.to;

  if (to === '*') {
    // Broadcast to all (except sender)
    this.broadcast(senderName, envelope, topic);
  } else if (to) {
    // Direct message
    this.sendDirect(senderName, to, envelope);
  }
}
```

#### Topic Subscriptions

Agents can subscribe to topics for filtered broadcasts:
```typescript
// Agent subscribes
router.subscribe('Alice', 'code-review');

// Later, broadcast only reaches topic subscribers
envelope.topic = 'code-review';
router.route(connection, envelope); // Only goes to subscribed agents
```

#### Sequence Numbers

Each message gets a sequence number per (topic, peer) stream for ordering:
```typescript
getNextSeq(topic: string, peer: string): number {
  const key = `${topic}:${peer}`;
  const seq = (this.sequences.get(key) ?? 0) + 1;
  this.sequences.set(key, seq);
  return seq;
}
```

### 3.6 RelayClient (`src/wrapper/client.ts`)

Client-side daemon connection with automatic reconnection.

#### State Machine

```
┌──────────────┐
│ DISCONNECTED │◀────────────────────────────────┐
└──────┬───────┘                                 │
       │ connect()                               │
       ▼                                         │
┌──────────────┐                                 │
│  CONNECTING  │─────error──────────────────────▶│
└──────┬───────┘                                 │
       │ socket connected                        │
       ▼                                         │
┌──────────────┐                                 │
│ HANDSHAKING  │─────error──────────────────────▶│
└──────┬───────┘                                 │
       │ WELCOME received                        │
       ▼                                         │
┌──────────────┐         ┌─────────┐            │
│    READY     │◀───────▶│ BACKOFF │────────────┘
└──────────────┘         └─────────┘
       │                      ▲
       │ disconnect           │ reconnect
       └──────────────────────┘
```

#### Reconnection Strategy

Exponential backoff with jitter:
```typescript
const jitter = Math.random() * 0.3 + 0.85; // 0.85 - 1.15
const delay = Math.min(this.reconnectDelay * jitter, 30000);
this.reconnectDelay *= 2; // Exponential growth
```

Starting at 100ms, max 30 seconds, up to 10 attempts.

---

## 4. Protocol Specification

### 4.1 Wire Format

Messages use a simple length-prefixed framing:

```
┌─────────────────┬─────────────────────────────────┐
│  Length (4B)    │  JSON Payload (UTF-8)           │
│  Big-endian     │  (up to 1 MiB)                  │
└─────────────────┴─────────────────────────────────┘
```

Example frame:
```
Header: 0x00 0x00 0x00 0x3A  (58 bytes)
Payload: {"v":1,"type":"HELLO","id":"abc","ts":1234,"payload":{...}}
```

### 4.2 Envelope Structure

Every message follows this structure:

```typescript
interface Envelope<T = unknown> {
  v: number;           // Protocol version (always 1)
  type: MessageType;   // Message type
  id: string;          // UUID, unique per sender
  ts: number;          // Unix timestamp (milliseconds)
  from?: string;       // Sender name (set by daemon)
  to?: string | '*';   // Recipient or broadcast
  topic?: string;      // Optional topic/channel
  payload: T;          // Type-specific payload
}
```

### 4.3 Message Types

| Type | Direction | Purpose |
|------|-----------|---------|
| `HELLO` | Client → Daemon | Initiate handshake, identify agent |
| `WELCOME` | Daemon → Client | Confirm session, provide config |
| `SEND` | Client → Daemon | Send message to another agent |
| `DELIVER` | Daemon → Client | Deliver message from another agent |
| `ACK` | Both | Acknowledge message receipt |
| `NACK` | Both | Negative acknowledgment |
| `PING` | Daemon → Client | Heartbeat check |
| `PONG` | Client → Daemon | Heartbeat response |
| `ERROR` | Daemon → Client | Error notification |
| `BUSY` | Daemon → Client | Backpressure signal |
| `SUBSCRIBE` | Client → Daemon | Subscribe to topic |
| `UNSUBSCRIBE` | Client → Daemon | Unsubscribe from topic |
| `BYE` | Both | Graceful disconnect |

### 4.4 Handshake Flow

```
Client                              Daemon
  │                                   │
  │────────── HELLO ─────────────────▶│
  │  {                                │
  │    agent: "Alice",                │
  │    cli: "claude",                 │
  │    capabilities: {                │
  │      ack: true,                   │
  │      resume: true,                │
  │      max_inflight: 256,           │
  │      supports_topics: true        │
  │    }                              │
  │  }                                │
  │                                   │
  │◀───────── WELCOME ────────────────│
  │  {                                │
  │    session_id: "...",             │
  │    resume_token: "...",           │
  │    server: {                      │
  │      max_frame_bytes: 1048576,    │
  │      heartbeat_ms: 5000           │
  │    }                              │
  │  }                                │
  │                                   │
  │         [Connection ACTIVE]       │
  │                                   │
```

### 4.5 Message Delivery Flow

```
Alice                    Daemon                    Bob
  │                        │                        │
  │──── SEND ─────────────▶│                        │
  │  {                     │                        │
  │    to: "Bob",          │                        │
  │    payload: {          │                        │
  │      kind: "message",  │                        │
  │      body: "Hello!"    │                        │
  │    }                   │                        │
  │  }                     │                        │
  │                        │                        │
  │                        │────── DELIVER ────────▶│
  │                        │  {                     │
  │                        │    from: "Alice",      │
  │                        │    payload: {...},     │
  │                        │    delivery: {         │
  │                        │      seq: 1,           │
  │                        │      session_id: "..." │
  │                        │    }                   │
  │                        │  }                     │
  │                        │                        │
  │                        │◀─────── ACK ───────────│
  │                        │  { ack_id: "...",      │
  │                        │    seq: 1 }            │
  │                        │                        │
```

### 4.6 Payload Kinds

Messages can have different semantic kinds:

| Kind | Purpose |
|------|---------|
| `message` | General communication |
| `action` | Request to perform a task |
| `state` | Status update |
| `thinking` | Shared reasoning (for transparency) |

---

## 5. Message Flow

### 5.1 Complete End-to-End Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 1. AGENT OUTPUT                                                         │
│    Agent (Claude) produces text: ">>relay:Bob Can you review auth.ts?"   │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 2. TMUX CAPTURE                                                         │
│    TmuxWrapper polls: `tmux capture-pane -t session -p -J -S -`         │
│    Retrieves full scrollback buffer                                     │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 3. OUTPUT PARSING                                                       │
│    OutputParser:                                                        │
│    - Strips ANSI escape codes                                           │
│    - Joins continuation lines                                           │
│    - Matches /^>>relay:(\S+)\s+(.+)$/                                    │
│    - Returns: { to: "Bob", body: "Can you review auth.ts?" }           │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 4. DEDUPLICATION CHECK                                                  │
│    Hash: "Bob:Can you review auth.ts?"                                  │
│    If seen before → skip                                                │
│    If new → add to hash set, continue                                   │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 5. RELAY CLIENT SEND                                                    │
│    Creates SEND envelope:                                               │
│    {                                                                    │
│      v: 1, type: "SEND", id: "uuid", ts: 1234567890,                   │
│      to: "Bob",                                                         │
│      payload: { kind: "message", body: "Can you review auth.ts?" }     │
│    }                                                                    │
│    Encodes with 4-byte length prefix, writes to socket                  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 6. DAEMON RECEIVES                                                      │
│    Connection.handleData() → FrameParser.push() → processFrame()        │
│    Validates state is ACTIVE, forwards to Router                        │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 7. ROUTER PROCESSES                                                     │
│    router.route(connection, envelope):                                  │
│    - Looks up "Bob" in agents map                                       │
│    - Creates DELIVER envelope with sequence number                      │
│    - Sends to Bob's connection                                          │
│    - Persists to SQLite storage                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 8. BOB'S CLIENT RECEIVES                                                │
│    RelayClient.handleDeliver():                                         │
│    - Sends ACK back to daemon                                           │
│    - Calls onMessage callback                                           │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 9. MESSAGE QUEUED                                                       │
│    TmuxWrapper.handleIncomingMessage():                                 │
│    - Adds to messageQueue                                               │
│    - Schedules injection check                                          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 10. IDLE DETECTION                                                      │
│     Wait for 1.5 seconds of no output from Bob's agent                  │
│     If still active output → retry in 500ms                             │
│     If idle → proceed to injection                                      │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 11. MESSAGE INJECTION                                                   │
│     tmux send-keys -t session -l "Relay message from Alice [abc12345]:  │
│                                   Can you review auth.ts?"              │
│     tmux send-keys -t session Enter                                     │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 12. BOB'S AGENT RECEIVES                                                │
│     The message appears as user input in Bob's terminal                 │
│     Bob's agent (Codex) processes it as a new message                   │
└─────────────────────────────────────────────────────────────────────────┘
```

### 5.2 Broadcast Flow

When sending to `>>relay:*`:

```
Alice                    Daemon                    Bob, Carol, Dave
  │                        │                        │
  │──── SEND ─────────────▶│                        │
  │  { to: "*", ... }      │                        │
  │                        │                        │
  │                        │──── DELIVER ──────────▶│ Bob
  │                        │──── DELIVER ──────────▶│ Carol
  │                        │──── DELIVER ──────────▶│ Dave
  │                        │                        │
  │                        │ (Alice excluded)       │
```

---

## 6. State Machines

### 6.1 Connection State Machine (Daemon-side)

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  CONNECTING ─────────────▶ HANDSHAKING ─────────────▶ ACTIVE   │
│       │                         │                        │      │
│       │                         │                        │      │
│       │         ┌───────────────┴────────────────────────┤      │
│       │         │                                        │      │
│       │         ▼                                        ▼      │
│       │      ERROR ──────────────────────────────────▶ CLOSED  │
│       │                                                  ▲      │
│       │                                                  │      │
│       └──────────────────────────────────────────────────┘      │
│                                                                 │
│  Transitions:                                                   │
│  - CONNECTING → HANDSHAKING: Socket accepted                    │
│  - HANDSHAKING → ACTIVE: Valid HELLO received, WELCOME sent     │
│  - HANDSHAKING → ERROR: Invalid HELLO or timeout                │
│  - ACTIVE → CLOSING: BYE received or sent                       │
│  - ACTIVE → ERROR: Protocol error or heartbeat timeout          │
│  - CLOSING → CLOSED: Socket closed                              │
│  - ERROR → CLOSED: Cleanup complete                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 Client State Machine (Wrapper-side)

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│                      ┌────────────────┐                         │
│                      │  DISCONNECTED  │◀──────────┐             │
│                      └───────┬────────┘           │             │
│                              │ connect()          │             │
│                              ▼                    │             │
│                      ┌────────────────┐           │             │
│            ┌─────────│  CONNECTING   │───────────┤             │
│            │         └───────┬────────┘           │             │
│            │                 │ connected          │             │
│            │                 ▼                    │             │
│            │         ┌────────────────┐           │             │
│            │ error   │  HANDSHAKING  │───────────┤             │
│            │         └───────┬────────┘           │             │
│            │                 │ WELCOME            │             │
│            │                 ▼                    │             │
│            │         ┌────────────────┐           │             │
│            │         │     READY      │           │             │
│            │         └───────┬────────┘           │             │
│            │                 │ disconnect         │             │
│            │                 ▼                    │             │
│            │         ┌────────────────┐           │             │
│            └────────▶│    BACKOFF    │───────────┘             │
│                      └────────────────┘   max attempts         │
│                              │                                  │
│                              │ timer expires                    │
│                              └──────▶ (retry connect())         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 6.3 Parser State Machine

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  ┌─────────────┐          ┌─────────────┐                      │
│  │   NORMAL    │◀────────▶│  IN_FENCE   │                      │
│  │             │   ```    │             │                      │
│  └──────┬──────┘          └─────────────┘                      │
│         │                                                       │
│         │ [[RELAY]]                                             │
│         ▼                                                       │
│  ┌─────────────┐                                               │
│  │  IN_BLOCK   │──── [[/RELAY]] ────▶ Parse JSON, emit command │
│  │             │                                               │
│  └─────────────┘                                               │
│                                                                 │
│  State Tracking:                                                │
│  - inCodeFence: boolean - ignore >>relay inside code fences    │
│  - inBlock: boolean - buffering [[RELAY]]...[[/RELAY]]         │
│  - blockBuffer: string - accumulated block content             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 7. Data Storage

### 7.1 Storage Architecture

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
       │  SQLite   │   │  Memory   │   │ PostgreSQL│
       │  Adapter  │   │  Adapter  │   │ (Planned) │
       └───────────┘   └───────────┘   └───────────┘
```

### 7.2 SQLite Schema

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,           -- UUID
  ts INTEGER NOT NULL,           -- Unix timestamp (ms)
  sender TEXT NOT NULL,          -- Sender agent name
  recipient TEXT NOT NULL,       -- Recipient agent name
  topic TEXT,                    -- Optional topic
  kind TEXT NOT NULL,            -- message/action/state/thinking
  body TEXT NOT NULL,            -- Message content
  data TEXT,                     -- JSON blob for structured data
  delivery_seq INTEGER,          -- Sequence number for ordering
  delivery_session_id TEXT,      -- Session that received it
  session_id TEXT                -- Sender's session
);

-- Performance indexes
CREATE INDEX idx_messages_ts ON messages(ts);
CREATE INDEX idx_messages_sender ON messages(sender);
CREATE INDEX idx_messages_recipient ON messages(recipient);
CREATE INDEX idx_messages_topic ON messages(topic);
```

**WAL Mode**: Enabled for better concurrent access.

### 7.3 Storage Locations

```
/tmp/agent-relay/{projectId}/
├── relay.sock          # Unix domain socket
├── relay.sock.pid      # Daemon PID file
├── messages.sqlite     # Message database
├── agents.json         # Connected agents (for dashboard)
└── team/
    └── {agentName}/
        └── inbox.md    # File-based inbox (optional)
```

### 7.4 Project Namespace Isolation

Each project gets isolated storage based on project root hash:

```typescript
function getProjectId(projectRoot: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(projectRoot);
  return hash.digest('hex').substring(0, 12);
}
```

Project roots are detected by looking for markers:
- `.git`
- `package.json`
- `Cargo.toml`
- `go.mod`
- `pyproject.toml`
- `.agent-relay`

---

## 8. Security Model

### 8.1 Trust Boundaries

```
┌─────────────────────────────────────────────────────────────────┐
│                    TRUST BOUNDARY: Local Machine                │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                 User's Terminal Session                   │  │
│  │                                                           │  │
│  │  Agents run with user's permissions                       │  │
│  │  Socket permissions: 0o600 (owner only)                   │  │
│  │  No network exposure                                      │  │
│  │                                                           │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  Assumptions:                                                   │
│  - All agents on the machine are trusted                        │
│  - No authentication between agents                             │
│  - Any process that can access the socket can send messages     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 8.2 Current Security Properties

| Property | Status | Notes |
|----------|--------|-------|
| Local-only communication | ✅ | Unix socket, no network |
| Socket permissions | ✅ | 0o600 (owner read/write only) |
| No authentication | ⚠️ | Any local process can connect |
| No encryption | ⚠️ | Messages in plaintext on socket |
| No message signing | ⚠️ | Sender identity trusted |
| Rate limiting | ❌ | Not implemented |
| Message validation | ⚠️ | Basic field presence checks only |

### 8.3 Threat Model

**In Scope:**
- Local process isolation (handled by Unix socket permissions)
- Preventing accidental message loops (deduplication)
- Graceful handling of malformed messages

**Out of Scope (Explicitly Not Protected Against):**
- Malicious local processes with same user permissions
- Message spoofing by compromised agents
- Denial of service from local processes
- Data exfiltration through relay messages

### 8.4 Security Recommendations

For sensitive environments:
1. Run agents under separate user accounts
2. Use filesystem ACLs for additional socket protection
3. Monitor message logs for anomalies
4. Consider adding TLS for socket encryption (not currently implemented)

---

## 9. Design Decisions & Trade-offs

### 9.1 Why Output Parsing Instead of API Integration?

**Decision**: Parse agent stdout for `>>relay:` patterns instead of modifying agent code.

**Rationale**:
- Works with any CLI agent without modification
- No vendor lock-in or API dependencies
- Agents naturally produce text - leverage this
- Users see exactly what agents communicate

**Trade-offs**:
- ❌ Parsing is inherently fragile (ANSI codes, line wrapping)
- ❌ Can miss messages in edge cases
- ❌ No structured validation of message content
- ✅ Zero changes to Claude, Codex, or other agents
- ✅ Transparent - users see `>>relay:` in agent output

### 9.2 Why Tmux Instead of Direct PTY?

**Decision**: Wrap agents in tmux sessions rather than implementing our own PTY handling.

**Rationale**:
- Tmux provides mature terminal emulation
- Users can detach/reattach to sessions
- Scrollback buffer capture is reliable
- Mouse scroll and copy/paste work naturally

**Trade-offs**:
- ❌ Dependency on tmux installation
- ❌ Slightly more complex setup
- ❌ Platform limitations (tmux on Windows requires WSL)
- ✅ Battle-tested terminal handling
- ✅ User can interact with raw session if needed

### 9.3 Why Unix Sockets Instead of TCP?

**Decision**: Use Unix domain sockets for daemon communication.

**Rationale**:
- No network exposure by default
- Filesystem permissions for access control
- Lower overhead than TCP
- Natural fit for single-machine communication

**Trade-offs**:
- ❌ No remote agent communication (by design)
- ❌ Platform-specific (Windows support limited)
- ✅ Security through file permissions
- ✅ No port conflicts

### 9.4 Why Inject Messages as User Input?

**Decision**: Inject incoming messages by typing them into the agent's terminal.

**Rationale**:
- Agents treat messages as natural user requests
- No modification to agent input handling
- Works with any CLI agent

**Trade-offs**:
- ❌ Timing-sensitive (must wait for agent idle)
- ❌ Can interrupt agent mid-thought
- ❌ Long messages get truncated
- ✅ Universal compatibility
- ✅ Natural conversational flow

### 9.5 Why File-Based Inbox as Backup?

**Decision**: Optionally write messages to `inbox.md` file in addition to terminal injection.

**Rationale**:
- Agents can read inbox at their convenience
- Survives terminal buffer overflow
- Provides message history
- Some agents read files more reliably than terminal input

**Trade-offs**:
- ❌ Agents must be instructed to check inbox
- ❌ Delayed message processing
- ✅ No message loss
- ✅ Works even if injection fails

### 9.6 Why SQLite for Storage?

**Decision**: Use SQLite for message persistence.

**Rationale**:
- Zero configuration
- Single file, easy to back up
- Fast enough for message volume
- WAL mode handles concurrent access

**Trade-offs**:
- ❌ Not suitable for distributed deployment
- ❌ Limited query capabilities vs. full database
- ✅ No external dependencies
- ✅ Works offline

---

## 10. Known Limitations

### 10.1 Message Delivery Reliability

| Issue | Impact | Mitigation |
|-------|--------|------------|
| Messages can be lost if agent is busy | Medium | Idle detection, file inbox |
| No delivery confirmation to sender | Medium | ACK exists but not surfaced |
| Dedup memory grows unbounded | Low | Restart periodically |

### 10.2 Terminal Handling

| Issue | Impact | Mitigation |
|-------|--------|------------|
| ANSI codes can confuse parser | Low | Aggressive stripping |
| Long messages truncated | Medium | Show truncation notice |
| Line wrapping breaks patterns | Medium | Continuation line joining |
| Code fences can hide commands | Low | Fence state tracking |

### 10.3 Timing Issues

| Issue | Impact | Mitigation |
|-------|--------|------------|
| Injection can interrupt agent | Medium | 1.5s idle wait |
| Polling has 200ms latency | Low | Acceptable for most use cases |
| Race between poll and injection | Low | Queue-based injection |

### 10.4 Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| Linux | ✅ Full | Primary development platform |
| macOS | ✅ Full | Well tested |
| Windows | ⚠️ Partial | Requires WSL for tmux |

### 10.5 Scalability

| Metric | Current Limit | Notes |
|--------|---------------|-------|
| Concurrent agents | ~50 | Limited by daemon resources |
| Message rate | ~100/sec | SQLite bottleneck |
| Message size | 1 MiB | Protocol limit |
| Storage retention | Unbounded | No automatic cleanup |

---

## 11. Future Considerations

### 11.1 Potential Enhancements

**Reliability**:
- Persistent session resume tokens
- Guaranteed delivery with retry
- Message acknowledgment surfacing

**Security**:
- Agent authentication tokens
- Message signing
- Encrypted socket communication

**Scalability**:
- PostgreSQL storage adapter
- Multiple daemon instances
- Message queue integration

**Features**:
- Agent discovery protocol
- Typed message schemas
- Priority queues
- Message threading

### 11.2 Architectural Evolution

The current architecture is intentionally simple. Future evolution might include:

```
Current:
  Agent ──▶ Tmux ──▶ Parser ──▶ Socket ──▶ Daemon ──▶ Socket ──▶ Agent

Future (hypothetical):
  Agent ──▶ Native SDK ──▶ gRPC ──▶ Message Broker ──▶ gRPC ──▶ Agent
                                         │
                                         ▼
                                   Distributed
                                    Storage
```

However, the output-parsing approach has proven remarkably effective for the target use case of local multi-agent coordination.

---

## Appendix A: File Map

```
agent-relay/
├── src/
│   ├── cli/
│   │   └── index.ts              # CLI entry point, command handling
│   ├── daemon/
│   │   ├── server.ts             # Daemon lifecycle, socket listener
│   │   ├── connection.ts         # Connection state machine
│   │   ├── router.ts             # Message routing logic
│   │   └── index.ts
│   ├── wrapper/
│   │   ├── tmux-wrapper.ts       # Tmux session management
│   │   ├── client.ts             # Daemon client connection
│   │   ├── parser.ts             # Output parsing (>>relay:)
│   │   ├── inbox.ts              # File-based inbox
│   │   └── index.ts
│   ├── protocol/
│   │   ├── types.ts              # Envelope and payload types
│   │   ├── framing.ts            # Wire format encoding
│   │   └── index.ts
│   ├── storage/
│   │   ├── adapter.ts            # Storage interface
│   │   └── sqlite-adapter.ts     # SQLite implementation
│   ├── dashboard/
│   │   ├── server.ts             # Express + WebSocket server
│   │   ├── start.ts              # Dashboard startup
│   │   └── public/               # Static assets
│   ├── utils/
│   │   ├── project-namespace.ts  # Multi-project isolation
│   │   └── name-generator.ts     # Random agent names
│   └── index.ts                  # Package exports
├── package.json
├── tsconfig.json
├── CLAUDE.md                     # Agent instructions
└── ARCHITECTURE.md               # This document
```

---

## Appendix B: Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_RELAY_DASHBOARD_PORT` | 3888 | Dashboard HTTP port |
| `AGENT_RELAY_STORAGE_TYPE` | sqlite | Storage backend (sqlite/memory) |
| `AGENT_RELAY_STORAGE_PATH` | (auto) | SQLite database path |
| `AGENT_RELAY_STORAGE_URL` | - | PostgreSQL URL (future) |
| `AGENT_RELAY_DEBUG` | false | Enable debug logging |

---

## Appendix C: Quick Reference

### Starting the System

```bash
# Start daemon (required first)
agent-relay up

# Start agents
agent-relay -n Alice claude
agent-relay -n Bob claude
```

### Agent Communication

```
# Direct message
>>relay:Bob Please review the auth module

# Broadcast
>>relay:* I've finished the database migration

# Structured (block format)
[[RELAY]]{"to":"Bob","type":"action","body":"Run tests"}[[/RELAY]]
```

### Troubleshooting

```bash
# Check daemon status
agent-relay status

# Read truncated message
agent-relay read <message-id>

# View logs
# (Daemon logs to stdout, wrapper logs to stderr)
```

---

*Document generated for agent-relay v1.0.7*
*Last updated: 2025*
