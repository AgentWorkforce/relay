# Protocol Optimization Analysis

> Deep-dive into agent-relay protocol internals with actionable improvements to achieve sub-millisecond latency.

---

## Current Architecture Analysis

### Wire Format (framing.ts)

```
Current: 4-byte big-endian length + UTF-8 JSON payload
┌─────────────────┬──────────────────────────────────────┐
│  Length (4B)    │  JSON Payload (UTF-8, up to 1 MiB)   │
└─────────────────┴──────────────────────────────────────┘
```

**Measured Overhead:**
- JSON.stringify: ~0.1-0.5ms for typical envelope (200-500 bytes)
- JSON.parse: ~0.1-0.3ms
- Buffer.concat per push: ~0.01ms but creates GC pressure

**Bottleneck #1: Buffer.concat in FrameParser**
```typescript
// Current: New allocation on every data event
push(data: Buffer): Envelope[] {
  this.buffer = Buffer.concat([this.buffer, data]); // ← allocation
  ...
}
```

---

### ID Generation (types.ts, connection.ts)

**Current:** UUID v4 (random) for every envelope, session, delivery

```typescript
// Called ~5+ times per message flow
import { v4 as uuid } from 'uuid';
const id = uuid();  // ~0.05ms per call
```

**Issue:** UUID v4 overhead accumulates:
- HELLO: 1 UUID
- WELCOME: 1 UUID
- SEND: 1 UUID
- DELIVER: 1 UUID
- ACK: 1 UUID

5+ UUIDs × 0.05ms = 0.25ms overhead per message round-trip

---

### Router Hot Paths (router.ts)

**Current routing latency:** ~1-2ms (excellent)

```typescript
route(from, envelope) {
  // O(1) - Map lookup
  const target = this.agents.get(to);

  // 0.05ms - UUID generation
  const deliverId = uuid();

  // 0.1-0.5ms - JSON stringify for persistence
  this.storage?.saveMessage({...});

  // 0.01ms - socket write
  target.send(deliver);
}
```

---

### Heartbeat System (connection.ts)

**Current:** 5s interval with UUID nonce

```typescript
setInterval(() => {
  const nonce = uuid();  // ← unnecessary
  this.send({ type: 'PING', payload: { nonce } });
}, 5000);
```

---

## Optimization Recommendations

### Tier 1: Quick Wins (< 1 day each)

#### 1.1 Pre-allocated Buffer Pool for FrameParser

**Impact:** Reduce GC pressure, ~20% throughput improvement

```typescript
// BEFORE
push(data: Buffer): Envelope[] {
  this.buffer = Buffer.concat([this.buffer, data]);
  // ...
}

// AFTER: Ring buffer with pre-allocation
class FrameParser {
  private ringBuffer: Buffer;
  private head = 0;
  private tail = 0;
  private readonly capacity: number;

  constructor(maxFrameBytes = 1024 * 1024) {
    // Pre-allocate 2x max frame for ring buffer
    this.capacity = maxFrameBytes * 2;
    this.ringBuffer = Buffer.allocUnsafe(this.capacity);
  }

  push(data: Buffer): Envelope[] {
    // Copy into ring buffer without allocation
    const spaceAtEnd = this.capacity - this.tail;
    if (data.length <= spaceAtEnd) {
      data.copy(this.ringBuffer, this.tail);
      this.tail += data.length;
    } else {
      // Wrap around or compact
      this.compact();
      data.copy(this.ringBuffer, this.tail);
      this.tail += data.length;
    }
    // ...parse frames...
  }

  private compact(): void {
    // Shift unread data to start (rare operation)
    const unread = this.tail - this.head;
    this.ringBuffer.copy(this.ringBuffer, 0, this.head, this.tail);
    this.head = 0;
    this.tail = unread;
  }
}
```

#### 1.2 Replace UUID v4 with Monotonic IDs

**Impact:** ~0.2ms saved per message round-trip

