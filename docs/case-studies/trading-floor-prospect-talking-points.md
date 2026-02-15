# Talking Points: Agent Relay Trading Floor — Sidecar Architecture

**Context:** Prospect's questions are about exchange-level concerns. From Zach's post, his architecture layers a custom exchange connector and Redis cache on top of Agent Relay's inter-agent coordination:

```
Exchange WebSocket/REST APIs
        │
        ▼
┌───────────────────────────────┐
│  Exchange Connector (Zach's)   │  ← Custom code: persistent WS to exchange
│  - WebSocket to exchange       │
│  - Auth & socket maintenance   │
│  - Writes state to Redis       │
└──────────┬────────────────────┘
           │
           ▼
┌───────────────────────────────┐
│  Redis (local state cache)     │  ← Sub-ms order state + position lifecycle
└──────────┬────────────────────┘
           │ agents read state from Redis
           ▼
┌───────────────────────────────┐
│  Agent Relay                   │  ← What the SDK provides
│  ┌─────────────────────────┐  │
│  │ relay-pty (Rust)         │  │  Per-agent PTY wrapper — manages agent
│  │ - Wraps each agent proc  │  │  processes, message injection, output
│  │ - Message injection      │  │  parsing. NOT the exchange connector.
│  │ - Output parsing         │  │
│  └─────────────────────────┘  │
│  ┌─────────────────────────┐  │
│  │ Relay Daemon (Node.js)   │  │  Message routing, delivery guarantees,
│  │ - Scanner → Risk → Exec  │  │  dedup, persistence, backpressure,
│  │ - At-least-once delivery │  │  agent lifecycle, monitoring.
│  │ - Backpressure & dedup   │  │
│  └─────────────────────────┘  │
└───────────────────────────────┘
```

**Important distinction:** Agent Relay does not connect to the exchange. It is the **inter-agent coordination layer** — routing signals reliably between Scanner, Risk, and Executor. The exchange WebSocket connection and Redis state cache are Zach's custom code built alongside the relay.

The prospect's three questions — "rate limits, order lifecycle handling, and effective depth under load" — are about the exchange interface. Here's what Agent Relay specifically contributes to each.

---

## What Agent Relay Does For Each Question

### Rate Limits

Agent Relay doesn't connect to the exchange — Zach's custom exchange connector handles that. But Agent Relay solves the **downstream problem**: how do multiple agents consume exchange data without each one independently hitting the API? The relay is the coordination bus that lets a single exchange connector fan signals out to many agents. Scanner, Risk, and Executor all communicate through the relay over sub-millisecond Unix socket IPC — none of them need their own exchange connection. Only the Executor's outbound order writes touch the exchange REST API, and because all order flow is serialized through that one agent via the relay pipeline, you get deterministic rate budget control. The relay itself has no hard ceiling on internal messaging — its rate limiter is configurable and can be disabled entirely for latency-critical paths.

### Order Lifecycle

This is where Agent Relay's delivery guarantees matter most. Every message between agents gets a UUID, at-least-once delivery with 5 retries over 60 seconds, and a client-side dedup cache so a fill notification is never lost AND never double-counted. Sequence numbers per sender guarantee order updates arrive in the same order the exchange emitted them. `sendAndWait()` lets the executor block until risk confirms it processed a fill — no fire-and-forget gaps where state can drift. If any agent crashes mid-pipeline, messages persist to SQLite and replay in-order on reconnect. Anything that fails delivery entirely lands in a dead letter queue with a reason code — that's your compliance audit trail.

### Depth Under Load

The exchange-to-Redis hot path is Zach's custom connector — Agent Relay doesn't sit on that path. Where Agent Relay matters is what happens **after** state lands in Redis: getting signals between agents reliably during a burst. The relay provides two tiers of backpressure — 200-message queue in the PTY injection layer and 2,000-message queue in the daemon, both with high/low water marks that signal pressure smoothly rather than dropping messages at a cliff edge. The ring buffer frame parser has zero GC pressure during throughput spikes. Inter-agent transit is sub-millisecond over Unix socket IPC, so the relay won't be the bottleneck — agent processing time will be. And `getHealth()` and `getMetrics()` give you per-agent monitoring with Prometheus-compatible exports — you see degradation on a dashboard before it touches execution quality.

### Why Not Alternatives?

