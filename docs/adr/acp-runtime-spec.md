# ACP Runtime Spec

**Status**: Spec
**Date**: 2026-03-10
**Depends on**: [pty-vs-acp-comparison.md](./pty-vs-acp-comparison.md), [acp-continuity-and-injection-proposals.md](./acp-continuity-and-injection-proposals.md)

---

## Overview

Add `'acp'` as a third `AgentRuntime` alongside `'pty'` and `'headless'`. ACP agents communicate with the broker via JSON-RPC over stdio using the Agent Client Protocol. The broker manages ACP adapter processes, routes relay messages via turn-boundary delivery, and exposes the same event surface to the SDK.

ACP is the default runtime for sequential swarm patterns (lead+workers, pipeline, fan-out, DAG, hub-spoke, cascade, handoff). PTY remains the only option for patterns requiring mid-turn message injection (mesh, consensus, debate).

---

## 1. Type Changes

### `protocol.ts`

```typescript
// Before
export type AgentRuntime = 'pty' | 'headless';

// After
export type AgentRuntime = 'pty' | 'headless' | 'acp';
```

### `AgentSpec` addition

```typescript
export interface AgentSpec {
  name: string;
  runtime: AgentRuntime;
  provider?: HeadlessProvider;
  cli?: string;
  args?: string[];
  channels?: string[];
  model?: string;
  cwd?: string;
  team?: string;
  shadow_of?: string;
  shadow_mode?: string;
  restart_policy?: RestartPolicy;

  // --- ACP-specific fields ---
  /** ACP adapter command (e.g. 'claude-agent-acp', 'codex-acp'). Required when runtime = 'acp'. */
  acp_adapter?: string;
  /** Additional ACP adapter arguments. */
  acp_adapter_args?: string[];
  /** MCP servers to pass in session/new. Merged with broker-injected Relaycast MCP server. */
  acp_mcp_servers?: AcpMcpServerConfig[];
}

export interface AcpMcpServerConfig {
  /** MCP transport: 'stdio' (required by ACP spec), 'http' (optional capability). */
  transport: 'stdio' | 'http';
  /** For stdio: command to run. */
  command?: string;
  /** For stdio: command arguments. */
  args?: string[];
  /** For stdio: environment variables. */
  env?: Record<string, string>;
  /** For http: endpoint URL. */
  url?: string;
  /** For http: headers. */
  headers?: Record<string, string>;
}
```

### New protocol messages

```typescript
// Broker → ACP Worker
export type BrokerToAcpWorker =
  | { type: 'init_acp_worker'; payload: { agent: AgentSpec; session_id: string } }
  | { type: 'deliver_relay_queued'; payload: RelayDelivery }
  | { type: 'cancel_turn'; payload: { reason: string; delivery?: RelayDelivery } }
  | { type: 'shutdown_worker'; payload: { reason: string; grace_ms?: number } }
  | { type: 'ping'; payload: { ts_ms: number } };

// ACP Worker → Broker
export type AcpWorkerToBroker =
  | { type: 'worker_ready'; payload: { name: string; runtime: 'acp'; session_id: string } }
  | { type: 'delivery_prompted'; payload: { delivery_id: string; event_id: string } }
  | { type: 'delivery_ack'; payload: { delivery_id: string; event_id: string } }
  | { type: 'turn_started'; payload: { prompt_preview: string } }
  | { type: 'turn_update'; payload: AcpTurnUpdate }
  | { type: 'turn_completed'; payload: { stop_reason: AcpStopReason; response: string } }
  | { type: 'worker_error'; payload: ProtocolError }
  | { type: 'worker_exited'; payload: { code?: number; signal?: string } }
  | { type: 'pong'; payload: { ts_ms: number } };

export type AcpStopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

export interface AcpTurnUpdate {
  /** Maps to ACP session/update notification types. */
  kind: 'thinking' | 'message_chunk' | 'tool_call' | 'tool_call_update' | 'plan';
  /** Tool call metadata (when kind = 'tool_call' or 'tool_call_update'). */
  tool_call?: {
    id: string;
    title: string;
    kind: 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'other';
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
  };
  /** Streamed text chunk (when kind = 'thinking' or 'message_chunk'). */
  chunk?: string;
}
```

