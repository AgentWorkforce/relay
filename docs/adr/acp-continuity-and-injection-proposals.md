# Proposals: Continuity via MCP Tools + Mid-Turn Injection Solutions

**Status**: Proposal
**Date**: 2026-03-10
**Depends on**: [pty-vs-acp-comparison.md](./pty-vs-acp-comparison.md)

---

## Part 1: Continuity via MCP Tools

### Problem

The PTY continuity protocol is fragile:

- Parses `KIND: continuity` / `ACTION: save` text blocks from a bounded 4KB terminal buffer (`pty_worker.rs:232-233`, `helpers.rs:798-886`)
- Only scans when `pending_verifications.is_empty()` to avoid false positives from injected messages (`pty_worker.rs:466`)
- Buffer management with `floor_char_boundary()` to avoid splitting UTF-8 (`pty_worker.rs:468-473`)
- Agent must output exact text format — no validation, no structured data, no error handling

With ACP, there is no terminal output to parse. We need a replacement.

### Proposal: `relay_checkpoint` and `relay_restore` MCP Tools

Add two MCP tools to the `@relaycast/mcp` server. These are available to agents via their MCP tool surface — works identically in PTY mode and ACP mode.

#### Tool: `relay_checkpoint`

```typescript
{
  name: "relay_checkpoint",
  description: "Save agent state for crash recovery or handoff. State is persisted to Relaycast cloud and associated with this agent's current session.",
  inputSchema: {
    type: "object",
    properties: {
      state: {
        type: "object",
        description: "Serializable state to persist. Typically includes current task context, progress, and any data needed to resume."
      },
      label: {
        type: "string",
        description: "Human-readable label for this checkpoint (e.g., 'mid-refactor', 'tests-passing')"
      }
    },
    required: ["state"]
  }
}
```

**Server-side behavior:**

1. Receives structured JSON (not terminal text)
2. Stores via Relaycast API: `POST /v1/agents/{name}/checkpoints`
3. Payload: `{ label, state, timestamp, sessionId }`
4. Retains last N checkpoints per agent (suggest N=5)
5. Returns `{ checkpointId, timestamp }` on success

#### Tool: `relay_restore`

```typescript
{
  name: "relay_restore",
  description: "Load the most recent checkpoint for this agent or a named predecessor. Use when resuming after a crash or continuing another agent's work.",
  inputSchema: {
    type: "object",
    properties: {
      from: {
        type: "string",
        description: "Agent name to restore from. Defaults to self. Use this for handoff: agent-2 restores agent-1's checkpoint."
      },
      checkpointId: {
        type: "string",
        description: "Specific checkpoint ID. If omitted, returns the most recent."
      }
    }
  }
}
```

**Server-side behavior:**

1. Fetches from Relaycast API: `GET /v1/agents/{name}/checkpoints?latest=true`
2. Returns `{ checkpointId, label, state, timestamp, agentName }` or `null` if none
3. The `from` parameter enables handoff: `continueFrom` in `SpawnPtyInput` (`client.ts:52`) becomes a prompt hint telling the new agent to call `relay_restore(from: "predecessor-name")`

### Why This Is Better Than PTY Continuity

| Aspect | PTY (`KIND: continuity`) | MCP (`relay_checkpoint`) |
|---|---|---|
| Data format | Free text in terminal output | Structured JSON |
| Parsing | Regex over 4KB ring buffer | Native JSON-RPC |
| Validation | None — any text accepted | Schema-validated |
| Error handling | Silent drop if buffer overflows | Tool returns error |
| False positives | Must gate on `pending_verifications` | Impossible — explicit tool call |
| Storage | Broker-side, in-memory only | Relaycast cloud, persisted |
| Cross-restart | Lost if broker crashes | Survives broker + agent crashes |
| Handoff | `continueFrom` flag, broker-managed | Agent calls `relay_restore(from: "old-agent")` |
| Runtime compatibility | PTY only | PTY + ACP + any future runtime |

### Migration Path

1. Add `relay_checkpoint` / `relay_restore` to `@relaycast/mcp`
2. Update agent prompt snippets to use the new tools instead of `KIND: continuity` output
3. Keep the `parse_continuity_command()` parser for backward compat (agents running old prompts)
4. Deprecate `KIND: continuity` in next major version

### Impact on `continueFrom`

Currently `continueFrom` in `SpawnPtyInput` (`client.ts:52`) tells the broker to inject a predecessor's continuity context. With MCP tools:

- **Remove** `continueFrom` from `SpawnPtyInput` — no longer a broker concern
- **Instead**: task prompt includes "Call `relay_restore(from: 'worker-3')` to load predecessor state"
- Agent is in control of when/whether to restore, not the broker

