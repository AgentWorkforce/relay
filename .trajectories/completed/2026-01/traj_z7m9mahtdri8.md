# Trajectory: Relay messaging reliability architecture decisions

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** January 16, 2026 at 06:14 AM
> **Completed:** January 16, 2026 at 06:17 AM

---

## Summary

Analyzed relay messaging reliability: chose Rust PTY over tmux, documented escalating retry and unread indicator improvements, identified dead code, designed synchronous request-response protocol for multi-agent coordination

**Approach:** Standard approach

---

## Key Decisions

### Chose Rust PTY direct writes over tmux send-keys for message injection
- **Chose:** Chose Rust PTY direct writes over tmux send-keys for message injection
- **Reasoning:** tmux send-keys spawns shell subprocess per injection (~1700ms latency), requires fragile shell escaping, has race conditions. Rust PTY writes directly to file descriptor (~550ms), no escaping, atomic operations. Direct syscall removes all indirection layers.

### Push-based messaging (PTY injection) over pull-based (file polling, MCP tools)
- **Chose:** Push-based messaging (PTY injection) over pull-based (file polling, MCP tools)
- **Reasoning:** Agents forget to poll. File-based inbox requires agent to remember to check. PTY injection forces message into terminal view - agent cannot miss it. The 'weakness' of PTY (timing) is actually a strength for guaranteed visibility.

### Keep parseRelayMetadataFromOutput despite being unused in production
- **Chose:** Keep parseRelayMetadataFromOutput despite being unused in production
- **Reasoning:** The [[RELAY_METADATA]] feature includes importance field which aligns with planned escalating retry feature. Agent can specify message priority, injector uses it for retry urgency. Removing would require reimplementing later.

### Remove formatIncomingMessage as dead code
- **Chose:** Remove formatIncomingMessage as dead code
- **Reasoning:** Function only used in tests. Production code uses buildInjectionString from shared.ts instead. Created cleanup task agent-relay-482.

### Planned improvement: Escalating retry with visibility markers (agent-relay-480)
- **Chose:** Planned improvement: Escalating retry with visibility markers (agent-relay-480)
- **Reasoning:** Addresses timing edge case where agent misses initial injection. Retry with increasing urgency: normal -> [RETRY] -> [URGENT] -> alert operator. Combines with existing idle detection for robust delivery.

### Planned improvement: Unread message indicator in output (agent-relay-481)
- **Chose:** Planned improvement: Unread message indicator in output (agent-relay-481)
- **Reasoning:** During long tasks agent processes tool outputs without noticing pending messages. Appending unread count to all output ensures visibility without requiring agent to poll. Push-based reminder in every response.

### Identified need for turn-based synchronization protocol
- **Chose:** Identified need for turn-based synchronization protocol
- **Reasoning:** Hearts game demo showed messages arriving after coordinator moved on. 4 agents sending simultaneously causes queue backlog. Fire-and-forget messaging insufficient for coordinated workflows. Need request-response semantics with ackRequired flag and blocking wait.

### Protocol has ACK types but daemon doesn't implement blocking waits
- **Chose:** Protocol has ACK types but daemon doesn't implement blocking waits
- **Reasoning:** SendMeta.requires_ack exists in protocol/types.ts but daemon/connection.ts handleSend() doesn't process it. ACK/NACK message types exist but aren't used for synchronization. The plumbing exists, implementation is missing.

### Designed request-response messaging protocol with correlationId tracking
- **Chose:** Designed request-response messaging protocol with correlationId tracking
- **Reasoning:** Protocol extension adds sync.correlationId to SendMeta, daemon tracks pendingAcks Map, resolves when matching ACK arrives. Client gets sendAndWait() and broadcastAndWait() APIs. Auto-ACK in wrapper for transparent operation. Created epic agent-relay-487 with 4 implementation tasks.

---

## Chapters

### 1. Work
*Agent: default*

- Chose Rust PTY direct writes over tmux send-keys for message injection: Chose Rust PTY direct writes over tmux send-keys for message injection
- Push-based messaging (PTY injection) over pull-based (file polling, MCP tools): Push-based messaging (PTY injection) over pull-based (file polling, MCP tools)
- Keep parseRelayMetadataFromOutput despite being unused in production: Keep parseRelayMetadataFromOutput despite being unused in production
- Remove formatIncomingMessage as dead code: Remove formatIncomingMessage as dead code
- Planned improvement: Escalating retry with visibility markers (agent-relay-480): Planned improvement: Escalating retry with visibility markers (agent-relay-480)
- Planned improvement: Unread message indicator in output (agent-relay-481): Planned improvement: Unread message indicator in output (agent-relay-481)
- Identified need for turn-based synchronization protocol: Identified need for turn-based synchronization protocol
- Protocol has ACK types but daemon doesn't implement blocking waits: Protocol has ACK types but daemon doesn't implement blocking waits
- Designed request-response messaging protocol with correlationId tracking: Designed request-response messaging protocol with correlationId tracking
