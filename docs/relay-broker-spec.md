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

### Token Lifecycle

- Agent tokens are obtained on startup via POST /v1/agents
- On WebSocket disconnect + reconnect, re-register to get a fresh token
- If an HTTP request returns 401, re-register and retry once
- No background token refresh — tokens are refreshed on-demand at failure boundaries

---

## Operational Behavior

### Disconnection Handling

When the WebSocket connection to relaycast drops:

1. **Outbound messages**: Buffer in memory (max 500 messages or 5MB). If buffer overflows, drop oldest P4 messages first, then P3, etc. Never drop P1.
2. **Inbound messages**: relaycast holds undelivered messages server-side. On reconnect, relay-broker re-subscribes to channels and receives queued messages.
3. **User visibility**: Emit a JSON event on stderr: `{"type":"connection","status":"disconnected"}` and `{"type":"connection","status":"reconnected"}`. The CLI continues to function — the human can still type and interact.
4. **Reconnection**: Exponential backoff starting at 1s, max 30s, with jitter. Unlimited retries.

### Graceful Shutdown

On SIGTERM or SIGINT:

1. Send `agent.offline` to relaycast via HTTP (best-effort, 2s timeout)
2. Send SIGTERM to all child relay-broker processes
3. Wait up to 5s for children to exit, then SIGKILL stragglers
4. Close WebSocket connection
5. Flush any pending log writes
6. Exit 0

### Continuity Protocol

When the CLI writes a `KIND: continuity` outbox file:
- `ACTION: save` — Forward the body to relaycast as a DM to self (persisted server-side)
- `ACTION: load` — Fetch last continuity save from relaycast and inject into CLI
- `ACTION: uncertain` — Forward as a tagged DM to self for future reference

### Channel Subscription Management

- On startup, subscribe to channels from `--channels` flag (default: `general`)
- Spawned children inherit parent's `--api-key` but get their own channel subscriptions (default: `general` only)
- Dynamic subscription changes via outbox files: `KIND: subscribe` / `KIND: unsubscribe` with channel name in body
- On WebSocket reconnect, re-subscribe to all active channels

### Logging

- Uses `tracing` + `tracing-subscriber` (existing)
- New log targets: `relay_broker::relaycast`, `relay_broker::ws_client`, `relay_broker::scheduler`, `relay_broker::spawner`
- Connection events logged at INFO level
- Message injection logged at DEBUG level
- Auth flow logged at DEBUG level (tokens redacted)
- `--json-output` flag emits structured JSON events on stderr (existing behavior, extended with new event types)

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
  --outbox-buffer <N>     Max buffered outbox messages when disconnected (default: 500)

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

### How `relay run` Invokes relay-broker

The Node.js `relay run` command becomes a thin launcher:

1. Find the `relay-broker` binary (PATH lookup, then `~/.npm/bin/relay-broker`, then adjacent `./relay-broker/target/release/relay-broker`)
2. Pass through all CLI arguments: `relay run claude --name lead` → `relay-broker --name lead claude`
3. `execvp` (replace process) — the Node.js process exits, relay-broker owns the terminal
4. If relay-broker binary not found, print install instructions and exit 1

---

## What Gets Deleted from Node.js

### Entire packages deleted

| Package | Lines | Reason |
|---------|-------|--------|
| packages/storage | 5,647 | relaycast persists |
| packages/benchmark | 1,888 | benchmarks dead system |

### Daemon package gutted (~90% deleted)

