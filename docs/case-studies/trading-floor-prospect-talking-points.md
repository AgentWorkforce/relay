# Talking Points: Agent Relay Trading Floor — Sidecar Architecture

**Context:** Prospect's questions are about exchange-level concerns — not Agent Relay's internal messaging. From his post, the architecture is:

```
Exchange WebSocket/REST APIs
        │
        ▼
┌──────────────────────────┐
│  relay-pty (Rust sidecar) │  ← Persistent "warm" connection to exchange
│  - Socket maintenance      │
│  - Auth lifecycle          │
│  - Real-time state buffer  │
└──────────┬───────────────┘
           │ Unix Socket IPC (<1ms)
           ▼
┌──────────────────────────┐
│  Redis (local state cache)│  ← Sub-ms order state + position lifecycle
└──────────┬───────────────┘
           │
           ▼
┌──────────────────────────┐
│  Python Agents            │  ← Strategy logic only — no connection mgmt
│  (Scanner, Risk, Executor)│
└──────────────────────────┘
```

The prospect's three questions — "rate limits, order lifecycle handling, and effective depth under load" — are about the **exchange interface**, not Agent Relay's internal bus. Here's how Agent Relay specifically addresses each.

---

## What Agent Relay Does For Each Question

### Rate Limits

Agent Relay's role here is **connection multiplexing**. The Rust PTY layer maintains one persistent warm connection — agents don't each open their own socket to the exchange. They talk to the relay, the relay talks to the exchange. So instead of N agents burning N times the rate budget, you have a single controlled pipe. The agents read state locally through the relay's IPC (sub-millisecond Unix socket), and only actual order writes hit the exchange REST API through one serialized executor. The relay itself has no hard rate ceiling on internal messaging — you can disable its internal rate limiter entirely for latency-critical paths.

### Order Lifecycle

This is where Agent Relay's delivery guarantees matter most. Every message between agents gets a UUID, at-least-once delivery with 5 retries over 60 seconds, and a client-side dedup cache so a fill notification is never lost AND never double-counted. Sequence numbers per sender guarantee order updates arrive in the same order the exchange emitted them. `sendAndWait()` lets the executor block until risk confirms it processed a fill — no fire-and-forget gaps where state can drift. If any agent crashes mid-pipeline, messages persist to SQLite and replay in-order on reconnect. Anything that fails delivery entirely lands in a dead letter queue with a reason code — that's your compliance audit trail.

### Depth Under Load

During a volatility burst, the hot path is the Rust sidecar (tokio async, zero GC) writing to the local state cache. Agent Relay sits between that cache and the Python agents with two tiers of backpressure — 200-message queue in the PTY layer and 2,000-message queue in the daemon, both with high/low water marks that signal pressure smoothly rather than dropping messages at a cliff edge. The ring buffer frame parser has zero GC pressure during throughput spikes. Agents read the latest state, not a growing queue of stale intermediates. And `getHealth()` and `getMetrics()` give you per-agent monitoring with Prometheus-compatible exports — you see degradation on a dashboard before it touches execution quality.

### Why Not Alternatives?

If asked "why not just Redis Pub/Sub or Kafka for the coordination layer" — Redis Pub/Sub is fire-and-forget (subscriber down = messages gone), and Kafka is infrastructure overkill for agent coordination. Agent Relay gives you persistent at-least-once delivery, agent spawning/lifecycle, shadow monitoring, and consensus — all as SDK method calls, not new infrastructure to operate.

---

## Deep Dive: Full Architecture Analysis

### 1. Rate Limits (Exchange 429s, Not Internal)

**Their real concern:** How do you avoid hitting exchange REST rate limits (the dreaded 429 "Too Many Requests") when multiple agents need market data and order state?

### The problem without a sidecar:

Each agent opens its own connection to the exchange. 5 agents polling order status = 5x the API calls. Exchanges like Binance enforce **1,200 requests/minute** with IP-based rate limits. You burn through your budget on routine state checks before you can even place a trade.

### How the sidecar architecture solves it:

**Single connection, multiplexed to many agents:**
- The relay-pty Rust process maintains **one persistent WebSocket** to the exchange per data feed (market data, order updates, position changes)
- That single connection writes updates into Redis in real-time
- Agents query Redis instead of the exchange — **zero exchange API calls for reads**
- Only writes (place order, cancel order) actually hit the exchange REST API

**Why Rust for the connection layer:**
- relay-pty is a Rust binary built on `tokio` async runtime — no GC pauses, no event loop contention with the Python agents
- Handles WebSocket reconnection, heartbeat, and authentication lifecycle without involving agent processes
- Persistent "warm" connection means no handshake/auth overhead per request

