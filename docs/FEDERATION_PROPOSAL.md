# Agent Relay Federation: Cross-Server Communication Proposal

**Status:** Draft v2 (revised after critical review)
**Last Updated:** 2025-12-21

## Executive Summary

This proposal extends agent-relay to support **federated multi-server deployments** while preserving the core differentiator: **automatic message injection via tmux**. Unlike polling-based systems (mcp_agent_mail OSS), federated agent-relay maintains real-time, interrupt-driven communication across server boundaries.

### Key Design Decisions (v2)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Transport | Pluggable (WebSocket default, NATS optional) | Start simple, scale up |
| Delivery | End-to-end confirmation | Sender knows agent received |
| Naming | Fleet-wide unique names | Avoid split-brain complexity |
| Auth | Asymmetric keys (Ed25519) | Scales better than N² tokens |
| Backpressure | Credit-based flow control | Prevent OOM on slow peers |

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           FEDERATED AGENT-RELAY                              │
│                                                                              │
│  ┌─────────────┐         ┌─────────────┐         ┌─────────────┐           │
│  │  Server A   │         │  Server B   │         │  Server C   │           │
│  │             │         │             │         │             │           │
│  │ ┌───┐ ┌───┐ │  wss:// │ ┌───┐ ┌───┐ │  wss:// │ ┌───┐       │           │
│  │ │Ali│ │Bob│ │◄───────►│ │Car│ │Dav│ │◄───────►│ │Eve│       │           │
│  │ └─┬─┘ └─┬─┘ │         │ └─┬─┘ └─┬─┘ │         │ └─┬─┘       │           │
│  │   │     │   │         │   │     │   │         │   │         │           │
│  │ ┌─┴─────┴─┐ │         │ ┌─┴─────┴─┐ │         │ ┌─┴───┐     │           │
│  │ │ Daemon  │ │         │ │ Daemon  │ │         │ │Daemon│     │           │
│  │ └─────────┘ │         │ └─────────┘ │         │ └─────┘     │           │
│  └─────────────┘         └─────────────┘         └─────────────┘           │
│                                                                              │
│  • Agents run in tmux (unchanged)                                           │
│  • Local injection via send-keys (unchanged)                                │
│  • Cross-server routing via WebSocket (NEW)                                 │
│  • Fleet-wide agent discovery (NEW)                                         │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Table of Contents