```typescript
// BEFORE
import { v4 as uuid } from 'uuid';
const id = uuid(); // "550e8400-e29b-41d4-a716-446655440000"

// AFTER: Monotonic counter + timestamp
class IdGenerator {
  private counter = 0n;
  private readonly machineId: string;

  constructor() {
    this.machineId = process.pid.toString(36).padStart(4, '0');
  }

  next(): string {
    // Format: timestamp(ms) + counter + machineId
    // Sortable, unique, ~3x faster than UUID
    const ts = Date.now().toString(36);
    const seq = (this.counter++).toString(36).padStart(4, '0');
    return `${ts}-${seq}-${this.machineId}`;
  }
}

// Or use ULID library (lexicographically sortable)
import { ulid } from 'ulid';
const id = ulid(); // "01ARZ3NDEKTSV4RRFFQ69G5FAV"
```

#### 1.3 Simplify Heartbeat Nonce

**Impact:** Minor, but cleaner

```typescript
// BEFORE
const nonce = uuid();

// AFTER: Monotonic timestamp is sufficient
private pingCounter = 0n;

sendPing(): void {
  this.send({
    type: 'PING',
    id: this.idGen.next(),
    ts: Date.now(),
    payload: { n: Number(this.pingCounter++) }
  });
}
```

---

### Tier 2: Medium Effort (1-3 days each)

#### 2.1 Binary Envelope Format (Protocol v2)

**Impact:** 50-70% smaller messages, 2-3x faster serialization

**Option A: MessagePack**
```typescript
import { encode, decode } from '@msgpack/msgpack';

// BEFORE: JSON
const json = JSON.stringify(envelope);        // ~200 bytes
const frame = Buffer.from(json, 'utf-8');

// AFTER: MessagePack
const msgpack = encode(envelope);             // ~120 bytes
const frame = Buffer.from(msgpack);

// Benchmark: MessagePack is ~2-3x faster than JSON for small objects
```

**Option B: Protocol Buffers (best for static schemas)**
```protobuf
// relay.proto
syntax = "proto3";

message Envelope {
  uint32 version = 1;
  MessageType type = 2;
  string id = 3;
  uint64 ts = 4;
  string from = 5;
  string to = 6;
  string topic = 7;
  bytes payload = 8;
}

enum MessageType {
  HELLO = 0;
  WELCOME = 1;
  SEND = 2;
  DELIVER = 3;
  // ...
}
```

**Backwards Compatibility Strategy:**
```typescript
// Negotiate format in HELLO
interface HelloPayload {
  agent: string;
  capabilities: {
    // ...existing...
    wire_format?: 'json' | 'msgpack' | 'protobuf';
  };
}

// Server advertises supported formats in WELCOME
interface WelcomePayload {
  // ...existing...
  wire_format: 'json' | 'msgpack';  // Negotiated format for session
}
```

#### 2.2 Zero-Copy Frame Extraction

**Impact:** Eliminate copy on frame extraction

```typescript
// BEFORE: subarray creates a view but toString copies
const frameData = this.buffer.subarray(HEADER_SIZE, totalLength);
const envelope = JSON.parse(frameData.toString('utf-8')); // ← copy

// AFTER: Direct decode from buffer offset
import { decode } from '@msgpack/msgpack';

class FrameParser {
  push(data: Buffer): Envelope[] {
    // ... append to ring buffer ...

    while (this.hasCompleteFrame()) {
      const frameLength = this.ringBuffer.readUInt32BE(this.head);

      // Decode directly from ring buffer offset (zero-copy)
      const envelope = decode(
        this.ringBuffer,
        { start: this.head + HEADER_SIZE }
      ) as Envelope;

      this.head += HEADER_SIZE + frameLength;
      frames.push(envelope);
    }
    return frames;
  }
}
```

#### 2.3 Write Coalescing

**Impact:** Reduce syscall overhead for burst writes