---

## Part 2: Mid-Turn Injection — Decision

### The Core Problem

ACP `session/prompt` is request-response. While Agent B processes a turn (1-10 minutes), inbound relay messages from Agent A cannot be delivered. The broker has no write path into the agent's context mid-turn.

PTY solves this with `pty.write_all()` on a 50ms tick (`pty_worker.rs:642-709`), injecting formatted messages directly into the terminal. ACP has no equivalent.

### Why No ACP Workaround Is Sufficient

Every approach to mid-turn injection under ACP fails at a fundamental level:

| Approach | Failure Mode |
|---|---|
| **Queue + drain on turn boundary** | Latency = turn duration (seconds to minutes). Not injection — just delayed delivery. |
| **Cancel + re-prompt** | Destructive. Agent loses in-flight tool calls and thinking state. Context reconstruction is lossy. |
| **MCP tool polling (`relay_inbox`)** | Relies on LLM choosing to call the tool. No guarantee. Not broker-controlled. |
| **"MCP sidecar" / dual-channel** | Collapses to polling. The MCP server receives messages via WebSocket, but the LLM can only access them via tool calls *within* the ACP turn. `notifications/tools/list_changed` goes to the ACP adapter, not the LLM mid-generation. There is no second channel — just a buffer the agent might or might not read. |
| **ACP spec extension (`session/inject`)** | Doesn't exist. Would need upstream spec change, adapter implementation across all agents, and months/years of adoption. Can't depend on it. |

The "MCP sidecar" concept deserves specific debunking because it sounds plausible:

```
                    ┌─── ACP (session/prompt) ──────────────┐
Broker ────────────►│ Agent Process                          │
                    │   ├── ACP adapter (turn-based)         │
                    │   └── Relaycast MCP server (has WS)    │◄── messages arrive here
                    └────────────────────────────────────────┘
                                                               ↑
                                                        But the LLM can only
                                                        see them via tool calls
                                                        gated by ACP turns
```

The MCP server having a WebSocket is irrelevant. The LLM interacts with MCP servers exclusively through tool calls. Tool calls happen within ACP turns. The ACP adapter mediates all tool access. There is no path from "MCP server received a WebSocket message" to "LLM is now aware of it" that doesn't go through ACP's turn-based tool-call mechanism — which means the LLM has to decide to call `relay_inbox()`, which it may not do.

### Decision: Mid-Turn Injection Requires PTY

**If a workflow needs mid-turn message injection, it must use PTY runtime.**

ACP's turn-based model is architecturally incompatible with injection. This is not a gap to be worked around — it is a design choice in the protocol. ACP chose structured request-response over raw I/O. That trade-off gives you typed tool calls, clean permissions, and reliable delivery, but it removes the ability to write arbitrary data into the agent's input stream at arbitrary times.

### What ACP CAN Do (Turn-Boundary Delivery)

For workflows that don't need mid-turn injection, ACP can deliver messages at turn boundaries. This is not injection — it's queued delivery:

```
Agent A → Relay → Broker [queue: msg1, msg2]
                         ... Agent B's turn completes ...
                  Broker → ACP session/prompt("You have 2 pending messages:
                    1. From Agent A [evt_abc]: ...
                    2. From Agent C [evt_def]: ...")
```

**Delivery lifecycle mapping (ACP mode):**
- `delivery_queued` — message enters broker queue (immediate)
- `delivery_prompted` — sent as next `session/prompt` (replaces `delivery_injected`)
- `delivery_ack` — ACP response received (guaranteed by protocol, replaces echo verification)
- `delivery_active` — inferred from `session/update` events (tool_call, thinking)

This works for:
- **Lead + workers** — workers finish turns, report DONE, get next task
- **Pipeline** — each stage completes before the next starts
- **Fan-out/gather** — fan-out is prompt-per-worker, gather waits for all turns to complete
- **Hub-spoke** — hub sends tasks, spokes complete turns and respond

This does NOT work for:
- **Mesh** — agents must react to messages while working
- **Consensus/Debate** — agents must see counterarguments mid-reasoning
- **Interactive** — human-in-the-loop needs real-time input

### Cancel + Re-Prompt as Emergency Interrupt

For urgent messages (P0/P1), the broker can use `session/cancel` + re-prompt as a destructive interrupt:

```
Agent B processing turn...
Agent A sends P0 message →
  Broker: session/cancel
  Agent B: { stopReason: "cancelled", response: [partial work] }
  Broker: session/prompt("Continue your previous task.
    Progress so far: {partial_response}.
    URGENT MESSAGE from Agent A: {message}")
```

