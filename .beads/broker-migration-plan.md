# Broker SDK Migration Plan

## Context
Moving the CLI to use the broker-sdk (`packages/sdk-ts`) as the primary architecture. The Rust binary handles agent spawning, PTY management, and Relaycast WebSocket communication. The TypeScript SDK wraps it via stdio.

## Critical Issues to Address

### P0: Broker crash = orphaned agents
- No PID file, no process group cleanup, no reattach logic
- `BrokerState` saves names but cannot reconnect to running processes
- **Fix**: Persist PIDs in state.json, use process groups (setsid), add reattach-on-startup logic

### P0: Enable local `send_message` with async Relaycast publish
- Currently explicitly disabled in main.rs:2192 (returns unsupported_operation error)
- All messaging forced through Relaycast cloud round-trip (50-200ms)
- **Fix**: Single code path that always does both:

#### Flow: SDK → Broker → Local + Cloud
```
SDK calls sendMessage({ to: "Worker1", text: "..." })
  → stdio JSON frame to broker
  → Broker handles send_message:
      1. Local delivery (blocking, fast):
         - Look up target in WorkerRegistry
         - If found: deliver_relay to worker's PTY (verified delivery from Layer 1)
         - If not found: skip local delivery (message is cross-machine)
      2. Relaycast publish (async, fire-and-forget):
         - tokio::spawn a task that POSTs to Relaycast API
         - Pre-seed DedupCache with the message ID so WS echo is dropped
         - Dashboard sees the message, cross-machine agents receive via WS
      3. Reply to SDK with delivery status
```

#### Key design decisions:
- **NOT two code paths** — broker always does both (local + cloud). Local is the fast
  delivery mechanism. Relaycast is persistence/visibility/cross-machine. Neither is optional.
- **Local failure ≠ total failure** — if local inject fails but Relaycast publish succeeds,
  the message still reaches the agent via WS echo (slower but reliable fallback)
- **Relaycast failure ≠ total failure** — if cloud is down, local delivery still works.
  Failed publishes are logged but don't block the sender.
- **Dedup prevents double delivery** — when Relaycast echoes the message back via WS,
  DedupCache (already seeded with the message ID) drops it. No duplicate injection.
- **SDK `relay.ts` change** — `sendMessage()` routes through `client.sendMessage()` (stdio)
  instead of `RelaycastApi.sendToChannel()`. RelaycastApi becomes internal to the broker.

#### Rust implementation sketch (main.rs):
```rust
"send_message" => {
    let payload: SendMessagePayload = serde_json::from_value(frame.payload)?;

    // 1. Local delivery (if target is a local worker)
    let local_result = if let Some(targets) = resolve_local_targets(&workers, &payload.to) {
        for worker_name in targets {
            queue_and_try_delivery_raw(
                &mut workers, &mut pending_deliveries,
                &worker_name, &event_id, &from, &payload.to, &payload.text,
                payload.thread_id.clone(), priority, delivery_retry_interval,
            ).await?;
        }
        true
    } else {
        false
    };

    // 2. Async Relaycast publish (fire-and-forget)
    dedup.insert(&event_id);  // pre-seed to prevent WS echo re-injection
    let ws_tx = ws_publish_tx.clone();
    tokio::spawn(async move {
        let _ = ws_tx.send(RelaycastPublish { channel, text, event_id }).await;
    });

    // 3. Reply to SDK
    send_ok(out_tx, frame.request_id, json!({
        "event_id": event_id,
        "local_delivery": local_result,
        "targets": targets,
    })).await?;
}
```

#### SDK change (`packages/sdk-ts/src/relay.ts`):
- `makeAgent().sendMessage()` calls `client.sendMessage()` instead of `RelaycastApi`
- `human().sendMessage()` also routes through broker
- Remove direct `RelaycastApi` usage from the public API (broker handles it internally)
- `RelaycastApi` class remains but only used by broker internals

### P1: Integration tests for core event loops
- run_init, run_wrap, run_pty_worker have zero test coverage
- Pure function unit tests exist but orchestration is untested
- **Fix**: Add integration tests for broker lifecycle, message delivery, worker spawn/release