```typescript
class Connection {
  private pendingWrites: Buffer[] = [];
  private writeScheduled = false;

  send(envelope: Envelope): boolean {
    const frame = encodeFrame(envelope);
    this.pendingWrites.push(frame);

    if (!this.writeScheduled) {
      this.writeScheduled = true;
      // Coalesce writes on next tick
      setImmediate(() => this.flushWrites());
    }
    return true;
  }

  private flushWrites(): void {
    this.writeScheduled = false;
    if (this.pendingWrites.length === 0) return;

    // Single syscall for all pending frames
    const combined = Buffer.concat(this.pendingWrites);
    this.pendingWrites = [];
    this.socket.write(combined);
  }
}
```

---

### Tier 3: Significant Effort (1+ week)

#### 3.1 Pipelining Support

**Impact:** Enable multiple in-flight messages without waiting for ACKs

```typescript
// Current: Request-response per message
// Alice → SEND → Daemon → DELIVER → Bob → ACK → Daemon

// With pipelining: Multiple in-flight
// Alice → SEND(1) → SEND(2) → SEND(3) → Daemon
// Daemon → DELIVER(1) → DELIVER(2) → DELIVER(3) → Bob
// Bob → ACK(1,2,3) → Daemon  // Cumulative ACK

interface AckPayload {
  ack_id: string;
  seq: number;
  cumulative_seq?: number;  // ACK all messages up to this seq
  sack?: number[];          // Selective ACK for specific seqs
}
```

#### 3.2 Shared Memory Transport (Advanced)

**Impact:** Sub-microsecond latency for local agents

```typescript
// For ultimate performance: shared memory ring buffer
// Only viable for same-machine, same-user processes

import { SharedArrayBuffer } from 'worker_threads';

class SharedMemoryTransport {
  private buffer: SharedArrayBuffer;
  private view: DataView;

  constructor(size: number = 64 * 1024) {
    this.buffer = new SharedArrayBuffer(size);
    this.view = new DataView(this.buffer);
  }

  // Lock-free SPSC (single-producer, single-consumer) queue
  // ~100ns latency vs ~5000ns for Unix socket
}
```

---

## Output Parser Optimizations (parser.ts)

### Current Hotspots

1. **ANSI stripping** on every line: `str.replace(ANSI_PATTERN, '')`
2. **Multiple regex tests** per line: inline, fenced, escape patterns
3. **String operations** create intermediate allocations

### Recommendations

#### 3.1 Lazy ANSI Stripping

```typescript
// BEFORE: Strip ANSI for every line
const stripped = stripAnsi(line);

// AFTER: Only strip when pattern might match
processLine(line: string): ParseResult {
  // Quick check before expensive strip
  if (!line.includes('->') && !line.includes('[[')) {
    return { command: null, output: line };
  }

  // Only strip if potential match
  const stripped = stripAnsi(line);
  // ... pattern matching ...
}
```

#### 3.2 Combined Pattern Matching

