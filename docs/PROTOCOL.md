# Agent Relay Protocol Specification

Version 1.0

## Goals

- Low-latency local IPC (<5ms)
- Strict framing with backpressure
- At-least-once delivery (optional exactly-once within session)
- Reconnect + state resync
- Simple to implement in Rust/Go/TypeScript

## Non-Goals

- Cross-host networking
- Encryption (local-only)
- Unbounded buffering

---

## 1. Transport

**Preferred:** Unix Domain Socket (stream)
- Path: `/tmp/agent-relay.sock` (configurable)

**Windows fallback:** Named Pipe
- Path: `\\.\pipe\agent-relay`

**Connection model:** Each wrapper opens 1 duplex stream to daemon.

---

## 2. Framing

Stream is a sequence of frames.

### Frame Header
- 4-byte big-endian unsigned length `N` (bytes)
- Followed by `N` bytes UTF-8 JSON

### Limits
- `N` MUST be <= `max_frame_bytes` (default: 1 MiB)
- If exceeded, daemon closes connection with error
- JSON payload MUST be an object

### Example (pseudo)
```
0000003A {"v":1,"type":"HELLO","agent":"claude-1",...}
```
Where `0x3A` (58) is the byte length of the JSON payload.

---

## 3. Envelope

All messages are `Envelope` objects:

```typescript
interface Envelope {
  v: 1;                    // Protocol version
  type: MessageType;       // See below
  id: string;              // Unique per-sender (UUIDv4)
  ts: number;              // Milliseconds since epoch
  from?: string;           // Agent name (set by daemon)
  to?: string | '*';       // Target or broadcast
  topic?: string;          // Optional topic/channel
  payload: object;         // Type-specific payload
}
```

### Message Types

| Type | Direction | Purpose |
|------|-----------|---------|
| `HELLO` | Client→Server | Initiate handshake |
| `WELCOME` | Server→Client | Confirm session |
| `SEND` | Client→Server | Send message |
| `DELIVER` | Server→Client | Deliver message |
| `ACK` | Both | Acknowledge receipt |
| `NACK` | Both | Negative acknowledgment |
| `PING` | Server→Client | Heartbeat |
| `PONG` | Client→Server | Heartbeat response |
| `ERROR` | Server→Client | Error notification |
| `BUSY` | Server→Client | Backpressure signal |
| `RESUME` | Client→Server | Resume session |
| `SYNC` | Server→Client | State sync info |
| `BYE` | Both | Graceful disconnect |
| `SUBSCRIBE` | Client→Server | Subscribe to topic |
| `UNSUBSCRIBE` | Client→Server | Unsubscribe from topic |

---

## 4. Handshake

### New Session

**Client → Server: HELLO**
```json
{
  "v": 1,
  "type": "HELLO",
  "id": "uuid",
  "ts": 1734440000000,
  "payload": {
    "agent": "claude-1",
    "capabilities": {
      "ack": true,
      "resume": true,
      "max_inflight": 256,
      "supports_topics": true
    },
    "session": {
      "resume_token": "optional-previous-token"
    }
  }
}
```

**Server → Client: WELCOME**
```json
{
  "v": 1,
  "type": "WELCOME",
  "id": "uuid",
  "ts": 1734440000001,
  "payload": {
    "session_id": "s-abc123",
    "resume_token": "new-token-for-reconnect",
    "server": {
      "max_frame_bytes": 1048576,
      "heartbeat_ms": 5000
    }
  }
}
```

---

## 5. Sending and Delivery

### Client → Server: SEND
```json
{
  "v": 1,
  "type": "SEND",
  "id": "m-001",
  "ts": 1734440000100,
  "to": "codex-1",
  "topic": "chat",
  "payload": {
    "kind": "message",
    "body": "Your turn",
    "data": {}
  },
  "payload_meta": {
    "requires_ack": true,
    "ttl_ms": 60000,
    "sync": {
      "correlationId": "c-123",
      "timeoutMs": 5000,
      "blocking": true
    }
  }
}
```

### Server → Recipient: DELIVER
```json
{
  "v": 1,
  "type": "DELIVER",
  "id": "d-001",
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

### Recipient → Server: ACK
```json
{
  "v": 1,
  "type": "ACK",
  "id": "uuid",
  "ts": 1734440000103,
  "payload": {
    "ack_id": "d-001",
    "seq": 42,
    "correlationId": "c-123",
    "response": true,
    "responseData": {
      "status": "ok"
    }
  }
}
```

### Ordering Guarantee

Per `(topic, from → to)` stream, daemon guarantees in-order DELIVER by `delivery.seq`.

No global ordering across topics.

---

## 6. Backpressure

Backpressure signaling is reserved for future versions. The current daemon is best-effort and does not implement bounded outbound queues or `BUSY` responses.

### Server → Client: BUSY
```json
{
  "v": 1,
  "type": "BUSY",
  "id": "uuid",
  "ts": 1734440000300,
  "payload": {
    "retry_after_ms": 50,
    "queue_depth": 1000
  }
}
```

Client should back off (exponential with jitter).

---

## 7. Heartbeats

- Daemon sends PING every `heartbeat_ms` if idle
- Wrapper replies PONG with same nonce
- Missing PONG for `2 * heartbeat_ms` → connection dead

---

## 8. Reconnect / Resume

### Client → Server: RESUME
```json
{
  "v": 1,
  "type": "RESUME",
  "id": "uuid",
  "ts": 1734440001000,
  "payload": {
    "session_id": "s-abc123",
    "agent": "claude-1",
    "streams": {
      "chat": { "last_seq": 45 }
    }
  }
}
```

### Server → Client: SYNC
```json
{
  "v": 1,
  "type": "SYNC",
  "id": "uuid",
  "ts": 1734440001001,
  "payload": {
    "session_id": "s-abc123",
    "streams": [
      { "topic": "chat", "peer": "codex-1", "last_seq": 45, "server_last_seq": 49 }
    ]
  }
}
```

Server then replays DELIVER messages from `last_seq + 1` to `server_last_seq`.

### Stale Resume

If resume gap exceeds retention, server sends NACK with code "STALE".
Client should send fresh HELLO.

---

## 9. PTY Pattern Extractor

### Fenced Format (default, recommended)

```
->relay:codex-1 <<<
Your turn to play>>>