### P1: Atomic state persistence
- BrokerState::save() uses direct fs::write() (not atomic)
- auth.rs already does this correctly with tmp+rename
- **Fix**: Use same tmp+rename pattern

### P2: Multi-broker guard
- No file locking on .agent-relay/ directory
- Two brokers in same dir silently corrupt state
- **Fix**: Advisory flock on a lockfile

### P2: Token out of WebSocket URL
- Auth token in query string leaks into logs
- **Fix**: Send via WS subprotocol header or first message

### P2: PTY auto-response patterns are hardcoded
- Pattern-matches against CLI UI text that can change
- **Fix**: Make patterns configurable via config file

### P3: main.rs decomposition
- 3500+ lines in one file
- **Fix**: Extract run_init, run_wrap, run_pty_worker, helpers into modules

## Legacy Package Cleanup
~17 TypeScript packages become legacy when broker-sdk is primary:
- daemon, protocol, bridge, wrapper, config, storage, continuity, resiliency
- telemetry, spawner, state, hooks, memory, policy, trajectory, user-directory, utils, sdk

Keep: sdk-ts, mcp (until ported to Rust), tooling (benchmark, cli-tester, acp-bridge)

## Architecture: Local + Cloud Messaging
- Broker delivers locally to co-located agents via PTY (fast, <1ms)
- Broker also publishes to Relaycast async (fire-and-forget) for dashboard visibility
- Cross-machine messages go through Relaycast only
- No socket needed — stdio pipe for SDK↔broker, PTY for broker→agent
- DedupCache prevents re-injection of echoed messages

## P0: Delivery Guarantees — Surpass Old Orchestrator

The old TypeScript orchestrator (`relay-pty-orchestrator.ts`) had 5 layers of delivery
assurance that the Rust broker currently lacks. The goal is not just parity but to
exceed these guarantees using Rust's strengths (speed, concurrency, direct PTY ownership).

### What the old orchestrator did well
1. **Output verification** — after PTY write, watched stdout for `Relay message from...` pattern
2. **Activity verification** — confirmed the agent started processing (thinking, tool use, etc.)
3. **Retry with backoff** — re-injected on verification failure
4. **Adaptive throttling** — tracked success/failure rates, slowed injection under stress
5. **Backpressure signaling** — agent could signal it was overwhelmed

### What the Rust broker must implement

#### Layer 1: Verified PTY Delivery (match old orchestrator)
- After `pty.write_all()`, monitor the PTY output stream for the injected message echo
- The wrap-mode worker already reads PTY output — add a verification window (e.g., 3s)
- If message doesn't appear in output within window, retry
- Track verification in `PendingDelivery` alongside current retry state
- Report `delivery_verified` event (not just `delivery_ack`) to SDK

#### Layer 2: Activity Confirmation (match old orchestrator)
- After message echo verified, watch for activity signals:
  - Claude: tool use markers, thinking indicators, `⠋⠙⠹` spinners
  - Codex: `Thinking...`, function call markers
  - Gemini: `Generating...`, action markers
- Configurable timeout (default 5s) before declaring delivery uncertain
- Report `delivery_active` event when activity detected

#### Layer 3: Adaptive Throttling (match old orchestrator)
- Track per-worker success/failure rates in `WorkerRegistry`
- Exponential backoff on injection delay when failures increase
- Faster injection when worker is healthy
- Minimum inter-injection delay to prevent overwhelming agents

#### Layer 4: Backpressure (exceed old orchestrator)
- Monitor PTY output buffer size — if agent is producing output rapidly, defer injection
- Track agent idle state: detect when agent is waiting for input vs actively working
- `PtyAutoState` already tracks `last_output_time` — extend to compute busyness score
- Expose backpressure state via `list_agents` response (SDK can make routing decisions)

#### Layer 5: Delivery Persistence (NEW — exceeds old orchestrator)
- Persist pending deliveries to disk (not just in-memory HashMap)
- On broker restart, reload pending deliveries and retry to reattached workers
- Ties into the crash recovery work (P0: orphaned agents)
- Enables "at-least-once" delivery guarantee across broker restarts

#### Layer 6: Priority-Aware Delivery Queue (NEW — exceeds old orchestrator)
- The broker already has `Scheduler` and `PriorityQueue` modules (scheduler.rs, queue.rs)
- Wire these into the delivery path: P2 (DMs) delivered before P3 (channel messages)
- Allow SDK to set priority on `send_message` calls
- Under backpressure, drop P4 messages before P2

