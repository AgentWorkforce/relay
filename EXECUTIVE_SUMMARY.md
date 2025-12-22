# Agent Relay: Executive Summary

> Real-time autonomous agent-to-agent communication without modifying the agents themselves.

---

## What Is Agent Relay?

Agent Relay enables AI coding assistants (Claude, Codex, Gemini) running in separate terminals to **discover each other and communicate autonomously** - without any code changes to the AI systems.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│    Terminal 1              Terminal 2              Terminal 3           │
│   ┌─────────┐             ┌─────────┐             ┌─────────┐          │
│   │  Alice  │────────────▶│   Bob   │◀────────────│  Carol  │          │
│   │ (Claude)│◀────────────│ (Codex) │────────────▶│(Gemini) │          │
│   └─────────┘             └─────────┘             └─────────┘          │
│        │                       │                       │                │
│        └───────────────────────┼───────────────────────┘                │
│                                │                                        │
│                    ┌───────────▼───────────┐                           │
│                    │    Relay Daemon       │                           │
│                    │  (Message Routing)    │                           │
│                    └───────────────────────┘                           │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## The Core Insight

**Agents already produce text.** By watching for a simple pattern in their output, we can extract communication intent:

```
Agent Output:  "I'll ask Bob for help. ->relay:Bob Can you review auth.ts?"
                                        ▲
                                        │
                            Relay captures this, routes to Bob
```

No API integration. No agent modification. Just pattern matching on stdout.

---

## How It Works (30-Second Version)

```
┌──────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│  1. WRAP                    2. CAPTURE                 3. ROUTE          │
│  ════════                   ═════════                  ═══════           │
│                                                                          │
│  agent-relay               Background                  Daemon            │
│  -n Alice claude    ───▶   polling     ───▶   finds   routes    ───▶    │
│                            captures          ->relay:   message          │
│  Agent runs in             output            Bob...    to Bob           │
│  tmux session                                                            │
│                                                                          │
│                                                                          │
│  4. DELIVER                 5. INJECT                  6. RESPOND        │
│  ═════════                  ════════                   ═════════         │
│                                                                          │
│  Bob's wrapper             Types into                  Bob's agent       │
│  receives       ───▶       Bob's        ───▶          processes  ───▶   │
│  message                   terminal                    as input          │
│                                                                          │
│                            "Relay message              Can reply with    │
│                             from Alice:                ->relay:Alice      │
│                             Can you..."                                  │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

```bash
# Terminal 1: Start the daemon
agent-relay up

# Terminal 2: Start first agent
agent-relay -n Alice claude

# Terminal 3: Start second agent
agent-relay -n Bob claude
```

Alice can now send: `->relay:Bob Can you help with the auth module?`

Bob receives: `Relay message from Alice [abc123]: Can you help with the auth module?`

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          AGENT RELAY SYSTEM                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    CLI Layer (Entry Point)                       │   │
│  │                                                                  │   │
│  │   agent-relay up      Start daemon + dashboard                   │   │
│  │   agent-relay down    Stop daemon                                │   │
│  │   agent-relay -n X    Wrap agent with name X                     │   │
│  │   agent-relay status  Check daemon status                        │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                    │                                    │
│                                    ▼                                    │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    Wrapper Layer (Per Agent)                     │   │
│  │                                                                  │   │
│  │   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐            │   │
│  │   │TmuxWrapper  │  │OutputParser │  │RelayClient  │            │   │
│  │   │             │  │             │  │             │            │   │
│  │   │• Runs agent │  │• ->relay:    │  │• Socket I/O │            │   │
│  │   │  in tmux    │  │  patterns   │  │• Reconnect  │            │   │
│  │   │• Captures   │  │• ANSI strip │  │• Handshake  │            │   │
│  │   │  output     │  │• Dedup      │  │             │            │   │
│  │   │• Injects    │  │             │  │             │            │   │
│  │   │  messages   │  │             │  │             │            │   │
│  │   └─────────────┘  └─────────────┘  └─────────────┘            │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                    │                                    │
│                          Unix Domain Socket                             │
│                                    │                                    │
│                                    ▼                                    │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    Daemon Layer (Central)                        │   │
│  │                                                                  │   │
│  │   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐            │   │
│  │   │Server       │  │Connection   │  │Router       │            │   │
│  │   │             │  │             │  │             │            │   │
│  │   │• Lifecycle  │  │• State M/C  │  │• Agent map  │            │   │
│  │   │• Socket     │  │• Handshake  │  │• Routing    │            │   │
│  │   │• PID file   │  │• Heartbeat  │  │• Broadcast  │            │   │
│  │   └─────────────┘  └─────────────┘  └─────────────┘            │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                    │                                    │
│                                    ▼                                    │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    Storage Layer (SQLite)                        │   │
│  │                                                                  │   │
│  │   • Message persistence        • Query by sender/recipient       │   │
│  │   • WAL mode for concurrency   • Full message history            │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Message Flow Diagram

```
  Alice (Claude)                    Daemon                      Bob (Codex)
       │                              │                              │
       │  Agent outputs:              │                              │
       │  "->relay:Bob review auth"    │                              │
       │                              │                              │
       ├──────────────────────────────┤                              │
       │     TmuxWrapper captures     │                              │
       │     OutputParser extracts    │                              │
       │     RelayClient sends SEND   │                              │
       ├─────────────────────────────▶│                              │
       │                              │                              │
       │                              │  Router looks up "Bob"       │
       │                              │  Creates DELIVER envelope    │
       │                              │  Persists to SQLite          │
       │                              │                              │
       │                              ├─────────────────────────────▶│
       │                              │                              │
       │                              │     RelayClient receives     │
       │                              │     TmuxWrapper waits idle   │
       │                              │     Injects via send-keys    │
       │                              │                              │
       │                              │              ┌───────────────┤
       │                              │              │ Bob sees:     │
       │                              │              │ "Relay msg    │
       │                              │              │  from Alice:  │
       │                              │              │  review auth" │
       │                              │              └───────────────┤
       │                              │                              │
       │                              │     Bob can respond:         │
       │                              │     "->relay:Alice Done!"     │
       │                              │                              │
       │                              │◀─────────────────────────────┤
       │◀─────────────────────────────┤                              │
       │                              │                              │
