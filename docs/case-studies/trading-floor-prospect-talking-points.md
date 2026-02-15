# Talking Points: Agent Relay Trading Floor Prospect

**Context:** Prospect is evaluating Agent Relay for an algorithmic trading system.
Their questions: *"rate limits, order lifecycle handling, and effective depth under load."*

---

## 1. Rate Limits

**Their concern:** Can the system keep up with high-frequency signal throughput without dropping messages?

### What Agent Relay provides:

- **500 messages/second sustained rate per agent** with burst capacity of 1,000 (token bucket algorithm). This is per-agent, so a 3-agent pipeline (Scanner, Risk, Executor) gets 1,500 msg/s aggregate throughput.
- **Configurable** — the rate limiter accepts custom `messagesPerSecond` and `burstSize` values. Can be disabled entirely by passing `rateLimit: null` to the router config for latency-sensitive deployments.
- **No silent drops** — when rate-limited, the sender gets an explicit signal (not a silent discard). Messages that can't be delivered are routed to a Dead Letter Queue with reason `rate_limited`, so nothing is lost without a record.

### Talking point:

> "The default is 500 msg/s sustained per agent with 1K burst — for a 3-stage pipeline that's 1,500 msg/s aggregate before you even tune it. The rate limiter is token-bucket based and fully configurable — you can raise the ceiling or disable it entirely for latency-critical paths. Anything that does get limited goes to a dead letter queue, never a silent drop."

---

## 2. Order Lifecycle Handling

**Their concern:** What happens between signal generation and execution? Can messages get lost, duplicated, or arrive out of order?

### What Agent Relay provides:

**At-least-once delivery with deduplication:**
- Every message gets a UUID envelope ID
- The daemon tracks pending deliveries and retries up to **5 attempts** over a **60-second TTL** if no ACK is received (first retry after 5s)
- Client-side circular dedup cache (2,000 IDs, O(1)) prevents duplicate processing even if the daemon retries

**Full lifecycle visibility:**
- Messages transition through states: `unread → read → acked` (or `failed`)
- Failed messages go to a **Dead Letter Queue** with reason codes: `max_retries_exceeded`, `ttl_expired`, `connection_lost`, `target_not_found`
- DLQ is queryable and supports manual retry — you can build alerting on it

**Per-sender ordering guarantees:**
- Sequence numbers per sender, per topic — Scanner→Risk messages arrive in the order they were sent
- Session-aware: on reconnect, pending messages replay in sequence order

**Synchronous patterns available:**
- `sendAndWait()` — blocks until the recipient ACKs (configurable timeout, default 30s). Use this for the Scanner→Risk handoff if you need confirmation that Risk received the signal before scanning the next stock
- `request()/respond()` — full request/response pattern with correlation IDs. Use for Risk→Executor if you want Executor to confirm the fill back to Risk

**Offline resilience:**
- If an agent disconnects mid-pipeline, messages are persisted to SQLite and delivered when it reconnects
- Session resume with token-based recovery restores sequence state

### Talking point:

> "Every order signal has a full lifecycle — we track it from send through delivery to acknowledgment, with 5 retries over 60 seconds before it hits the dead letter queue. You get at-least-once delivery with client-side dedup so the executor never double-fills. The system supports both fire-and-forget and synchronous patterns — you can have your scanner block until risk ACKs receipt, and risk can wait for executor to confirm the fill. If any agent crashes mid-pipeline, messages persist to SQLite and replay in-order on reconnect."

---

## 3. Effective Depth Under Load

**Their concern:** How many concurrent signals can the system handle before latency degrades or messages queue up?

### What Agent Relay provides:

**Connection-level backpressure (no uncontrolled queuing):**
- Per-connection write queue with **2,000 message capacity**
- High-water mark at **1,500** triggers backpressure signal; low-water mark at **500** releases it
- When socket buffer fills, drain pauses until the OS-level TCP buffer clears (`socket.write()` return value + drain event)
- This is two-tier backpressure: application-level queue + OS socket buffer

**Architecture:**
- Single-process, non-blocking event loop (Node.js)
- Ring buffer frame parser eliminates GC pressure during high throughput
- Max frame size: 1 MiB — large payloads supported
- Heartbeat at 5s intervals with 30s timeout (exempts agents actively processing)

**Scaling characteristics:**
- **Up to 10,000 concurrent agents** on a single daemon instance (configurable via `MAX_AGENTS`)
- Broadcast fan-out is O(n) per message — fine for a 3-10 agent trading pipeline, becomes a consideration at 1,000+ agent broadcast targets
- For a Scanner→Risk→Executor pipeline specifically, the bottleneck is the agents' processing time, not the relay — message transit is sub-millisecond on the same machine (Unix socket IPC)

**Batched persistence:**
- SQLite writes batched at 50 messages or 100ms or 1MB — whichever triggers first
- Transaction-based for atomicity
- Failed batches re-queue automatically

**Monitoring built-in:**
- `getHealth()` returns a 0-100 health score with automatic deductions for issues
- `getMetrics()` exposes per-agent RSS, CPU, uptime, and alert levels
- Prometheus-compatible metrics available (agents total, healthy/unhealthy, crashes, restarts, memory, CPU)

### Talking point:

> "The write path has two-tier backpressure — application queue with 2K depth and high/low water marks, plus OS socket buffer awareness. Under load, the system applies backpressure rather than dropping messages. For a pipeline topology like yours (3 agents, sequential flow), message transit is sub-millisecond over Unix socket IPC — the bottleneck will be your risk model evaluation, not the messaging layer. The daemon supports up to 10K concurrent agents on one machine, with persistence batched at 50-message increments to keep SQLite writes efficient. And you have full observability — health scores, per-agent metrics, and Prometheus-compatible exports — so you'll see degradation before your users do."

---

## Bonus: Why Agent Relay vs. Raw Message Queues

If they ask "why not just use Redis/Kafka/ZeroMQ":

> "You could wire up a message queue, but then you're building the agent lifecycle yourself — spawning, health monitoring, reconnection, session resume, dead letter handling, and delivery tracking. Agent Relay gives you all of that as primitives. The SDK is ~3 lines to connect and send. And as your system grows — say you want a shadow agent monitoring all trades for compliance, or consensus between multiple risk agents before a large order — those are single method calls, not new infrastructure."

---

## Quick Reference: Numbers They'll Want

| Metric | Value |
|--------|-------|
| Sustained msg/s per agent | 500 (configurable) |
| Burst capacity | 1,000 tokens |
| Delivery retries | 5 attempts over 60s TTL |
| ACK timeout | 5s per attempt |
| Write queue depth | 2,000 messages per connection |
| Backpressure high-water | 1,500 messages |
| Message dedup cache | 2,000 IDs (O(1) circular) |
| Max frame size | 1 MiB |
| Max concurrent agents | 10,000 (configurable) |
| Heartbeat interval | 5s (30s timeout) |
| SQLite batch size | 50 msg / 100ms / 1MB |
| DLQ retention | 7 days (configurable) |
| Memory warning threshold | 512 MB |
| Memory critical threshold | 1 GB |
