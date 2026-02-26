# Delivery Acknowledgment Reliability Proposal

**Author:** Ack-Brainstorm
**Date:** 2026-02-20
**Status:** Draft / Brainstorm

---

## 1. Current Architecture

### Message Delivery Pipeline

```
SDK/Orchestrator                    Broker (main.rs)                    PTY Worker (pty_worker.rs)              Agent CLI
     |                                   |                                   |                                    |
     |-- send_message ----------------->|                                   |                                    |
     |                                   |-- deliver_relay ---------------->|                                    |
     |                                   |                                   |-- write to PTY stdin ------------->|
     |                                   |                                   |   (format_injection)               |
     |                                   |                                   |   50ms pause                       |
     |                                   |                                   |   send \r (Enter)                  |
     |                                   |                                   |                                    |
     |                                   |<-- delivery_queued -------------|                                    |
     |<-- delivery_queued --------------|                                   |                                    |
     |                                   |<-- delivery_injected ------------|                                    |
     |<-- delivery_injected ------------|                                   |                                    |
     |                                   |                                   |                                    |
     |                                   |                                   |<--- PTY output (echo) ------------|
     |                                   |                                   |   check_echo_in_output()           |
     |                                   |                                   |   matches "Relay message from X"   |
     |                                   |<-- delivery_ack ----------------|                                    |
     |<-- delivery_ack ----------------|                                   |                                    |
     |                                   |<-- delivery_verified ------------|                                    |
     |<-- delivery_verified ------------|                                   |                                    |
     |                                   |                                   |                                    |
     |                                   |                                   |   (optional) ActivityDetector      |
     |                                   |<-- delivery_active -------------|   watches for tool use patterns    |
     |<-- delivery_active --------------|                                   |                                    |
```

### Delivery State Machine (per delivery)

```
                      queue_and_try_delivery_raw()
                                 |
                                 v
                    +------------------------+
                    |   PENDING              |
                    |   (in pending_deliveries|
                    |    HashMap, broker)     |
                    +------------------------+
                                 |
                       deliver_relay frame sent to worker
                                 |
                                 v
                    +------------------------+
                    |   QUEUED               |
                    |   (PendingWorkerInjection|
                    |    in pty_worker)       |
                    +------------------------+
                                 |
                       idle window found, bytes written to PTY
                                 |
                                 v
                    +------------------------+
                    |   INJECTED             |
                    |   (PendingVerification  |
                    |    in pty_worker)       |
                    +------------------------+
                          /              \
               echo detected         5s VERIFICATION_WINDOW
               in output                  timeout
                    /                        \
                   v                          v
     +-------------------+      +-------------------+
     |   VERIFIED/ACKED  |      |   RETRY           |
     |   (removed from   |      |   (re-inject,     |
     |    pending_        |      |    up to 3x)      |
     |    deliveries)     |      +-------------------+
     +-------------------+               |
              |                    max retries hit
              v                          |
     +-------------------+               v
     |   ACTIVE          |      +-------------------+
     |   (ActivityDetector|     |   FAILED           |
     |    saw tool use)  |      |   (delivery_failed |
     +-------------------+      |    event emitted)  |
                                +-------------------+
```

### Key Files & Responsibilities

| File                           | Role                                                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `src/main.rs`                  | Broker: manages `pending_deliveries` HashMap, retry timer, forwards worker events to SDK                   |
| `src/pty_worker.rs`            | PTY worker: injection queue, echo verification loop, activity detection                                    |
| `src/helpers.rs`               | `format_injection()`, `check_echo_in_output()`, `PendingVerification`, `ActivityDetector`, `ThrottleState` |
| `relay-pty/src/inject.rs`      | Legacy standalone injector (optimistic — always returns `Ok(true)` at line 266)                            |
| `packages/sdk/src/protocol.ts` | Protocol type definitions for all delivery events                                                          |

### The Problem in Detail

**Echo detection** is the primary verification mechanism. After injecting `"Relay message from Alice [evt_123]: hello"` into the PTY, the worker watches for that exact string (after stripping ANSI codes) to appear in the agent's output within a 5-second window (`VERIFICATION_WINDOW`).

