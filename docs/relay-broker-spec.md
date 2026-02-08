# relay-broker: Unified Agent Runtime

## Vision

Replace the entire Node.js daemon layer with a single Rust binary that wraps CLIs and talks directly to relaycast. One process per agent. No middleman.

```
TODAY:    relay-broker (Rust) <-- Unix socket --> Node.js (HostedRunner + RelaycastInjector) <-- WS --> relaycast
PROPOSED: relay-broker (Rust) <-- WS --> relaycast
```

---

## What relay-broker IS

A single Rust binary that:
1. Wraps a CLI in a PTY (everything relay-broker does today)
2. Connects directly to relaycast via WebSocket
3. Injects incoming messages into the CLI
4. Forwards outbox messages to relaycast
5. Spawns child relay-broker processes on demand

```
relay-broker claude
```

That's the entire user experience.

---

## Architecture

```
                         relaycast cloud
                              |
                         WebSocket + HTTP
                              |
    ┌─────────────────────────┴─────────────────────────┐
    |                   relay-broker                      |
    |                                                     |
    |  ┌────────────┐  ┌────────────┐  ┌──────────────┐ |
    |  | PTY Manager|  | Relaycast  |  | Injection    | |
    |  | (existing) |  | Client     |  | Scheduler    | |
    |  |            |  | (NEW)      |  | (enhanced)   | |
    |  └─────┬──────┘  └─────┬──────┘  └──────┬───────┘ |
    |        |               |                 |          |
    |        |   ┌───────────┴───────────┐     |          |
    |        |   | Outbox    | Stdin     |     |          |
    |        |   | Watcher   | Monitor   |     |          |
    |        |   | (existing)| (NEW)     |     |          |
    |        |   └───────────┴───────────┘     |          |
    |        |                                  |          |
    |        └──────────► PTY ◄────────────────┘          |
    |                      |                               |
    |                   claude                             |
    └──────────────────────────────────────────────────────┘
```

---

## Relaycast API Surface (what relay-broker implements)

### HTTP Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | /v1/agents | API key | Register agent, get token |
| POST | /v1/dms/send | Agent token | Send direct message |
| POST | /v1/channels/{name}/messages | Agent token | Post to channel |

### WebSocket

```
WS /v1/stream?token={agent-token}
```

**Inbound events (relaycast -> broker):**
- `message.created` — channel message, inject into CLI
- `dm.received` — direct message, inject into CLI
- `thread.reply` — thread reply, inject into CLI
- `agent.online` / `agent.offline` — presence updates

**Outbound messages (broker -> relaycast):**
- `subscribe` / `unsubscribe` — channel membership
- `ping` — keepalive

### Auth Flow

```
RELAYCAST_API_KEY (rk_live_...)
        |
        v
POST /v1/agents --> agent_token (at_live_...)
        |
        v
Use agent_token for all HTTP + WebSocket
```

---

## Injection Scheduler (enhanced from current queue)

The injection scheduler replaces the current priority queue with human-awareness:

### Priority Tiers

| Priority | Source | Behavior |
|----------|--------|----------|
| P0 | Human stdin | Passthrough, never queued, pauses all injection |
| P1 | System | shutdown, ACK — immediate |
| P2 | Direct messages | Agent-to-agent DMs |
| P3 | Channel messages | Broadcast / channel posts |
| P4 | Background | Status, heartbeat, presence |

### Stdin Monitoring

```
human types key
    |
    v
record last_human_keypress_ms
    |
    v
if (now - last_human_keypress_ms < HUMAN_COOLDOWN):
    pause injection queue
    // human is actively typing, don't interrupt
```

Default HUMAN_COOLDOWN: 3000ms (configurable via --human-cooldown)

### Message Coalescing

When multiple messages arrive within a coalesce window (default 500ms):