| File | Lines | Status | Reason |
|------|-------|--------|--------|
| server.ts | 1,978 | DELETE | local daemon — relaycast replaces |
| router.ts | 1,925 | DELETE | message routing — relaycast replaces |
| orchestrator.ts | 1,374 | DELETE | workspace mgmt — relaycast replaces |
| api.ts | 1,012 | DELETE | daemon HTTP API — relaycast replaces |
| hosted-runner.ts | 950 | DELETE | Node.js orchestrator — relay-broker replaces |
| cli-auth.ts | 906 | DELETE | daemon auth — relaycast handles auth |
| cloud-sync.ts | 902 | DELETE | auto-sync via relaycast |
| consensus.ts | 848 | DELETE | not needed |
| connector.ts | 766 | DELETE | Node.js bridge — relay-broker replaces |
| hosted-daemon.ts | 719 | DELETE | hosted daemon — relaycast replaces |
| agent-signing.ts | 707 | DELETE | not needed |
| agent-manager.ts | 677 | DELETE | agent mgmt — relaycast replaces |
| connection.ts | 561 | DELETE | connection FSM — relaycast replaces |
| relaycast-injector.ts | 528 | DELETE | Node.js bridge — relay-broker replaces |
| consensus-integration.ts | 510 | DELETE | not needed |
| sync-queue.ts | 477 | DELETE | sync/queue — relaycast replaces |
| repo-manager.ts | 468 | DELETE | repo management — relaycast replaces |
| ws-connection.ts | 409 | DELETE | WebSocket adapter — not needed |
| enhanced-features.ts | 390 | DELETE | not needed |
| workspace-manager.ts | 369 | DELETE | workspace mgmt — relaycast replaces |
| spawn-manager.ts | 362 | DELETE | spawning — relay-broker replaces |
| pty-spawner.ts | 313 | DELETE | Node.js spawn utils — relay-broker replaces |
| agent-registry.ts | 284 | DELETE | relaycast tracks agents |
| auth.ts | 276 | DELETE | daemon auth — relaycast replaces |
| channel-membership-store.ts | 217 | DELETE | relaycast tracks membership |
| rate-limiter.ts | 172 | DELETE | relaycast handles rate limiting |
| delivery-tracker.ts | 145 | DELETE | relaycast tracks delivery |
| outbox-parser.ts | 86 | DELETE | moved to Rust |
| registry.ts | 8 | DELETE | relaycast tracks agents |
| orchestrator.test.ts | 231 | DELETE | tests dead code |
| router.test.ts | 181 | DELETE | tests dead code |
| outbox-parser.test.ts | 98 | DELETE | tests dead code |

**Daemon files kept:**

| File | Lines | Reason |
|------|-------|--------|
| index.ts | 73 | MODIFY — re-export only what survives |
| types.ts | 158 | KEEP — shared types used by MCP/SDK |

**Total deleted from daemon: ~16,840 lines**

### CLI commands deleted/simplified

| Command | Status |
|---------|--------|
| `relay up` | DELETE — no daemon |
| `relay down` | DELETE — no daemon |
| `relay daemons` | DELETE — no daemon instances |
| `relay gc` | DELETE — no local state |
| `relay serve` | DELETE — no hosted daemon |
| `relay connect` | DELETE — no connector |
| `relay run` | REFACTOR — becomes thin launcher for relay-broker |
| `relay spawn` | DELETE — relay-broker handles spawning |
| `relay cloud` | DELETE — no cloud-sync |
| `relay bridge` | REVIEW — may still be needed for cross-project relay |

### SDK simplified

- Delete Unix socket transport (`socket-transport.ts`, 115 lines)
- Keep/enhance WebSocket transport (`websocket-transport.ts`, 245 lines)
- Refactor `client.ts` (2,164 lines) to use relaycast API directly
- Review `browser-client.ts` (985 lines) for relaycast compatibility
- Total SDK: 17 files, 5,907 lines — ~40% deleted/refactored

### Packages NOT mentioned above — disposition

| Package | Lines | Decision | Reason |
|---------|-------|----------|--------|
| packages/protocol | 2,701 | KEEP | Message types still used by MCP/SDK |
| packages/bridge | ~800 | DELETE | Local bridging — relay-broker replaces |
| packages/acp-bridge | ~300 | DELETE | ACP bridge — relay-broker replaces |
| packages/api-types | ~500 | KEEP | Type definitions for relaycast API |
| packages/spawner | 621 | DELETE | Node.js spawning — relay-broker replaces |
| packages/trajectory | 1,269 | KEEP | Work trajectory tracking (CLI tool) |
| packages/state | 500 | REVIEW | May merge into continuity |
| packages/user-directory | ~200 | KEEP | User directory service |
| packages/cli-tester | ~300 | KEEP | CLI testing utilities |
| packages/dashboard-server | ~400 | REFACTOR | Switch backend to relaycast API |

### What stays in Node.js