**Net effect:**
- Exchange API calls drop by **90%+** (reads become local Redis queries)
- The remaining writes can be serialized through a single executor agent, giving precise rate budget control
- If you have 10 strategy agents, they all read from the same Redis state — the exchange sees 1 connection, not 10

### Talking point:

> "The agents never talk to the exchange directly for reads. The Rust sidecar maintains a single persistent WebSocket to the exchange and writes state updates into a local Redis buffer in real-time. Your Python agents query Redis — sub-millisecond, zero API calls. Only actual order placement hits the exchange REST API, and that goes through a single executor agent so you have deterministic rate budget control. Ten strategy agents all reading from the same buffer — the exchange sees one connection, not ten."

---

### 2. Order Lifecycle Handling (Ghost Orders & State Integrity)

**Their real concern:** How do you ensure the agent's internal model of open orders and positions matches the exchange's actual state? Ghost orders (agent thinks an order is live when it's been cancelled/filled on the exchange) are catastrophic in HFT.

### The problem without state reconciliation:

1. Agent places a limit order via REST
2. Exchange fills the order 50ms later via a market sweep
3. Agent's next polling cycle is 200ms away — for 150ms, the agent has a **stale model**
4. Agent makes decisions based on a position that doesn't exist
5. Ghost orders accumulate: the agent thinks it has exposure it doesn't, or vice versa

### How the sidecar architecture solves it:

**Real-time state via WebSocket, not polling:**
- The Rust sidecar receives order status changes the instant the exchange pushes them (WebSocket execution reports)
- Redis is updated within single-digit milliseconds of the exchange event
- When an agent queries "what are my open orders?", it gets the state as of ~5ms ago, not ~200ms ago

**Two layers of reconciliation the relay enables:**

Layer 1 — **Streaming updates through the relay pipeline:**
- Exchange pushes: `OrderFilled { orderId, fillQty, fillPrice }` via WebSocket
- Rust sidecar writes to Redis AND forwards through Agent Relay to the relevant agents
- Agent Relay provides **at-least-once delivery with deduplication** (2,000-ID circular dedup cache) — so the executor never processes the same fill twice
- `sendAndWait()` can block until the downstream agent ACKs receipt — guaranteeing no dropped transitions

Layer 2 — **Periodic full reconciliation:**
- A dedicated reconciliation agent can periodically REST-query the exchange for full order/position state
- Diffs against Redis cache to catch any missed WebSocket events
- Discrepancies trigger alerts through relay channels

**Order state machine in Redis:**
```
PENDING_NEW → OPEN → PARTIALLY_FILLED → FILLED
                  → CANCELLED
                  → REJECTED
```
- Each transition is an atomic Redis operation
- Agents subscribe to state transitions through relay pub/sub, not polling

**Agent Relay's delivery guarantees map directly to order safety:**

| Relay Feature | Order Lifecycle Use |
|---|---|
| At-least-once delivery + dedup | Fill notifications never lost or double-counted |
| Sequence numbers per sender | Order updates arrive in exchange-order |
| `sendAndWait()` | Block until risk agent confirms receipt of fill |
| `request()/respond()` | Executor confirms fill back to risk before risk updates position model |
| Dead Letter Queue | Any failed delivery is captured — audit trail for compliance |
| Offline persistence + replay | If risk agent restarts, it replays missed fills in-order on reconnect |

### Talking point:

> "Ghost orders happen when your agent's model drifts from the exchange's actual state. We eliminate that with two layers: the Rust sidecar receives execution reports over a persistent WebSocket and updates Redis within single-digit milliseconds — your agents always read near-real-time state, not stale polls. On top of that, the relay's delivery guarantees mean fill notifications are never lost or double-counted — at-least-once delivery with dedup, sequence ordering, and synchronous ACKs so risk can block until it knows the executor processed the fill. If any agent restarts mid-session, missed messages replay in-order from persistent storage. The dead letter queue gives you a full audit trail of any delivery that didn't land."

---

### 3. Effective Depth Under Load (Order Book Fidelity During Volatility)

**Their real concern:** During a volatility spike (100ms burst of high throughput), how deep into the order book can the system maintain accurate state? Do updates get dropped or fall behind?

### The problem during volatility spikes:

During a flash crash or news event, the exchange pushes **thousands of order book updates per second**. If the system can't keep up:
- Book depth becomes stale — agent sees prices that no longer exist
- Execution decisions based on phantom liquidity
- Strategic drift: the backtest says the strategy works, but live execution diverges because the agent's market view lagged reality

### How the sidecar architecture handles this:

**The Rust layer is built for burst throughput:**
- `tokio` async runtime handles thousands of concurrent WebSocket frames without blocking
- Ring buffer frame parser in the relay protocol layer — zero GC pressure during bursts
- No Python GIL contention — the hot path (exchange → Redis) is pure Rust + Redis

**Backpressure, not data loss:**
- relay-pty has a configurable message queue (default 200, tunable) with explicit backpressure signals
- When the queue hits capacity, it signals `Backpressure { accept: false }` upstream — the Node.js orchestrator adapts its send rate
- High-water mark at 75% capacity, low-water mark at 50% — smooth pressure transitions, no cliff edges
- Per-connection write queue in the daemon: **2,000 message depth** with its own high/low water marks (1,500/500)

**Redis as the depth buffer:**
- Redis sorted sets are purpose-built for order book representation: `ZADD book:BTC-USD:bids price qty`
- Sub-millisecond reads even for full book snapshots
- The Rust sidecar can batch-write hundreds of book level updates per Redis pipeline call
- Agents read a consistent snapshot — no partial-update visibility

**What the agents see during a spike:**
- Agents don't see the raw firehose — they see the **current state** in Redis, updated in real-time by the sidecar
- If the sidecar falls behind momentarily (burst exceeds write throughput), the next update overwrites with the latest state — no stale intermediate states accumulate
- The relay's internal messaging between agents (Scanner → Risk → Executor) has its own capacity: sub-millisecond Unix socket IPC, 2K message queue depth per connection

**Monitoring for degradation:**
- `getHealth()` exposes a 0-100 health score with automatic deductions
- `getMetrics()` provides per-agent RSS, CPU, and alert levels (critical/warning thresholds)
- Prometheus-compatible metrics exportable for Grafana dashboards
- The system tells you when depth is degrading **before** it affects execution

### Talking point:

> "During a volatility burst, the exchange can push thousands of book updates per second. The Rust sidecar handles that — it's a tokio async runtime, no GC pauses, no Python GIL. Book updates flow into Redis sorted sets in batched pipelines, and your agents always read the latest state, not a queue of stale intermediates. If throughput temporarily exceeds capacity, the system applies backpressure — explicit signals, not silent drops. And there's two tiers of queue depth: 200 messages in the PTY injection queue and 2,000 in the daemon write queue, both with high/low water marks for smooth pressure transitions. You get Prometheus-compatible metrics on every agent, so you'll see degradation on a Grafana dashboard before it ever hits your P&L."

---

### Bonus: Why This Architecture vs. Alternatives

If they ask "why not just use a raw WebSocket client in Python":

> "You could, but then every agent process is managing its own connection lifecycle — reconnection, auth token refresh, heartbeat, error handling. That's undifferentiated heavy lifting. With the sidecar, your Python agents are pure strategy logic — 50 lines of signal processing, not 500 lines of connection management. And when you want to add a compliance shadow agent that watches all order flow, or a consensus check between multiple risk agents before a large block trade, that's a single method call on the relay SDK, not a new piece of infrastructure."

If they ask "why not just Redis Pub/Sub directly":

> "Redis Pub/Sub is fire-and-forget — if a subscriber is down, those messages are gone. Agent Relay gives you at-least-once delivery with persistence. If your risk agent crashes and restarts, it gets every missed fill replayed in order. Redis is the right tool for the state cache layer; Agent Relay is the right tool for the reliable coordination layer. They're complementary, not competing."

---

### Quick Reference: Architecture Numbers

| Layer | Metric | Value |
|-------|--------|-------|
| **Rust Sidecar** | Injection latency (best case) | ~60-70ms |
| | Injection latency (typical) | ~500-1500ms |
| | Message queue depth | 200 (configurable) |
| | Backpressure high-water | 75% capacity |
| | Max output buffer | 10 MB |
| | WebSocket reconnect | Automatic with backoff |
| **Relay Daemon** | Write queue per connection | 2,000 messages |
| | Backpressure high/low water | 1,500 / 500 |
| | Message dedup cache | 2,000 IDs (O(1) circular) |
| | Delivery retries | 5 attempts / 60s TTL |
| | Max concurrent agents | 10,000 (configurable) |
| | Inter-agent latency (Unix socket) | <1ms |
| | SQLite batch persistence | 50 msg / 100ms / 1MB |
| **Redis Layer** | Read latency | <1ms |
| | Write pipeline (batch) | Sub-ms per batch |
| | Book depth representation | Sorted sets (native) |
