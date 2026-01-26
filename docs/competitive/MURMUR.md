# Murmur vs Agent Relay: Protocol Comparison

## Executive Summary

**Murmur** and **Agent Relay** solve fundamentally different problems with different architectural approaches:

- **Murmur**: End-to-end encrypted, offline-first messaging for AI agents across networks using Signal Protocol (X3DH + Double Ratchet)
- **Agent Relay**: Low-latency (<5ms) local IPC messaging between agents in the same workspace via Unix Domain Sockets

**Key Insight**: These are complementary, not competitive. Murmur excels at secure cross-network agent communication; Agent Relay excels at real-time local coordination.

---

## Quick Comparison Table

| Dimension | Murmur | Agent Relay |
|-----------|--------|-------------|
| **Design Goal** | Secure cross-network messaging | Fast local coordination |
| **Latency** | 100-500ms (network + crypto) | <5ms (in-memory) |
| **Transport** | HTTPS REST API + SSE | Unix Domain Socket (UDS) |
| **Scope** | Cross-network, internet-scale | Single machine, local IPC |
| **Encryption** | End-to-end (Signal Protocol) | None (local-only, trusted) |
| **Authentication** | Ed25519 signatures + JWT | Agent name registration |
| **Persistence** | 30-day PostgreSQL | In-memory (optional) |
| **Offline Support** | Yes (store-and-forward) | No (requires daemon running) |
| **Server Role** | Dumb relay (zero-knowledge) | Smart coordinator |
| **Client Complexity** | High (crypto state) | Low (thin wrapper) |
| **Scalability** | Horizontal (stateless) | Vertical (single daemon) |
| **Browser Support** | Yes (SSE) | No (UDS only) |

---

## Detailed Protocol Comparison

### 1. Transport Layer

#### Murmur
- **Transport**: HTTPS REST API for sending, SSE (Server-Sent Events) for receiving
- **Connection**: Stateless HTTP, long-lived SSE for notifications
- **Path**: Internet-accessible server (default: hosted service)
- **Network Scope**: Cross-machine, cross-network, internet-scale
- **Latency**: 100-500ms (network RTT + cryptographic overhead)

#### Agent Relay
- **Transport**: Unix Domain Socket (stream-based)
- **Connection**: Stateful bidirectional stream per agent
- **Path**: `/tmp/agent-relay.sock` (local only)
- **Network Scope**: Single machine IPC
- **Latency**: <5ms (in-memory message passing)

**Analysis**: Different layers of the network stack. Murmur operates over the internet; Agent Relay operates within a single OS.

---

### 2. Message Format & Structure

#### Murmur (3-Layer Encryption)

```
Layer 1: Application Payload (plaintext before encryption)
   ↓
Layer 2: Protocol Message (Double Ratchet encrypted)
   ↓
Layer 3: Server Envelope (Ed25519 signed)
```

**Application Payload** (before encryption):
```json
{
  "text": "Hello there",
  "profileSecretKey": "base64url-no-padding",
  "attachments": {
    "report.pdf": {
      "hash": "sha256-hex",
      "iv": "base64",
      "key": "base64"
    }
  }
}
```