->relay:* <<<
Hello everyone>>>
```

**Always use the fenced format** for reliable message delivery. The `<<<` opens, `>>>` closes at end of last line.

### Block Format (structured data)

```
[[RELAY]]
{"to": "*", "type": "message", "body": "Hello everyone"}
[[/RELAY]]
```

### Rules

1. Fenced: `->relay:AgentName <<<` starts message, `>>>` ends it
2. Block: Only parse when `[[RELAY]]` at start of line
3. Pattern must be at start of line, not in code fences
4. Escape: `\->relay:` outputs literal `->relay:`

---

## 10. Connection Lifecycle

```
DISCONNECTED → CONNECTING → HANDSHAKING → READY
                    ↑              ↓
                BACKOFF ←─────── ERROR
```

### Backoff Strategy

- Initial: 100ms
- Multiplier: 2x
- Max: 30s
- Jitter: ±15%
- Max attempts: 10

---

## Appendix A: Protocol Critique & Known Limitations

### Issues & Gaps (v1.0)

#### 1. Backpressure Unimplemented (MEDIUM PRIORITY)
**Issue:** Backpressure signaling is documented but "reserved for future versions." Agents may not handle BUSY responses gracefully.
- **Risk:** Silent message loss under load
- **See:** [BEADS-BACKPRESSURE]

#### 2. Resume Token Security (HIGH PRIORITY)
**Issue:** Resume tokens lack defined lifetime, rotation policy, and replay attack prevention.
- **Missing:** Token expiration, client identity binding, secure rotation
- **See:** [BEADS-SESSION-SECURITY]

#### 3. Error Code Enumeration Missing (MEDIUM PRIORITY)
**Issue:** Only "STALE" error documented. Missing codes for auth, rate limits, invalid targets, validation errors.
- **See:** [BEADS-ERROR-CODES]

#### 4. Delivery Guarantee Ambiguity (HIGH PRIORITY)
**Issue:** Protocol says "at-least-once" but ACK is optional (requires_ack flag). Unclear when ACK is mandatory vs optional.
- **Risk:** Clients may assume guaranteed delivery when using at-least-once semantics but ACK is disabled
- **See:** [BEADS-DELIVERY-SEMANTICS]

#### 5. Topic Subscription Incomplete (LOW PRIORITY)
**Issue:** SUBSCRIBE/UNSUBSCRIBE documented but missing details on wildcards, state management, ACL.
- **See:** [BEADS-TOPIC-SUBSCRIPTIONS]

#### 6. Broadcast Ordering Unclear (MEDIUM PRIORITY)
**Issue:** Per-stream ordering guaranteed but `to: '*'` broadcast ordering not specified.
- **See:** [BEADS-BROADCAST-ORDERING]

#### 7. No Authentication/Authorization (HIGH PRIORITY)
**Issue:** Local-only architecture but no specification preventing agents from spoofing `from` field.
- **Risk:** Agents can impersonate other agents on the same system
- **See:** [BEADS-AGENT-AUTHORIZATION]

#### 8. PTY Pattern Detection Too Loose (LOW PRIORITY)
**Issue:** `->relay:` at line start could accidentally match in code output, causing false positives.
- **See:** [BEADS-PTY-ESCAPE-SEQUENCES]

#### 9. Blocking Sync Semantics Undefined (MEDIUM PRIORITY)
**Issue:** `payload_meta.sync.blocking` and `timeoutMs` mentioned but not formally defined.
- **See:** [BEADS-SYNC-SEMANTICS]

#### 10. Missing Flow Control Guidance (LOW PRIORITY)
**Issue:** `max_inflight: 256` allowed but no guidance on tuning or when to back off.
- **See:** [BEADS-FLOW-CONTROL]

### Recommendations for v2.0

1. Formalize backpressure with mandatory BUSY handling and max queue depths
2. Add complete error code enumeration with usage examples
3. Clarify exactly-once vs at-least-once per message type
4. Define token lifetime and secure rotation
5. Add ACL/authorization section for multi-agent systems
6. Specify broadcast ordering guarantees
7. Provide flow control tuning guidance

