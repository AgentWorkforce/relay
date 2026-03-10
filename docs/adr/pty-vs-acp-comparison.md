# ADR: What Is Lost Moving from PTY to ACP

**Status**: Analysis
**Date**: 2026-03-10
**Context**: Evaluating ACP (Agent Client Protocol) as an alternative runtime to PTY for agent management, while keeping Relaycast as the hosted message routing layer.

---

## Architecture Recap

```
Agent A → MCP tools → Relaycast Cloud → Broker → [PTY | ACP] → Agent B
                                                   ^^^^^^^^
                                              ACP only changes this
```

ACP replaces the **last mile** — how the broker communicates with agent processes. Relaycast workspaces, channels, DMs, threads, presence, webhooks, and the dashboard are unchanged.

---

## 1. Mid-Turn Message Injection — LOST (High Severity)

### What PTY does

The broker maintains a `pending_worker_injections: VecDeque` and processes it on a 50ms tick inside the `tokio::select!` loop. Messages are written directly into the terminal at any time:

```rust
// src/pty_worker.rs:300-329
"deliver_relay" => {
    let delivery: RelayDelivery = serde_json::from_value(frame.payload)?;
    pending_worker_injections.push_back(PendingWorkerInjection {
        delivery,
        request_id: frame.request_id,
        queued_at: Instant::now(),
    });
}
```

The actual injection is a raw PTY write — the equivalent of a human typing into the terminal:

```rust
// Format: "Relay message from {from} [in #{channel}] [{event_id}]: {body}"
pty.write_all(formatted_message.as_bytes());
pty.write_all(b"\r"); // Enter
```

The broker also auto-suggestion-blocks injection for 10s after detecting an auto-complete suggestion (`AUTO_SUGGESTION_BLOCK_TIMEOUT`) to avoid corrupting the agent's input.

### What ACP cannot do

ACP is strictly request-response. `session/prompt` must complete (`stopReason: "end_turn"`) before another can be sent. There is no `pty.write_all()` equivalent. The only interruption mechanism is `session/cancel`, which aborts the entire turn.

### Impact

If Agent A sends Agent B a message while B is mid-task:
- **PTY**: message arrives within 50ms (subject to idle detection)
- **ACP**: message queues until B's current turn finishes — potentially minutes later

This breaks real-time coordination patterns (mesh, consensus, debate). The lead+workers pattern is mostly unaffected since workers report DONE before receiving the next task.

---

## 2. 5-Stage Delivery Lifecycle — LOST (Medium Severity)

### What PTY does

After injecting a message, the broker verifies the agent saw it by scanning PTY output for the injected text:

```rust
// src/helpers.rs:211-214
pub(crate) fn check_echo_in_output(output: &str, expected: &str) -> bool {
    let clean = strip_ansi(output);
    clean.contains(expected)
}
```

This feeds a 5-event delivery lifecycle:

| Event | Meaning |
|---|---|
| `delivery_queued` | Broker received message, waiting for injection window |
| `delivery_injected` | Written to PTY |
| `delivery_ack` | Echo detected in output — agent saw the message |
| `delivery_verified` | Confirmed (or timeout fallback after 5s) |
| `delivery_active` | Agent is working on it (activity pattern detected) |

Plus adaptive throttling that backs off on delivery failures:

```rust
// src/helpers.rs:98-128 — ThrottleState
DeliveryOutcome::Success => {
    // Halve delay after 3 consecutive successes (min 100ms)
}
DeliveryOutcome::Failed => {
    // Back off: 100ms → 200ms → 500ms → 1s → 2s → 5s
}
```

And CLI-specific activity detection:

```rust
// src/helpers.rs:146-159
let patterns = if lower.contains("claude") {
    vec!["⠋", "⠙", "⠹", "Tool:", "Read(", "Write(", "Edit("]
} else if lower.contains("codex") {
    vec!["Thinking...", "Running:", "$ ", "function_call"]
} else if lower.contains("gemini") {
    vec!["Generating", "Action:", "Executing"]
};
```

### What ACP provides instead

A `session/prompt` either succeeds (response received) or fails (connection error / cancel). Delivery is guaranteed by the protocol — no echo verification needed.

### What's lost

The observability. A lead agent can no longer ask "has worker-3 started working on my message?" by checking for `delivery_active`. ACP's `session/update` events (thinking, tool_call, message chunks) are richer and structured, but they're per-turn data — there's no delivery-ID-to-activity correlation.

---

## 3. Auto-Approval Handlers — ELIMINATED (Good)

### What PTY does

`PtyAutoState` (src/wrap.rs:32-56) contains five auto-approval handlers, each with detection buffers, cooldown timers, and response automation:

