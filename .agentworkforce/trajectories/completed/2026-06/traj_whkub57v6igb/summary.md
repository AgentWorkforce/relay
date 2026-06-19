# Trajectory: Audit and fix web/content/docs against actual code implementation

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** June 19, 2026 at 09:16 PM
> **Completed:** June 19, 2026 at 09:27 PM

---

## Summary

Audited web/content/docs against code: fixed intro 3-vs-4 inconsistency, rewrote agent-relay-mcp tool table and action result shape, aligned onEvent signature, fixed reference-cli fleet/workspace rows and session-capabilities attachments optionality. SDK/messaging and delivery/actions/events docs verified accurate.

**Approach:** Standard approach

---

## Key Decisions

### Fixed intro 'three core jobs' vs 4 cards

- **Chose:** Fixed intro 'three core jobs' vs 4 cards
- **Reasoning:** Card group listed Messaging/Delivery/Actions/Webhooks (4) and prose said three; cols={3} with 4 cards. Corrected to four + cols={2}.

### Rewrote agent-relay-mcp tool table

- **Chose:** Rewrote agent-relay-mcp tool table
- **Reasoning:** Doc claimed table was 'the names registered by agent-relay mcp' but mcp registers ~31 tools across 3 files; table listed 12 mixed messaging+agent tools. Replaced with accurate 3 tool groups and complete 20-tool messaging table verified against mcp/messaging-tools.ts.

### Fixed MCP Action Result Shape

- **Chose:** Fixed MCP Action Result Shape
- **Reasoning:** Shown success JSON had inline 'output', contradicting the doc's own fire-and-forget statement and action-tools.ts which returns { ok, status: 'invoked', invocation }. Replaced with the real ack shape.

### Aligned onEvent signature to source

- **Chose:** Aligned onEvent signature to source
- **Reasoning:** Docs showed onEvent(handler...): void-only; source is onEvent(emit: ...=> void|Promise<void>): () => void. Fixed param name and return in intro + harnesses.

### Fixed reference-cli fleet serve + workspace active

- **Chose:** Fixed reference-cli fleet serve + workspace active
- **Reasoning:** fleet serve documented as required <node>; code is optional [file] with --enrollment-token path. workspace active missing --refresh-timeout. Both verified in commands/fleet.ts and workspace.ts.

### Fixed session-capabilities attachments optionality

- **Chose:** Fixed session-capabilities attachments optionality
- **Reasoning:** Messaging Capabilities block dropped the ? on attachments; source type is attachments?: MessageAttachmentCapability[].

---

## Chapters

### 1. Work

_Agent: default_

- Fixed intro 'three core jobs' vs 4 cards: Fixed intro 'three core jobs' vs 4 cards
- Rewrote agent-relay-mcp tool table: Rewrote agent-relay-mcp tool table
- Fixed MCP Action Result Shape: Fixed MCP Action Result Shape
- Aligned onEvent signature to source: Aligned onEvent signature to source
- Fixed reference-cli fleet serve + workspace active: Fixed reference-cli fleet serve + workspace active
- Fixed session-capabilities attachments optionality: Fixed session-capabilities attachments optionality