### Broker events

```typescript
// New event kinds added to BrokerEvent union
| { kind: 'acp_turn_started'; name: string; prompt_preview: string }
| { kind: 'acp_turn_update'; name: string; update: AcpTurnUpdate }
| { kind: 'acp_turn_completed'; name: string; stop_reason: AcpStopReason; response: string }
| { kind: 'delivery_prompted'; name: string; delivery_id: string; event_id: string }
```

---

## 2. Workflow Type Changes

### `AgentDefinition` in `workflows/types.ts`

```typescript
export interface AgentDefinition {
  name: string;
  cli: AgentCli;
  role?: string;
  task?: string;
  channels?: string[];
  constraints?: AgentConstraints;
  interactive?: boolean;
  cwd?: string;
  additionalPaths?: string[];
  preset?: AgentPreset;

  // --- New ---
  /** Agent runtime override. Default: inferred from preset/interactive.
   *  - 'acp': ACP adapter (structured, turn-based)
   *  - 'pty': PTY terminal (raw I/O, mid-turn injection)
   *  - 'headless': non-interactive subprocess
   * When omitted, the runner selects the runtime:
   *  - preset=worker/reviewer/analyst → 'headless'
   *  - interactive=false → 'headless'
   *  - pattern requires injection (mesh/consensus/debate) → 'pty'
   *  - otherwise → 'acp' (default for interactive agents)
   */
  runtime?: 'pty' | 'acp' | 'headless';
  /** ACP adapter command. Resolved from cli if omitted (e.g. claude → claude-agent-acp). */
  acpAdapter?: string;
}
```

### `AgentOptions` in `workflows/builder.ts`

```typescript
export interface AgentOptions {
  cli: AgentCli;
  role?: string;
  task?: string;
  channels?: string[];
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  retries?: number;
  idleThresholdSecs?: number;
  interactive?: boolean;

  // --- New ---
  /** Override the agent runtime. Default: auto-selected by runner. */
  runtime?: 'pty' | 'acp' | 'headless';
  /** ACP adapter command override. */
  acpAdapter?: string;
}
```

### New `SpawnAcpInput` in `client.ts`

`SpawnPtyInput` remains unchanged. A new `SpawnAcpInput` interface is added alongside it:

```typescript
export interface SpawnAcpInput {
  name: string;
  cli: string;
  args?: string[];
  channels?: string[];
  task?: string;
  model?: string;
  cwd?: string;
  team?: string;
  /** ACP adapter command override. */
  acpAdapter?: string;
  /** Additional MCP servers for the ACP session. */
  acpMcpServers?: AcpMcpServerConfig[];
  /** Auto-restart policy. */
  restartPolicy?: RestartPolicy;
}
```

The client gets a new `spawnAcp()` method alongside the existing `spawnPty()` and `spawnHeadless()`. The runner calls the appropriate one based on `resolveRuntime()`.

---

## 3. ACP Adapter Resolution

Each CLI maps to a known ACP adapter:

```typescript
const ACP_ADAPTERS: Record<AgentCli, string | null> = {
  claude:       'claude-agent-acp',
  codex:        'codex-acp',
  gemini:       null, // No known adapter yet → fallback to PTY
  aider:        null, // No known adapter yet → fallback to PTY
  goose:        'goose', // Goose has native ACP support
  opencode:     'opencode', // OpenCode has native ACP support
  droid:        null,
  cursor:       null,
  'cursor-agent': null,
  agent:        null,
};
```