This breaks in several scenarios:

1. **Chatty agents**: An agent producing heavy output (running tests, dumping logs, compiling) pushes the 16KB `echo_buffer` past the injection echo before it can be matched.

2. **Non-echoing CLIs**: Some CLIs don't echo stdin back to stdout. The current system handles this for `relay-pty/src/inject.rs` (optimistic `Ok(true)`), but `pty_worker.rs` actually relies on echo detection.

3. **Buffered/delayed echo**: PTY output is not instantaneous. If the CLI buffers input processing, the echo may arrive after the 5s window.

4. **Multi-message collisions**: Rapid successive deliveries can interleave in the echo buffer, causing partial matches or missed verifications.

5. **ANSI artifacts**: Despite `strip_ansi()`, some CLIs produce unusual escape sequences that break matching.

---

## 2. What Does "Delivered" Mean?

Before proposing solutions, we need to define the semantics we're aiming for:

| Level          | Meaning                                           | Current Support           | Value                            |
| -------------- | ------------------------------------------------- | ------------------------- | -------------------------------- |
| L0: Written    | Bytes written to PTY stdin                        | Yes (delivery_injected)   | Low — doesn't confirm receipt    |
| L1: Echoed     | Message appeared in PTY output                    | Yes (delivery_verified)   | Medium — confirms CLI saw input  |
| L2: In Context | Agent's LLM has the message in its context window | No                        | High — confirms agent "heard" it |
| L3: Processed  | Agent took action in response                     | Partial (delivery_active) | Highest — confirms understanding |

**Current system targets L1 and partially L3.** The problem is L1 is unreliable, and L3 (ActivityDetector) is heuristic-based.

**Recommended target: L1 as baseline with L2/L3 as progressive enhancements.**

---

## 3. Proposed Approaches

### Approach A: Sidecar File Ack (File-Based Protocol Extension)

**Concept:** After the agent processes a relay message, its tooling writes an ack file to a known location. The PTY worker watches this directory for new ack files.

```
Agent receives message → Agent's relay snippet processes it
                       → Writes: .agent-relay/<agent>/acks/<delivery_id>
PTY worker inotify/poll → Reads ack file → Sends delivery_ack
```

**Implementation:**

- Extend the existing MCP tool protocol with an `acks/` mechanism
- The agent's system prompt snippet already handles relay messages — add an instruction to write an ack file after processing
- PTY worker polls `acks/` directory every 200ms (or uses inotify on Linux/kqueue on macOS)
- Ack file contains: `{"delivery_id": "...", "event_id": "...", "status": "received"}`

**Pros:**

- Works with ANY CLI — doesn't depend on CLI output format
- Reliable — filesystem operations are atomic and verifiable
- Already uses the established MCP tool protocol pattern
- Agent-initiated — confirms the message reached the agent's context (L2)
- No ANSI/encoding issues
- Backward compatible — echo detection remains as fallback

**Cons:**

- Requires agent cooperation (system prompt must instruct ack writing)
- Adds latency (filesystem I/O + poll interval)
- Agents we don't control (codex, gemini, aider) need their system prompts updated
- File cleanup needed to avoid unbounded growth
- Race condition: agent might crash between reading and acking

**Estimated Effort:** 2-3 days

---

### Approach B: PTY-Level Echo Verification with Relaxed Matching

**Concept:** Keep the current echo-detection approach but make it significantly more robust by relaxing the matching algorithm and extending the verification window.

**Implementation:**

- **Fuzzy matching**: Instead of exact substring match, use a token-based approach:
  - Extract key tokens from the injection: sender name, event_id, first N words of body
  - Match if all key tokens appear in the output buffer (in any order)
- **Extended buffer**: Increase `echo_buffer` from 16KB to 64KB, with a sliding window
- **Longer verification window**: Increase `VERIFICATION_WINDOW` from 5s to 15s, with early-exit on match
- **Two-phase verification**: Phase 1 looks for the event_id alone (unique, unlikely to appear otherwise). Phase 2 confirms full message content.
- **Backpressure**: If agent output rate is high, pause injection attempts until output settles

```
Inject message → Watch for event_id token in output (Phase 1)
              → If event_id found, confirm full message (Phase 2)
              → If output rate > threshold, extend window
```