#### Layer 7: Delivery Receipts to Sender (NEW — exceeds old orchestrator)
- When Agent A sends to Agent B via broker, report delivery lifecycle back to A:
  - `delivery_queued` → `delivery_injected` → `delivery_verified` → `delivery_active`
  - Or: `delivery_queued` → `delivery_injected` → `delivery_failed` (with reason)
- SDK exposes these as events or as a Promise that resolves on `delivery_active`
- Enables sender to retry via a different channel or escalate

### Implementation Order
1. Verified PTY delivery (Layer 1) — highest impact, blocks everything else
2. Enable `send_message` (from P0 above) — needs Layer 1 to be useful
3. Activity confirmation (Layer 2) — makes delivery trustworthy
4. Adaptive throttling (Layer 3) — prevents cascading failures
5. Delivery receipts (Layer 7) — enables SDK-level reliability
6. Backpressure (Layer 4) — optimization for high-throughput scenarios
7. Priority queuing (Layer 6) — optimization for mixed workloads
8. Delivery persistence (Layer 5) — requires crash recovery (P0) first

### Success Criteria
- Zero silent message loss: every delivery results in a verified receipt or explicit failure
- Local agent-to-agent latency < 5ms for verified delivery (PTY write + echo check)
- Graceful degradation under load: throttle before dropping, drop low-priority first
- Broker restart recovers pending deliveries (at-least-once guarantee)
- All delivery paths covered by integration tests

## TDD: Integration Test Strategy

### Approach
Write tests FIRST for each layer before implementing. The existing test infrastructure
at `tests/integration/` provides the harness — extend it with broker-specific tests
that exercise the Rust binary directly via the broker-sdk.

### Existing Coverage (what we have)
- `tests/integration/sdk/` — 15 tests for the OLD SDK (`@agent-relay/sdk` + daemon)
- `tests/integration/mcp/` — 20 tests for MCP tools (spawn agents, send messages via MCP)
- `packages/sdk-ts/src/__tests__/` — 7 tests for broker-sdk (lifecycle, spawn, release)
- `src/*.rs` — 110+ Rust unit tests (pure functions, no integration)

### Gap: What's NOT tested
- Broker event loop orchestration (run_init, run_wrap, run_pty_worker)
- Local send_message delivery (currently disabled)
- Delivery verification (echo check, activity confirmation)
- Delivery retry and failure recovery
- Broker crash and restart recovery
- Concurrent multi-agent message delivery under load
- Backpressure and adaptive throttling behavior
- Dedup correctness (local send + WS echo)
- Cross-machine fallback (local miss → Relaycast delivery)

### New Test Suite: `tests/integration/broker/`
Tests use the broker-sdk (`@agent-relay/broker-sdk`) directly, exercising the Rust
binary as a subprocess — no old daemon dependency.

#### Phase 1: Foundation (write before Layer 1 implementation)
```
tests/integration/broker/
  01-broker-lifecycle.ts     — start, hello_ack, shutdown, restart
  02-spawn-release.ts        — spawn PTY agent, verify running, release, verify exited
  03-local-send-message.ts   — send_message between two local agents, verify delivery
  04-send-with-relaycast.ts  — send_message reaches Relaycast (check via getMessages)
  05-dedup-no-double.ts      — local send + WS echo doesn't double-inject
```

#### Phase 2: Delivery Guarantees (write before Layers 1-3)
```
  06-delivery-verified.ts    — message echo appears in agent PTY output
  07-delivery-retry.ts       — inject during agent busy state, verify retry succeeds
  08-delivery-timeout.ts     — inject to crashed agent, verify failure event
  09-activity-confirmed.ts   — after delivery, agent shows processing activity
  10-adaptive-throttle.ts    — rapid messages slow down injection rate
```

#### Phase 3: Resilience (write before Layers 4-5)
```
  11-backpressure.ts         — overwhelm agent, verify broker defers new injections
  12-priority-ordering.ts    — P2 messages delivered before P4 under load
  13-broker-crash-recover.ts — kill broker, restart, verify agents reattached
  14-pending-persist.ts      — kill broker mid-delivery, restart, pending retried
  15-multi-agent-storm.ts    — 5+ agents, rapid cross-talk, zero message loss
```