When `runtime: 'acp'` is requested but no adapter is available:
1. If user explicitly set `runtime: 'acp'` → error: "No ACP adapter available for {cli}"
2. If runtime was auto-selected → silently fallback to `'pty'`

---

## 4. Runtime Auto-Selection in Runner

```typescript
private resolveRuntime(
  agentDef: AgentDefinition,
  pattern: SwarmPattern
): AgentRuntime {
  // Explicit runtime always wins
  if (agentDef.runtime) return agentDef.runtime;

  // Non-interactive presets → headless (unchanged)
  if (agentDef.interactive === false) return 'headless';
  if (['worker', 'reviewer', 'analyst'].includes(agentDef.preset ?? '')) return 'headless';

  // Patterns requiring mid-turn injection → PTY
  const INJECTION_PATTERNS: SwarmPattern[] = ['mesh', 'consensus', 'debate'];
  if (INJECTION_PATTERNS.includes(pattern)) return 'pty';

  // Default: ACP if adapter available, else PTY
  const adapter = agentDef.acpAdapter ?? ACP_ADAPTERS[agentDef.cli];
  return adapter ? 'acp' : 'pty';
}
```

---

## 5. ACP Worker Lifecycle (Broker Side)

### Spawn

```
Broker                              ACP Adapter Process
  │                                        │
  ├─ spawn(adapter_cmd, --stdio) ─────────►│
  │                                        │
  ├─ JSON-RPC: initialize ───────────────►│
  │◄──────── initialize result ────────────┤  (capabilities negotiated)
  │                                        │
  ├─ JSON-RPC: session/new ──────────────►│
  │   { cwd, mcpServers: [relaycast, ...] }│
  │◄──────── { sessionId } ────────────────┤
  │                                        │
  ├─ emit(worker_ready) ──────────────────►│
  │                                        │
```

### Turn-Boundary Message Delivery

```
Relay message arrives for Agent B while turn is active:

  Relaycast WS ──► Broker
                     │
                     ├─ pending_deliveries.push(msg)
                     ├─ emit(delivery_queued)
                     │
                     │  ... Agent B's turn completes ...
                     │
                     ├─ drain pending_deliveries
                     ├─ format as prompt text
                     ├─ JSON-RPC: session/prompt ──────────► ACP Adapter
                     ├─ emit(delivery_prompted)
                     │◄──── session/update (streaming) ──────┤
                     ├─ emit(acp_turn_update)
                     │◄──── prompt response ─────────────────┤
                     ├─ emit(delivery_ack)
                     ├─ emit(acp_turn_completed)
```

### P0 Emergency Interrupt

```
P0 message arrives for Agent B while turn is active:

  Relaycast WS ──► Broker
                     │
                     ├─ JSON-RPC: session/cancel ──────────► ACP Adapter
                     │◄──── { stopReason: "cancelled",  ─────┤
                     │        response: partial_work }
                     │
                     ├─ merge: original_task + partial_work + urgent_message
                     ├─ JSON-RPC: session/prompt ──────────► ACP Adapter
                     │   (merged context)
```

### Release / Shutdown

```
  Broker
    │
    ├─ JSON-RPC: session/cancel (if turn active)
    │◄──── cancelled response
    │
    ├─ close stdin pipe (adapter should exit gracefully)
    ├─ wait(grace_ms)
    ├─ SIGTERM if still alive
    ├─ emit(worker_exited)
```

---

## 6. MCP Server Injection

The broker always injects the Relaycast MCP server into the ACP session's `mcpServers` array. This gives the agent access to `relay_send`, `relay_inbox`, `relay_who`, `relay_checkpoint`, `relay_restore`, etc.