**Pros:**

- No changes needed on agent side
- Works with all existing CLIs immediately
- No new protocol surface or file I/O
- Low risk — incremental improvement on existing mechanism
- Backward compatible by default

**Cons:**

- Still fundamentally relies on echo — some CLIs genuinely don't echo
- Fuzzy matching could produce false positives (unlikely with event_id, but possible)
- Extended windows mean slower failure detection
- Doesn't solve the fundamental problem — just makes it fail less often
- Still only L1 verification (echo ≠ "agent saw it in context")

**Estimated Effort:** 1-2 days

---

### Approach C: MCP Tool Ack (Agent-Native Acknowledgment)

**Concept:** Leverage the MCP (Model Context Protocol) tool infrastructure. When the agent receives a relay message, its MCP server (already running for Relaycast) automatically sends an ack through the MCP channel.

```
Agent receives message → LLM processes it
                       → LLM calls any MCP tool (mark_read, post_message, etc.)
                       → MCP server intercepts, sends ack for pending deliveries
                       → Broker receives ack via Relaycast WebSocket
```

Alternatively, a dedicated `relay_ack` MCP tool could be registered that the agent's system prompt instructs it to call.

**Implementation:**

- Add a `relay_ack` MCP tool to the Relaycast MCP server
- When the agent calls `mark_read(message_id)` or `relay_ack(delivery_id)`, the MCP server sends the ack through the WebSocket
- Broker's Relaycast integration receives the ack and resolves the pending delivery
- Fall back to echo detection for agents without MCP

```
[Agent LLM] --MCP call--> [Relaycast MCP Server] --WebSocket--> [Relaycast Cloud]
                                                                        |
[Broker] <-------------- WebSocket event (delivery_ack) <-------------- |
```

**Pros:**

- Agent-initiated, confirms L2 (in context) — the LLM literally called a tool
- Uses existing infrastructure (MCP servers, Relaycast WebSocket)
- Clean protocol — no file I/O, no output parsing
- Could extend to L3 by tracking which tools the agent calls after ack
- Natural for Claude Code (MCP-native)

**Cons:**

- Only works for MCP-enabled CLIs (currently Claude Code)
- Codex, Gemini, Aider don't have MCP support — need fallback
- Adds dependency on Relaycast cloud service for local-only deployments
- Latency: LLM → MCP → WebSocket → Cloud → WebSocket → Broker is slower than echo detection
- Agent may not call the ack tool (LLM is non-deterministic)
- Requires system prompt changes to instruct ack behavior

**Estimated Effort:** 3-5 days

---

### Approach D: Hybrid Waterfall (Recommended)

**Concept:** Use a multi-strategy waterfall that progressively upgrades confidence. Start with the fastest signal and use slower but more reliable signals as confirmation.

```
                         Inject Message
                              |
                   +----------+----------+
                   |                     |
             L0: PTY Write         Start timers
             (immediate,           (200ms, 5s, 15s)
              delivery_injected)
                   |
            +------+------+
            |             |
      Echo detected?  File ack detected?
      (< 200ms)      (< 5s poll)
            |             |
            v             v
     delivery_ack    delivery_ack
     (L1: echoed)    (L2: agent saw it)
            |             |
            +------+------+
                   |
          Activity detected?
          (< 15s, ActivityDetector)
                   |
                   v
            delivery_active
            (L3: agent acted)
```

**Implementation:**

1. **Keep echo detection** (Approach B improvements) as the fast path — most deliveries will be acked within 200ms.

2. **Add file-based ack** (Approach A) as the reliable fallback — if echo isn't detected within 2s, the file ack becomes the primary signal.

3. **Add MCP ack** (Approach C) as an optional enhancement — for MCP-enabled agents, this provides the strongest signal.

4. **Upgrade the state machine** to track confidence level:

```rust
enum DeliveryConfidence {
    Injected,       // L0: bytes written to PTY
    Echoed,         // L1: echo detected in output
    FileAcked,      // L2: agent wrote ack file
    McpAcked,       // L2: agent called MCP tool
    Active,         // L3: agent started acting on it
}
```