| Component | Why |
|-----------|-----|
| `relay` CLI | Thin wrapper, shells out to relay-broker |
| Dashboard web UI | User-facing Next.js app, talks to relaycast API |
| Dashboard server | Backend for dashboard, refactored to relaycast API |
| MCP server | Agent tool interface (36 files, 4,697 lines), refactored to relaycast backend |
| packages/wrapper | PTY orchestration utilities |
| packages/config | Project configuration |
| packages/utils | Name generation, command resolution |
| packages/resiliency | Logging, monitoring |
| packages/continuity | Session state |
| packages/memory | Semantic memory |
| packages/policy | Agent behavior control |
| packages/hooks | Event emission |
| packages/telemetry | Usage analytics |
| packages/protocol | Message types |
| packages/api-types | Relaycast API type definitions |
| packages/trajectory | Work trajectory tracking |
| packages/user-directory | User directory service |
| packages/cli-tester | CLI testing utilities |

---

## Implementation Waves

### Wave 1: Relaycast Client in Rust (foundation)

**Goal:** relay-broker can register with relaycast, send/receive messages

**New Rust modules:**
- `relaycast.rs` — HTTP client (reqwest): register, send DM, post message
- `ws_client.rs` — WebSocket client (tokio-tungstenite): connect, subscribe, handle events
- `auth.rs` — API key -> agent token flow, token caching, on-demand refresh

**New dependencies (Cargo.toml):**
```toml
reqwest = { version = "0.12", features = ["json", "rustls-tls"] }
tokio-tungstenite = { version = "0.24", features = ["rustls-tls-native-roots"] }
```

**Deliverable:** Can run `relay-broker --api-key rk_live_xxx echo "hello"` and see the agent register + connect to relaycast WebSocket.

**Agents:** 2 parallel
- Agent A [claude]: HTTP client + auth flow + agent registration
- Agent B [codex]: WebSocket client + event handling + reconnection logic

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
- Agent C [claude]: Inbound path (WebSocket events -> injection queue)
- Agent D [codex]: Outbound path (outbox watcher -> relaycast HTTP API)

---

### Wave 3: Injection Scheduler (human-aware queuing) — parallel with Wave 4

**Goal:** Smart injection that respects human typing and coalesces burst messages

**New module:**
- `scheduler.rs` — Replaces direct injection with priority-aware scheduling

**Changes:**
- `main.rs` — Monitor stdin for human keypress timestamps
- `inject.rs` — Check scheduler before injecting (human cooldown, coalesce window)
- `queue.rs` — Add priority tiers (P0-P4)

**Deliverable:** Human typing pauses injection. Burst messages from same sender are coalesced.

**Agents:** 1
- Agent E [claude]: Scheduler implementation + stdin monitoring + coalescing logic

---

### Wave 4: Spawning (multi-agent) — parallel with Wave 3

**Goal:** relay-broker can spawn child relay-broker processes

**New module:**
- `spawner.rs` — Parse spawn files, fork/exec child relay-broker, track PIDs, handle release/cleanup

**Changes:**
- `main.rs` — Handle spawn/release from outbox watcher and relay-broker stderr events
- `outbox_monitor.rs` — Detect KIND: spawn/release files

**Deliverable:** `relay-broker claude` can spawn a child `relay-broker codex` via `->relay-file:spawn`. Both communicate through relaycast.

**Agents:** 1
- Agent F [claude]: Spawn/release lifecycle, child process management, SIGCHLD handling, cleanup on exit

**Note:** Escalated from Codex to Claude. Tokio signal handling + async child process reaping + cascading cleanup + auth propagation crosses the complexity threshold for a worker agent.

---

### Wave 5: Socket Removal + Directory Rename

**Goal:** Remove the Unix socket server, rename binary and directory to relay-broker

**Changes:**
- `socket.rs` — DELETE entirely (no external injection needed)
- `main.rs` — Remove socket server startup, remove socket-related CLI flags (`--socket`, `--name` for socket path)
- `Cargo.toml` — Update `[[bin]] name` to `relay-broker`
- Rename directory `relay-pty/` to `relay-broker/`
- Update all references across the codebase (import paths, build scripts, CI, npm package)
- Update `findRelayPtyBinary` references in Node.js to `findRelayBrokerBinary`

**What stays from the socket protocol:** The internal InjectRequest/InjectResponse types stay — they just become in-memory structs passed between channels instead of JSON over a socket.

