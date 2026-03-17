# TypeScript Relay Communicate Adapter Review

**Date**: 2026-03-14
**Reviewer**: Review-Adapters agent
**Scope**: 6 adapters + index.ts + 6 test files (39 tests)

## Summary

The adapters are well-structured and follow a consistent pattern overall. All 6 expose the same 4 relay tools (`relay_send`, `relay_inbox`, `relay_post`, `relay_agents`) with matching descriptions and behavior. Each adapter duck-types the target framework's interfaces rather than importing them at runtime, which is a good design choice for optional peer dependencies.

**All 39 tests pass after fixes.**

---

## Issues Found & Fixed

### 1. Pi adapter: No cleanup exposed (FIXED)
**File**: `src/communicate/adapters/pi.ts`
**Severity**: Medium

The `unsubscribe` handle from `relay.onMessage()` was captured in a closure variable but never exposed to the caller. Every other adapter that subscribes to messages provides a cleanup/unsubscribe mechanism. Added a `cleanup()` method to the returned config object.

### 2. CrewAI: Dead `messageBuffer` code (FIXED)
**File**: `src/communicate/adapters/crewai.ts`
**Severity**: Low

`messageBuffer` was populated in the `onMessage` callback but never read anywhere. Removed the dead accumulator — `step_callback` is the only routing mechanism needed.

### 3. Missing `onCrewRelay` export (FIXED)
**File**: `src/communicate/adapters/index.ts`
**Severity**: Medium

`crewai.ts` exports both `onRelay` (single agent) and `onCrewRelay` (all agents in a crew), but `index.ts` only re-exported `onRelay`. Added `onCrewRelay` to the barrel export.

### 4. LangGraph: Hardcoded agent name (FIXED)
**File**: `src/communicate/adapters/langgraph.ts`
**Severity**: Low

The default Relay name was hardcoded to `'langgraph'`, unlike all other adapters which derive it from the agent or accept it as a parameter. Updated the second parameter to accept either a `RelayLike` instance or a `string` name, preserving backward compatibility.

---

## Consistency Audit

| Aspect | Pi | Claude SDK | OpenAI Agents | LangGraph | Google ADK | CrewAI |
|--------|----|-----------:|---------------|-----------|------------|--------|
| Tool names | relay_send/inbox/post/agents | N/A (MCP) | relay_send/inbox/post/agents | relay_send/inbox/post/agents | relay_send/inbox/post/agents | relay_send/inbox/post/agents |
| Tool descriptions | Consistent | N/A | Consistent | Consistent | Consistent | Consistent |
| Message formatting | formatRelayMessage | formatRelayMessage | formatRelayMessage | formatRelayMessage | formatRelayMessage | formatRelayMessage |
| Inbox formatting | formatRelayInbox | drainInbox (wraps formatRelayMessage) | formatRelayInbox | formatRelayInbox | formatRelayInbox | formatRelayInbox |
| Cleanup mechanism | cleanup() (fixed) | N/A (stateless hooks) | cleanup() | unsubscribe() | unsubscribe() | unsubscribe() |
| Name source | param | param | agent.name | param or default | param | agent.role |

### Notes on intentional differences

- **Claude SDK** uses MCP server + hooks pattern (no custom tools) — this is correct for how Claude Agent SDK works.
- **CrewAI** uses `tool_name` instead of `name` — matches CrewAI's tool interface.
- **Google ADK** tools return `{ result: string }` objects — matches ADK's FunctionTool contract.
- **OpenAI Agents** tools accept `input: string` (JSON) via `invoke()` — matches the OpenAI Agents SDK function tool interface.

---

## Type Safety

- **Good**: All adapters use duck-typed interfaces (`*Like` types) to avoid hard dependencies.
- **Acceptable**: CrewAI uses `any[]` for `tools` and `any` for `step_callback` step param — this mirrors CrewAI's own loose typing.
- **Good**: OpenAI Agents uses `as const` assertions for literal types (`'function'`, `false`, `true`).

---

## Error Handling

All adapters delegate errors to the Relay instance (which handles connection errors, auth, etc.). Tool execution functions propagate promise rejections naturally. No adapter swallows errors, which is correct — callers see failures via the tool return.

**Potential improvement** (not fixed — low priority): The OpenAI Agents adapter's `JSON.parse(input)` in `invoke()` could throw on malformed input. A try/catch with a descriptive error message would be more framework-friendly.

---

## Test Coverage

| Adapter | Tests | Tools | Message routing | Cleanup | Preserves existing |
|---------|------:|------:|----------------:|--------:|-------------------:|
| Pi | 3 | Yes | steer + followUp | No test | Yes (onSessionCreated) |
| Claude SDK | 4 | N/A | PostToolUse + Stop hooks | N/A | Yes (existing hooks) |
| OpenAI Agents | 7 | Yes + invoke | instructions injection | Yes | Yes (fn instructions) |
| LangGraph | 7 | Yes + invoke | graph.invoke() | Yes | N/A |
| Google ADK | 9 | Yes + execute | runner.runAsync() | Yes | N/A |
| CrewAI | 10 | Yes + execute | step_callback | Yes | Yes (onCrewRelay) |

**Gaps**:
- Pi: No test for the new `cleanup()` method (added by this review).
- Pi: No test for `relay_send` / `relay_post` tool execution (only tests tool presence).
- Claude SDK: No test for empty inbox returning `{}` (no systemMessage).

---

## Export Naming (index.ts)

```typescript
onPiRelay        // ✓ clear
onClaudeRelay    // ✓ clear
onCrewAIRelay    // ✓ clear
onCrewRelay      // ✓ added (crew-level helper)
onOpenAIAgentsRelay  // ✓ clear
onLangGraphRelay     // ✓ clear
onGoogleAdkRelay     // ✓ clear
```

All exports follow `on<Framework>Relay` naming convention. Consistent and discoverable.