This should only be used for critical interrupts because:
- Agent loses in-flight tool calls and thinking state
- Context reconstruction from `partial_response` is lossy
- Wastes tokens re-processing cancelled work
- Race condition if cancel arrives during a tool call

**Priority mapping from `BoundedPriorityQueue` (`queue.rs`):**
- P0 (critical): Cancel immediately, re-prompt
- P1 (high): Cancel if agent idle >5s, else queue
- P2-P4: Always queue for next turn boundary

### Runtime Selection Rule

**ACP is the default.** PTY is the fallback for patterns that require mid-turn injection.

ACP gives you structured tool calls, clean permissions via `session/request_permission`, no CLI-specific auto-approval hacks, and guaranteed delivery at turn boundaries. There is no reason to use PTY unless you specifically need to write into the agent's input stream while it's working.

```
┌─────────────────────────────────────────────────┐
│ Does the workflow need mid-turn message injection? │
│                                                   │
│   NO  → runtime: "acp" (DEFAULT)                  │
│         Structured output, typed tool calls,       │
│         clean permissions, no auto-approval hacks, │
│         turn-boundary delivery with queue + drain  │
│                                                   │
│   YES → runtime: "pty" (FALLBACK)                 │
│         PTY injection via pty.write_all()          │
│         50ms delivery queue tick                   │
│         Echo verification + activity detection     │
│         Full 5-stage delivery lifecycle            │
│         Auto-approval handlers (fragile)           │
└─────────────────────────────────────────────────┘
```

This maps to swarm patterns:

| Pattern | Mid-Turn Injection? | Runtime |
|---|---|---|
| Lead + Workers | No | **`acp`** (default) |
| Pipeline | No | **`acp`** (default) |
| Fan-out/Gather | No | **`acp`** (default) |
| Hub-spoke | No (P0 via cancel) | **`acp`** (default) |
| Cascade | No | **`acp`** (default) |
| DAG | No | **`acp`** (default) |
| Handoff | No | **`acp`** (default) |
| Mesh | **Yes** | `pty` (fallback) |
| Consensus | **Yes** | `pty` (fallback) |
| Debate | **Yes** | `pty` (fallback) |
| Hierarchical | Depends on sub-pattern | Mixed |

Most real-world swarms use lead+workers, pipeline, or fan-out — all ACP-compatible. Mesh, consensus, and debate are specialized patterns that represent a small fraction of usage.

### Future: ACP `session/inject` Proposal

If ACP adds a `session/inject` method, mid-turn injection becomes possible without PTY. This would be the ideal solution:

```typescript
// Proposed ACP extension
interface SessionInjectParams {
  sessionId: string;
  content: ContentBlock[];
  priority?: "normal" | "urgent";
}
```

The agent would receive injected content as a notification during turn processing and handle it at natural breakpoints (between tool calls). This is worth proposing as an RFD to the ACP spec, but we cannot depend on it.

**Until `session/inject` exists: mid-turn injection = PTY. No exceptions.**

---

## Implementation Sketch: ACP Turn-Boundary Delivery

```rust
// In acp_worker.rs (new file, parallel to pty_worker.rs)

struct AcpWorkerState {
    pending_messages: VecDeque<RelayDelivery>,
    current_turn_active: bool,
    session_id: String,
}

impl AcpWorkerState {
    /// Called when a relay message arrives for this agent
    fn enqueue_delivery(&mut self, delivery: RelayDelivery) {
        // Emit delivery_queued event
        self.pending_messages.push_back(delivery);
    }

    /// Called after session/prompt returns (turn complete)
    fn drain_pending(&mut self) -> Option<String> {
        if self.pending_messages.is_empty() {
            return None;
        }
        let messages: Vec<String> = self.pending_messages
            .drain(..)
            .enumerate()
            .map(|(i, d)| format!(
                "{}. Relay message from {} [{}]: {}",
                i + 1, d.from, d.event_id, d.body
            ))
            .collect();

        Some(format!(
            "You have {} pending relay message(s):\n\n{}",
            messages.len(),
            messages.join("\n\n")
        ))
    }
}

// Main loop sketch:
loop {
    let prompt = if let Some(pending) = state.drain_pending() {
        // Deliver queued messages as next prompt
        pending
    } else {
        // Wait for next relay message or external prompt
        wait_for_next_delivery(&mut rx).await
    };

    // Send via ACP
    let response = acp_client.session_prompt(&state.session_id, &prompt).await?;

    // Process response, emit delivery_ack for each delivered message
    // Check for new messages that arrived during this turn
}
```