**Deliverable:** Binary is `relay-broker`. Directory is `relay-broker/`. No Unix socket. All injection is internal.

**Agents:** 1
- Agent G [codex]: Socket removal, directory rename, binary rename, reference updates

---

### Wave 6: Node.js Cleanup

**Goal:** Delete all Node.js code that relay-broker replaces

**Deletions:**
- packages/storage (entire package, 5,647 lines)
- packages/benchmark (entire package, 1,888 lines)
- packages/bridge (entire package, ~800 lines)
- packages/acp-bridge (entire package, ~300 lines)
- packages/spawner (entire package, 621 lines)
- packages/daemon: ALL files listed in the deletion table above (~16,840 lines)
- src/cli: remove `up`, `down`, `daemons`, `gc`, `serve`, `connect`, `spawn`, `cloud` commands
- Update `relay run` to exec relay-broker binary

**Refactors:**
- MCP server (36 files, 4,697 lines): switch backend from daemon to relaycast API
- SDK (17 files, 5,907 lines): remove socket transport, simplify to relaycast
- Dashboard server: switch from daemon WebSocket to relaycast API
- packages/daemon/index.ts: re-export only types.ts

**Agents:** 3 parallel
- Agent H [codex]: Delete daemon files + storage + benchmark + bridge + acp-bridge + spawner packages
- Agent I [codex]: Delete dead CLI commands, refactor `relay run` to exec relay-broker
- Agent J [claude]: Refactor MCP + SDK + dashboard-server to use relaycast API

---

### Wave 7: Testing + Integration

**Goal:** Everything works end-to-end

**Tests:**
- Rust: unit tests for relaycast client, ws_client, message_bridge, scheduler, spawner
- Integration: two relay-broker instances messaging through relaycast
- E2E: `relay run claude` works with the new relay-broker binary
- Disconnection: verify buffering, reconnection, message redelivery

**Agents:** 2 parallel
- Agent K [claude]: Integration tests: two relay-brokers through relaycast, spawn/release, disconnection
- Agent L [codex]: Rust unit tests for new modules (relaycast.rs, ws_client.rs, scheduler.rs, spawner.rs)

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


Wave 3 (injection scheduler) — parallel with Wave 4 ──────────────────────
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
  ├─ Lead-4 [claude]     Spawner: fork child relay-broker, track PIDs, cleanup
  |                       WHY CLAUDE: Escalated from Codex. Tokio signal handling
  |                       for SIGCHLD, async child process reaping, cascading
  |                       cleanup, and auth key propagation to children. Requires
  |                       modifying main.rs + outbox_monitor.rs + new spawner.rs.
  |
  └─ Deliverable: relay-broker spawns child relay-broker via ->relay-file:spawn


Wave 5 (socket removal + rename) ──────────────────────────────────────────
  |
  ├─ Worker-3 [codex]    Delete socket.rs, remove socket CLI flags, rename binary
  |                       and directory from relay-pty to relay-broker
  |                       WHY CODEX: Mechanical deletion and find-replace. Clear
  |                       checklist: delete file, remove imports, update Cargo.toml,
  |                       rename directory, update references.
  |
  └─ Deliverable: Binary is relay-broker. Directory is relay-broker/. No Unix socket.


Wave 6 (Node.js cleanup) ──────────────────────────────────────────────────
  |
  ├─ Worker-4 [codex]    Delete daemon files + storage + benchmark + bridge +
  |                       acp-bridge + spawner packages
  |                       WHY CODEX: Pure deletion. Delete listed files, remove
  |                       package.json entries, update monorepo config. No design
  |                       decisions.
  |
  ├─ Worker-5 [codex]    Delete dead CLI commands, refactor relay run
  |                       WHY CODEX: Remove up/down/daemons/gc/serve/connect/spawn/
  |                       cloud commands from src/cli/index.ts. Refactor relay run
  |                       to exec relay-broker. Mechanical edits.
  |
  ├─ Lead-5 [claude]     Refactor MCP + SDK + dashboard-server to relaycast API
  |                       WHY CLAUDE: Requires understanding MCP tool contracts,
  |                       SDK consumer expectations, and designing the new backend
  |                       integration. Not mechanical — needs judgment about what
  |                       to keep, what to change, and API compatibility.
  |
  └─ Deliverable: All dead Node.js code removed. MCP/SDK talk to relaycast.