#### Phase 4: Parity with Old Tests (prove broker-sdk replaces old stack)
```
  16-broadcast.ts            — port of sdk/07-broadcast.js via broker-sdk
  17-multi-worker.ts         — port of sdk/06-multi-worker.js via broker-sdk
  18-continuity-handoff.ts   — port of sdk/15-continuity-handoff.js via broker-sdk
  19-orch-to-worker.ts       — port of sdk/05b2-orch-to-worker.js via broker-sdk
  20-stability-soak.ts       — long-running stability test (messages over 5+ minutes)
```

### Test Helpers: `tests/integration/broker/utils/`
```
  broker-harness.ts   — start/stop broker binary, capture stdio, manage lifecycle
  agent-helpers.ts    — spawn agents, wait for ready, collect PTY output
  delivery-helpers.ts — send message, wait for delivery_verified/delivery_active events
  assert-helpers.ts   — assertDelivered, assertNoDoubleDelivery, assertPriorityOrder
```

### Running
```bash
# All broker tests
node tests/integration/run-all-tests.js --type=broker

# Individual test
npx tsx tests/integration/broker/03-local-send-message.ts

# Rust unit tests (existing)
cargo test
```

### TDD Workflow
For each layer:
1. Write the integration test that exercises the expected behavior
2. Run it — verify it fails (broker doesn't support it yet)
3. Implement the feature in Rust
4. Run it — verify it passes
5. Add edge case tests
6. Move to next layer

## Benchmark Tests: Broker vs Old Stack

### Purpose
Quantitatively prove the broker-sdk architecture is faster, more reliable, and more
efficient than the old daemon + relay-pty + TypeScript orchestrator stack. These
benchmarks run both stacks side-by-side and produce comparable numbers.

### Existing Benchmark Gap
The existing `packages/benchmark/` framework measures task-level outcomes (single vs
subagent vs swarm). It doesn't measure the messaging infrastructure itself:
- No message latency benchmarks
- No delivery reliability metrics
- No overhead/resource comparisons between stacks
- No stress testing under concurrent load

### New Benchmark Suite: `tests/benchmarks/`

#### Benchmark 1: Message Latency (`latency.ts`)
Measure round-trip time for a message from Agent A → infrastructure → Agent B.

**Old stack**: Agent A → Unix socket → daemon router → Unix socket → relay-pty → PTY inject
**Broker**: Agent A → broker send_message (stdio) → PTY inject + async Relaycast

Metrics captured:
- `local_p50_ms` / `local_p99_ms` — local delivery latency
- `cloud_p50_ms` / `cloud_p99_ms` — time until message appears in Relaycast
- `end_to_end_p50_ms` / `end_to_end_p99_ms` — sender call → recipient PTY echo
- Sample size: 100 messages per run, 3 runs averaged

Expected outcome: broker local delivery < 5ms vs old daemon ~10-20ms (no socket hop)

#### Benchmark 2: Throughput (`throughput.ts`)
Maximum messages per second the infrastructure can handle.

Setup: 2 agents, Agent A sends as fast as possible to Agent B
Measure:
- `messages_per_second` — sustained throughput
- `messages_until_backpressure` — how many before system pushes back
- `recovery_time_ms` — time to return to normal after burst

Run at: 10 msg/s, 50 msg/s, 100 msg/s, max rate
Compare old stack vs broker at each rate.

Expected outcome: broker handles higher throughput (no socket serialization, Rust event loop)

#### Benchmark 3: Delivery Reliability (`reliability.ts`)
Under realistic conditions, what percentage of messages are delivered successfully?

Setup: 3 agents, cross-talk pattern (each sends to both others), 60-second run
Inject chaos:
- Kill and restart one agent mid-run
- Introduce 200ms network delay to Relaycast
- Send messages during agent boot-up (not yet ready)

Metrics:
- `delivery_rate` — % messages successfully delivered
- `silent_loss_count` — messages with no delivery event (ack, fail, or drop)
- `duplicate_count` — messages delivered more than once
- `avg_retry_count` — average retries per successful delivery
- `max_delivery_time_ms` — worst-case delivery latency

Expected outcome: broker achieves higher delivery rate (verified delivery + retry),
zero silent loss (every message has an explicit outcome)

#### Benchmark 4: Resource Overhead (`overhead.ts`)
How much CPU/memory does the infrastructure itself consume?

Setup: idle broker with 3 spawned agents, measure over 60 seconds
Then: active broker with 3 agents exchanging 10 msg/s, measure over 60 seconds

Metrics:
- `broker_rss_idle_mb` / `daemon_rss_idle_mb` — memory at rest
- `broker_rss_active_mb` / `daemon_rss_active_mb` — memory under load
- `broker_cpu_idle_pct` / `daemon_cpu_idle_pct` — CPU at rest
- `broker_cpu_active_pct` / `daemon_cpu_active_pct` — CPU under load
- `startup_time_ms` — time from spawn to first message deliverable

Expected outcome: Rust broker uses significantly less memory than Node.js daemon +
TypeScript orchestrator (single binary vs multiple Node processes)

#### Benchmark 5: Scale-out (`scale.ts`)
How does performance degrade as agent count increases?

Setup: spawn N agents (2, 5, 10, 20), each sending 1 msg/s to a random peer
Run for 30 seconds at each scale, measure:
- `latency_at_N` — P50/P99 latency at each agent count
- `throughput_at_N` — actual delivered msg/s at each count
- `memory_at_N` — broker RSS at each count
- `spawn_time_at_N` — time to spawn Nth agent

Expected outcome: broker degrades more gracefully (Rust async vs Node.js event loop
contention with many socket connections)

#### Benchmark 6: Startup to First Message (`cold-start.ts`)
Full cold-start: nothing running → first message delivered between two agents.

Measure:
- `total_cold_start_ms` — from binary spawn to first verified delivery
- Breakdown: `binary_start_ms` + `auth_ms` + `ws_connect_ms` + `agent_spawn_ms` + `delivery_ms`

Compare:
- Old: `agent-relay up` (daemon start) → SDK connect → spawn → deliver
- Broker: SDK spawns binary → init → spawn agents → deliver

Expected outcome: broker is faster (single process start vs daemon + SDK handshake)

### Benchmark Harness: `tests/benchmarks/utils/`
```
  harness.ts          — runs both stacks, collects metrics, outputs comparison table
  old-stack-runner.ts — starts daemon + old SDK, manages lifecycle
  broker-runner.ts    — starts broker-sdk, manages lifecycle
  metrics.ts          — TimeSeries, Histogram, Percentile helpers
  report.ts           — markdown/JSON report generation with comparison tables
```

### Output Format
```
┌─────────────────────┬───────────┬──────────┬────────┐
│ Metric              │ Old Stack │ Broker   │ Winner │
├─────────────────────┼───────────┼──────────┼────────┤
│ Local P50 latency   │ 12ms      │ 2ms      │ Broker │
│ Local P99 latency   │ 45ms      │ 8ms      │ Broker │
│ Throughput (msg/s)  │ 85        │ 340      │ Broker │
│ Delivery rate       │ 97.2%     │ 99.8%    │ Broker │
│ Silent loss         │ 3         │ 0        │ Broker │
│ Memory (idle)       │ 142MB     │ 28MB     │ Broker │
│ Memory (active)     │ 198MB     │ 45MB     │ Broker │
│ Cold start          │ 3200ms    │ 1100ms   │ Broker │
│ Scale: 20 agents P50│ 89ms      │ 12ms     │ Broker │
└─────────────────────┴───────────┴──────────┴────────┘
```

### Running
```bash
# All benchmarks
npx tsx tests/benchmarks/run-all.ts

# Individual benchmark
npx tsx tests/benchmarks/latency.ts
npx tsx tests/benchmarks/throughput.ts

# Output report
npx tsx tests/benchmarks/run-all.ts --output results/broker-vs-old.md

# CI: run benchmarks and fail if regression detected
npx tsx tests/benchmarks/run-all.ts --assert-no-regression
```

### When to Run
- After each delivery layer implementation (verify improvement)
- Before/after major Rust broker changes (catch regressions)
- As part of the migration validation (prove broker is ready to replace old stack)
