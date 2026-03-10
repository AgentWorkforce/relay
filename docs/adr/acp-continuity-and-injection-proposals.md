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

## Part 2: Mid-Turn Injection — Five Proposals

### The Core Problem

ACP `session/prompt` is request-response. While Agent B processes a turn (1-10 minutes), inbound relay messages from Agent A cannot be delivered. The broker has no write path into the agent's context mid-turn.

PTY solves this with `pty.write_all()` on a 50ms tick (`pty_worker.rs:642-709`), injecting formatted messages directly into the terminal. ACP has no equivalent.

### Proposal A: Queue + Drain on Turn Boundary

**Mechanism**: Broker queues inbound messages. When the current `session/prompt` completes (`stopReason: "end_turn"`), broker sends queued messages as the next prompt.

```
Agent A → Relay → Broker [queue: msg1, msg2]
                         ... Agent B's turn completes ...
                  Broker → ACP session/prompt("You have 2 pending messages:\n1. From Agent A: ...\n2. From Agent C: ...")
```

**Pros:**
- Simple to implement
- No protocol extensions
- Works with all ACP adapters

**Cons:**
- Latency: messages wait until turn ends (seconds to minutes)
- Breaks real-time patterns (mesh, consensus, debate)
- Lead agent can't interrupt a stuck worker

**Best for:** Lead+workers pattern where workers complete tasks before receiving the next one. This is already the dominant relay pattern.

**Delivery lifecycle mapping:**
- `delivery_queued` — message enters broker queue (immediate)
- `delivery_injected` — becomes `delivery_prompted` when sent as next `session/prompt`
- `delivery_ack` — ACP response received (guaranteed by protocol)
- `delivery_verified` — same as ack (no echo verification needed)
- `delivery_active` — inferred from `session/update` events (tool_call, thinking)

---

### Proposal B: Cancel + Re-Prompt with Context Merge

**Mechanism**: On high-priority message, broker sends `session/cancel`, waits for cancellation, then re-prompts with merged context: original task + accumulated progress + new message.

```
Agent B processing turn...
Agent A sends urgent message →
  Broker: session/cancel
  Agent B: { stopReason: "cancelled", response: [partial work] }
  Broker: session/prompt("Continue your previous task. Here's what you've done so far: {partial_response}. NEW MESSAGE from Agent A: {message}")
```

**Pros:**
- Delivers messages within seconds
- Works with standard ACP

**Cons:**
- Destructive: agent loses in-flight tool calls, thinking state
- Context reconstruction is lossy — partial_response may not capture full state
- Wastes tokens re-processing cancelled work
- Race condition: cancel arrives while agent is mid-tool-call

**Mitigation**: Only trigger for priority >= P1 messages. P2+ messages use Proposal A (queue + drain).

**Priority mapping from `BoundedPriorityQueue` (`queue.rs`):**
- P0 (critical): Cancel immediately, re-prompt
- P1 (high): Cancel if idle for >5s, else queue
- P2-P4: Always queue for next turn boundary

---

### Proposal C: MCP Tool Polling (`relay_inbox` Pull Model)

**Mechanism**: Agent proactively calls `relay_inbox()` during its turn to check for new messages. Broker doesn't inject — agent pulls.

```
Agent B's turn:
  1. Think about task...
  2. Call tool: relay_inbox()  → returns [{from: "Agent A", body: "..."}]
  3. Process message inline
  4. Continue task...
```

**Pros:**
- No protocol extension needed
- Agent decides when to check (natural breakpoints between tool calls)
- Works today — `relay_inbox` already exists in `@relaycast/mcp`

**Cons:**
- Agent must be prompted to check inbox regularly ("Check relay_inbox every 3-5 tool calls")
- No guarantee agent will check — LLM may ignore instruction
- Adds latency: message waits until next inbox check
- Consumes tool-call budget on polling

**Enhancement — Inbox Hint via MCP Notification:**

MCP supports server-initiated notifications. When a relay message arrives for Agent B:

1. Relaycast MCP server receives the message via its own WebSocket connection
2. Server sends MCP notification: `notifications/tools/list_changed`
3. ACP adapter sees tool list changed, re-fetches tools
4. A new dynamic tool appears: `relay_pending_message_1` with the message content in its description
5. Agent sees the tool in its context and can decide to "call" it (acknowledging the message)

This is a hack, but it's within spec. The real version would use MCP's proposed `notifications/message` (not yet standardized).

---

### Proposal D: Dual-Channel Architecture (MCP Sidecar)

**Mechanism**: Agent has two communication channels: ACP for prompt/response, and a persistent MCP connection for real-time relay messages.

```
                    ┌─── ACP (session/prompt) ──────────────┐
Broker ────────────►│ Agent Process                          │
                    │   ├── ACP adapter (turn-based)         │
                    │   └── Relaycast MCP server (persistent)│◄── relay messages
                    └────────────────────────────────────────┘
```

**How it works:**

1. Broker spawns agent with ACP adapter
2. `session/new` includes Relaycast MCP server in `mcpServers` config
3. Relaycast MCP server maintains its own WebSocket to Relaycast cloud
4. When relay message arrives, MCP server receives it via WebSocket
5. Agent discovers message via `relay_inbox()` tool (pull) or `notifications/tools/list_changed` (push-ish)
6. Agent processes message as part of its current turn