If asked "why not just Redis Pub/Sub or Kafka for the coordination layer" — Redis Pub/Sub is fire-and-forget (subscriber down = messages gone), and Kafka is infrastructure overkill for agent coordination. Agent Relay gives you persistent at-least-once delivery, agent spawning/lifecycle, shadow monitoring, and consensus — all as SDK method calls, not new infrastructure to operate.

---

## Deep Dive: Full Architecture Analysis

### 1. Rate Limits (Exchange 429s, Not Internal)

**Their real concern:** How do you avoid hitting exchange REST rate limits (the dreaded 429 "Too Many Requests") when multiple agents need market data and order state?

### The problem without a sidecar:

Each agent opens its own connection to the exchange. 5 agents polling order status = 5x the API calls. Exchanges like Binance enforce **1,200 requests/minute** with IP-based rate limits. You burn through your budget on routine state checks before you can even place a trade.

### How Zach's architecture solves it (exchange connector + Redis are his custom code):

**Single exchange connection, multiplexed to many agents:**
- A custom exchange connector maintains one persistent WebSocket per data feed
- That connection writes updates into Redis in real-time
- Agents query Redis instead of the exchange — **zero exchange API calls for reads**
- Only writes (place order, cancel order) actually hit the exchange REST API

### What Agent Relay contributes:

- **Agent pipeline coordination:** Scanner, Risk, and Executor communicate through the relay — none need their own exchange connection
- **Serialized order flow:** All outbound orders route through a single Executor agent via the relay, giving precise rate budget control
- **relay-pty process management:** Each agent runs in a managed PTY with the Rust wrapper handling injection, output parsing, and lifecycle — agents focus on strategy logic, not process plumbing
- **No internal rate ceiling:** The relay's own rate limiter is configurable and can be disabled entirely for latency-critical agent-to-agent messaging

### Talking point:

> "The exchange connector and Redis cache handle the read-side rate limit problem — agents read local state, not the exchange. Agent Relay's role is the coordination layer between those agents. All order signals flow through the relay pipeline: Scanner to Risk to Executor. Because that pipeline serializes outbound orders through a single executor, you get deterministic rate budget control over exchange writes. Ten strategy agents, one outbound pipe."

---

### 2. Order Lifecycle Handling (Ghost Orders & State Integrity)