**Server Envelope** (what's transmitted):
```json
{
  "messageId": "cuid2-id",
  "recipientId": "base64-identity-key",
  "blob": "base64(encrypted-protocol-message)",
  "signature": "ed25519-signature"
}
```

#### Agent Relay (Single-Layer Envelope)

```json
{
  "v": 1,
  "type": "DELIVER",
  "id": "uuid",
  "ts": 1734440000102,
  "from": "claude-1",
  "to": "codex-1",
  "topic": "chat",
  "payload": {
    "kind": "message",
    "body": "Your turn",
    "data": {}
  },
  "delivery": {
    "seq": 42,
    "session_id": "s-abc123"
  }
}
```

**Complexity Comparison**:
- **Murmur**: ~10x more complex due to cryptographic layers
- **Agent Relay**: Simple JSON envelope, no encryption
- **Throughput**: Agent Relay ~100x faster for local messaging

---

### 3. Security Model

| Feature | Murmur | Agent Relay |
|---------|--------|-------------|
| **Identity** | Ed25519 keypair (cryptographic) | Agent name (string, daemon-enforced) |
| **Confidentiality** | E2E encrypted (server blind) | None (local trust) |
| **Integrity** | Ed25519 signatures on all messages | None currently |
| **Authentication** | Signature verification | Name registration only |
| **Authorization** | Profile key signatures | None (all local agents equal) |
| **Replay Protection** | Timestamp validation (±5min) | None |
| **Message Tampering** | Prevented (cryptographic signatures) | Possible (daemon trusted) |

#### Murmur's Cryptographic Approach
- **Identity**: Permanent Ed25519 keypair
- **Profile Key**: Separate keypair for profile encryption (rotatable)
- **Session Keys**: X3DH key agreement → Double Ratchet
- **Message Signing**: All messages signed with identity key
- **Forward Secrecy**: One-time prekeys
- **Post-Compromise Security**: Ratcheting introduces new entropy

#### Agent Relay's Trust Model
- **Local machine = trusted**: All agents run on same system
- **Daemon = trusted**: Single source of truth for routing
- **All agents = peers**: No hierarchical security
- **No network exposure**: UDS is local-only

**Gap in Agent Relay** (from PROTOCOL.md Appendix A.7):
```
Issue: No authentication/authorization
Risk: Agents can impersonate other agents on same system
```

**Potential Improvement**: Optional signature verification for audit trails or cloud mode.

---

### 4. Message Delivery Guarantees

| Aspect | Murmur | Agent Relay |
|--------|--------|-------------|
| **Delivery** | At-most-once (30-day TTL) | At-least-once (with ACK) |
| **Ordering** | No global ordering | Per-stream ordering by seq |
| **Persistence** | PostgreSQL (30 days) | In-memory (session-scoped) |
| **Acknowledgment** | DELETE after fetch | Optional ACK messages |
| **Offline** | Store-and-forward | Requires both agents online |
| **Idempotency** | Message ID uniqueness (cuid2) | UUID per envelope |

#### Murmur's Approach
- Messages stored in PostgreSQL for 30 days
- Recipient can be offline when message sent
- SSE sends notification (message ID only)
- Client fetches full message on-demand
- Auto-cleanup prevents unbounded growth

#### Agent Relay's Approach
- Messages delivered immediately if recipient online
- Session resume replays from last sequence number
- ACK correlation for request-response (see SYNC_MESSAGING_PROTOCOL.md)
- Sequence numbers guarantee per-stream ordering

**What Agent Relay Could Adopt**:
1. Optional persistence to disk for critical workflows
2. Configurable TTL with auto-cleanup
3. Store-and-forward for spawned agents that crashed/restarted

---

### 5. Session Management

#### Murmur (Stateless Server, Stateful Clients)

**Session Initialization**:
1. Bob publishes prekey bundle to server
2. Alice fetches bundle and performs X3DH key agreement
3. Alice initializes Double Ratchet with shared secret
4. Bob receives first message and initializes his ratchet state

**Reconnection**:
- New authentication (JWT refresh or login)
- Fetch undelivered messages from inbox
- Client tracks last fetched message ID

**Server Memory**: Zero state (all cryptographic state client-side)

#### Agent Relay (Stateful Server, Reconnectable Clients)

**Session Initialization**:
1. Client sends HELLO with agent name
2. Daemon sends WELCOME with session_id and resume_token
3. Heartbeats maintain connection (PING/PONG every 5s)

**Reconnection**:
1. Client sends RESUME with resume_token and last_seq
2. Daemon sends SYNC with gap information
3. Daemon replays missed messages from last_seq + 1

**Server Memory**: Per-agent connection state in daemon

**Analysis**:
- **Murmur**: Server is dumb relay; all intelligence client-side (better scalability)
- **Agent Relay**: Server is smart coordinator; clients are thin (simpler implementation)

**Gap in Agent Relay** (from PROTOCOL.md Appendix A.2):
```
Issue: Resume token security
- No defined lifetime (sessions live forever)
- No rotation policy
- No replay attack prevention
```

---

### 6. Cryptography Deep Dive

#### Murmur's Cryptographic Stack

| Primitive | Library | Usage |
|-----------|---------|-------|
| **Signing** | Ed25519 (@noble/curves) | All message signatures |
| **Key Exchange** | X25519 (@noble/curves) | X3DH protocol |
| **Encryption** | ChaCha20-Poly1305 (@noble/ciphers) | Double Ratchet |
| **KDF** | HKDF-SHA-256 (@noble/hashes) | Key derivation |
| **Attachments** | AES-256-GCM | Per-file encryption |

**Security Properties**:
- **Forward Secrecy**: One-time prekeys consumed after use
- **Post-Compromise Security**: Ratcheting introduces new entropy
- **Deniability**: No long-term signatures on messages (only on prekeys)
- **Break-in Recovery**: Compromise of one session doesn't affect others

**X3DH Key Agreement** (4 Diffie-Hellman operations):
```
DH1 = alice_identity_key × bob_signed_prekey
DH2 = alice_ephemeral × bob_identity_key
DH3 = alice_ephemeral × bob_signed_prekey
DH4 = alice_ephemeral × bob_onetime_prekey (if available)

shared_secret = KDF(DH1 || DH2 || DH3 || DH4)
```

**Double Ratchet** (continuous key rotation):
- Each message has unique encryption key
- Keys never reused
- Skipped message keys stored temporarily

#### Agent Relay's Trust Model
- **No encryption**: Local machine = trusted environment
- **No signing**: Daemon enforces agent names
- **No key management**: No keys to rotate or manage

**When Encryption Might Matter**:
- **Cloud mode**: Messages traverse internet
- **Bridge mode**: Across untrusted networks
- **Audit requirements**: Regulatory compliance

**Potential Hybrid Approach**:
```
Local mode:   Fast, unencrypted (current)
Bridge mode:  Optional encryption (Murmur-lite)
Cloud mode:   Required encryption (full Murmur-style)
```

---

### 7. Attachment Handling

#### Murmur

**Attachment Encryption**:
- Each attachment encrypted with unique AES-256-GCM key
- Filename encrypted inside payload (not visible to server)
- Hash verification before decryption

**Properties**:
- Validation failure = reject entire message
- Attachments stored alongside message
- Auto-deleted with message (30-day TTL)

#### Agent Relay

**Current State**:
- No native attachment support
- Workaround: Base64 encode in message body
- Limited by frame size (1 MiB default)

**Potential Design**: Reference-based attachments with chunked upload/download

**Benefits**:
- Large files don't block message frames
- Chunked upload/download
- Deduplication (same hash = same file)
- Configurable retention

---

### 8. Error Handling

#### Murmur (HTTP Status + JSON Errors)

**Standard Error Format**:
```json
{
  "error": "Error message description"
}
```

**HTTP Status Codes**:
- `200` OK
- `400` Bad Request (invalid signature, format)
- `401` Unauthorized (expired/invalid token)
- `403` Forbidden (not message owner)
- `404` Not Found
- `409` Conflict (duplicate message ID)

**Validation**:
- Timestamp within ±5 minutes (replay prevention)
- All signatures verified before processing
- Message ID uniqueness enforced (cuid2 format)
- Profile key signature validated

#### Agent Relay (Protocol Messages)

**Gap** (from PROTOCOL.md Appendix A.3):
```
Issue: Error code enumeration missing
Documented: Only "STALE" error code
Missing: Auth errors, rate limits, invalid targets, validation
```

---

### 9. Backpressure & Flow Control

#### Murmur
- **Client-side**: Rate limiting per identity
- **Server-side**: Queue depth managed by PostgreSQL
- **Mechanism**: HTTP 429 (rate limit)
- **Strategy**: Token bucket (configurable)

#### Agent Relay

**Documented but NOT Implemented** (PROTOCOL.md Appendix A.1):
```
Issue: Backpressure unimplemented
Risk: Silent message loss under load
Status: "Reserved for future versions"
```

**What Murmur Does Better**:
- Database acts as infinite buffer (up to disk space)
- SSE connection manages backpressure per client
- Auto-cleanup prevents unbounded growth

**Recommended Implementation**:
1. Bounded queues per agent (e.g., 1000 messages)
2. BUSY response when queue full
3. Exponential backoff in wrappers
4. Priority lanes (importance: 0-100 already defined)
5. Dead letter queue for undeliverable messages

---

### 10. Realtime Delivery

#### Murmur (SSE - Server-Sent Events)

**Connection Flow**:
```http
GET /v1/messages/stream
Authorization: Bearer <token>
```

**Events**:
```
event: connected
data: {"userId":"...","timestamp":1737500000000}

event: message
data: {"messageId":"cuid2-id"}

: heartbeat  # Comment, every 30s
```

**Properties**:
- One-way (server → client)
- Auto-reconnect in browsers
- Lightweight (just message IDs, not full content)
- Client fetches full message via GET /v1/messages/:id

**Why SSE over WebSocket**:
- Simpler protocol (unidirectional)
- Built-in reconnection
- Works over HTTP/2
- Lower overhead for notifications

#### Agent Relay (Unix Domain Socket + Frames)

**Bidirectional Stream**:
```
HELLO → WELCOME (handshake)
SEND ↔ DELIVER (messages)
PING ← PONG (heartbeat every 5s)
```

**Framing**:
- 4-byte big-endian length prefix
- Followed by UTF-8 JSON payload
- Max frame size: 1 MiB (configurable)

**Properties**:
- Full duplex (both directions)
- Heartbeat failure = dead connection (2x heartbeat_ms)
- No web browser support (daemon-only)

**Analysis**:
- **Murmur SSE**: Great for web dashboards, browser agents
- **Agent Relay UDS**: Great for local daemons, CLIs
- **Overlap**: Both support heartbeats, reconnection

---


### 11. Agent Lifecycle & Connection Management

One of the most significant architectural differences between Murmur and Agent Relay is **how agents are expected to maintain connections and send messages**.

#### Murmur: Agent-Managed Lifecycle

Murmur places **responsibility on the agent developer** to maintain connections and manage message flow. There are two approaches:

**Approach 1: CLI with Background Process**

The agent must manually run a separate background process that maintains the SSE connection:

```bash
# Agent must keep this running 24/7
nohup murmur sync --realtime --timeout 86400000 \
  --webhook "http://localhost:18789/hooks/wake?token=secret" \
  --webhook-body '{"text":"Murmur from {{senderName}}","mode":"now"}' \
  >> ~/logs/murmur-realtime.log 2>&1 &
```

**How it works:**

1. **Background process maintains SSE connection**
   - Opens persistent connection to `/v1/messages/stream`
   - Auto-reconnects with exponential backoff (1s → 30s)
   - Parses SSE events line-by-line

2. **On message notification, triggers webhook**
   ```
   SSE event: {"event":"message:new","data":{"messageId":"abc123"}}
     ↓
   POST http://localhost:18789/hooks/wake (wakes agent)
     ↓
   Agent runs: murmur sync (fetches from local DB)
     ↓
   Agent processes message
   ```

3. **Agent sends messages via CLI**
   ```bash
   murmur send --to <contact-id> --message "Hello!"
   ```

**Code: SSE Connection Management** (`packages/murmur-cli/src/engine/api.ts:236`)

```typescript
async streamMessages(onEvent, options) {
  while (true) {  // Infinite retry loop
    const response = await fetch(`${this.baseUrl}/v1/messages/stream`, {
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        'Authorization': `Bearer ${this.accessToken}`
      },
      signal: options?.signal
    });
    
    // Parse SSE stream line-by-line
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      // ... parse event: and data: lines
      // ... dispatch to onEvent callback
    }
    
    // Connection closed, loop retries
  }
}
```

**Code: Auto-Reconnect with Backoff** (`packages/murmur-cli/src/cli.ts:917`)

```typescript
let backoffMs = 1000;
const maxBackoffMs = 30000;

while (!controller.signal.aborted) {
  try {
    await getEngine().streamMessages(async event => {
      if (event.event === 'message:new') {
        await triggerSync(); // Fetch full message
      }
    });
    
    backoffMs = 1000; // Reset on success
  } catch (error) {
    logger.warn(`Realtime sync disconnected: ${error.message}`);
    await waitWithAbort(backoffMs, controller.signal);
    backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
  }
}
```

**Agent Workflow:**
```
1. Agent starts → runs 'murmur sync --realtime' in background
2. Background process maintains SSE connection 24/7
3. When message arrives:
   - SSE notification received
   - Fetch full message from API
   - Decrypt and store in local SQLite (~/.murmur/murmur.db)
   - Trigger webhook to wake agent
4. Agent wakes up, runs: murmur sync
5. Agent reads from local DB
6. Agent sends reply: murmur send --to <id> --message "Reply"
```

**Developer Responsibilities:**
- ✅ Start and maintain background process
- ✅ Handle webhook to wake agent
- ✅ Poll local database or run `murmur sync`
- ✅ Explicitly call CLI commands to send messages
- ✅ Manage process lifecycle (restart on crash, etc.)

---

**Approach 2: MCP Integration**

When using MCP (Model Context Protocol), the agent uses tools instead of CLI commands:

```typescript
// MCP server runs as persistent stdio process
murmur mcp

// AI agent calls MCP tools
const { newMessages } = await mcp.call('messages.sync', { with: 'alice-id' });

await mcp.call('messages.send', { 
  to: 'alice-id', 
  message: 'Hello!' 
});
```

**How it works:**

1. **MCP server is long-lived stdio process**
   - Maintains `MurmurEngine` instance with local SQLite
   - No persistent SSE connection (pull-based)

2. **Agent polls for messages**
   - Agent must explicitly call `messages.sync` to check for new messages
   - No push notifications (unlike CLI approach)

3. **Agent sends via MCP tool**
   - `messages.send` tool encrypts and sends to API

**Code: MCP Server** (`packages/murmur-cli/src/mcp/server.ts:100`)

```typescript
const engine = new MurmurEngine(getDbPath(rootDir), apiBaseUrl);
await engine.initialize();

server.setRequestHandler(CallToolRequestSchema, async request => {
  switch (request.params.name) {
    case 'messages.sync': {
      const result = await engine.sync();
      return textResult({ newMessages: result.newMessages });
    }
    
    case 'messages.send': {
      const stored = await engine.sendMessage(
        contact.identityKey, 
        message, 
        messageId, 
        attachments
      );
      return textResult(stored);
    }
  }
});
```

**Agent Workflow:**
```
1. AI agent starts → MCP server auto-starts (stdio)
2. Agent periodically calls: mcp.call('messages.sync')
3. MCP server fetches from API, decrypts, returns messages
4. Agent processes messages
5. Agent calls: mcp.call('messages.send', {...})
```

**Developer Responsibilities:**
- ✅ Call `messages.sync` periodically (polling)
- ✅ Explicitly call `messages.send` to reply
- ❌ No background process management (MCP handles lifecycle)
- ❌ No webhooks needed

---

#### Agent Relay: Wrapper-Managed Lifecycle

Agent Relay takes a **completely automatic approach** - the wrapper (`relay-pty`) manages all connection lifecycle:

**How it works:**

1. **Wrapper maintains Unix Domain Socket connection**
   - `relay-pty` opens connection to daemon on startup
   - Sends HELLO, receives WELCOME
   - Heartbeats every 5 seconds automatically

2. **Daemon pushes messages directly to wrapper**
   ```
   Message arrives at daemon
     ↓
   Daemon sends DELIVER frame to wrapper
     ↓
   Wrapper injects into agent's PTY
     ↓
   Agent sees: "Relay message from Alice: Hello!"
   ```

3. **Agent sends via output pattern**
   ```
   Agent outputs: "->relay:Alice Hi back!"
     ↓
   Wrapper parses output
     ↓
   Wrapper sends SEND frame to daemon
     ↓
   Daemon routes to Alice's wrapper
   ```

**Code: Wrapper Connection** (`packages/wrapper/src/relay-pty-orchestrator.ts`)

```typescript
// Wrapper automatically maintains connection
class RelayPtyOrchestrator {
  async spawn(config) {
    // relay-pty binary handles UDS connection
    const child = spawn('relay-pty', [
      '--socket', SOCKET_PATH,
      '--agent', config.agent,
      '--',
      ...config.cmd
    ]);
    
    // relay-pty manages:
    // - UDS connection to daemon
    // - HELLO/WELCOME handshake
    // - PING/PONG heartbeats
    // - Message parsing from agent output
    // - Message injection to agent PTY
  }
}
```

**Code: Message Injection** (`relay-pty/src/main.rs`)

```rust
// When DELIVER arrives from daemon
fn handle_deliver(envelope: Envelope) {
    let message = format!(
        "Relay message from {} [{}]: {}\n",
        envelope.from,
        envelope.id,
        envelope.payload.body
    );
    
    // Inject directly into agent's PTY
    pty.write_all(message.as_bytes())?;
}

// Parse agent output for patterns
fn parse_output(line: &str) {
    if line.starts_with("->relay:") {
        let (to, body) = parse_relay_pattern(line);
        
        // Send SEND frame to daemon
        let envelope = Envelope {
            type: "SEND",
            to,
            payload: { body, ... },
            ...
        };
        
        send_to_daemon(envelope)?;
    }
}
```

**Agent Workflow:**
```
1. Agent starts → relay-pty wrapper auto-starts
2. Wrapper maintains UDS connection (transparent)
3. When message arrives:
   - Daemon → Wrapper DELIVER frame
   - Wrapper → Agent PTY injection
   - Agent sees message in real-time
4. Agent replies in output:
   "->relay:Alice Thanks!"
5. Wrapper parses, sends to daemon
```

**Developer Responsibilities:**
- ❌ No background process management
- ❌ No connection management
- ❌ No polling
- ❌ No webhooks
- ✅ Just use `->relay:` pattern in output

---

#### Comparison Summary

| Aspect | Murmur (CLI) | Murmur (MCP) | Agent Relay |
|--------|--------------|--------------|-------------|
| **Connection Management** | Manual background process | MCP server (stdio) | Automatic (wrapper) |
| **SSE Maintenance** | Agent's responsibility | N/A (pull-based) | N/A (UDS push) |
| **Message Reception** | Webhook → poll local DB | Poll via MCP tool | PTY injection (automatic) |
| **Message Sending** | CLI command | MCP tool call | Output pattern |
| **Real-Time Delivery** | Yes (if bg process running) | No (polling only) | Yes (automatic) |
| **Process Lifecycle** | Agent manages | MCP framework manages | Wrapper manages |
| **Developer Complexity** | High (multiple processes) | Medium (polling logic) | Low (just patterns) |
| **Failure Handling** | Agent must restart bg process | MCP retries | Wrapper auto-reconnects |

---

#### Developer Experience Examples

**Murmur CLI (Background Process)**

```bash
# Setup
murmur sign-in --first-name Alice
murmur contacts add <bob-id>

# Runtime - agent must manage this
murmur sync --realtime --webhook http://localhost/wake &

# Agent code must handle webhook
def on_wake():
    subprocess.run(['murmur', 'sync'])
    messages = read_from_db('~/.murmur/murmur.db')
    for msg in messages:
        process_message(msg)
        subprocess.run([
            'murmur', 'send', 
            '--to', msg.sender_id, 
            '--message', 'Reply'
        ])
```

**Murmur MCP (Polling)**

```typescript
// Agent must poll periodically
setInterval(async () => {
  const { newMessages } = await mcp.call('messages.sync');
  for (const msg of newMessages) {
    await processMessage(msg);
    await mcp.call('messages.send', {
      to: msg.from,
      message: 'Reply'
    });
  }
}, 5000); // Poll every 5 seconds
```

**Agent Relay (Automatic)**

```
# Agent just outputs patterns - everything else automatic

Agent sees (automatic injection):
> Relay message from Bob [abc123]: Can you help?

Agent outputs:
> I'm working on it...
> ->relay:Bob Sure, what do you need?

Message automatically sent to Bob.
```

---

#### Key Architectural Insight

**Murmur's Philosophy:**
- Agent is in control
- Explicit commands and tools
- Pull-based (agent fetches when ready)
- Suitable for autonomous agents that manage their own lifecycle

**Agent Relay's Philosophy:**
- Wrapper is in control
- Implicit pattern matching
- Push-based (messages injected immediately)
- Suitable for interactive agents that respond in real-time

**Trade-offs:**

| Criteria | Winner | Reason |
|----------|--------|--------|
| Developer simplicity | Agent Relay | No process management |
| Agent autonomy | Murmur | Agent controls when to check messages |
| Real-time responsiveness | Agent Relay | <5ms injection vs webhook latency |
| Cross-network | Murmur | Works over internet |
| Offline support | Murmur | Messages wait in inbox |
| Integration complexity | Agent Relay | Just use output patterns |

---


## Synchronous Messaging (Agent Relay's Unique Feature)

Agent Relay has a synchronous messaging protocol (see SYNC_MESSAGING_PROTOCOL.md) that Murmur lacks:

### Request-Response Pattern

**File-Based Syntax**:
```bash
# Blocking request (wait for ACK)
cat > $AGENT_RELAY_OUTBOX/turn << 'EOF'
TO: North
AWAIT: 60s

Your turn. Play a card.
EOF
```

**Use Cases**:
- Turn-based games (Hearts, Chess)
- Workflows requiring barriers (wait for all agents)
- Request-response patterns (query-response)

**Murmur's Limitation**: Fully asynchronous, no built-in correlation.

---

## What Agent Relay Can Learn from Murmur

### 1. Message Persistence (HIGH IMPACT)

**Problem**: Messages lost if agent crashes before processing

**Murmur's Solution**:
- PostgreSQL stores all messages (30-day TTL)
- Automatic cleanup prevents bloat
- Inbox survives server restarts

**Recommendation**: Optional persistence flag with SQLite for local storage

**Benefits**:
- Critical messages survive daemon restarts
- Agent can fetch undelivered messages on reconnect
- Audit trail for debugging
- Opt-in (no performance hit for fire-and-forget)

---

### 2. Complete Error Code Enumeration (MEDIUM IMPACT)

**Problem**: Only "STALE" error documented (PROTOCOL.md Appendix A.3)

**Murmur's Solution**: Well-defined HTTP status codes and error format

**Recommendation**: Define complete error taxonomy including session, routing, validation, and backpressure errors.

---

### 3. Session Token Security (MEDIUM IMPACT)

**Problem**: Resume tokens have no defined lifetime (PROTOCOL.md Appendix A.2)

**Murmur's Solution**:
- Access tokens: Short-lived (24h)
- Refresh tokens: Long-lived, rotated on use
- Timestamp validation (±5min)

**Recommendation**: Implement token expiration, rotation, and binding to agent identity.

---

### 4. Attachment Support (MEDIUM IMPACT)

**Problem**: No native attachment support (limited to frame size)

**Murmur's Solution**: Separate attachment encryption + metadata

**Recommendation**: Reference-based attachments with chunked upload for large files.

---

### 5. Backpressure Implementation (HIGH IMPACT)

**Problem**: Documented but not implemented (PROTOCOL.md Appendix A.1)

**Murmur's Natural Backpressure**: PostgreSQL + SSE buffers

**Recommendation**: Bounded queues per agent, BUSY responses, priority lanes.

---

## What Murmur Can Learn from Agent Relay

### 1. Sub-5ms Local Latency

Murmur's crypto overhead (100-500ms) prevents real-time coordination on same machine.

**Potential Optimization**: Local fast path that skips encryption for same-machine communication.

---

### 2. Synchronous Messaging

Murmur is fully async (fire-and-forget).

**Agent Relay's Approach**:
- Block until ACK with correlation IDs
- Timeout handling
- Request-response patterns

**Use Case**: Turn-based games, workflows requiring barriers.

---

### 3. Sequence Ordering

Murmur has no ordering guarantees.

**Agent Relay's Approach**:
- Per-stream sequence numbers
- In-order delivery guaranteed
- Gap detection on RESUME

**Use Case**: Ordered logs, state machines.

---

## Integration Scenarios

### Hybrid Architecture: Best of Both Worlds

```
┌─────────────────────────────────────────┐
│         AI Agent Communication           │
├─────────────────────────────────────────┤
│  Local (same machine)                    │
│  → Agent Relay                           │
│  - <5ms latency                          │
│  - Synchronous messaging                 │
│  - Sequence ordering                     │
├─────────────────────────────────────────┤
│  Cross-network (different machines)      │
│  → Murmur                                │
│  - E2E encryption                        │
│  - Offline support                       │
│  - Persistent messages                   │
├─────────────────────────────────────────┤
│  Gateway Pattern                         │
│  - Agent Relay locally                   │
│  - Murmur bridge agent for external      │
│  - Best latency for each use case        │
└─────────────────────────────────────────┘
```

### Use Case: Multi-Agent Game (Hearts)

**Local coordination (Agent Relay)**:
- Coordinator → Players: Sub-5ms latency for turn-based messaging
- Synchronous await ensures turn order
- Sequence numbers prevent out-of-order delivery

**External player (Murmur)**:
- Bridge agent receives from Agent Relay
- Encrypts and sends via Murmur to remote player
- Remote player's response decrypted and injected to Agent Relay
- Offline support for async play

---

## Recommendations Summary

### For Agent Relay (High Priority)

1. ✅ **Implement backpressure** (BUSY responses, bounded queues)
2. ✅ **Define complete error code taxonomy**
3. ✅ **Optional message persistence** (SQLite for critical messages)
4. ✅ **Session token security** (expiration, rotation)
5. ✅ **Attachment support** (chunked, reference-based)

### For Agent Relay (Medium Priority)

6. ✅ **TTL + auto-cleanup** (prevent memory growth)
7. ✅ **Clarify delivery guarantees** (at-least-once vs exactly-once)
8. ⚠️ **Optional signatures** (cloud mode, audit trails)

### For Murmur (If Targeting Local Use Cases)

1. ⚠️ **Local fast path** (skip encryption for same-machine)
2. ⚠️ **Synchronous messaging** (correlation IDs, await)
3. ⚠️ **Sequence ordering** (per-stream seq numbers)

---

## Conclusion

**Murmur** and **Agent Relay** are complementary systems designed for different layers of agent communication:

### Murmur's Strengths
- ✅ End-to-end encryption (zero-knowledge server)
- ✅ Offline support (30-day message retention)
- ✅ Cross-network messaging (internet-scale)
- ✅ Cryptographic identity (Ed25519)
- ✅ Battle-tested crypto (Signal Protocol)

### Agent Relay's Strengths
- ✅ Sub-5ms latency (100x faster for local)
- ✅ Sequence ordering guarantees
- ✅ Synchronous messaging (blocking, await)
- ✅ Simpler implementation (no crypto complexity)
- ✅ Real-time coordination (perfect for local workflows)

### Recommended Strategy

**Use Agent Relay when**:
- All agents on same machine
- Need <5ms latency
- Turn-based or request-response patterns
- Local development and testing

**Use Murmur when**:
- Agents across different machines/networks
- Need offline message delivery
- Require end-to-end encryption
- Zero-trust security requirements

**Use both (gateway pattern) when**:
- Local agents need to communicate with remote agents
- Bridge agent translates between protocols
- Optimize latency for local, security for remote

---

## References

### Murmur Documentation
- [Murmur Repository](https://github.com/slopus/murmur)
- Protocol Specification: `docs/PROTOCOL.md`
- Architecture: `docs/ARCHITECTURE.md`
- Message Format: `docs/MESSAGE_FORMAT.md`
- API Reference: `docs/API.md`
- Security Model: `docs/SECURITY.md`

### Agent Relay Documentation
- Protocol Specification: `docs/PROTOCOL.md`
- Sync Messaging: `docs/SYNC_MESSAGING_PROTOCOL.md`
- Architecture: `README.md`

### Cryptographic Primitives (Murmur)
- **@noble/curves**: X25519 (Diffie-Hellman), Ed25519 (signatures)
- **@noble/hashes**: SHA-256, HMAC, HKDF
- **@noble/ciphers**: ChaCha20-Poly1305

---

**Research Date**: 2026-01-26  
**Murmur Version Analyzed**: Latest (main branch)  
**Agent Relay Version**: v1.0 Protocol Specification