| Handler | Detects | Responds With | Lines |
|---|---|---|---|
| MCP approval | "MCP Server Approval Required" | `a` key (approve all) | wrap.rs:93-129 |
| Bypass permissions | "bypass" + "permission" prompts | `y\n` or arrow-down + enter | wrap.rs:131-157 |
| Codex model upgrade | "Codex" + "upgrade" dialog | arrow-down + enter | wrap.rs:160-176 |
| Gemini action | "Action Required" + "Allow" | `2\n` | wrap.rs:179-198 |
| CLI flag injection | — | `--force --approve-mcps` | helpers.rs:49-59 |

Plus auto-enter for stuck agents with exponential backoff (10s → 15s → 25s → 40s → 60s):

```rust
// src/wrap.rs:202-232
let backoff_multiplier = match self.auto_enter_retry_count {
    0 => 1.0, 1 => 1.5, 2 => 2.5, 3 => 4.0, _ => 6.0,
};
let _ = pty.write_all(b"\r");
```

### What ACP provides instead

Permissions via `session/request_permission`. MCP servers configured in `session/new`. No terminal prompts exist.

### Impact

**200+ lines of fragile, CLI-specific text detection become unnecessary.** This is the strongest argument FOR ACP. Every new CLI version that changes its prompt format risks breaking these handlers.

---

## 4. Continuity / Crash Recovery Protocol — LOST (Medium Severity)

### What PTY does

The broker scans PTY output for `KIND: continuity` blocks — a custom protocol where agents signal state save/load:

```
KIND: continuity
ACTION: save

{serialized state here}
```

Parser at `src/helpers.rs:798-848`:

```rust
pub(crate) fn parse_continuity_command(buf: &str) -> Option<(ContinuityAction, String, usize)> {
    // ContinuityAction::Save | Load | Uncertain
    // Returns body content for persistence
}
```

Scans a bounded 4KB continuity buffer, only when no echo verifications are pending (to avoid false positives from injected messages).

### What ACP provides instead

ACP has `session/load` (resume sessions across restarts) and a proposed `session/resume` (reconnect without replay). These cover the "restore after crash" case but not the agent-initiated "I'm about to crash, here's my state" case.

### What's lost

The agent-initiated state save mechanism. With PTY, the agent outputs `KIND: continuity / ACTION: save` at any time and the broker captures it. With ACP, the agent would need an MCP tool (`relay_save_state`) or a protocol extension.

---

## 5. Crash Classification Accuracy — DEGRADED (Low-Medium Severity)

### What PTY does

Three-method process detection (`src/pty.rs:162-277`):
1. `try_wait()` — waitpid with WNOHANG
2. `kill(pid, 0)` — Unix process existence check
3. No-PID fallback — 6 consecutive checks = assume dead

`CrashInsights` (`src/crash_insights.rs`) classifies by exit code and signal:

```rust
pub enum CrashCategory {
    Oom,       // exit 137, SIGKILL
    Segfault,  // SIGSEGV / signal 11
    Error,     // nonzero exit
    Signal,    // other signals
    Unknown,
}
```

Health score (0-100) based on hourly crash rate. `Supervisor` (`src/supervisor.rs`) with policy-driven restart (max 5 restarts, 2s cooldown, max 3 consecutive failures).

### What ACP provides instead

ACP does not define lifecycle management. The broker would see "HTTP connection to ACP adapter dropped" — but not whether the underlying cause was OOM (137), segfault (SIGSEGV), or a clean exit.

### What's lost

Crash classification granularity. The supervisor restart logic could be ported to restart ACP adapters, but it adds a layer of indirection (broker → adapter → CLI) and loses direct process signal access.

---

## 6. Swarm TUI Data Pipeline — NEEDS REWRITE (Medium Severity)

### What PTY does

`SwarmTui` (`src/swarm_tui.rs:86-408`) renders a live terminal dashboard consuming `TuiUpdate` events driven by PTY output:

```rust
pub enum TuiUpdate {
    WorkerActivity { name: String, activity: String },  // from ActivityDetector
    WorkerCompleted { name: String },
    Tick { elapsed_secs: u64, pending_count: usize, total_count: usize },
    Log { message: String },
}
```

Worker activity comes from scanning PTY output for spinner chars and tool names. The TUI renders box-drawn borders, per-worker status rows, activity logs, and an interactive input bar.

### What ACP provides instead

`session/update` events with typed data: `thinking` chunks, `tool_call` events (with kind: read/edit/execute), `plan` updates. These are richer than PTY text scanning.

### What's lost