Wave 7 (testing) ──────────────────────────────────────────────────────────
  |
  ├─ Lead-6 [claude]     Integration tests: two relay-brokers through relaycast
  |                       WHY CLAUDE: Designs test harness, manages test relaycast
  |                       environment, validates end-to-end message flow including
  |                       spawn/release, coalescing, human-awareness, disconnection.
  |
  ├─ Worker-6 [codex]    Rust unit tests for new modules
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
| Lead-4 | 4 | claude | Design | Process spawner + signal handling |
| Worker-3 | 5 | codex | Refactor | Socket removal + rename |
| Worker-4 | 6 | codex | Delete | Daemon files + packages |
| Worker-5 | 6 | codex | Delete | CLI commands cleanup |
| Lead-5 | 6 | claude | Refactor | MCP + SDK + dashboard backend swap |
| Lead-6 | 7 | claude | Design | Integration test harness |
| Worker-6 | 7 | codex | Implement | Unit tests |

### Resource Allocation

```
             Wave 1    Wave 2    Wave 3    Wave 4    Wave 5    Wave 6    Wave 7
Claude        1         1         1         1         -         1         1      = 6 assignments
Codex         1         1         -         -         1         2         1      = 6 assignments
                                                                                ────────────────
Parallel      2         2        [1]       [1]        1         3         2      Total: 12
                                  ↑         ↑
                                  └── run in parallel ──┘

Claude:Codex ratio = 6:6 (50% lead, 50% worker)
```

### When to Escalate Worker -> Lead

A Codex worker should be replaced with Claude if:
- The task requires modifying more than 3 files that import each other
- A design decision surfaces that wasn't anticipated in the spec
- Build errors require understanding cross-module type contracts
- The worker is stuck for more than 2 iterations on the same error

### Dependencies Between Waves

```
Wave 1 ─────► Wave 2 ─────┬─► Wave 3 ─┬──► Wave 5 ─────► Wave 6 ─────► Wave 7
                           |            |
                           └─► Wave 4 ──┘
```

- Wave 2 needs Wave 1 (relaycast client must exist to bridge messages)
- Wave 3 needs Wave 2 (scheduler needs working message flow)
- Wave 4 needs Wave 2 (spawning needs working message flow), runs parallel with Wave 3
- Wave 5 needs Waves 3+4 (socket removal needs all new paths working)
- Wave 6 needs Wave 5 (don't delete Node.js until Rust is the runtime)
- Wave 7 needs Wave 6 (test the final system)

---

## Decisions Made

These design decisions are intentional and should not be revisited:

| Decision | Rationale |
|----------|-----------|
| No "custom daemon" mode | relay-broker only talks to relaycast. Local-only mode is dropped. |
| No configuration files | relay-broker is configured entirely via CLI flags and env vars. packages/config stays for the Node.js CLI layer only. |
| exec, not spawn | `relay run` replaces its process with relay-broker via execvp. No Node.js parent process stays alive. |
| Token refresh on failure | No background refresh thread. Re-register on 401. Simpler. |
| Outbox buffer cap | 500 messages / 5MB max during disconnection. Prevents unbounded memory growth. |

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
**Total deleted Node.js: ~26,000+ lines** (daemon ~16,840 + storage 5,647 + benchmark 1,888 + bridge ~800 + acp-bridge ~300 + spawner 621)

---

## Risk Mitigations

| Risk | Mitigation |
|------|------------|
| relaycast API changes | Pin API version, integration tests |
| WebSocket reliability | Exponential backoff reconnect with jitter (1s-30s) |
| Human typing detection false positives | Configurable cooldown, conservative 3s default |
| Child process zombies | SIGCHLD handler, periodic PID reaping, graceful shutdown cascade |
| Binary size increase | reqwest + tungstenite add ~4-5MB, total ~7-8MB |
| Cross-platform | reqwest + tungstenite work on Linux/macOS/Windows |
| relaycast downtime | Outbox buffer (500 msg / 5MB), CLI continues functioning, reconnect on recovery |
| Token expiry mid-session | Re-register on 401, transparent to CLI |
| Spawned agent auth | Parent passes --api-key to child, child registers independently |