```
msg from Alice at T+0ms:   "Here's the plan"
msg from Alice at T+200ms: "Step 1: ..."
msg from Alice at T+400ms: "Step 2: ..."

Coalesced into single injection:
  Relay message from Alice [abc123]:
  Here's the plan
  Step 1: ...
  Step 2: ...
```

Rules:
- Same sender + same target within window -> coalesce
- Different senders -> separate injections
- Window resets on each new message from same sender
- Max coalesce window: 2000ms (don't hold messages too long)

---

## Spawning

When the CLI writes `->relay-file:spawn`:

```
relay-broker (parent: "claude")
    |
    | detects spawn file in outbox
    | parses: NAME=Worker1, CLI=codex
    |
    v
fork/exec: relay-broker --spawner=claude --api-key=... codex
    |
    v
relay-broker (child: "Worker1")
    |
    | registers with relaycast as "Worker1"
    | connects own WebSocket
    | wraps codex in PTY
    |
    v
Both agents communicate via relaycast (no local routing)
```

Parent tracks child PIDs for cleanup. On release or parent exit, children get SIGTERM.

---

## CLI Interface

```
relay-broker [OPTIONS] <COMMAND> [ARGS...]

OPTIONS:
  --name <NAME>           Agent name (default: auto-generated)
  --api-key <KEY>         Relaycast API key (or RELAYCAST_API_KEY env)
  --api-url <URL>         Relaycast API URL (default: https://api.relaycast.dev)
  --channels <CH>         Channels to subscribe (default: general)
  --spawner <NAME>        Parent agent name (set by parent on spawn)
  --human-cooldown <MS>   Pause injection after human input (default: 3000)
  --coalesce-window <MS>  Message coalescing window (default: 500)

  # Inherited from current relay-broker:
  --idle-timeout <MS>     Silence before marking idle (default: 5000)
  --queue-max <N>         Max queued messages (default: 200)
  --rows <N>              Terminal rows
  --cols <N>              Terminal cols
  --log-level <LEVEL>     Logging level
  --log-file <PATH>       Log file path
  --json-output           JSON events on stderr

EXAMPLES:
  relay-broker claude
  relay-broker --name lead --channels general,ops claude
  relay-broker --api-key rk_live_xxx codex
```

---

## What Gets Deleted from Node.js

### Entire packages deleted

| Package | Lines (approx) | Reason |
|---------|----------------|--------|
| packages/storage | ~3,000 | relaycast persists |
| packages/benchmark | ~500 | benchmarks dead system |

### Daemon package gutted (~80% deleted)

| File | Lines | Status | Reason |
|------|-------|--------|--------|
| server.ts | ~800 | DELETE | local daemon — relaycast replaces |
| router.ts | ~1,800 | DELETE | message routing — relaycast replaces |
| connection.ts | ~600 | DELETE | connection FSM — relaycast replaces |
| ws-connection.ts | 414 | DELETE | WebSocket adapter — not needed |
| hosted-daemon.ts | 724 | DELETE | hosted daemon — relaycast replaces |
| hosted-runner.ts | 1,015 | DELETE | Node.js orchestrator — relay-broker replaces |
| relaycast-injector.ts | 532 | DELETE | Node.js bridge — relay-broker replaces |
| connector.ts | 658 | DELETE | Node.js bridge — relay-broker replaces |
| pty-spawner.ts | ~280 | DELETE | Node.js spawn utils — relay-broker replaces |
| outbox-parser.ts | ~85 | DELETE | moved to Rust |
| orchestrator.ts | ~800 | DELETE | workspace mgmt — relaycast replaces |
| workspace-manager.ts | ~400 | DELETE | workspace mgmt — relaycast replaces |
| agent-manager.ts | ~500 | DELETE | agent mgmt — relaycast replaces |
| cloud-sync.ts | ~300 | DELETE | auto-sync via relaycast |
| agent-registry.ts | ~400 | DELETE | relaycast tracks agents |
| registry.ts | ~200 | DELETE | relaycast tracks agents |
| consensus.ts | ~600 | DELETE | not needed |
| agent-signing.ts | ~300 | DELETE | not needed |
| enhanced-features.ts | ~400 | DELETE | not needed |

**Total deleted from daemon: ~9,800 lines**

### CLI commands deleted/simplified

| Command | Status |
|---------|--------|
| `relay up` | DELETE — no daemon |
| `relay down` | DELETE — no daemon |
| `relay daemons` | DELETE — no daemon instances |
| `relay gc` | DELETE — no local state |
| `relay serve` | DELETE — no hosted daemon |
| `relay connect` | DELETE — no connector |

### SDK simplified

- Delete Unix socket transport
- Refactor RelayClient to use relaycast API
- ~40% of sdk code removed

### What stays in Node.js

| Component | Why |
|-----------|-----|
| `relay` CLI | Thin wrapper, shells out to relay-broker |
| Dashboard web UI | User-facing, talks to relaycast API |
| MCP server | Agent tool interface, refactored to relaycast backend |
| packages/wrapper | PTY orchestration utilities |
| packages/config | Project configuration |
| packages/utils | Name generation, command resolution |
| packages/resiliency | Logging, monitoring |
| packages/continuity | Session state |
| packages/memory | Semantic memory |
| packages/policy | Agent behavior control |
| packages/hooks | Event emission |
| packages/telemetry | Usage analytics |

---

## Implementation Waves

### Wave 1: Relaycast Client in Rust (foundation)

**Goal:** relay-broker can register with relaycast, send/receive messages

**New Rust modules:**
- `relaycast.rs` — HTTP client (reqwest): register, send DM, post message
- `ws_client.rs` — WebSocket client (tokio-tungstenite): connect, subscribe, handle events
- `auth.rs` — API key -> agent token flow, token caching

**New dependencies (Cargo.toml):**
```toml
reqwest = { version = "0.12", features = ["json", "rustls-tls"] }
tokio-tungstenite = { version = "0.24", features = ["rustls-tls-native-roots"] }
```

**Deliverable:** Can run `relay-broker --api-key rk_live_xxx echo "hello"` and see the agent register + connect to relaycast WebSocket.

**Agents:** 2 parallel
- Agent A: HTTP client + auth flow + agent registration
- Agent B: WebSocket client + event handling + reconnection logic

---

### Wave 2: Message Bridge (wire it together)

**Goal:** Messages flow end-to-end: relaycast -> CLI stdin, CLI outbox -> relaycast

**Changes to existing modules:**
- `main.rs` — Add relaycast WebSocket to the `tokio::select!` event loop
- `inject.rs` — Accept messages from WebSocket (not just Unix socket)
- `outbox_monitor.rs` — On file detected, parse and send via relaycast HTTP API instead of emitting to stderr

**New module:**
- `message_bridge.rs` — Translates between relaycast event format and internal InjectRequest format. Handles self-message filtering.

**Deliverable:** Two relay-broker instances can message each other through relaycast. Agent A sends `->relay-file:msg`, Agent B sees it injected.

**Agents:** 2 parallel
- Agent C: Inbound path (WebSocket events -> injection queue)
- Agent D: Outbound path (outbox watcher -> relaycast HTTP API)

---

### Wave 3: Injection Scheduler (human-aware queuing)

**Goal:** Smart injection that respects human typing and coalesces burst messages

**New module:**
- `scheduler.rs` — Replaces direct injection with priority-aware scheduling

**Changes:**
- `main.rs` — Monitor stdin for human keypress timestamps
- `inject.rs` — Check scheduler before injecting (human cooldown, coalesce window)
- `queue.rs` — Add priority tiers (P0-P4)

**Deliverable:** Human typing pauses injection. Burst messages from same sender are coalesced.

**Agents:** 1
- Agent E: Scheduler implementation + stdin monitoring + coalescing logic

---

### Wave 4: Spawning (multi-agent)

**Goal:** relay-broker can spawn child relay-broker processes

**New module:**
- `spawner.rs` — Parse spawn files, fork/exec child relay-broker, track PIDs, handle release/cleanup

**Changes:**
- `main.rs` — Handle spawn/release from outbox watcher and relay-broker stderr events
- `outbox_monitor.rs` — Detect KIND: spawn/release files

**Deliverable:** `relay-broker claude` can spawn a child `relay-broker codex` via `->relay-file:spawn`. Both communicate through relaycast.

**Agents:** 1
- Agent F: Spawn/release lifecycle, child process management, cleanup on exit

---

### Wave 5: Socket Removal + CLI Rename

**Goal:** Remove the Unix socket server, rename binary to relay-broker

**Changes:**
- `socket.rs` — DELETE entirely (no external injection needed)
- `main.rs` — Remove socket server startup, remove socket-related CLI flags
- `Cargo.toml` — Update binary name to `relay-broker`
- Update all references across the codebase

**What stays from the socket protocol:** The internal InjectRequest/InjectResponse types stay — they just become in-memory structs passed between channels instead of JSON over a socket.

**Deliverable:** Binary is `relay-broker`. No Unix socket. All injection is internal.

**Agents:** 1
- Agent G: Socket removal, rename, reference updates

---

### Wave 6: Node.js Cleanup

**Goal:** Delete all Node.js code that relay-broker replaces

**Deletions:**
- packages/storage (entire package)
- packages/benchmark (entire package)
- packages/daemon: server.ts, router.ts, connection.ts, ws-connection.ts, hosted-daemon.ts, hosted-runner.ts, relaycast-injector.ts, connector.ts, pty-spawner.ts, outbox-parser.ts, orchestrator.ts, workspace-manager.ts, agent-manager.ts, cloud-sync.ts, agent-registry.ts, registry.ts, consensus.ts, agent-signing.ts, enhanced-features.ts
- src/cli: remove `up`, `down`, `daemons`, `gc`, `serve`, `connect` commands
- Update `relay run` to shell out to `relay-broker`

**Refactors:**
- MCP server: switch backend from daemon to relaycast API
- SDK: remove socket transport, simplify to relaycast
- Dashboard: switch from daemon WebSocket to relaycast API

**Agents:** 3 parallel
- Agent H: Delete daemon files + storage package + benchmark
- Agent I: Refactor CLI commands (delete dead commands, update `relay run`)
- Agent J: Refactor MCP + SDK to use relaycast API

---

### Wave 7: Testing + Integration

**Goal:** Everything works end-to-end

**Tests:**
- Rust: unit tests for relaycast client, ws_client, message_bridge, scheduler, spawner
- Integration: two relay-broker instances messaging through relaycast
- E2E: `relay run claude` works with the new relay-broker binary

**Agents:** 2 parallel
- Agent K: Rust unit + integration tests
- Agent L: E2E tests + CLI integration tests

---

## Staffing Plan

### Agent Types

**Claude (Lead)** — Architecture decisions, complex integration, code review, multi-file refactors.
Used when the work requires understanding system boundaries, making design tradeoffs,
or touching code that spans multiple modules.

**Codex (Worker)** — Focused implementation tasks with clear specs. Single-module work,
mechanical refactors, deletions, test writing. Fast and cheap for well-defined work.

### Wave Roster

```
Wave 1 (foundation) ────────────────────────────────────────────────────────
  |
  ├─ Lead-1 [claude]     Relaycast HTTP client + auth (relaycast.rs, auth.rs)
  |                       WHY CLAUDE: Designs the API abstraction, error handling
  |                       patterns, and auth flow that all later waves depend on.
  |
  ├─ Worker-1 [codex]    WebSocket client (ws_client.rs)
  |                       WHY CODEX: Clear spec — connect, subscribe, handle events,
  |                       reconnect. Well-defined tokio-tungstenite patterns.
  |
  └─ Deliverable: relay-broker registers with relaycast + connects WebSocket


Wave 2 (message bridge) ───────────────────────────────────────────────────
  |
  ├─ Lead-2 [claude]     Inbound path: WebSocket events -> injection queue
  |                       WHY CLAUDE: Integrates into existing main.rs event loop.
  |                       Must understand relay-broker internals (inject.rs, queue.rs)
  |                       and make architectural decisions about channel wiring.
  |
  ├─ Worker-2 [codex]    Outbound path: outbox file -> relaycast HTTP
  |                       WHY CODEX: Clear pipeline — detect file, parse headers,
  |                       call relaycast.send_dm() or post_message(). Uses existing
  |                       outbox_monitor.rs + new relaycast.rs from Wave 1.
  |
  └─ Deliverable: Two relay-broker instances message each other through relaycast


Wave 3 (injection scheduler) ──────────────────────────────────────────────
  |
  ├─ Lead-3 [claude]     Scheduler: priority, human-awareness, coalescing
  |                       WHY CLAUDE: Novel design work. No existing pattern to
  |                       follow. Must balance latency vs correctness, design the
  |                       coalescing algorithm, integrate stdin monitoring into
  |                       the event loop. Touches main.rs, inject.rs, queue.rs.
  |
  └─ Deliverable: Human typing pauses injection. Burst messages coalesced.


Wave 4 (spawning) — parallel with Wave 3 ──────────────────────────────────
  |
  ├─ Worker-3 [codex]    Spawner: fork child relay-broker, track PIDs, cleanup
  |                       WHY CODEX: Well-defined behavior — parse spawn file,
  |                       fork/exec with args, track PID, handle SIGCHLD, kill
  |                       on release. Process management is mechanical.
  |
  └─ Deliverable: relay-broker spawns child relay-broker via ->relay-file:spawn


Wave 5 (socket removal + rename) ──────────────────────────────────────────
  |
  ├─ Worker-4 [codex]    Delete socket.rs, remove socket CLI flags, rename binary
  |                       WHY CODEX: Mechanical deletion and find-replace. Clear
  |                       checklist: delete file, remove imports, update Cargo.toml,
  |                       update references.
  |
  └─ Deliverable: Binary is relay-broker. No Unix socket.


Wave 6 (Node.js cleanup) ──────────────────────────────────────────────────
  |
  ├─ Worker-5 [codex]    Delete daemon files + storage + benchmark packages
  |                       WHY CODEX: Pure deletion. Delete listed files, remove
  |                       package.json entries, update index.ts exports. No design
  |                       decisions.
  |
  ├─ Worker-6 [codex]    Delete dead CLI commands, update relay run
  |                       WHY CODEX: Remove up/down/daemons/gc/serve/connect
  |                       commands from src/cli/index.ts. Update relay run to
  |                       shell out to relay-broker. Mechanical edits.
  |
  ├─ Lead-4 [claude]     Refactor MCP + SDK to use relaycast API
  |                       WHY CLAUDE: Requires understanding MCP tool contracts,
  |                       SDK consumer expectations, and designing the new backend
  |                       integration. Not mechanical — needs judgment about what
  |                       to keep, what to change, and API compatibility.
  |
  └─ Deliverable: All dead Node.js code removed. MCP/SDK talk to relaycast.


Wave 7 (testing) ──────────────────────────────────────────────────────────
  |
  ├─ Lead-5 [claude]     Integration tests: two relay-brokers through relaycast
  |                       WHY CLAUDE: Designs test harness, manages test relaycast
  |                       environment, validates end-to-end message flow including
  |                       spawn/release, coalescing, human-awareness.
  |
  ├─ Worker-7 [codex]    Rust unit tests for new modules
  |                       WHY CODEX: Each module has clear inputs/outputs.
  |                       relaycast.rs, ws_client.rs, scheduler.rs, spawner.rs
  |                       all have testable interfaces. Write tests against spec.
  |
  └─ Deliverable: Full test coverage. CI green.
```

### Summary Table

| Agent | Wave | CLI | Role | Task |
|-------|------|-----|------|------|
| Lead-1 | 1 | claude | Architect | HTTP client + auth design |
| Worker-1 | 1 | codex | Implement | WebSocket client |
| Lead-2 | 2 | claude | Integrate | Inbound message path into event loop |
| Worker-2 | 2 | codex | Implement | Outbound outbox -> relaycast |
| Lead-3 | 3 | claude | Design | Injection scheduler (novel) |
| Worker-3 | 4 | codex | Implement | Process spawner |
| Worker-4 | 5 | codex | Refactor | Socket removal + rename |
| Worker-5 | 6 | codex | Delete | Daemon files + packages |
| Worker-6 | 6 | codex | Delete | CLI commands cleanup |
| Lead-4 | 6 | claude | Refactor | MCP + SDK backend swap |
| Lead-5 | 7 | claude | Design | Integration test harness |
| Worker-7 | 7 | codex | Implement | Unit tests |

### Resource Allocation

```
             Wave 1    Wave 2    Wave 3    Wave 4    Wave 5    Wave 6    Wave 7
Claude        1         1         1         -         -         1         1      = 5 assignments
Codex         1         1         -         1         1         2         1      = 7 assignments
                                                                                ────────────────
Parallel      2         2         1        [1]        1         3         2      Total: 12
                                           ↑
                                    runs parallel with Wave 3

Claude:Codex ratio = 5:7 (42% lead, 58% worker)
```

### When to Escalate Worker -> Lead

A Codex worker should be replaced with Claude if:
- The task requires modifying more than 3 files that import each other
- A design decision surfaces that wasn't anticipated in the spec
- Build errors require understanding cross-module type contracts
- The worker is stuck for more than 2 iterations on the same error

### Dependencies Between Waves

```
Wave 1 ─────► Wave 2 ─────► Wave 3 ─────► Wave 5 ─────► Wave 6 ─────► Wave 7
                |                                           ▲
                └──────────► Wave 4 ────────────────────────┘
```

- Wave 2 needs Wave 1 (relaycast client must exist to bridge messages)
- Wave 3 needs Wave 2 (scheduler needs working message flow)
- Wave 4 needs Wave 2 (spawning needs working message flow), can parallel with Wave 3
- Wave 5 needs Waves 3+4 (socket removal needs all new paths working)
- Wave 6 needs Wave 5 (don't delete Node.js until Rust is the runtime)
- Wave 7 needs Wave 6 (test the final system)

---

## New Rust Files Summary

| File | Wave | Lines (est) | Purpose |
|------|------|-------------|---------|
| src/relaycast.rs | 1 | ~200 | HTTP client: register, send DM, post message |
| src/ws_client.rs | 1 | ~300 | WebSocket client: connect, subscribe, events, reconnect |
| src/auth.rs | 1 | ~80 | API key -> agent token, caching |
| src/message_bridge.rs | 2 | ~150 | Translate relaycast events <-> InjectRequest |
| src/scheduler.rs | 3 | ~250 | Priority queue, human cooldown, coalescing |
| src/spawner.rs | 4 | ~200 | Fork/exec child relay-broker, PID tracking |

**Total new Rust: ~1,180 lines**
**Total deleted Node.js: ~14,000+ lines**

---

## Risk Mitigations

| Risk | Mitigation |
|------|------------|
| relaycast API changes | Pin API version, integration tests |
| WebSocket reliability | Exponential backoff reconnect (existing pattern) |
| Human typing detection false positives | Configurable cooldown, conservative default |
| Child process zombies | SIGCHLD handler, periodic PID reaping |
| Binary size increase | reqwest + tungstenite add ~2MB, still under 5MB |
| Cross-platform | reqwest + tungstenite work on Linux/macOS/Windows |