```typescript
const relaycastMcp: AcpMcpServerConfig = {
  transport: 'stdio',
  command: 'npx',
  args: ['@relaycast/mcp'],
  env: {
    RELAY_BASE_URL: brokerBaseUrl,
    RELAY_AGENT_NAME: agentSpec.name,
    RELAY_AGENT_TOKEN: agentToken,
    RELAY_AGENT_TYPE: 'agent',
  },
};

// Merge with user-specified MCP servers
const mcpServers = [relaycastMcp, ...(agentSpec.acp_mcp_servers ?? [])];
```

---

## 7. Delivery Lifecycle Mapping

| Stage | PTY | ACP |
|---|---|---|
| Queued | `delivery_queued` | `delivery_queued` |
| Written to agent | `delivery_injected` (pty.write_all) | `delivery_prompted` (session/prompt) |
| Agent saw it | `delivery_ack` (echo verification) | `delivery_ack` (prompt response received) |
| Agent is working | `delivery_active` (ActivityDetector) | `acp_turn_update` (tool_call events) |
| Verified | `delivery_verified` (echo + timeout) | implicit (protocol guarantees delivery) |

ACP mode skips echo verification entirely — the protocol guarantees the agent received the prompt.

---

## 8. Swarm TUI Integration

The Swarm TUI (`SwarmTui`) currently consumes `TuiUpdate` events from PTY-based `ActivityDetector` pattern matching. ACP provides the same data via structured `acp_turn_update` events:

```typescript
// Map ACP turn updates to TuiUpdate
function acpUpdateToTui(name: string, update: AcpTurnUpdate): TuiUpdate | null {
  switch (update.kind) {
    case 'tool_call':
      return {
        type: 'WorkerActivity',
        name,
        activity: `${update.tool_call!.kind}: ${update.tool_call!.title}`,
      };
    case 'thinking':
      return { type: 'WorkerActivity', name, activity: 'Thinking...' };
    case 'message_chunk':
      return { type: 'WorkerActivity', name, activity: 'Responding...' };
    default:
      return null;
  }
}
```

This is more reliable than PTY pattern matching — no regex needed for spinner detection.

---

## 9. Crash Recovery

ACP adapter crash → broker detects process exit:

1. Capture exit code and signal (same as PTY `CrashInsights`)
2. If `restart_policy.enabled`:
   a. Restart adapter process
   b. `initialize` + `session/load` (if adapter supports `loadSession` capability)
   c. If `session/load` unsupported → `session/new` + re-prompt with last known task
3. Emit `agent_exit` event with crash classification

Loss vs PTY: exit code and signal are available (adapter process dies like any other). OOM detection (exit 137) still works. The indirection (broker → adapter → CLI) means the exit code is the *adapter's* exit code, not the underlying CLI's. Adapters should forward the CLI's exit code.

---

## 10. Permission Flow

ACP defines `session/request_permission` — the adapter asks the broker to approve a tool call before execution. The broker can:

1. **Auto-allow** based on agent's permission policy (configured in AgentSpec or workflow)
2. **Forward to SDK** as a broker event for the orchestrator to decide
3. **Reject** based on policy (e.g., no file deletion for worker agents)

```typescript
// New broker event
| { kind: 'permission_request'; name: string; request: AcpPermissionRequest }

export interface AcpPermissionRequest {
  request_id: string;
  tool_name: string;
  tool_kind: 'read' | 'edit' | 'delete' | 'execute' | 'other';
  description: string;
}

// SDK can respond
| { type: 'permission_response'; payload: { name: string; request_id: string; decision: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' } }
```

This replaces the PTY auto-approval handlers (`PtyAutoState`, 200+ lines in `wrap.rs`).

---

## 11. What Does NOT Change

- Relaycast cloud routing (channels, threads, DMs, presence, webhooks)
- MCP tool surface (`relay_send`, `relay_inbox`, `relay_who`, etc.)
- Workflow builder API (`.agent()`, `.step()`, `.run()`)
- Swarm patterns, barriers, state store, trajectory recording
- Non-interactive/headless execution path
- `agent-relay-broker` binary (adds ACP worker alongside PTY worker)