5. **Ack resolution priority**: First signal wins. If echo comes in 100ms, great. If file ack comes in 2s, also great. The delivery is considered acked at whichever comes first.

6. **Failure only after ALL channels timeout**: delivery_failed only fires when echo (15s), file (15s), AND MCP (if applicable) all fail.

**Verification Strategy Per CLI:**

| CLI         | Echo    | File Ack | MCP Ack | Expected Primary   |
| ----------- | ------- | -------- | ------- | ------------------ |
| Claude Code | Yes     | Yes      | Yes     | Echo (fast) or MCP |
| Codex       | Partial | Yes      | No      | File ack           |
| Gemini      | Partial | Yes      | No      | File ack           |
| Aider       | Yes     | Yes      | No      | Echo               |
| Goose       | Unknown | Yes      | No      | File ack           |

**Pros:**

- Most reliable — multiple independent verification channels
- Graceful degradation — works even if one mechanism fails
- Backward compatible — echo detection works exactly as before
- Progressive rollout — can add file ack first, MCP later
- Solves the chatty agent problem — file ack doesn't care about output volume
- Works with all CLIs (file ack is universal)

**Cons:**

- Most complex to implement
- Three verification mechanisms to maintain
- Potential for conflicting signals (echo says failed, file says success)
- Higher resource usage (file watching + echo scanning + MCP)

**Estimated Effort:** 5-8 days (phased)

---

## 4. Recommendation

**Approach D (Hybrid Waterfall)**, implemented in phases:

### Phase 1: Improve Echo Detection (1-2 days)

- Implement Approach B improvements (fuzzy matching, larger buffer, event_id-first matching)
- This is a quick win with zero protocol changes
- Fixes the most common chatty-agent failures

### Phase 2: Add File-Based Ack (2-3 days)

- Implement Approach A as a parallel verification channel
- Update the relay agent snippet to instruct agents to write ack files
- PTY worker watches for ack files alongside echo detection
- First signal to arrive wins — echo and file ack are both valid
- This is the critical phase — it makes delivery reliable for ALL CLIs

### Phase 3: MCP Ack (Optional, 2-3 days)

- Add `relay_ack` to the Relaycast MCP server
- Only applies to Claude Code agents
- Provides the strongest "agent understood the message" signal
- Can defer this until MCP adoption is higher

### Phase 4: Confidence Tracking & Observability (1 day)

- Add `delivery_confidence` field to delivery events
- Dashboard can show which verification method succeeded
- Useful for debugging and tuning timeouts

---

## 5. Migration Path

### Step 1: Non-breaking improvements (Phase 1)

- Ship improved echo detection
- All existing agents benefit immediately
- No agent-side changes needed

### Step 2: File ack with fallback (Phase 2)

- Add file watcher to PTY worker
- Update agent relay snippet (new agents get file ack automatically)
- Existing agents continue to work via echo detection
- File ack is additive — doesn't disable echo detection

### Step 3: Deprecation timeline

- After 2-4 weeks of Phase 2, measure file ack adoption rate
- If >90% of deliveries are file-acked, reduce echo verification window from 15s to 5s
- Echo becomes a fast optimization, not the reliability mechanism

### Step 4: MCP ack (Phase 3)

- Optional enhancement for Claude Code agents
- Doesn't affect other CLIs or existing behavior

---

## 6. Open Questions

1. **Should file ack be opt-in or opt-out?** If the agent snippet writes ack files, agents that don't use the snippet won't ack. Is that acceptable, or do we need a broker-side fallback?

2. **What about headless_claude runtime?** The headless runtime (`AgentRuntime::headless_claude`) doesn't use PTY. Does it need its own ack mechanism, or is the existing conversation API sufficient?

3. **Ack timeout values**: The current 5s verification window is aggressive. What's the right balance between fast failure detection and giving chatty agents time to echo?

4. **Should delivery_ack and delivery_verified be merged?** Currently they're separate events with slightly different semantics. Simplifying to a single ack event with a `method` field (echo/file/mcp) might be cleaner.

5. **Priority-based ack requirements**: Should high-priority messages require stronger ack (file/MCP) while low-priority messages accept echo-only?
