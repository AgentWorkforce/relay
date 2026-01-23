# Protocol Hardening Proposal

> **Status**: Draft
> **Author**: ProtocolHardener
> **Date**: January 23, 2026
> **Target**: Agent Relay Protocol v2

## Executive Summary

The Agent Relay Protocol is well-architected for agent-to-agent communication with strong file-based reliability. This proposal identifies critical gaps and proposes backward-compatible enhancements to make the protocol production-ready while preserving its Unix philosophy: human-readable, local-first, simple, and debuggable.

---

## Table of Contents

1. [Critical Gap Analysis](#1-critical-gap-analysis)
2. [Proposed Solutions](#2-proposed-solutions)
3. [Schema Formalization](#3-schema-formalization)
4. [Error Taxonomy](#4-error-taxonomy)
5. [Migration Path](#5-migration-path)
6. [Success Metrics](#6-success-metrics)
7. [Implementation Priorities](#7-implementation-priorities)

---

## 1. Critical Gap Analysis

### 1.1 Message Atomicity & Fragmentation

**Current State**: Messages are written to files atomically (single `write()` call), but there's no guarantee the orchestrator reads them atomically.

**Gaps**:
- No message boundaries in multi-message scenarios
- Partial file reads possible during write
- No checksum/integrity verification

**Risk Level**: Medium - File system semantics usually protect us, but edge cases exist.

### 1.2 Error Handling Taxonomy

**Current State**: Only 5 error codes defined:
```typescript
type ErrorCode = 'BAD_REQUEST' | 'UNAUTHORIZED' | 'NOT_FOUND' | 'INTERNAL' | 'RESUME_TOO_OLD'
```

**Gaps**:
- No distinction between transient vs permanent errors
- No retry guidance in error responses
- Missing codes: `TIMEOUT`, `RATE_LIMITED`, `BACKPRESSURE`, `VERSION_MISMATCH`, `QUEUE_FULL`
- No error categories (validation, routing, delivery, system)

**Risk Level**: High - Agents can't make intelligent retry decisions.

### 1.3 Message Ordering Guarantees

**Current State**: No sequence numbers, no ordering guarantees.

**Gaps**:
- Concurrent messages can arrive out-of-order
- No way to detect message loss
- No causal ordering for thread-based conversations
- Retry messages may duplicate or reorder

**Risk Level**: Medium - Works for independent messages, breaks for stateful conversations.

### 1.4 Partial Message Handling

**Current State**: Parser tries header format first, falls back to JSON, then fails silently.

**Gaps**:
- No partial message detection
- No way to request retransmission
- Truncated messages are silently dropped
- No size limits enforced at file level

**Risk Level**: Low - Files are typically small, but long messages can truncate.

### 1.5 Backpressure Modeling

**Current State**: `Backpressure` response exists but behavior is undefined.

**Gaps**:
- No documented backpressure signals
- No queue depth visibility to senders
- No rate limiting guidance
- No flow control for fast producers

**Risk Level**: High - Thundering herd can overwhelm recipients.

### 1.6 Version Negotiation

**Current State**: Protocol version is hardcoded to `1`, no negotiation.

**Gaps**:
- No way to detect old/new agents
- Breaking changes require coordinated deployment
- No feature detection
- No graceful degradation path

**Risk Level**: High - Blocks protocol evolution.

### 1.7 Sync/Blocking Semantics

**Current State**: `AWAIT` header exists but behavior is under-documented.

**Gaps**:
- Timeout behavior undefined (what response on timeout?)
- No explicit ACK format for sync messages
- No correlation ID in file format
- No cancellation mechanism

**Risk Level**: Medium - Sync messaging is fragile.

### 1.8 Schema Validation

**Current State**: JSON schemas exist for documentation but aren't enforced at runtime.

**Gaps**:
- TypeScript types and JSON schemas can drift
- No runtime validation in Rust parser
- No validation error details returned
- No schema version in messages

**Risk Level**: Medium - Silent failures on malformed messages.

### 1.9 Discovery & Registry

**Current State**: Agents are implicitly discovered via `HELLO` handshake.

**Gaps**:
- No agent capability advertisement
- No health status in registry
- No way to query available agents
- No typed agent interfaces

**Risk Level**: Low - Current model works, but limits composability.

---

## 2. Proposed Solutions

### 2.1 Message Envelope Enhancements

**Goal**: Add message IDs, sequence numbers, and checksums without breaking compatibility.

#### Current Format
```
TO: Bob
KIND: message
THREAD: task-123

Hello Bob, please review this.
```

#### Proposed Format (v2)
```
TO: Bob
KIND: message
THREAD: task-123
ID: msg_01HV8X9Y2Z3W4Q5R6S7T8U9V0
SEQ: 42
CHECKSUM: sha256:a1b2c3d4
REPLY-TO: msg_00HU7W8X1Y2Z3A4B5C6D7E8F9

Hello Bob, please review this.
```

**New Headers** (all optional for backward compatibility):
| Header | Type | Description |
|--------|------|-------------|
| `ID` | string | Unique message ID (recommended: `msg_` prefix + ULID) |
| `SEQ` | integer | Monotonically increasing sequence per sender |
| `CHECKSUM` | string | `algorithm:value` format, e.g., `sha256:abc123` |
| `REPLY-TO` | string | Message ID this is responding to |
| `PRIORITY` | integer | Lower = higher priority (0-9, default 5) |
| `TTL` | duration | Message expiry, e.g., `30s`, `5m` |
| `VERSION` | integer | Protocol version (default: 1) |

**Complexity**: Low - Parser changes only, backward compatible.

#### Pseudo-code: Enhanced Parsing
```rust
fn parse_enhanced_headers(content: &str) -> RelayMessage {
    let mut msg = parse_basic_headers(content);

    // Enhanced headers (optional, v2+)
    if let Some(id) = extract_header("ID", content) {
        msg.id = Some(id);
    }
    if let Some(seq) = extract_header("SEQ", content) {
        msg.sequence = seq.parse().ok();
    }
    if let Some(checksum) = extract_header("CHECKSUM", content) {
        msg.checksum = Some(parse_checksum(checksum)?);
        if !verify_checksum(&msg.body, &msg.checksum) {
            return Err(ProtocolError::ChecksumMismatch);
        }
    }
    // ... other optional headers

    msg
}
```

### 2.2 Rich Error Taxonomy

**Goal**: Enable intelligent retry decisions and clear error categorization.

#### Proposed Error Codes

```typescript
// Error categories
type ErrorCategory =
  | 'validation'   // Message format issues
  | 'routing'      // Delivery path issues
  | 'delivery'     // Target agent issues
  | 'system'       // Infrastructure issues
  | 'protocol';    // Version/compatibility issues

// Comprehensive error codes
type ErrorCode =
  // Validation errors (4xx equivalent)
  | 'INVALID_FORMAT'      // Message parse failure
  | 'MISSING_HEADER'      // Required header missing
  | 'INVALID_HEADER'      // Header value invalid
  | 'CHECKSUM_MISMATCH'   // Integrity check failed
  | 'MESSAGE_TOO_LARGE'   // Exceeds size limit
  | 'INVALID_TARGET'      // Target syntax invalid

  // Routing errors
  | 'AGENT_NOT_FOUND'     // Target agent unknown
  | 'CHANNEL_NOT_FOUND'   // Target channel unknown
  | 'PERMISSION_DENIED'   // Not authorized for target
  | 'ROUTE_NOT_FOUND'     // No path to target

  // Delivery errors
  | 'AGENT_OFFLINE'       // Target agent disconnected
  | 'AGENT_BUSY'          // Target agent backpressured
  | 'QUEUE_FULL'          // Target queue at capacity
  | 'DELIVERY_TIMEOUT'    // Delivery exceeded TTL
  | 'REJECTED'            // Target explicitly rejected

  // System errors (5xx equivalent)
  | 'INTERNAL_ERROR'      // Unexpected system failure
  | 'RATE_LIMITED'        // Too many requests
  | 'SERVICE_UNAVAILABLE' // Daemon/orchestrator down

  // Protocol errors
  | 'VERSION_MISMATCH'    // Incompatible protocol version
  | 'FEATURE_UNSUPPORTED' // Requested feature not available
  | 'RESUME_TOO_OLD';     // Cannot resume from checkpoint

interface RichError {
  code: ErrorCode;
  category: ErrorCategory;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;    // Suggested retry delay
  details?: Record<string, unknown>;
}
```

#### Error Response Format
```
KIND: error
CODE: AGENT_BUSY
CATEGORY: delivery
RETRYABLE: true
RETRY-AFTER: 5000

Target agent "Bob" is processing a message. Queue depth: 3/10.
```

**Complexity**: Medium - Requires parser and orchestrator updates.

### 2.3 Sequence Numbering & Ordering

**Goal**: Detect message loss and enable ordered delivery.

#### Design
- Each agent maintains a monotonic sequence counter
- Sequence resets on reconnection (with new session ID)
- Gaps in sequence indicate lost messages
- Optional strict ordering mode per conversation

```
TO: Bob
SEQ: 42
SESSION: ses_01HV8X9Y2Z

Message content here.
```

#### Receiver Logic
```rust
struct SequenceTracker {
    // Per-sender sequence tracking
    sequences: HashMap<(AgentId, SessionId), u64>,
}

impl SequenceTracker {
    fn check(&mut self, from: &AgentId, session: &SessionId, seq: u64) -> SeqResult {
        let key = (from.clone(), session.clone());
        let expected = self.sequences.get(&key).map(|s| s + 1).unwrap_or(0);

        match seq.cmp(&expected) {
            Ordering::Equal => {
                self.sequences.insert(key, seq);
                SeqResult::InOrder
            }
            Ordering::Greater => {
                // Gap detected - messages lost
                let missing = expected..seq;
                self.sequences.insert(key, seq);
                SeqResult::Gap { missing: missing.collect() }
            }
            Ordering::Less => {
                // Duplicate or reordered
                SeqResult::Duplicate
            }
        }
    }
}
```

**Complexity**: Medium - Requires state tracking, optional for v2.

### 2.4 Backpressure Protocol

**Goal**: Enable flow control and prevent queue overflow.

#### Backpressure Signals

```typescript
interface BackpressureInfo {
  queueDepth: number;     // Current messages in queue
  queueCapacity: number;  // Maximum queue size
  estimatedDelayMs: number; // Estimated processing delay
  acceptingMessages: boolean;
}
```

#### Proactive Backpressure Response
When an agent's queue exceeds 80% capacity:
```
KIND: backpressure
QUEUE-DEPTH: 8
QUEUE-CAPACITY: 10
DELAY-MS: 5000
ACCEPTING: true

Please reduce send rate. Current queue is 80% full.
```

#### Sender Behavior
```rust
fn send_with_backpressure(msg: Message, target: &Agent) -> Result<(), SendError> {
    // Check cached backpressure state
    if let Some(bp) = self.backpressure_cache.get(target) {
        if !bp.accepting_messages {
            return Err(SendError::BackpressureRejected);
        }
        if bp.queue_depth > bp.queue_capacity * 0.8 {
            // Add jitter to spread retry load
            let delay = bp.estimated_delay_ms + random_jitter(0..1000);
            sleep(Duration::from_millis(delay));
        }
    }

    self.send_internal(msg)
}
```

**Complexity**: Medium - Requires bidirectional state.

### 2.5 Sync Message Improvements

**Goal**: Make blocking/sync messaging reliable and well-defined.

#### Enhanced AWAIT Semantics

```
TO: Bob
KIND: message
AWAIT: 30s
CORRELATION: corr_01HV8X9Y2Z

Please confirm you received the deployment plan.
```

**New Headers**:
| Header | Description |
|--------|-------------|
| `AWAIT` | Timeout duration (`30s`, `5m`, `1h`, or milliseconds) |
| `CORRELATION` | Unique ID for matching response |
| `REQUIRE-ACK` | Explicit ACK required (default: true if AWAIT set) |

**Response Format**:
```
TO: Alice
KIND: ack
CORRELATION: corr_01HV8X9Y2Z

ACK: Received deployment plan, reviewing now.
```

**Timeout Behavior**:
1. Sender writes message with `AWAIT` header
2. Orchestrator holds sender's inject until response or timeout
3. On timeout: inject timeout notification to sender
4. On response: inject response immediately

```
KIND: timeout
CORRELATION: corr_01HV8X9Y2Z
WAITED: 30000

Message to Bob timed out after 30s. No response received.
```

**Complexity**: Medium - Requires orchestrator correlation tracking.

### 2.6 Version Negotiation

**Goal**: Enable protocol evolution without breaking existing agents.

#### Hello/Welcome Enhancement
```
KIND: hello
VERSION: 2
CAPABILITIES: sync,backpressure,checksums
NAME: Alice
```

```
KIND: welcome
VERSION: 2
NEGOTIATED-VERSION: 2
CAPABILITIES: sync,backpressure
NAME: daemon
```

#### Version Negotiation Rules
1. Agent sends highest supported version in `HELLO`
2. Daemon responds with negotiated version (min of both)
3. Both parties use negotiated version features only
4. Unknown headers from higher versions are ignored

#### Capability Flags
```typescript
type Capability =
  | 'sync'           // Supports AWAIT/blocking
  | 'backpressure'   // Sends/respects backpressure
  | 'checksums'      // Sends/verifies checksums
  | 'sequences'      // Uses sequence numbers
  | 'priorities'     // Respects message priorities
  | 'channels'       // Supports channel messaging
  | 'shadows';       // Supports shadow agents
```

**Complexity**: Low - Mostly documentation and conventions.

---

## 3. Schema Formalization

### 3.1 JSON Schema Updates

Add new schemas for enhanced message format:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "relay-file-format-v2.schema.json",
  "title": "Agent Relay File Format v2",
  "type": "object",
  "properties": {
    "TO": { "type": "string", "pattern": "^[\\w#*@:.-]+$" },
    "KIND": { "enum": ["message", "spawn", "release", "ack", "error", "backpressure"] },
    "ID": {
      "type": "string",
      "pattern": "^msg_[A-Za-z0-9]{26}$",
      "description": "ULID-based message identifier"
    },
    "SEQ": {
      "type": "integer",
      "minimum": 0,
      "description": "Monotonic sequence number per sender"
    },
    "CHECKSUM": {
      "type": "string",
      "pattern": "^(sha256|crc32):[a-f0-9]+$"
    },
    "REPLY-TO": { "type": "string" },
    "PRIORITY": { "type": "integer", "minimum": 0, "maximum": 9 },
    "TTL": { "type": "string", "pattern": "^\\d+[smh]$" },
    "THREAD": { "type": "string" },
    "AWAIT": { "type": "string" },
    "CORRELATION": { "type": "string" },
    "VERSION": { "type": "integer", "default": 1 }
  },
  "required": ["TO"]
}
```

### 3.2 Runtime Validation

Add optional schema validation to parser:

```rust
use jsonschema::JSONSchema;

lazy_static! {
    static ref MESSAGE_SCHEMA: JSONSchema =
        JSONSchema::compile(&serde_json::from_str(include_str!("schema.json")).unwrap())
        .expect("Invalid schema");
}

fn validate_message(msg: &ParsedRelayCommand) -> Result<(), Vec<ValidationError>> {
    let json = serde_json::to_value(msg)?;
    MESSAGE_SCHEMA.validate(&json)
        .map_err(|errors| errors.collect())
}
```

**Complexity**: Low - Optional validation, doesn't block parsing.

---

## 4. Error Taxonomy

### 4.1 Error Code Categories

| Category | Codes | Retry Strategy |
|----------|-------|----------------|
| Validation | `INVALID_FORMAT`, `MISSING_HEADER`, `CHECKSUM_MISMATCH` | Never retry, fix message |
| Routing | `AGENT_NOT_FOUND`, `PERMISSION_DENIED` | Never retry without change |
| Delivery | `AGENT_OFFLINE`, `AGENT_BUSY`, `QUEUE_FULL` | Retry with backoff |
| System | `RATE_LIMITED`, `INTERNAL_ERROR` | Retry with exponential backoff |
| Protocol | `VERSION_MISMATCH` | Reconnect with lower version |

### 4.2 Retry Policy

```rust
struct RetryPolicy {
    max_retries: u32,
    base_delay_ms: u64,
    max_delay_ms: u64,
    jitter_factor: f64,  // 0.0 - 1.0
}

impl RetryPolicy {
    fn delay_for_attempt(&self, attempt: u32) -> Duration {
        let base = self.base_delay_ms * 2u64.pow(attempt);
        let capped = base.min(self.max_delay_ms);
        let jitter = (random::<f64>() * self.jitter_factor * capped as f64) as u64;
        Duration::from_millis(capped + jitter)
    }
}

// Default policy
const DEFAULT_RETRY_POLICY: RetryPolicy = RetryPolicy {
    max_retries: 3,
    base_delay_ms: 300,
    max_delay_ms: 30_000,
    jitter_factor: 0.2,
};
```

---

## 5. Migration Path

### 5.1 Version Rollout Strategy

**Phase 1: v1.1 (Non-breaking additions)**
- Add optional headers: `ID`, `SEQ`, `CHECKSUM`, `PRIORITY`
- Extend error codes (new codes, same format)
- Add capability flags to HELLO/WELCOME
- Timeline: 1 sprint

**Phase 2: v1.2 (Enhanced semantics)**
- Implement backpressure protocol
- Add CORRELATION for sync messages
- Add VERSION header to all messages
- Timeline: 1 sprint

**Phase 3: v2.0 (Optional strict mode)**
- Optional strict ordering enforcement
- Optional checksum verification
- Optional message expiry (TTL)
- Timeline: 2 sprints

### 5.2 Backward Compatibility Rules

1. **New headers are always optional** - Old agents ignore unknown headers
2. **New error codes fall back** - Unrecognized codes treated as `INTERNAL`
3. **Version defaults to 1** - Missing VERSION header implies v1
4. **Capability negotiation is additive** - Only enable features both parties support

### 5.3 Deprecation Timeline

| Feature | Deprecated | Removed |
|---------|------------|---------|
| Messages without ID | v1.2 (warning) | v3.0 |
| Untyped errors | v1.2 (warning) | v3.0 |
| Missing VERSION header | v2.0 (warning) | v3.0 |

### 5.4 Agent Upgrade Path

```bash
# v1 agent (current)
cat > $AGENT_RELAY_OUTBOX/msg << 'EOF'
TO: Bob

Hello Bob
EOF

# v1.1+ agent (enhanced, backward compatible)
cat > $AGENT_RELAY_OUTBOX/msg << 'EOF'
TO: Bob
ID: msg_01HV8X9Y2Z3W4Q5R6S7T8U9V0
SEQ: 42
VERSION: 2

Hello Bob
EOF
```

Old agents can communicate with new agents without changes. New agents get enhanced reliability when talking to each other.

---

## 6. Success Metrics

### 6.1 Production-Ready Definition

| Metric | Target | Measurement |
|--------|--------|-------------|
| Message delivery rate | 99.9% | Delivered / Sent (non-offline targets) |
| Message latency (p50) | < 50ms | Injection to delivery |
| Message latency (p99) | < 500ms | Injection to delivery |
| Protocol error rate | < 0.1% | Errors / Total messages |
| Recovery time | < 5s | Agent restart to active |
| Queue overflow rate | < 0.01% | Dropped / Total messages |

### 6.2 Reliability Targets

- **Zero message loss** for delivered messages (checksum verified)
- **Exactly-once delivery** for sync messages (correlation tracked)
- **At-least-once delivery** for async messages (retry on failure)
- **Ordered delivery** within single thread (sequence tracked)

### 6.3 Performance Targets

```
Messages/second/agent: 100+ (burst: 1000+)
Concurrent agents: 100+ per daemon
Message size limit: 1 MiB
Queue depth per agent: 100 messages
Backpressure latency: < 10ms to signal
```

### 6.4 Observability Targets

- **Traceability**: Every message traceable via ID
- **Debugging**: Human-readable format preserved
- **Metrics**: Queue depth, latency percentiles, error rates
- **Logging**: Structured logs with correlation IDs

---

## 7. Implementation Priorities

### 7.1 Priority Matrix

| Item | Impact | Effort | Priority |
|------|--------|--------|----------|
| Rich error taxonomy | High | Low | **P0** |
| Message IDs | High | Low | **P0** |
| Version negotiation | High | Low | **P0** |
| Backpressure protocol | High | Medium | **P1** |
| Sequence numbers | Medium | Medium | **P1** |
| Sync improvements | Medium | Medium | **P1** |
| Checksum verification | Low | Low | **P2** |
| Schema validation | Low | Low | **P2** |
| TTL/expiry | Low | Medium | **P3** |

### 7.2 Implementation Order

**Sprint 1: Foundation (P0)**
1. Add `ID` header generation and parsing
2. Expand error code taxonomy
3. Add VERSION to HELLO/WELCOME
4. Update JSON schemas

**Sprint 2: Reliability (P1)**
1. Implement backpressure signaling
2. Add sequence tracking (optional)
3. Enhance sync/AWAIT with CORRELATION
4. Add retry policy with jitter

**Sprint 3: Hardening (P2)**
1. Add checksum generation/verification
2. Runtime schema validation
3. TTL enforcement
4. Observability metrics

### 7.3 Files to Modify

| Component | Files | Changes |
|-----------|-------|---------|
| Rust Parser | `relay-pty/src/parser.rs` | New header parsing |
| Rust Protocol | `relay-pty/src/protocol.rs` | New types |
| TS Schemas | `packages/protocol/src/relay-pty-schemas.ts` | New interfaces |
| JSON Schemas | `docs/schemas/*.json` | New fields |
| Daemon | `packages/daemon/src/daemon.ts` | Backpressure, sequence tracking |
| Orchestrator | `packages/bridge/src/orchestrator.ts` | Correlation, routing |

---

## Appendix A: Before/After Examples

### A.1 Simple Message

**Before (v1)**:
```
TO: Bob

Please review the PR.
```

**After (v2)**:
```
TO: Bob
ID: msg_01HV8X9Y2Z3W4Q5R6S7T8U9V0
SEQ: 42
VERSION: 2

Please review the PR.
```

### A.2 Sync Message

**Before (v1)**:
```
TO: Bob
AWAIT: 30s

Please confirm receipt.
```

**After (v2)**:
```
TO: Bob
AWAIT: 30s
CORRELATION: corr_01HV8X9Y2Z
ID: msg_01HV8X9Y2Z3W4Q5R6S7T8U9V0
VERSION: 2

Please confirm receipt.
```

**Response (v2)**:
```
TO: Alice
KIND: ack
CORRELATION: corr_01HV8X9Y2Z
REPLY-TO: msg_01HV8X9Y2Z3W4Q5R6S7T8U9V0
ID: msg_01HV8Y0Z3A4B5C6D7E8F9G0H1
VERSION: 2

ACK: Confirmed, reviewing now.
```

### A.3 Error Response

**Before (v1)**:
```
{
  "type": "ERROR",
  "payload": {
    "code": "NOT_FOUND",
    "message": "Agent not found",
    "fatal": false
  }
}
```

**After (v2)**:
```
KIND: error
CODE: AGENT_OFFLINE
CATEGORY: delivery
RETRYABLE: true
RETRY-AFTER: 5000
CORRELATION: corr_01HV8X9Y2Z

Agent "Bob" is currently offline. Last seen 5 minutes ago.
```

---

## Appendix B: Open Questions

1. **Checksum algorithm**: SHA-256 vs CRC32 (SHA-256 is safer, CRC32 is faster)
2. **Message ID format**: ULID vs UUID (ULID is sortable, UUID is more common)
3. **Sequence scope**: Per-agent global vs per-target vs per-thread?
4. **Backpressure threshold**: 80% queue depth or configurable?
5. **Schema validation**: Strict (reject) vs lenient (warn)?

---

## Appendix C: Glossary

| Term | Definition |
|------|------------|
| **Atomicity** | Message is either fully delivered or not at all |
| **Backpressure** | Signal to slow down message production |
| **Correlation** | Linking request/response pairs |
| **Idempotency** | Same message can be delivered multiple times safely |
| **Sequence** | Monotonic counter for ordering |
| **TTL** | Time-to-live before message expires |
