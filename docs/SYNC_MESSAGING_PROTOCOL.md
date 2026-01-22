# Synchronous Messaging Protocol Design

## Problem Statement

In multi-agent coordination scenarios (e.g., card games, workflows, pipelines), messages arrive **out of order** or **after the coordinator has moved on**. The current fire-and-forget messaging model is insufficient for turn-based or request-response patterns.

### Observed Failure (Hearts Game Demo)

```
Timeline:
  t=0:    Coordinator sends hands to 4 players
  t=10s:  Coordinator announces game complete, releases agents
  t=12s:  Late ACK arrives from North: "I play 3C"
  t=14s:  Late ACK arrives from East: "I play 6C"
  t=15s:  Late ACK arrives from South: "I play 9C"
```

**Root causes:**
1. 4 agents sending simultaneously → queue backlog
2. Each response waits for idle detection before injection
3. No synchronization barrier - coordinator proceeds without confirmation
4. Fire-and-forget semantics - no delivery guarantee

## Current Protocol State

The protocol already has foundations that are **defined but not implemented**:

```typescript
// protocol/types.ts - EXISTS
export interface SendMeta {
  requires_ack?: boolean;  // ← Not processed by daemon
  ttl_ms?: number;         // ← Not processed by daemon
  importance?: number;     // 0-100, used for display only
  replyTo?: string;        // Correlation ID - not used for blocking
}

// Message types - EXIST but unused for sync
type MessageType = 'ACK' | 'NACK' | ...;

export interface AckPayload {
  ack_id: string;
  seq: number;
  // ...
}
```

**Gap:** `daemon/connection.ts` `handleSend()` doesn't process `requires_ack`. ACKs are received but not correlated to pending requests.

## Proposed Solution: Request-Response Messaging

### 1. Protocol Extensions

```typescript
// Extended SendMeta
export interface SendMeta {
  requires_ack?: boolean;
  ttl_ms?: number;
  importance?: number;
  replyTo?: string;

  // NEW: Synchronization fields
  sync?: {
    /** Unique correlation ID for this request */
    correlationId: string;
    /** Timeout for response (ms, default: 30000) */
    timeoutMs?: number;
    /** Whether sender should block until ACK (default: false) */
    blocking?: boolean;
  };
}

// Extended AckPayload
export interface AckPayload {
  ack_id: string;
  seq: number;

  // NEW: Response correlation
  correlationId?: string;
  /** Optional response body (for request-response pattern) */
  response?: string;
  /** Optional structured response data */
  responseData?: Record<string, unknown>;
}
```

### 2. Daemon Changes

```typescript
// daemon/server.ts - New tracking structure
interface PendingAck {
  correlationId: string;
  from: string;
  to: string;
  sentAt: number;
  timeoutMs: number;
  resolve: (ack: AckPayload) => void;
  reject: (error: Error) => void;
}

class RelayServer {
  private pendingAcks: Map<string, PendingAck> = new Map();

  // When SEND has sync.blocking = true
  async handleBlockingSend(envelope: SendEnvelope): Promise<AckPayload> {
    const { correlationId, timeoutMs } = envelope.payload_meta?.sync ?? {};

    return new Promise((resolve, reject) => {
      // Track pending ACK
      this.pendingAcks.set(correlationId, {
        correlationId,
        from: envelope.from,
        to: envelope.to,
        sentAt: Date.now(),
        timeoutMs: timeoutMs ?? 30000,
        resolve,
        reject,
      });

      // Route the message
      this.routeMessage(envelope);

      // Start timeout
      setTimeout(() => {
        if (this.pendingAcks.has(correlationId)) {
          this.pendingAcks.delete(correlationId);
          reject(new Error(`ACK timeout for ${correlationId}`));
        }
      }, timeoutMs ?? 30000);
    });
  }

  // When ACK is received
  handleAck(envelope: AckEnvelope): void {
    const { correlationId } = envelope.payload;
    const pending = this.pendingAcks.get(correlationId);

    if (pending) {
      this.pendingAcks.delete(correlationId);
      pending.resolve(envelope.payload);
    }
  }
}
```

### 3. Wrapper Changes

```typescript
// wrapper/client.ts - New sync method
class RelayClient {
  /**
   * Send message and wait for ACK (blocking)
   */
  async sendAndWait(
    to: string,
    body: string,
    options?: { timeoutMs?: number }
  ): Promise<AckPayload> {
    const correlationId = crypto.randomUUID();

    this.sendMessage(to, body, 'message', undefined, undefined, {
      sync: {
        correlationId,
        blocking: true,
        timeoutMs: options?.timeoutMs ?? 30000,
      },
    });

    return this.waitForAck(correlationId, options?.timeoutMs);
  }

  /**
   * Send to multiple recipients and wait for all ACKs
   */
  async broadcastAndWait(
    recipients: string[],
    body: string,
    options?: { timeoutMs?: number }
  ): Promise<Map<string, AckPayload>> {
    const promises = recipients.map(to =>
      this.sendAndWait(to, body, options)
        .then(ack => [to, ack] as const)
    );

    const results = await Promise.all(promises);
    return new Map(results);
  }
}
```

### 4. Agent-Side ACK Generation

Agents need to send ACKs when they receive messages with `requires_ack`. This can happen:

**Option A: Automatic (wrapper handles it)**
```typescript
// wrapper/base-wrapper.ts
protected handleIncomingMessage(from, payload, messageId, meta) {
  // Auto-ACK if required
  if (meta?.sync?.correlationId) {
    this.client.sendAck(from, meta.sync.correlationId);
  }

  // Then process normally
  this.messageQueue.push(...);
}
```