1. [Design Principles](#1-design-principles)
2. [Architecture Overview](#2-architecture-overview)
3. [Network Topology](#3-network-topology)
4. [Protocol Specification](#4-protocol-specification)
5. [Agent Discovery & Registry](#5-agent-discovery--registry)
6. [Message Routing](#6-message-routing)
7. [Delivery Confirmation](#7-delivery-confirmation) *(NEW)*
8. [Security Model](#8-security-model)
9. [Flow Control & Backpressure](#9-flow-control--backpressure) *(NEW)*
10. [Failure Handling & Resilience](#10-failure-handling--resilience)
11. [Transport Abstraction (NATS Option)](#11-transport-abstraction-nats-option) *(NEW)*
12. [Configuration](#12-configuration)
13. [CLI Interface](#13-cli-interface)
14. [Implementation Plan](#14-implementation-plan)
15. [Migration Path](#15-migration-path)
16. [Open Questions](#16-open-questions) *(NEW)*
17. [Storage Architecture](#17-storage-architecture) *(NEW)*

---

## 1. Design Principles

### 1.1 Preserve the Core Magic

The #1 requirement is preserving **automatic message injection**:

```
Message arrives → tmux send-keys → Agent receives as user input
```

This is what differentiates agent-relay from polling-based systems. Federation must not compromise this.

### 1.2 Separation of Concerns

```
┌─────────────────────────────────────────────────────────┐
│                    ROUTING LAYER (NEW)                   │
│         Cross-server message delivery via WebSocket      │
├─────────────────────────────────────────────────────────┤
│                  INJECTION LAYER (UNCHANGED)             │
│         Local tmux send-keys for each server             │
└─────────────────────────────────────────────────────────┘
```

- **Routing** is a network problem → WebSocket between daemons
- **Injection** is a local problem → tmux send-keys (unchanged)

### 1.3 Progressive Enhancement

- Single-server deployments work exactly as before
- Federation is opt-in via configuration
- No breaking changes to existing setups

### 1.4 Operational Simplicity

- No external dependencies (Redis, NATS) required
- Optional hub for convenience, not required
- Static peer configuration works fine
- Simple CLI for fleet management

---

## 2. Architecture Overview

### 2.1 Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              SERVER NODE                                     │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         AGENT LAYER                                  │   │
│  │                                                                      │   │
│  │   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐         │   │
│  │   │ tmux: Alice  │    │ tmux: Bob    │    │ tmux: Carol  │         │   │
│  │   │ (claude)     │    │ (codex)      │    │ (gemini)     │         │   │
│  │   └──────┬───────┘    └──────┬───────┘    └──────┬───────┘         │   │
│  │          │ capture-pane      │                   │                  │   │
│  │          │ send-keys         │                   │                  │   │
│  │          ▼                   ▼                   ▼                  │   │
│  │   ┌──────────────────────────────────────────────────────────┐     │   │
│  │   │                   TmuxWrapper (per agent)                 │     │   │
│  │   │  • Parse @relay: patterns                                 │     │   │
│  │   │  • Inject incoming messages                               │     │   │
│  │   │  • Connect to local daemon                                │     │   │
│  │   └──────────────────────────┬───────────────────────────────┘     │   │
│  │                              │ Unix Socket                         │   │
│  └──────────────────────────────┼─────────────────────────────────────┘   │
│                                 │                                          │
│  ┌──────────────────────────────▼─────────────────────────────────────┐   │
│  │                         DAEMON LAYER                                │   │
│  │                                                                      │   │
│  │   ┌─────────────────┐    ┌─────────────────┐    ┌────────────────┐ │   │
│  │   │  LocalServer    │    │  PeerManager    │    │  Registry      │ │   │
│  │   │  (Unix socket)  │    │  (WebSocket)    │    │  (agents map)  │ │   │
│  │   │                 │    │                 │    │                │ │   │
│  │   │ • Accept local  │    │ • Connect peers │    │ • Local agents │ │   │
│  │   │   connections   │    │ • Route cross-  │    │ • Remote agents│ │   │
│  │   │ • Handle HELLO  │    │   server msgs   │    │ • Server map   │ │   │
│  │   └────────┬────────┘    └────────┬────────┘    └────────┬───────┘ │   │
│  │            │                      │                      │         │   │
│  │            └──────────────────────┼──────────────────────┘         │   │
│  │                                   │                                 │   │
│  │                         ┌─────────▼─────────┐                      │   │
│  │                         │      Router       │                      │   │
│  │                         │                   │                      │   │
│  │                         │ • Decide local vs │                      │   │
│  │                         │   remote routing  │                      │   │
│  │                         │ • Handle broadcast│                      │   │
│  │                         │ • Queue on disco- │                      │   │
│  │                         │   nnect           │                      │   │
│  │                         └───────────────────┘                      │   │
│  │                                                                      │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                 │                                          │
│                                 │ WebSocket (wss://)                       │
│                                 ▼                                          │
│                    ┌─────────────────────────────┐                        │
│                    │       PEER SERVERS          │                        │
│                    │   (other fleet members)     │                        │
│                    └─────────────────────────────┘                        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Data Flow: Cross-Server Message

```
Alice@ServerA sends to Bob@ServerB:

┌─────────────────────────────────────────────────────────────────────────────┐
│ SERVER A                                                                     │
│                                                                              │
│ 1. Alice outputs: @relay:Bob Can you review auth.ts?                        │
│         │                                                                    │
│         ▼                                                                    │
│ 2. TmuxWrapper captures via tmux capture-pane                               │
│         │                                                                    │
│         ▼                                                                    │
│ 3. Parser extracts: { to: "Bob", body: "Can you review auth.ts?" }          │
│         │                                                                    │
│         ▼                                                                    │
│ 4. RelayClient sends SEND envelope to local daemon (Unix socket)            │
│         │                                                                    │
│         ▼                                                                    │
│ 5. Router checks registry: Bob not local, Bob is on ServerB                 │
│         │                                                                    │
│         ▼                                                                    │
│ 6. PeerManager sends PEER_ROUTE to ServerB (WebSocket)                      │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ wss:// (TLS encrypted)
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ SERVER B                                                                     │
│                                                                              │
│ 7. PeerManager receives PEER_ROUTE                                          │
│         │                                                                    │
│         ▼                                                                    │
│ 8. Router looks up Bob in local connections                                 │
│         │                                                                    │
│         ▼                                                                    │
│ 9. Router calls TmuxWrapper.deliverToLocal(Bob, envelope)                   │
│         │                                                                    │
│         ▼                                                                    │
│ 10. TmuxWrapper executes:                                                   │
│     tmux send-keys -t relay-Bob-12345 -l "Relay message from Alice..."      │
│     tmux send-keys -t relay-Bob-12345 Enter                                 │
│         │                                                                    │
│         ▼                                                                    │
│ 11. Bob's agent receives message AS USER INPUT                              │
│     (automatic, no polling, no checking!)                                   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Network Topology

### 3.1 Topology Options

#### Option A: Full Mesh (Recommended for <10 servers)

```
        ServerA ◄────────► ServerB
           ▲                  ▲
           │                  │
           │                  │
           ▼                  ▼
        ServerC ◄────────► ServerD
```

- Every daemon connects to every other daemon
- O(n²) connections, but fine for small fleets
- No single point of failure
- Lowest latency (direct paths)

#### Option B: Hub-and-Spoke (Recommended for 10+ servers)

```
                    ┌─────────┐
         ┌─────────►│   Hub   │◄─────────┐
         │          └────┬────┘          │
         │               │               │
         ▼               ▼               ▼
     ServerA         ServerB         ServerC
```

- All daemons connect to central hub
- Hub routes messages between servers
- Single point of failure (mitigate with hub HA)
- Simpler operations

#### Option C: Hybrid (Recommended for production)

```
                    ┌─────────┐
         ┌─────────►│ Hub     │◄─────────┐
         │          │(discover)│          │
         │          └─────────┘          │
         │                               │
         ▼                               ▼
     ServerA ◄─────────────────────► ServerB
         ▲                               ▲
         │                               │
         └───────────► ServerC ◄─────────┘
```

- Hub provides discovery and registry sync
- Daemons establish direct peer connections
- Messages route directly (low latency)
- Hub failure doesn't break existing connections

### 3.2 Recommended Approach

**Hybrid topology with optional hub:**

1. Daemons can be configured with static peer list (no hub needed)
2. Optionally connect to hub for dynamic discovery
3. Once peers are known, establish direct connections
4. Hub going down doesn't break messaging (just discovery)

---

## 4. Protocol Specification

### 4.1 Peer Protocol Messages

Extend the existing envelope format with peer-specific message types:

```typescript
// New message types for federation
type PeerMessageType =
  | 'PEER_HELLO'      // Initial handshake
  | 'PEER_WELCOME'    // Handshake response
  | 'PEER_SYNC'       // Registry synchronization
  | 'PEER_ROUTE'      // Route message to local agent
  | 'PEER_BROADCAST'  // Broadcast to local agents
  | 'PEER_PING'       // Heartbeat
  | 'PEER_PONG'       // Heartbeat response
  | 'PEER_BYE';       // Graceful disconnect

// Peer envelope (over WebSocket)
interface PeerEnvelope<T = unknown> {
  v: 1;                    // Protocol version
  type: PeerMessageType;
  id: string;              // Message UUID
  ts: number;              // Timestamp
  from_server: string;     // Originating server ID
  payload: T;
}
```

### 4.2 PEER_HELLO / PEER_WELCOME

Initial handshake between daemons:

```typescript
// Client → Server
interface PeerHelloPayload {
  server_id: string;           // e.g., "nyc-prod-01"
  server_name?: string;        // Human-readable name
  version: string;             // agent-relay version
  capabilities: {
    max_message_size: number;
    supports_broadcast: boolean;
    supports_topics: boolean;
  };
  agents: AgentInfo[];         // Local agents to register
  auth_token: string;          // Pre-shared token
}

// Server → Client
interface PeerWelcomePayload {
  server_id: string;
  session_id: string;          // For reconnection
  agents: AgentInfo[];         // Server's local agents
  peers: PeerInfo[];           // Other known peers (for mesh)
  config: {
    heartbeat_ms: number;      // Ping interval
    sync_interval_ms: number;  // Registry sync interval
  };
}

interface AgentInfo {
  name: string;
  server_id: string;
  cli?: string;                // claude, codex, gemini
  connected_at: string;        // ISO timestamp
  status: 'online' | 'idle' | 'busy';
}

interface PeerInfo {
  server_id: string;
  url: string;                 // WebSocket URL
  agents: string[];            // Agent names on this peer
}
```

### 4.3 PEER_SYNC

Registry updates when agents join/leave:

```typescript
interface PeerSyncPayload {
  type: 'agent_joined' | 'agent_left' | 'full_sync';
  agents?: AgentInfo[];        // For full_sync
  agent?: AgentInfo;           // For join/leave
}
```

### 4.4 PEER_ROUTE

Forward a message to a specific agent:

```typescript
interface PeerRoutePayload {
  original_envelope: Envelope<SendPayload>;  // The actual message
  target_agent: string;                       // Local agent name
  hops: string[];                             // Servers traversed (loop prevention)
}
```

### 4.5 PEER_BROADCAST

Forward a broadcast to all local agents:

```typescript
interface PeerBroadcastPayload {
  original_envelope: Envelope<SendPayload>;
  exclude_agents?: string[];   // Don't deliver to these
  scope?: 'fleet' | 'server';  // Broadcast scope
}
```

### 4.6 Connection State Machine

```
                     ┌─────────────────┐
                     │  DISCONNECTED   │◄─────────────────────┐
                     └────────┬────────┘                      │
                              │ connect()                     │
                              ▼                               │
                     ┌─────────────────┐                      │
          ┌──────────│   CONNECTING    │──────────┐           │
          │          └────────┬────────┘          │           │
          │                   │ socket open       │           │
          │ error             ▼                   │ error     │
          │          ┌─────────────────┐          │           │
          │          │  HANDSHAKING    │──────────┤           │
          │          └────────┬────────┘          │           │
          │                   │ WELCOME received  │           │
          │                   ▼                   │           │
          │          ┌─────────────────┐          │           │
          │          │     ACTIVE      │──────────┤           │
          │          └────────┬────────┘          │           │
          │                   │ BYE or error      │           │
          │                   ▼                   │           │
          │          ┌─────────────────┐          │           │
          └─────────►│   RECONNECTING  │◄─────────┘           │
                     └────────┬────────┘                      │
                              │ max retries                   │
                              └───────────────────────────────┘

  Reconnection: exponential backoff 1s → 2s → 4s → 8s → 16s → 30s (max)
  Max attempts: unlimited (peers are persistent)
```

---

## 5. Agent Discovery & Registry

### 5.1 Registry Structure

```typescript
interface FleetRegistry {
  // All known agents across the fleet
  agents: Map<string, AgentRecord>;

  // Server information
  servers: Map<string, ServerRecord>;

  // Index for fast lookup
  agentToServer: Map<string, string>;  // agentName → serverId
}

interface AgentRecord {
  name: string;
  server_id: string;
  qualified_name: string;      // "Alice@nyc-prod-01"
  cli?: string;
  status: 'online' | 'idle' | 'offline';
  connected_at: string;
  last_seen: string;
  metadata?: Record<string, unknown>;
}

interface ServerRecord {
  id: string;
  name?: string;
  url: string;
  status: 'connected' | 'disconnected' | 'unknown';
  agents: Set<string>;
  connected_at?: string;
  last_seen: string;
  latency_ms?: number;
}
```

### 5.2 Name Resolution

Agents can be addressed in multiple ways:

| Pattern | Resolution |
|---------|------------|
| `@relay:Bob` | Local first, then fleet-wide lookup |
| `@relay:Bob@nyc` | Explicitly route to server "nyc" |
| `@relay:Bob@*` | Send to ALL agents named Bob (rare) |
| `@relay:*` | Broadcast to entire fleet |
| `@relay:*@local` | Broadcast to local server only |
| `@relay:*@nyc` | Broadcast to all agents on "nyc" |

### 5.3 Name Collision Handling (v2: Fleet-Wide Uniqueness)

**Design Decision:** Agent names must be unique across the entire fleet.

This is simpler than "first-registered wins" which has race conditions with async gossip. With fleet-wide uniqueness:
- No split-brain scenarios
- No ambiguous routing
- Clear error on collision

```typescript
// Registration flow
async function registerAgent(name: string, serverId: string): Promise<Result> {
  // Check fleet-wide registry
  if (registry.exists(name)) {
    const existing = registry.get(name);
    return {
      success: false,
      error: `Name "${name}" already registered on ${existing.server_id}`,
      suggestion: `${name}-${serverId.slice(0, 4)}` // e.g., "Bob-nyc1"
    };
  }

  // Broadcast reservation with Lamport timestamp
  await broadcastReservation(name, serverId, lamportClock.tick());

  // Wait for quorum acknowledgment (majority of peers)
  const acks = await waitForAcks(name, QUORUM_TIMEOUT_MS);
  if (acks < quorumSize()) {
    return { success: false, error: 'Failed to achieve quorum' };
  }

  registry.add(name, serverId);
  return { success: true };
}

// Resolution is now simple
function resolveAgent(name: string): AgentRecord | null {
  // Check for explicit qualification (still supported)
  if (name.includes('@')) {
    const [agentName, serverSpec] = name.split('@');
    return registry.findOnServer(agentName, serverSpec);
  }

  // Fleet-wide lookup (guaranteed unique)
  return registry.get(name);
}
```

### 5.4 Registry Synchronization

Registries sync via gossip-like protocol:

```
Server A joins fleet:
1. A → B: PEER_HELLO (includes A's agents)
2. B → A: PEER_WELCOME (includes B's agents + known peers)
3. A → C: PEER_HELLO (A learned about C from B)
4. A → B: PEER_SYNC (A now knows about C's agents)
...eventually consistent...
```

**Sync triggers:**
- New peer connection
- Agent joins/leaves locally
- Periodic full sync (every 60s)
- On reconnection after disconnect

---

## 6. Message Routing

### 6.1 Routing Algorithm

```typescript
class FederatedRouter {
  route(from: string, envelope: Envelope<SendPayload>): void {
    const target = envelope.to;

    // 1. Broadcast handling
    if (target === '*' || target?.startsWith('*@')) {
      return this.handleBroadcast(from, envelope, target);
    }

    // 2. Resolve target agent
    const resolved = this.registry.resolve(target, this.serverId);
    if (!resolved) {
      this.sendNack(from, envelope.id, 'UNKNOWN_AGENT');
      return;
    }

    // 3. Local delivery
    if (resolved.server_id === this.serverId) {
      this.deliverLocal(from, resolved.name, envelope);
      return;
    }

    // 4. Remote delivery
    this.deliverRemote(from, resolved, envelope);
  }

  private handleBroadcast(from: string, envelope: Envelope, scope: string): void {
    const [, serverSpec] = scope.split('@');

    // Deliver to local agents (except sender)
    if (!serverSpec || serverSpec === 'local' || serverSpec === this.serverId) {
      for (const agent of this.localAgents) {
        if (agent.name !== from) {
          this.deliverLocal(from, agent.name, envelope);
        }
      }
    }

    // Forward to peers (unless local-only)
    if (serverSpec !== 'local') {
      for (const peer of this.peers.values()) {
        if (!serverSpec || peer.serverId === serverSpec) {
          peer.send({
            type: 'PEER_BROADCAST',
            payload: {
              original_envelope: envelope,
              exclude_agents: [from],
            }
          });
        }
      }
    }
  }

  private deliverRemote(
    from: string,
    target: AgentRecord,
    envelope: Envelope
  ): void {
    const peer = this.peers.get(target.server_id);

    if (!peer || peer.state !== 'ACTIVE') {
      // Queue for later delivery
      this.queueMessage(target.server_id, envelope);
      return;
    }

    peer.send({
      type: 'PEER_ROUTE',
      payload: {
        original_envelope: envelope,
        target_agent: target.name,
        hops: [this.serverId],
      }
    });
  }
}
```

### 6.2 Message Queuing

When a peer is disconnected, messages are queued:

```typescript
interface QueuedMessage {
  envelope: Envelope;
  target_server: string;
  queued_at: number;
  attempts: number;
  expires_at: number;  // TTL
}

class MessageQueue {
  private queues: Map<string, QueuedMessage[]>;

  enqueue(serverId: string, envelope: Envelope): void {
    const queue = this.queues.get(serverId) ?? [];
    queue.push({
      envelope,
      target_server: serverId,
      queued_at: Date.now(),
      attempts: 0,
      expires_at: Date.now() + 3600000,  // 1 hour TTL
    });
    this.queues.set(serverId, queue);
  }

  // Called when peer reconnects
  flush(serverId: string, peer: PeerConnection): void {
    const queue = this.queues.get(serverId) ?? [];
    for (const msg of queue) {
      if (Date.now() < msg.expires_at) {
        peer.send({ type: 'PEER_ROUTE', payload: msg.envelope });
      }
    }
    this.queues.delete(serverId);
  }
}
```

### 6.3 Loop Prevention

Prevent messages from bouncing between servers:

```typescript
interface PeerRoutePayload {
  // ... other fields
  hops: string[];  // Servers this message has traversed
}

// On receiving PEER_ROUTE
function handlePeerRoute(msg: PeerEnvelope<PeerRoutePayload>): void {
  // Check for loop
  if (msg.payload.hops.includes(this.serverId)) {
    console.warn('Loop detected, dropping message');
    return;
  }

  // Add ourselves to hops if forwarding
  if (needsForwarding) {
    msg.payload.hops.push(this.serverId);
  }
}
```

---

## 7. Delivery Confirmation *(NEW)*

### 7.1 The Problem

Without end-to-end confirmation, senders don't know if messages were actually received:

```
Alice sends → Daemon A → Daemon B → tmux send-keys → ???
                          ↑
                          ACK (peer received)

But: Did Bob's agent actually see it?
     - tmux session might have crashed
     - Agent might be blocked
     - Injection might have failed silently
```

### 7.2 Solution: DELIVERY_CONFIRMED Message

Add a new message type that confirms the message was injected into the agent's terminal:

```typescript
interface DeliveryConfirmedPayload {
  original_message_id: string;  // ID of the message being confirmed
  injected_at: number;          // Timestamp when send-keys completed
  agent_status: 'active' | 'idle' | 'unknown';
}
```

### 7.3 Confirmation Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         END-TO-END DELIVERY CONFIRMATION                     │
│                                                                              │
│  Alice@A                    Daemon A         Daemon B              Bob@B    │
│     │                          │                │                    │       │
│     │ ── @relay:Bob msg ────►  │                │                    │       │
│     │                          │ ─ PEER_ROUTE ─►│                    │       │
│     │                          │                │ ── send-keys ────► │       │
│     │                          │                │    (inject msg)    │       │
│     │                          │                │                    │       │
│     │                          │                │ ◄── capture-pane ──│       │
│     │                          │                │    (detect receipt)│       │
│     │                          │                │                    │       │
│     │                          │ ◄─ DELIVERY_ ──│                    │       │
│     │                          │   CONFIRMED    │                    │       │
│     │                          │                │                    │       │
│     │ ◄─ inject confirmation ──│                │                    │       │
│     │   "[✓] Bob received"     │                │                    │       │
│     │                          │                │                    │       │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 7.4 Detection Mechanism

After injecting a message, the TmuxWrapper watches for evidence the agent received it:

```typescript
async function confirmDelivery(messageId: string): Promise<boolean> {
  // Wait for agent to echo/process the message
  const startTime = Date.now();
  const timeout = 5000; // 5 seconds

  while (Date.now() - startTime < timeout) {
    const output = await capturePane();

    // Look for our injected message in output
    if (output.includes(`Relay message from`) && output.includes(messageId.slice(0, 8))) {
      return true;
    }

    await sleep(200);
  }

  return false; // Timeout - uncertain delivery
}
```

### 7.5 Sender Notification

Senders receive confirmation or timeout notification:

```
# Success case
[relay:Alice] → Bob: Can you review auth.ts?
[relay:Alice] ✓ Bob received (145ms)

# Timeout case
[relay:Alice] → Bob: Can you review auth.ts?
[relay:Alice] ⚠ Delivery to Bob unconfirmed (timeout)
```

### 7.6 Configuration

Delivery confirmation is optional (adds latency):

```yaml
federation:
  delivery_confirmation:
    enabled: true           # Enable end-to-end confirmation
    timeout_ms: 5000        # How long to wait for confirmation
    notify_sender: true     # Inject confirmation into sender's terminal
```

---

## 8. Security Model

### 8.1 Authentication (v2: Asymmetric Keys)

**Design Decision:** Use Ed25519 keypairs instead of pre-shared tokens.

Pre-shared tokens don't scale: N servers = N² tokens. With asymmetric keys:
- Each server has one keypair
- Servers exchange public keys once
- Challenge-response authentication
- Easy key rotation

```typescript
// Each server generates a keypair on first run
interface ServerIdentity {
  server_id: string;
  public_key: string;   // Ed25519 public key (base64)
  private_key: string;  // Ed25519 private key (stored securely)
}

// Handshake uses challenge-response
interface PeerHelloPayload {
  server_id: string;
  public_key: string;
  challenge: string;          // Random nonce
  challenge_signature: string; // Sign our challenge with our private key
}

interface PeerWelcomePayload {
  server_id: string;
  challenge_response: string;  // Sign their challenge with our private key
  // ... rest of welcome
}
```

### 8.2 Key Distribution

Options for distributing public keys:

**Option A: Static Configuration (Simple)**
```yaml
auth:
  private_key_path: /etc/agent-relay/server.key
  known_peers:
    london-prod-01: "ed25519:abc123..."  # Public key
    tokyo-prod-01: "ed25519:def456..."
```

**Option B: Trust-on-First-Use (TOFU)**
```yaml
auth:
  tofu_enabled: true      # Accept new peers, remember their keys
  tofu_require_approval: true  # Require human approval for new peers
```

**Option C: Certificate Authority (Enterprise)**
```yaml
auth:
  ca_cert: /etc/agent-relay/ca.pem
  server_cert: /etc/agent-relay/server.pem
  server_key: /etc/agent-relay/server.key
```

### 8.3 Message Signing

Each peer-to-peer message is signed:

```typescript
interface PeerEnvelope<T> {
  // ... existing fields
  signature: string;  // Ed25519 signature of (type + id + ts + payload)
}

function signEnvelope(envelope: PeerEnvelope, privateKey: Key): string {
  const payload = JSON.stringify({
    type: envelope.type,
    id: envelope.id,
    ts: envelope.ts,
    payload: envelope.payload
  });
  return ed25519.sign(payload, privateKey);
}

function verifyEnvelope(envelope: PeerEnvelope, publicKey: Key): boolean {
  // Reject if signature invalid - prevents spoofing
  return ed25519.verify(envelope.signature, publicKey);
}
```

### 8.4 Transport Security

**Mandatory TLS** for peer connections:

```typescript
const ws = new WebSocket(peerUrl, {
  // TLS configuration
  rejectUnauthorized: true,  // Verify peer certificate
  ca: fs.readFileSync('/etc/agent-relay/ca.pem'),

  // Client certificate (for mTLS)
  cert: fs.readFileSync('/etc/agent-relay/client.pem'),
  key: fs.readFileSync('/etc/agent-relay/client-key.pem'),
});
```

### 8.5 Authorization

Simple capability model:

```typescript
interface ServerCapabilities {
  can_broadcast: boolean;       // Can send fleet-wide broadcasts
  can_route_to: string[];       // Allowed target servers
  max_message_rate: number;     // Rate limit (msgs/sec)
  allowed_agents: string[];     // Can message these agents (or '*')
}
```

### 8.6 Security Checklist

| Control | Status | Notes |
|---------|--------|-------|
| TLS encryption | Required | wss:// only |
| Peer authentication | Required | Pre-shared token |
| mTLS (mutual TLS) | Optional | For high-security |
| Message signing | Future | Verify message origin |
| Rate limiting | Recommended | Prevent floods |
| Audit logging | Recommended | Log all cross-server |

---

## 9. Flow Control & Backpressure *(NEW)*

### 15.1 The Problem

Without flow control, a fast sender can overwhelm a slow receiver:

```
Server A: sends 1000 msgs/sec to Server B
Server B: can only inject 10 msgs/sec (agents busy)
Server B: queue grows → memory exhaustion → OOM crash
```

### 15.2 Credit-Based Flow Control

Each peer connection has a credit window:

```typescript
interface FlowControl {
  // Sender side
  credits: number;          // How many messages we can send
  pendingAcks: Map<string, Envelope>;  // Messages awaiting ACK

  // Receiver side
  windowSize: number;       // Max messages before ACK required
  received: number;         // Messages received since last ACK
}

// Sender checks credits before sending
function canSend(): boolean {
  return this.credits > 0;
}

function send(envelope: Envelope): boolean {
  if (!this.canSend()) {
    this.queue.push(envelope);  // Queue locally
    return false;
  }

  this.credits--;
  this.pendingAcks.set(envelope.id, envelope);
  this.peer.send(envelope);
  return true;
}

// Receiver sends PEER_ACK to replenish credits
function onReceive(envelope: Envelope): void {
  this.received++;

  if (this.received >= this.windowSize / 2) {
    this.peer.send({
      type: 'PEER_ACK',
      payload: { credits: this.received }
    });
    this.received = 0;
  }
}

// Sender receives ACK, replenishes credits
function onAck(ack: PeerAckPayload): void {
  this.credits += ack.credits;
  this.flushQueue();  // Send queued messages
}
```

### 15.3 Backpressure Signals

When a receiver is overwhelmed, it sends PEER_BUSY:

```typescript
type PeerMessageType =
  // ... existing types
  | 'PEER_ACK'    // Replenish sender credits
  | 'PEER_BUSY'   // Receiver overwhelmed, stop sending
  | 'PEER_READY'; // Receiver recovered, resume

interface PeerBusyPayload {
  reason: 'queue_full' | 'agent_busy' | 'rate_limited';
  retry_after_ms?: number;  // Suggested wait time
}
```

### 9.4 Rate Limiting

Per-peer and fleet-wide rate limits:

```typescript
interface RateLimiter {
  // Token bucket algorithm
  tokens: number;
  maxTokens: number;
  refillRate: number;  // tokens per second

  tryConsume(count: number): boolean {
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }
}

// Applied at multiple levels
const limits = {
  perPeer: new RateLimiter({ maxTokens: 100, refillRate: 50 }),     // 50/sec per peer
  perAgent: new RateLimiter({ maxTokens: 20, refillRate: 10 }),     // 10/sec per agent
  fleetWide: new RateLimiter({ maxTokens: 1000, refillRate: 200 }), // 200/sec total
};
```

### 9.5 Bounded Queues

Queues have maximum sizes with drop policies:

```typescript
interface BoundedQueue<T> {
  maxSize: number;
  dropPolicy: 'oldest' | 'newest' | 'reject';

  push(item: T): boolean {
    if (this.items.length >= this.maxSize) {
      switch (this.dropPolicy) {
        case 'oldest':
          this.items.shift();  // Drop oldest
          break;
        case 'newest':
          return false;        // Reject new item
        case 'reject':
          throw new QueueFullError();
      }
    }
    this.items.push(item);
    return true;
  }
}
```

### 9.6 Configuration

```yaml
federation:
  flow_control:
    window_size: 100          # Messages before ACK required
    max_queue_size: 1000      # Max queued messages per peer
    queue_drop_policy: oldest # oldest | newest | reject

  rate_limits:
    per_peer_per_second: 50
    per_agent_per_second: 10
    fleet_wide_per_second: 200
```

---

## 10. Failure Handling & Resilience

### 13.1 Connection Failures

```
┌─────────────────────────────────────────────────────────────────┐
│                    CONNECTION FAILURE HANDLING                   │
│                                                                  │
│  Peer disconnects                                                │
│       │                                                          │
│       ▼                                                          │
│  Mark peer as DISCONNECTED                                       │
│       │                                                          │
│       ├──► Queue outbound messages                               │
│       │                                                          │
│       ├──► Start reconnection timer                              │
│       │    (exponential backoff: 1s, 2s, 4s, ... 30s max)       │
│       │                                                          │
│       └──► Notify local agents (optional)                        │
│            "@relay:* [SYSTEM] Lost connection to server-b"       │
│                                                                  │
│  On reconnect:                                                   │
│       │                                                          │
│       ├──► Re-authenticate (PEER_HELLO/WELCOME)                 │
│       │                                                          │
│       ├──► Sync registries (PEER_SYNC full_sync)                │
│       │                                                          │
│       └──► Flush queued messages                                 │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 13.2 Split Brain Prevention

If the fleet gets partitioned:

1. **Agents remain addressable** within their partition
2. **Cross-partition messages queue** until healed
3. **No automatic conflict resolution** - messages deliver in order received
4. **TTL expiration** - queued messages expire after 1 hour (configurable)

### 13.3 Graceful Degradation

```
Fleet healthy:     A ◄──► B ◄──► C    (full connectivity)

B goes down:       A ◄─X─► B ◄─X─► C
                   A ◄──────────────► C  (A-C still works)

B comes back:      A ◄──► B ◄──► C    (queued messages flush)
```

### 10.4 Health Monitoring

```typescript
// Heartbeat every 30 seconds
setInterval(() => {
  for (const peer of this.peers.values()) {
    if (peer.state === 'ACTIVE') {
      peer.send({ type: 'PEER_PING', ts: Date.now() });

      // If no PONG in 60s, consider dead
      peer.setTimeout(() => {
        if (!peer.lastPong || Date.now() - peer.lastPong > 60000) {
          peer.reconnect();
        }
      }, 60000);
    }
  }
}, 30000);
```

---

## 11. Transport Abstraction (NATS Option) *(NEW)*

### 14.1 Motivation

The custom WebSocket protocol works for simple deployments, but production fleets may benefit from battle-tested message infrastructure. NATS JetStream provides:

- ✅ Persistent message queues (survive restarts)
- ✅ Exactly-once delivery semantics
- ✅ Built-in clustering and HA
- ✅ Backpressure and flow control
- ✅ Rich observability (metrics, tracing)
- ✅ Years of production hardening

**Trade-off:** External dependency vs. implementation effort.

### 14.2 Transport Interface

Abstract the transport layer so implementations are swappable:

```typescript
interface PeerTransport {
  // Lifecycle
  connect(config: TransportConfig): Promise<void>;
  disconnect(): Promise<void>;

  // Messaging
  send(serverId: string, envelope: PeerEnvelope): Promise<void>;
  broadcast(envelope: PeerEnvelope): Promise<void>;
  subscribe(handler: (from: string, envelope: PeerEnvelope) => void): void;

  // Discovery
  getConnectedPeers(): string[];
  onPeerJoin(handler: (serverId: string) => void): void;
  onPeerLeave(handler: (serverId: string) => void): void;
}
```

### 14.3 WebSocket Implementation (Default)

```typescript
class WebSocketTransport implements PeerTransport {
  private connections: Map<string, WebSocket>;

  async connect(config: TransportConfig): Promise<void> {
    for (const peer of config.peers) {
      const ws = new WebSocket(peer.url);
      // ... handshake, auth
      this.connections.set(peer.serverId, ws);
    }
  }

  async send(serverId: string, envelope: PeerEnvelope): Promise<void> {
    const ws = this.connections.get(serverId);
    ws?.send(JSON.stringify(envelope));
  }

  // ... rest of implementation
}
```

### 11.4 NATS Implementation (Optional)

```typescript
class NatsTransport implements PeerTransport {
  private nc: NatsConnection;
  private js: JetStreamClient;

  async connect(config: TransportConfig): Promise<void> {
    this.nc = await connect({ servers: config.natsUrl });
    this.js = this.nc.jetstream();

    // Create stream for fleet messages
    await this.js.streams.add({
      name: 'RELAY_FLEET',
      subjects: ['relay.>'],
      retention: RetentionPolicy.Limits,
      max_age: 3600 * 1e9, // 1 hour
    });
  }

  async send(serverId: string, envelope: PeerEnvelope): Promise<void> {
    // Publish to server-specific subject
    await this.js.publish(`relay.server.${serverId}`, encode(envelope));
  }

  async broadcast(envelope: PeerEnvelope): Promise<void> {
    // Publish to broadcast subject
    await this.js.publish('relay.broadcast', encode(envelope));
  }

  subscribe(handler: (from: string, envelope: PeerEnvelope) => void): void {
    // Subscribe to our server subject + broadcast
    const sub = this.nc.subscribe(`relay.server.${this.serverId}`);
    const broadcastSub = this.nc.subscribe('relay.broadcast');

    (async () => {
      for await (const msg of sub) {
        const envelope = decode(msg.data);
        handler(envelope.from_server, envelope);
      }
    })();
  }
}
```

### 11.5 Configuration

```yaml
federation:
  # Transport selection
  transport: websocket  # websocket | nats

  # WebSocket config (if transport: websocket)
  websocket:
    peers:
      - url: wss://london.example.com:8765
        server_id: london

  # NATS config (if transport: nats)
  nats:
    url: nats://nats.example.com:4222
    credentials: /etc/agent-relay/nats.creds
    stream_name: RELAY_FLEET
```

### 11.6 When to Use Which

| Scenario | Recommended Transport | Rationale |
|----------|----------------------|-----------|
| 2-5 servers, simple setup | WebSocket | No external deps |
| Development/testing | WebSocket | Easy to run locally |
| 10+ servers | NATS | Better scaling |
| High reliability required | NATS | Persistence, HA |
| Already have NATS | NATS | Leverage existing |
| Air-gapped/restricted | WebSocket | No external deps |

### 11.7 Migration Path

Start with WebSocket, migrate to NATS when needed:

1. Deploy NATS cluster
2. Update config: `transport: nats`
3. Restart daemons (one at a time)
4. Messages route through NATS immediately

No changes to agents or injection logic.

---

## 12. Configuration

### 15.1 Configuration File

```yaml
# /etc/agent-relay/config.yaml (or ~/.agent-relay/config.yaml)

# Server identity
server:
  id: nyc-prod-01                    # Unique server ID
  name: "NYC Production 01"          # Human-readable name

# Local daemon settings (unchanged from current)
local:
  socket_path: /tmp/agent-relay/relay.sock
  storage_path: /tmp/agent-relay/messages.sqlite

# Federation settings (NEW)
federation:
  enabled: true

  # Listen for peer connections
  listen:
    host: 0.0.0.0
    port: 8765

  # TLS configuration
  tls:
    enabled: true
    cert: /etc/agent-relay/server.pem
    key: /etc/agent-relay/server-key.pem
    ca: /etc/agent-relay/ca.pem       # For client verification
    mutual: false                      # Require client certs

  # Authentication
  auth:
    # This server's token (peers use this to connect to us)
    server_token: "${RELAY_SERVER_TOKEN}"

    # Tokens for connecting to peers
    peer_tokens:
      london-prod-01: "${RELAY_TOKEN_LONDON}"
      tokyo-prod-01: "${RELAY_TOKEN_TOKYO}"

  # Peer connections
  peers:
    - url: wss://london.example.com:8765
      server_id: london-prod-01
      auto_connect: true

    - url: wss://tokyo.example.com:8765
      server_id: tokyo-prod-01
      auto_connect: true

  # Optional hub for discovery
  hub:
    url: wss://hub.example.com:8765
    token: "${RELAY_HUB_TOKEN}"
    enabled: false                    # Hub is optional

  # Behavior settings
  settings:
    heartbeat_interval_ms: 30000      # Ping peers every 30s
    reconnect_max_delay_ms: 30000     # Max backoff delay
    message_queue_ttl_ms: 3600000     # 1 hour queue TTL
    sync_interval_ms: 60000           # Full registry sync
    max_message_size_bytes: 1048576   # 1 MiB

# Dashboard settings
dashboard:
  enabled: true
  port: 3888
  show_fleet: true                    # Show all fleet agents
```

### 15.2 Environment Variables

All config can be overridden via environment:

```bash
# Server identity
AGENT_RELAY_SERVER_ID=nyc-prod-01
AGENT_RELAY_SERVER_NAME="NYC Production 01"

# Federation
AGENT_RELAY_FEDERATION_ENABLED=true
AGENT_RELAY_FEDERATION_PORT=8765
AGENT_RELAY_SERVER_TOKEN=secret-token
AGENT_RELAY_PEER_london-prod-01_TOKEN=london-token
AGENT_RELAY_PEER_london-prod-01_URL=wss://london.example.com:8765
```

### 15.3 Minimal Configuration

For simple two-server setup:

```yaml
# Server A (nyc)
server:
  id: nyc
federation:
  enabled: true
  listen:
    port: 8765
  auth:
    server_token: "shared-secret"
  peers:
    - url: wss://london.example.com:8765
      server_id: london
```

```yaml
# Server B (london)
server:
  id: london
federation:
  enabled: true
  listen:
    port: 8765
  auth:
    server_token: "shared-secret"
  peers:
    - url: wss://nyc.example.com:8765
      server_id: nyc
```

---

## 13. CLI Interface

### 13.1 New Commands

```bash
# Start daemon with federation
agent-relay up [--peer-port 8765] [--config /path/to/config.yaml]

# Peer management
agent-relay peer list                           # List connected peers
agent-relay peer add <url> [--token <token>]    # Add peer dynamically
agent-relay peer remove <server-id>             # Remove peer
agent-relay peer status <server-id>             # Detailed peer status

# Fleet-wide agent listing
agent-relay agents                     # Local agents only (default)
agent-relay agents --fleet             # All agents in fleet
agent-relay agents --server <id>       # Agents on specific server

# Send to remote agent
agent-relay send <agent>[@<server>] <message>

# Fleet status
agent-relay fleet status               # Overview of all servers
agent-relay fleet topology             # Show connection graph

# Debugging
agent-relay fleet ping <server-id>     # Ping a peer
agent-relay fleet trace <agent>        # Trace route to agent
```

### 13.2 Example Session

```bash
# On Server NYC
$ agent-relay up --peer-port 8765
Daemon started (federation enabled)
Listening for peers on :8765
Connecting to peer: london.example.com:8765...
Connected to london (3 agents)
Connecting to peer: tokyo.example.com:8765...
Connected to tokyo (2 agents)

$ agent-relay agents --fleet
AGENT         SERVER    CLI      STATUS    CONNECTED
Alice         nyc       claude   online    2 min ago
Bob           nyc       codex    online    5 min ago
Carol         london    claude   online    1 min ago
Dave          london    gemini   idle      10 min ago
Eve           tokyo     claude   online    3 min ago

$ agent-relay fleet status
SERVER    STATUS       AGENTS    LATENCY    LAST SEEN
nyc       local        2         -          -
london    connected    2         45ms       just now
tokyo     connected    1         120ms      2s ago

# Start an agent that can message across servers
$ agent-relay -n Alice claude

# Inside Claude session:
# Alice> @relay:Carol Can you help with the auth module?
# [relay:Alice] → Carol@london: Can you help with the auth module?

# Carol (on london server) automatically receives:
# "Relay message from Alice@nyc [abc123]: Can you help with the auth module?"
```

### 13.3 Addressing Examples

```bash
# From Alice on NYC server:

@relay:Bob hello                    # Bob is local (NYC) → local delivery
@relay:Carol hello                  # Carol is on london → routes to london
@relay:Carol@london hello           # Explicit: route to Carol on london
@relay:Eve@tokyo hello              # Explicit: route to Eve on tokyo
@relay:* Status update              # Broadcast to ALL agents in fleet
@relay:*@local Status update        # Broadcast only to NYC agents
@relay:*@london Status update       # Broadcast to all london agents
```

---

## 14. Implementation Plan

### 14.1 Phases

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 1: Foundation (1 week)                                                 │
│                                                                              │
│ • Define peer protocol types (src/protocol/peer-types.ts)                   │
│ • Implement PeerConnection class (src/federation/peer-connection.ts)        │
│ • Implement basic HELLO/WELCOME handshake                                   │
│ • Add peer WebSocket listener to daemon                                     │
│ • Unit tests for protocol                                                   │
│                                                                              │
│ Deliverable: Two daemons can connect and handshake                          │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 2: Registry & Discovery (1 week)                                       │
│                                                                              │
│ • Implement FleetRegistry (src/federation/registry.ts)                      │
│ • Implement PEER_SYNC message handling                                      │
│ • Add registry to Router for lookups                                        │
│ • Implement name resolution (local → fleet)                                 │
│ • CLI: `agent-relay agents --fleet`                                         │
│                                                                              │
│ Deliverable: Agents visible across servers                                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 3: Message Routing (1 week)                                            │
│                                                                              │
│ • Implement PEER_ROUTE handling                                             │
│ • Implement PEER_BROADCAST handling                                         │
│ • Integrate with existing Router                                            │
│ • Cross-server message delivery                                             │
│ • Local tmux injection on receipt (existing code!)                          │
│                                                                              │
│ Deliverable: Alice@NYC can message Bob@London automatically                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 4: Resilience (1 week)                                                 │
│                                                                              │
│ • Implement reconnection logic                                              │
│ • Implement message queue for disconnected peers                            │
│ • Implement heartbeat (PING/PONG)                                           │
│ • Handle graceful shutdown (PEER_BYE)                                       │
│ • CLI: `agent-relay peer status`                                            │
│                                                                              │
│ Deliverable: Fleet survives server restarts                                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 5: Security & Polish (1 week)                                          │
│                                                                              │
│ • Add TLS support for peer connections                                      │
│ • Add token-based authentication                                            │
│ • Add configuration file support                                            │
│ • Update dashboard for fleet view                                           │
│ • Documentation                                                             │
│                                                                              │
│ Deliverable: Production-ready federation                                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 14.2 File Structure

```
src/
├── federation/                    # NEW: Federation module
│   ├── index.ts                   # Exports
│   ├── peer-connection.ts         # WebSocket connection to peer
│   ├── peer-manager.ts            # Manages all peer connections
│   ├── peer-server.ts             # WebSocket server for incoming
│   ├── registry.ts                # Fleet-wide agent registry
│   ├── message-queue.ts           # Queue for disconnected peers
│   └── config.ts                  # Federation configuration
│
├── protocol/
│   ├── types.ts                   # Existing types
│   └── peer-types.ts              # NEW: Peer protocol types
│
├── daemon/
│   ├── server.ts                  # Modified: integrate federation
│   ├── router.ts                  # Modified: federated routing
│   └── ...
│
└── cli/
    └── index.ts                   # Modified: new commands
```

### 14.3 Estimated Effort (Revised)

**Original estimate was too optimistic.** Distributed systems are hard. Realistic timeline:

| Phase | Optimistic | Realistic | Notes |
|-------|------------|-----------|-------|
| Phase 1: Foundation | 1 week | 1.5-2 weeks | WebSocket edge cases |
| Phase 2: Registry | 1 week | 2 weeks | Consistency is hard |
| Phase 3: Routing | 1 week | 1.5 weeks | Broadcast complexity |
| Phase 4: Resilience | 1 week | 2-3 weeks | Reconnection, testing |
| Phase 5: Security | 1 week | 2 weeks | TLS setup, key mgmt |
| Phase 6: Stabilization | - | 2 weeks | Bug fixes, edge cases |
| **Total** | 4-5 weeks | **8-10 weeks** | |

### 14.4 MVP Option

To ship faster, consider a reduced-scope MVP:

**MVP Scope (4 weeks):**
- Static peer list only (no hub)
- No TLS (rely on VPN/private network)
- Single fleet token (not per-pair)
- Require unique names (no conflict resolution)
- Memory-only queues (no persistence)
- No message priorities

**Post-MVP (add incrementally):**
- TLS + asymmetric key auth
- Hub for discovery
- Queue persistence
- Delivery confirmation
- NATS transport option
- Observability

---

## 15. Migration Path

### 15.1 Backward Compatibility

Existing single-server deployments work without changes:

```yaml
# No federation block = single-server mode (current behavior)
local:
  socket_path: /tmp/agent-relay/relay.sock
```

### 15.2 Upgrade Path

1. **Update agent-relay** to federation-capable version
2. **Add federation config** to enable cross-server
3. **Start daemons** - they auto-connect to peers
4. **Agents just work** - no changes needed

### 15.3 Rollback

If issues arise:
1. Set `federation.enabled: false`
2. Restart daemon
3. Back to single-server mode

---

## Summary

This proposal extends agent-relay to support federated multi-server deployments while **preserving the core differentiator**: automatic message injection via tmux.

**Key points:**

1. **Injection stays local** - Each server runs tmux sessions, does local send-keys
2. **Routing goes network** - Daemons connect via WebSocket for cross-server
3. **Progressive enhancement** - Single-server still works, federation is opt-in
4. **Simple operations** - Static peer config works, hub optional
5. **Resilient** - Reconnection, message queuing, graceful degradation

**What we preserve:**
- Zero-config agent integration (@relay: pattern)
- Automatic message delivery (no polling)
- Low latency (<5ms local, +network RTT remote)
- Simple mental model

**What we add:**
- Cross-server messaging
- Fleet-wide agent discovery
- Peer-to-peer daemon connections
- Message queuing for resilience

---

## 16. Open Questions *(NEW)*

These questions remain unresolved and need input before/during implementation:

### Architecture

1. **Hub vs. Mesh for MVP?**
   - Hub is simpler but single point of failure
   - Mesh is resilient but more complex
   - Recommendation: Start with mesh (static peers), add hub later

2. **Queue persistence?**
   - Memory-only: Simple, but loses messages on crash
   - SQLite: Survives restarts, but adds complexity
   - Recommendation: Memory for MVP, SQLite for v2

3. **NATS priority?**
   - Implement WebSocket first, NATS later?
   - Or start with NATS to avoid reimplementing?
   - Recommendation: WebSocket MVP, NATS for production scale

### Protocol

4. **Message ordering guarantees?**
   - Per-agent FIFO? Global ordering? Best-effort?
   - Strict ordering adds latency and complexity
   - Recommendation: Document best-effort, no guarantees

5. **Broadcast scalability?**
   - O(n) messages for n agents - acceptable?
   - Need gossip-style fan-out for large fleets?
   - Recommendation: Direct broadcast for <50 agents, revisit at scale

### Security

6. **Key distribution method?**
   - Static config, TOFU, or CA?
   - Trade-off: security vs. operational simplicity
   - Recommendation: TOFU with approval for dev, CA for enterprise

7. **mTLS required?**
   - Adds complexity but strong authentication
   - Alternative: TLS + Ed25519 challenge-response
   - Recommendation: TLS + challenge-response for MVP

### Operations

8. **Testing strategy?**
   - How to test multi-server locally?
   - Need chaos testing framework?
   - Recommendation: Docker Compose for integration tests

9. **Observability from day one?**
   - Add Prometheus metrics in MVP?
   - Or defer to post-MVP?
   - Recommendation: Basic metrics (connections, messages) in MVP

10. **NAT traversal?**
    - Support servers behind NAT?
    - Requires connection reversal or TURN relay
    - Recommendation: Document requirement for direct connectivity, defer NAT to v2

---

## 17. Storage Architecture *(NEW)*

Federation introduces storage requirements for **ephemeral message routing**. Durable storage for trajectories and work history is handled by the separate [agent-trajectories](https://github.com/khaliqgant/agent-trajectories) project.

### 17.1 Separation of Concerns

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         STORAGE RESPONSIBILITY                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────┐      ┌─────────────────────────────────────┐  │
│  │   agent-relay           │      │   agent-trajectories                 │  │
│  │   (This Project)        │      │   (Separate Project)                 │  │
│  │                         │      │                                      │  │
│  │  EPHEMERAL STORAGE      │      │  DURABLE STORAGE                    │  │
│  │  • Peer message queues  │      │  • Agent work history               │  │
│  │  • Pending ACKs         │      │  • Decisions & retrospectives       │  │
│  │  • Flow control credits │      │  • Knowledge workspace              │  │
│  │  • Connection state     │      │  • Exported artifacts               │  │
│  │  • Registry cache       │      │  • Semantic search / RAG            │  │
│  │                         │      │                                      │  │
│  │  Lifetime: minutes/hours│      │  Lifetime: months/years             │  │
│  │  Backend: Memory, NATS  │      │  Backend: File, SQLite, PG, S3      │  │
│  └─────────────────────────┘      └─────────────────────────────────────┘  │
│                                                                              │
│  Integration: agent-relay emits events → agent-trajectories captures them   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

> **See:** [agent-trajectories](https://github.com/khaliqgant/agent-trajectories) for trajectory format, storage backends, and knowledge workspace.
>
> **Memory Layer:** agent-trajectories uses [Mem0](https://github.com/mem0ai/mem0) as the memory substrate. See [MEMORY_STACK_DECISION.md](./MEMORY_STACK_DECISION.md) for rationale.

### 17.2 Ephemeral Storage (Message Routing)

For federation's real-time message routing, **memory is the default**. Messages are transient—they matter for delivery, not history.

#### In-Memory Queues (Default)

```typescript
class EphemeralStore {
  // Per-peer outbound queues (for disconnected peers)
  peerQueues: Map<string, BoundedQueue<PeerEnvelope>>;

  // Pending delivery confirmations
  pendingAcks: Map<string, { envelope: Envelope; sentAt: number }>;

  // Flow control state
  peerCredits: Map<string, number>;

  // Configuration
  config: {
    maxQueueSize: 1000;           // Bounded to prevent OOM
    ackTimeoutMs: 30000;          // Expire pending ACKs after 30s
    queueTtlMs: 3600000;          // Drop queued messages after 1 hour
  };
}
```

**Properties:**
- ✅ Fast (no I/O)
- ✅ Simple (no external deps)
- ❌ Lost on daemon restart
- ❌ Limited by available memory

**When this is fine:**
- Most messages deliver immediately
- Disconnections are brief (seconds to minutes)
- Acceptable to lose queued messages on crash

#### NATS JetStream (Optional Upgrade)

When using NATS transport (Section 11), streams provide ephemeral persistence:

```typescript
// NATS stream for routing messages
const routingStream = {
  name: 'RELAY_ROUTING',
  subjects: ['relay.route.*', 'relay.broadcast'],
  retention: RetentionPolicy.Limits,
  max_age: 3600 * 1e9,           // 1 hour retention
  max_bytes: 100 * 1024 * 1024,  // 100 MB max
  discard: DiscardPolicy.Old,    // Drop oldest on limit
};
```

**Properties:**
- ✅ Survives daemon restarts
- ✅ Shared across peers (no per-peer queuing)
- ✅ Built-in flow control and backpressure
- ❌ External dependency
- ❌ Additional operational complexity

**When to use NATS:**
- High message volume
- Long disconnection tolerance needed
- Already have NATS infrastructure

### 17.3 Integration with agent-trajectories

agent-relay emits events that [agent-trajectories](https://github.com/khaliqgant/agent-trajectories) can capture:

```typescript
// agent-relay daemon emits events
interface RelayEvent {
  type: 'message_sent' | 'message_received' | 'broadcast';
  from: string;
  to: string;
  content: string;
  ts: number;
  messageId: string;
}

// Event emitter in daemon
this.events.emit('relay:message', {
  type: 'message_sent',
  from: 'Alice',
  to: 'Bob',
  content: 'Can you review auth.ts?',
  ts: Date.now(),
  messageId: 'msg-abc123'
});
```

agent-trajectories subscribes to these events and incorporates them into task trajectories as inter-agent communication records.

### 17.4 Storage Configuration

```yaml
# /etc/agent-relay/config.yaml

storage:
  # Ephemeral (routing) - managed by agent-relay
  ephemeral:
    type: memory                   # memory | nats
    max_queue_per_peer: 1000
    queue_ttl_ms: 3600000

    # If using NATS
    nats:
      stream: RELAY_ROUTING
      max_age_seconds: 3600
      max_bytes: 104857600         # 100 MB

  # Event emission for agent-trajectories integration
  events:
    enabled: true
    emit_to: 'unix:///tmp/agent-trajectories/events.sock'
```

### 17.5 Federation Impact on Storage

When federation is enabled:

| Concern | Single Server | Federated Fleet |
|---------|---------------|-----------------|
| **Routing queues** | Per-agent | Per-peer + per-agent |
| **Registry** | Local only | Fleet-wide sync |
| **Event emission** | Optional | Recommended (for trajectories) |

**Recommendations:**

1. **Routing:** Use NATS if available, otherwise memory with bounded queues
2. **Registry:** Memory + periodic persistence (survive restarts)
3. **Events:** Enable emission to agent-trajectories for cross-agent history

---

## Summary (v2)

This revised proposal addresses the critical issues identified in review:

| Issue | Resolution |
|-------|------------|
| No end-to-end ACK | Added delivery confirmation (Section 7) |
| Registry split-brain | Fleet-wide unique names + quorum (Section 5.3) |
| Token scaling | Asymmetric keys (Section 8.1) |
| No backpressure | Credit-based flow control (Section 9) |
| Timeline unrealistic | Revised to 8-10 weeks (Section 14.3) |
| NATS consideration | Pluggable transport layer (Section 11) |
| Trajectory storage | Delegated to [agent-trajectories](https://github.com/khaliqgant/agent-trajectories) (Section 17) |

**Key additions in v2:**
- End-to-end delivery confirmation
- Fleet-wide unique name enforcement
- Ed25519 authentication (scales better)
- Credit-based flow control + rate limiting
- Transport abstraction for NATS option
- Ephemeral storage for routing, events emitted to agent-trajectories
- Realistic timeline with MVP option
- Open questions for discussion

---

## Next Steps

1. Review v2 proposal, discuss open questions
2. Decide on MVP scope
3. Create implementation tasks in Beads
4. Begin Phase 1: Foundation