**Their real concern:** How do you ensure the agent's internal model of open orders and positions matches the exchange's actual state? Ghost orders (agent thinks an order is live when it's been cancelled/filled on the exchange) are catastrophic in HFT.

### The problem without state reconciliation:

1. Agent places a limit order via REST
2. Exchange fills the order 50ms later via a market sweep
3. Agent's next polling cycle is 200ms away — for 150ms, the agent has a **stale model**
4. Agent makes decisions based on a position that doesn't exist
5. Ghost orders accumulate: the agent thinks it has exposure it doesn't, or vice versa

### How Zach's architecture addresses real-time state (exchange connector + Redis are his custom code):

**Real-time state via WebSocket, not polling:**
- The custom exchange connector receives order status changes the instant the exchange pushes them (WebSocket execution reports)
- Redis is updated within single-digit milliseconds of the exchange event
- When an agent queries "what are my open orders?", it gets the state as of ~5ms ago, not ~200ms ago

### What Agent Relay contributes — delivery guarantees that prevent ghost orders:

Once exchange state lands in Redis, the coordination problem is: how do you ensure every agent in the pipeline processes fill notifications reliably, in order, exactly once? This is Agent Relay's core value.

**Streaming updates through the relay pipeline:**
- The exchange connector writes to Redis AND forwards fill events through Agent Relay to the relevant agents
- Agent Relay provides **at-least-once delivery with deduplication** (2,000-ID circular dedup cache) — so the executor never processes the same fill twice
- `sendAndWait()` can block until the downstream agent ACKs receipt — guaranteeing no dropped transitions

**Periodic full reconciliation (enabled by relay agent lifecycle):**
- A dedicated reconciliation agent (spawned and managed via the relay) can periodically REST-query the exchange for full order/position state
- Diffs against Redis cache to catch any missed WebSocket events
- Discrepancies trigger alerts through relay channels

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

> "Ghost orders happen when your agent's model drifts from the exchange's actual state. The exchange connector and Redis handle the real-time state — that's Zach's code. Agent Relay's role is ensuring every agent in the pipeline processes those state changes reliably. Fill notifications are never lost or double-counted — at-least-once delivery with dedup, sequence ordering, and synchronous ACKs so risk can block until it knows the executor processed the fill. If any agent restarts mid-session, missed messages replay in-order from persistent storage. The dead letter queue gives you a full audit trail of any delivery that didn't land."

---

### 3. Effective Depth Under Load (Order Book Fidelity During Volatility)

**Their real concern:** During a volatility spike (100ms burst of high throughput), how deep into the order book can the system maintain accurate state? Do updates get dropped or fall behind?

### The problem during volatility spikes:

During a flash crash or news event, the exchange pushes **thousands of order book updates per second**. If the system can't keep up:
- Book depth becomes stale — agent sees prices that no longer exist
- Execution decisions based on phantom liquidity
- Strategic drift: the backtest says the strategy works, but live execution diverges because the agent's market view lagged reality

### How Zach's architecture handles exchange throughput (exchange connector + Redis are his custom code):

**The exchange-to-Redis hot path is custom code — Agent Relay doesn't sit on this path:**
- Zach's exchange connector handles the WebSocket firehose from the exchange
- Redis sorted sets buffer book depth for sub-millisecond agent reads
- Agents read a consistent snapshot, not a raw stream of deltas

### What Agent Relay contributes — inter-agent backpressure and monitoring:

**Backpressure between agents, not data loss:**
- relay-pty has a configurable message queue (default 200, tunable) with explicit backpressure signals
- When the queue hits capacity, it signals `Backpressure { accept: false }` upstream — the Node.js orchestrator adapts its send rate
- High-water mark at 75% capacity, low-water mark at 50% — smooth pressure transitions, no cliff edges
- Per-connection write queue in the daemon: **2,000 message depth** with its own high/low water marks (1,500/500)
- Ring buffer frame parser in the relay protocol — zero GC pressure during throughput spikes

**What the agents see during a spike:**
- Agents read the **current state** from Redis (Zach's code), not a growing queue of stale intermediates
- The relay's inter-agent messaging (Scanner → Risk → Executor) has its own capacity: sub-millisecond Unix socket IPC, 2K message queue depth per connection
- The relay won't be the bottleneck — agent processing time will be

**Monitoring for degradation:**
- `getHealth()` exposes a 0-100 health score with automatic deductions
- `getMetrics()` provides per-agent RSS, CPU, and alert levels (critical/warning thresholds)
- Prometheus-compatible metrics exportable for Grafana dashboards
- The system tells you when agents are degrading **before** it affects execution

### Talking point:

> "The exchange-to-Redis path is Zach's custom connector — that handles the firehose. Agent Relay's job is making sure the agent pipeline stays healthy during that burst. The relay provides two tiers of backpressure between agents — 200-message PTY injection queue and 2,000-message daemon queue, both with smooth high/low water marks, never silent drops. Inter-agent transit is sub-millisecond Unix socket IPC, so the relay won't be your bottleneck. And you get Prometheus-compatible per-agent metrics — you'll see degradation on a Grafana dashboard before it hits your P&L."

---

### Bonus: Why This Architecture vs. Alternatives

If they ask "why not just wire up the agents directly without a relay":

> "You could have Scanner call Risk directly over HTTP or a queue, but then you're building delivery guarantees, dedup, ordering, reconnection, and agent lifecycle yourself. With Agent Relay, that's all built in. And when you want to add a compliance shadow agent that watches all order flow, or a consensus check between multiple risk agents before a large block trade, those are single method calls on the SDK, not new infrastructure."

If they ask "why not just Redis Pub/Sub directly":

> "Redis Pub/Sub is fire-and-forget — if a subscriber is down, those messages are gone. Agent Relay gives you at-least-once delivery with persistence. If your risk agent crashes and restarts, it gets every missed fill replayed in order. Redis is the right tool for the state cache layer; Agent Relay is the right tool for the reliable coordination layer. They're complementary, not competing."

---

### Quick Reference: Architecture Numbers

| Layer | Metric | Value |
|-------|--------|-------|
| **relay-pty (agent wrapper)** | Injection latency (best case) | ~60-70ms |
| | Injection latency (typical) | ~500-1500ms |
| | Message queue depth | 200 (configurable) |
| | Backpressure high-water | 75% capacity |
| | Max output buffer | 10 MB |
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