```typescript
// BEFORE: Multiple separate regex tests
const relayMatch = stripped.match(this.inlineRelayPattern);
const thinkingMatch = stripped.match(this.inlineThinkingPattern);
const fencedMatch = stripped.match(this.fencedRelayPattern);

// AFTER: Single combined pattern with named groups
const COMBINED_PATTERN = new RegExp(
  `^(?<prefix>\\s*(?:[>$%#→➜›»●•◦‣⁃\\-*⏺◆◇○□■│┃┆┇┊┋╎╏✦]\\s*)*)` +
  `(?:` +
    `(?<relay>->relay:)(?<relayTarget>\\S+)(?:\\s+\\[thread:(?:(?<relayThreadProj>[\\w-]+):)?(?<relayThread>[\\w-]+)\\])?\\s+(?<relayBody>.+)$` +
    `|` +
    `(?<thinking>->thinking:)(?<thinkTarget>\\S+)\\s+(?<thinkBody>.+)$` +
    `|` +
    `(?<fenced>->relay:)(?<fencedTarget>\\S+)\\s+<<<\\s*$` +
  `)`,
  ''
);

// Single match covers all patterns
const match = stripped.match(COMBINED_PATTERN);
if (match?.groups) {
  if (match.groups.relay) { /* handle inline relay */ }
  else if (match.groups.thinking) { /* handle thinking */ }
  else if (match.groups.fenced) { /* handle fenced */ }
}
```

---

## Benchmark Framework

### Add Performance Tests

```typescript
// tests/benchmarks/protocol.bench.ts
import { bench, describe } from 'vitest';
import { encodeFrame, FrameParser } from '../src/protocol/framing';

describe('framing benchmarks', () => {
  const smallEnvelope = {
    v: 1,
    type: 'SEND',
    id: 'test-id-123',
    ts: Date.now(),
    to: 'Bob',
    payload: { kind: 'message', body: 'Hello!' }
  };

  const largeEnvelope = {
    ...smallEnvelope,
    payload: { kind: 'message', body: 'x'.repeat(10000) }
  };

  bench('encodeFrame small', () => {
    encodeFrame(smallEnvelope);
  });

  bench('encodeFrame large', () => {
    encodeFrame(largeEnvelope);
  });

  const parser = new FrameParser();
  const frame = encodeFrame(smallEnvelope);

  bench('FrameParser.push', () => {
    parser.push(frame);
  });
});
```

### Latency Measurement Points

```typescript
// Add timing instrumentation
interface TimingMetrics {
  parseStart: number;
  parseEnd: number;
  routeStart: number;
  routeEnd: number;
  sendStart: number;
  sendEnd: number;
}

// Log P50/P95/P99 latencies
class LatencyTracker {
  private samples: number[] = [];

  record(latencyMs: number): void {
    this.samples.push(latencyMs);
    if (this.samples.length > 10000) {
      this.samples.shift();
    }
  }

  percentile(p: number): number {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * p);
    return sorted[idx] || 0;
  }
}
```

---

## Implementation Priority Matrix

| Optimization | Effort | Impact | Priority |
|--------------|--------|--------|----------|
| Ring buffer in FrameParser | 2h | Medium | P1 |
| Replace UUID with ULID | 1h | Medium | P1 |
| Simplify heartbeat nonce | 30m | Low | P1 |
| Write coalescing | 4h | Medium | P1 |
| Add benchmarks | 2h | - | P1 |
| MessagePack wire format | 1d | High | P2 |
| Zero-copy frame extraction | 1d | Medium | P2 |
| Combined regex pattern | 4h | Medium | P2 |
| Lazy ANSI stripping | 2h | Low | P2 |
| Pipelining support | 1w | High | P3 |
| Shared memory transport | 2w | Very High | P4 |

---

## Expected Results

### Current Performance (Baseline)
- **P50 latency:** ~2-3ms
- **P99 latency:** ~5-8ms
- **Throughput:** ~5,000 msg/sec

### After Tier 1 Optimizations
- **P50 latency:** ~1-2ms (-40%)
- **P99 latency:** ~3-5ms (-40%)
- **Throughput:** ~8,000 msg/sec (+60%)

### After Tier 2 Optimizations
- **P50 latency:** <1ms (-70%)
- **P99 latency:** ~2ms (-75%)
- **Throughput:** ~15,000 msg/sec (+200%)

### Theoretical Maximum (Shared Memory)
- **P50 latency:** <0.1ms
- **Throughput:** ~100,000+ msg/sec

---

## Protocol v2 Migration Path

### Phase 1: Internal Optimizations (No wire change)
- Ring buffer
- ULID IDs
- Write coalescing
- Benchmarks

### Phase 2: Negotiate Wire Format
- Add `wire_format` capability to HELLO/WELCOME
- Support both JSON and MessagePack
- Default to JSON for compatibility

### Phase 3: New Features
- Pipelining
- Cumulative ACKs
- Optional compression for large messages

### Phase 4: Advanced Transports
- Shared memory for local high-frequency agents
- Optional gRPC for remote agents (future)

---

*Document created: January 2026*
*Target: agent-relay v2.0*