**Option B: Explicit (agent decides when to ACK)**
```
Agent output: ->relay:Dashboard ACK:correlation-123 I received and processed your message
```

**Recommendation:** Start with Option A (automatic) for simplicity. Add Option B later for cases where agent needs to indicate "I've not just received, but completed processing."

## Agent Syntax (File-Based)

Agents choose blocking vs fire-and-forget via the AWAIT header:

### Fire-and-Forget (Default)
```bash
cat > ~/.agent-relay/outbox/$AGENT_RELAY_NAME/msg << 'EOF'
TO: Target

Hello, this is a normal message
EOF
```
Then: `->relay-file:msg`

Message sent, agent continues immediately. Current behavior.

### Blocking/Await
```bash
cat > ~/.agent-relay/outbox/$AGENT_RELAY_NAME/turn << 'EOF'
TO: Target
AWAIT: 30s

Your turn. Play a card.
EOF
```
Then: `->relay-file:turn`

Agent's wrapper blocks until response received or timeout. Response injected back to agent.

### Responding to Awaited Messages
When an agent receives a message that requires response:
```
Relay message from Coordinator [abc123] [awaiting]: Your turn. Play a card.
```

The `[awaiting]` tag tells the agent they should respond. Agent responds normally:
```bash
cat > ~/.agent-relay/outbox/$AGENT_RELAY_NAME/reply << 'EOF'
TO: Coordinator

I play 3C
EOF
```
Then: `->relay-file:reply`

The system correlates by thread/conversation context.

## Usage Patterns

### Pattern 1: Turn-Based Game (Blocking)

```bash
# Coordinator writes blocking request
cat > ~/.agent-relay/outbox/$AGENT_RELAY_NAME/turn << 'EOF'
TO: North
AWAIT: 60s

Your turn. Play a card.
EOF
```
Then: `->relay-file:turn`

North receives:
```
Relay message from Coordinator [abc123] [awaiting]: Your turn. Play a card.
```

North responds:
```bash
cat > ~/.agent-relay/outbox/$AGENT_RELAY_NAME/play << 'EOF'
TO: Coordinator

I play 3C
EOF
```
Then: `->relay-file:play`

Coordinator receives response, then continues to East.

### Pattern 2: Fanout with Barrier (Blocking)

```bash
# Send all hands, wait for all ACKs
# (Each written to separate files, triggers sent in sequence)
cat > ~/.agent-relay/outbox/$AGENT_RELAY_NAME/north << 'EOF'
TO: North
AWAIT: 60s

Your hand: 3C, 5H, 9D
EOF
```
Then: `->relay-file:north` (repeat for East, South, West)

All must ACK before coordinator continues.

### Pattern 3: Fire-and-Forget Broadcast

```bash
cat > ~/.agent-relay/outbox/$AGENT_RELAY_NAME/announce << 'EOF'
TO: *

Game starting in 30 seconds!
EOF
```
Then: `->relay-file:announce`

### Pattern 4: Mixed Mode

```bash
# Fire-and-forget status update
cat > ~/.agent-relay/outbox/$AGENT_RELAY_NAME/status << 'EOF'
TO: Dashboard

STATUS: Starting round 3
EOF
```
Then: `->relay-file:status`

```bash
# Blocking turn request
cat > ~/.agent-relay/outbox/$AGENT_RELAY_NAME/turn << 'EOF'
TO: North
AWAIT: 60s

Your turn
EOF
```
Then: `->relay-file:turn`

## Client API

```typescript
// Fire-and-forget (default)
relay.send('Target', 'Hello');

// Blocking with await
const response = await relay.sendAndWait('Target', 'Your turn', {
  timeoutMs: 60000
});

// Explicit fire-and-forget
relay.send('Target', 'Status update', { blocking: false });

// Broadcast fire-and-forget
relay.broadcast(['A', 'B', 'C'], 'Hello all');

// Broadcast with barrier (wait for all)
const responses = await relay.broadcastAndWait(['A', 'B', 'C'], 'Ready?');
```

## Implementation Phases

### Phase 1: Foundation (P1)
- [ ] Add `sync` fields to SendMeta
- [ ] Add `correlationId` and `response` to AckPayload
- [ ] Implement `pendingAcks` tracking in daemon
- [ ] Wire up ACK correlation in daemon

### Phase 2: Client API (P1)
- [ ] Add `sendAndWait()` to RelayClient
- [ ] Add `broadcastAndWait()` to RelayClient
- [ ] Auto-ACK in wrapper when `correlationId` present

### Phase 3: Agent Syntax (P2)
- [ ] Parse `->relay:Target ACK:correlationId response` format
- [ ] Allow agents to send explicit ACKs with responses

### Phase 4: Timeouts & Retries (P2)
- [ ] Integrate with escalating retry (agent-relay-480)
- [ ] Dead letter queue for timed-out blocking requests
- [ ] Metrics for ACK latency

## Alternatives Considered

### 1. Polling-based synchronization
Agent polls for "your turn" signal. Rejected: agents forget to poll.

### 2. File-based barriers
Write barrier files, wait for agent to create completion file. Rejected: requires filesystem coordination, doesn't scale.

### 3. External orchestrator
Separate process manages turn order. Rejected: adds complexity, single point of failure.

### 4. Eventual consistency
Accept out-of-order delivery, design workflows to be idempotent. Acceptable for some use cases, but doesn't solve the Hearts game problem where order matters.

## References

- `src/protocol/types.ts` - Existing protocol types
- `src/daemon/connection.ts` - Message handling
- `src/daemon/server.ts` - Message routing
- `src/wrapper/client.ts` - Client API
- `docs/RELAY_PTY_IMPROVEMENTS.md` - Related reliability improvements