```

---

## Protocol Overview

### Wire Format

```
┌────────────────┬──────────────────────────────────────────────────────┐
│  Length (4B)   │              JSON Payload (UTF-8)                    │
│  Big-endian    │              Up to 1 MiB                             │
└────────────────┴──────────────────────────────────────────────────────┘
```

### Message Types

| Type | Direction | Purpose |
|------|-----------|---------|
| `HELLO` | Client → Daemon | Identify agent |
| `WELCOME` | Daemon → Client | Confirm session |
| `SEND` | Client → Daemon | Send message |
| `DELIVER` | Daemon → Client | Receive message |
| `PING/PONG` | Both | Heartbeat |
| `BYE` | Both | Disconnect |

### Envelope Structure

```json
{
  "v": 1,
  "type": "SEND",
  "id": "uuid-here",
  "ts": 1703001234567,
  "to": "Bob",
  "payload": {
    "kind": "message",
    "body": "Can you review auth.ts?"
  }
}
```

---

## State Machines

### Connection States (Daemon-side)

```
 CONNECTING ──▶ HANDSHAKING ──▶ ACTIVE ──▶ CLOSING ──▶ CLOSED
                     │             │
                     └─── ERROR ───┘
```

### Client States (Wrapper-side)

```
 DISCONNECTED ──▶ CONNECTING ──▶ HANDSHAKING ──▶ READY
       ▲                                           │
       │                                           │
       └──────────── BACKOFF ◀─────────────────────┘
                   (auto-reconnect)
```

---

## Communication Patterns

### Direct Message
```
->relay:Bob Please review the authentication module
```

### Broadcast
```
->relay:* I've completed the database migration - all tests passing
```

### Structured (Block Format)
```
[[RELAY]]{"to":"Bob","type":"action","body":"Run integration tests","data":{"priority":"high"}}[[/RELAY]]
```

### Common Conventions
```
->relay:* STATUS: Starting work on auth module
->relay:* DONE: Auth module complete
->relay:Reviewer REVIEW: Please check src/auth/*.ts
->relay:Architect QUESTION: Should we use JWT or sessions?
```

---

## Key Design Decisions

| Decision | Why |
|----------|-----|
| **Output parsing** | Works with any CLI agent, no modifications needed |
| **Tmux wrapper** | Mature terminal emulation, users can detach/reattach |
| **Unix sockets** | No network exposure, filesystem permissions for security |
| **Message injection** | Agents treat messages as natural user input |
| **SQLite storage** | Zero config, single file, good enough for local use |

---

## Limitations (Transparency)

| Area | Limitation |
|------|------------|
| **Security** | No authentication between agents (local trust assumed) |
| **Reliability** | Messages can be lost if agent is busy outputting |
| **Timing** | 200ms polling latency, 1.5s idle wait before injection |
| **Platform** | Windows requires WSL (tmux dependency) |
| **Scale** | ~50 concurrent agents, ~100 msg/sec |

---

## File Structure

```
agent-relay/
├── src/
│   ├── cli/index.ts           # CLI entry point
│   ├── daemon/
│   │   ├── server.ts          # Daemon server
│   │   ├── connection.ts      # Connection state machine
│   │   └── router.ts          # Message routing
│   ├── wrapper/
│   │   ├── tmux-wrapper.ts    # Tmux session management
│   │   ├── client.ts          # Daemon client
│   │   └── parser.ts          # ->relay: pattern matching
│   ├── protocol/
│   │   ├── types.ts           # Message types
│   │   └── framing.ts         # Wire format
│   └── storage/
│       └── sqlite-adapter.ts  # Message persistence
├── ARCHITECTURE.md            # Detailed technical docs
└── EXECUTIVE_SUMMARY.md       # This document
```

---

## Storage Locations

```
/tmp/agent-relay/{project-hash}/
├── relay.sock              # Unix domain socket
├── relay.sock.pid          # Daemon PID
├── messages.sqlite         # Message history
└── agents.json             # Connected agents
```

---

## See Also

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** - Complete technical deep-dive
- **[README.md](./README.md)** - Quick start guide

---

*Agent Relay v1.0.7*