**Pros:**
- ACP handles structured prompt/response
- MCP handles real-time relay messaging
- Clean separation of concerns
- Messages available within the turn via tool calls

**Cons:**
- Still relies on agent choosing to call `relay_inbox()` (same as Proposal C)
- MCP server must maintain persistent WebSocket (already does for PTY mode)
- Two connections per agent to Relaycast cloud

**This is the most architecturally clean option.** ACP owns the conversation lifecycle. MCP owns the tool surface including relay communication. The broker orchestrates both.

---

### Proposal E: ACP Protocol Extension (`session/inject`)

**Mechanism**: Propose a new ACP method `session/inject` that allows the client to send a message into an active turn without cancelling it.

```typescript
// New ACP method (would need spec proposal)
interface SessionInjectParams {
  sessionId: string;
  content: ContentBlock[];
  priority?: "normal" | "urgent";
}

// Agent receives as a notification during turn processing
interface SessionInjectedNotification {
  sessionId: string;
  content: ContentBlock[];
  injectedAt: string; // ISO timestamp
}
```

**Pros:**
- First-class solution: protocol-level support for exactly the PTY capability we're losing
- Clean semantics: agent can handle injected messages at natural breakpoints
- Compatible with existing `session/update` streaming

**Cons:**
- Requires ACP spec change — not something we control
- Every adapter must implement it
- May never be accepted upstream
- Months/years before adoption

**Feasibility**: ACP is actively developed and accepting RFDs. The `session/resume` RFD shows the community is open to extensions. A `session/inject` proposal with relay/multi-agent use cases could land, but we can't depend on it.

---

### Recommendation Matrix

| Pattern | Proposal A (Queue) | Proposal B (Cancel) | Proposal C (Poll) | Proposal D (Dual-Channel) | Proposal E (Extend ACP) |
|---|---|---|---|---|---|
| Lead + Workers | Sufficient | Unnecessary | Works | Overkill | Overkill |
| Pipeline | Sufficient | Unnecessary | Works | Works | Best |
| Fan-out/gather | Sufficient | Unnecessary | Works | Works | Best |
| Mesh (real-time) | Too slow | Destructive | Unreliable | Best available | Best |
| Consensus/Debate | Too slow | Destructive | Unreliable | Best available | Best |
| Hub-spoke | Sufficient | For urgent only | Works | Works | Best |

### Recommended Implementation Order

1. **Proposal A** (Queue + Drain) — implement first, covers 80% of patterns
2. **Proposal D** (Dual-Channel) — implement second, covers real-time patterns via MCP sidecar
3. **Proposal B** (Cancel + Re-Prompt) — implement as P0/P1 interrupt mechanism alongside A
4. **Proposal C** (Poll) — already works today via `relay_inbox()`, just needs prompt engineering
5. **Proposal E** (ACP Extension) — submit RFD to ACP spec, implement if/when accepted

### Hybrid Strategy

Combine A + B + D:

```
message arrives for Agent B (mid-turn):
  ├─ P0 (critical): Proposal B — cancel + re-prompt immediately
  ├─ P1 (high):     Proposal B — cancel if idle >5s, else queue (A)
  ├─ P2 (normal):   Proposal A — queue, deliver on next turn boundary
  └─ P3-P4 (low):   Proposal A — queue, deliver on next turn boundary

For real-time patterns (mesh, consensus, debate):
  └─ Proposal D — MCP sidecar with relay_inbox() polling
```

The broker already has `BoundedPriorityQueue` with 5 priority levels (`queue.rs`). This maps directly.

---

## Implementation Sketch: Proposal A (Queue + Drain)

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

## Implementation Sketch: Proposal D (Dual-Channel MCP Sidecar)

The Relaycast MCP server already maintains a WebSocket connection. The change is:

1. **MCP server receives push messages** via its WebSocket (already happens for PTY mode)
2. **MCP server buffers them** in an internal queue
3. **`relay_inbox()` drains the buffer** (already works)
4. **Agent prompt includes**: "Check `relay_inbox()` periodically during long tasks"

No code change needed in the MCP server. The only change is in the ACP broker:
- Pass `@relaycast/mcp` as an MCP server in `session/new`
- Ensure the MCP server's WebSocket receives messages for this agent

The gap is push notification. Today, `relay_inbox()` is pull-only. To make the agent aware of pending messages without polling:

```typescript
// In @relaycast/mcp server
class RelaycastMcpServer {
  private pendingMessages: RelayDelivery[] = [];

  onRelayMessage(delivery: RelayDelivery) {
    this.pendingMessages.push(delivery);
    // Send MCP notification that tools changed
    // Agent's next tool-list refresh will see relay_pending_count
    this.sendNotification("notifications/tools/list_changed");
  }

  // Dynamic tool that appears only when messages are pending
  getTools() {
    const tools = [/* ... standard tools ... */];
    if (this.pendingMessages.length > 0) {
      tools.push({
        name: "relay_inbox",
        // Update description dynamically to hint at pending count
        description: `Check inbox (${this.pendingMessages.length} pending message(s))`,
        inputSchema: { type: "object", properties: {} }
      });
    }
    return tools;
  }
}
```

This leverages MCP's `notifications/tools/list_changed` — when the agent re-fetches the tool list, it sees the updated description with pending count. This is a gentle nudge, not a guarantee.