Not the TUI itself — but the data source pipeline. `WorkerActivity` would need to map from `session/update` events instead of `ActivityDetector` pattern matching. The interactive input bar would route through `session/prompt` instead of `pty.write_all()` (which means messages can't be sent while the worker is active — circles back to item #1).

---

## 7. Wrap Mode (Interactive Passthrough) — LOST (High Severity)

### What PTY does

`run_wrap()` (`src/wrap.rs:342+`) provides full interactive terminal passthrough:
- Stdin reader thread → writes to PTY (human types, agent sees it)
- PTY output → writes to stdout (human sees agent output)
- Raw mode terminal with SIGWINCH resize handling
- Relay messages injected alongside human input

This enables `agent-relay-broker wrap <cli>` — attach a human terminal to a relay-connected agent.

### What ACP cannot do

ACP is `session/prompt` → `session/update` → turn ends. There is no stdin passthrough. A human cannot type commands to the agent mid-turn. There is no terminal session to attach to.

### What's lost

The entire `agent-relay-broker wrap` command. Interactive agent sessions require PTY mode.

---

## 8. Mid-Turn Idle Detection — LOST (Medium Severity)

### What PTY does

Edge-triggered idle detection (`src/wrap.rs:258-273`) emits `agent_idle` once on active → idle transition:

```rust
// Threshold: idle_threshold_secs (default 30s)
if since_output >= threshold && !self.is_idle {
    self.is_idle = true;
    Some(since_output.as_secs())
}
```

Hard safety net: `NO_OUTPUT_EXIT_TIMEOUT` (120s) — no PTY output for 2 minutes = assume dead.

### What ACP provides instead

Turn completion (`stopReason: "end_turn"`) signals idle. But during a turn, silence is invisible. An agent thinking for 60s produces no signal.

### What's lost

Detection of agents stuck mid-turn. With PTY, 30s silence → `agent_idle` event. With ACP, a hung turn blocks indefinitely unless the broker implements its own timeout on `session/update` streaming.

---

## 9. Terminal Query Handling — ELIMINATED (Good)

### What PTY does

`TerminalQueryParser` (`src/helpers.rs:276-295`) intercepts DA1/DA2/DSR escape sequences and auto-responds to prevent agents hanging on unanswered terminal queries.

### What ACP provides instead

No terminal. No escape sequences. Not needed.

---

## Summary Matrix

| # | Capability | PTY | ACP | Verdict |
|---|---|---|---|---|
| 1 | Mid-turn message injection | 50ms queue + write | Must wait for turn end | **LOST** — High |
| 2 | 5-stage delivery lifecycle | Echo verify + activity detect | Guaranteed by protocol | **LOST** — Medium |
| 3 | Auto-approval handlers | 5 handlers, 200+ lines | `session/request_permission` | **ELIMINATED** |
| 4 | Auto-enter for stuck agents | Exponential backoff Enter | `session/cancel` | **ELIMINATED** |
| 5 | Continuity protocol | KIND: continuity in-band | session/load (adapter-dependent) | **LOST** — Medium |
| 6 | Crash classification | Exit code + signal + OOM/SEGV | "Connection dropped" | **DEGRADED** — Low-Med |
| 7 | Swarm TUI | ActivityDetector → TuiUpdate | session/update → ? | **REWRITE** — Medium |
| 8 | Wrap mode (interactive) | Full stdin/stdout passthrough | Not possible | **LOST** — High |
| 9 | Mid-turn idle detection | Edge-triggered, 30s threshold | Turn-end only | **LOST** — Medium |
| 10 | Terminal query handling | DA1/DA2/DSR auto-response | Not needed | **ELIMINATED** |

### Hard losses (no workaround)
- **Mid-turn injection** (#1) — breaks real-time coordination
- **Wrap mode** (#8) — no interactive equivalent

### Soft losses (workarounds exist)
- **Delivery lifecycle** (#2) — ACP's structured updates are different but usable
- **Continuity** (#5) — replace with MCP tool or protocol extension
- **Crash classification** (#6) — adapter could forward exit codes
- **Idle detection** (#9) — broker-side timeout on session/update stream

### Eliminated (good riddance)
- **Auto-approval** (#3) — 200+ lines of fragile text detection gone
- **Auto-enter** (#4) — PTY-specific workaround not needed
- **Terminal queries** (#10) — PTY-specific workaround not needed

---

## Recommendation

Make ACP opt-in per agent (`runtime: "acp"` in AgentSpec), keep PTY as default:

- **Automated workers** (lead+workers pattern): ACP is strictly better — structured output, clean permissions, no CLI-specific hacks
- **Interactive agents** (wrap mode, human-in-the-loop): PTY only
- **Real-time collaborative** (mesh, consensus, debate): PTY required for mid-turn injection
- **Swarm TUI**: Works with both runtimes if the data pipeline is abstracted

Relaycast remains the hosted routing layer regardless of runtime choice.
