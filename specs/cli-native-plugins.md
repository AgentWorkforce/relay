# CLI Native Plugins — Implementation Spec

**Covers**: OpenCode Plugin, Claude Code Plugin, Gemini CLI Extension (Codex deferred)
**Status**: Draft
**Date**: 2026-03-13
**Author**: Design session (human + Claude)

---

## 1. Vision

Native plugins for **OpenCode, Claude Code, and Gemini CLI** that enable spawning and coordinating multiple instances communicating via Agent Relay. Unlike oh-my-openagent's one-way parent→child model, this unlocks full peer-to-peer messaging between independent sessions — across tools, across processes, across machines. All brokerless via Relaycast.

### What This Unlocks

1. **Native multi-instance orchestration** — Spawn additional CLI instances from within a session, each with its own task, all communicating via Relay.
2. **Peer-to-peer messaging** — Any instance can DM any other, post to channels, and participate in threads. Not limited to parent→child.
3. **Cross-tool interop** — OpenCode instances can communicate with Claude Code, Gemini CLI, Codex, Aider, or any other agent on the same Relay workspace.
4. **Zero-config for end users** — One install command and you're on the relay.

### Differentiation from oh-my-openagent

| | oh-my-openagent | Relay Plugin |
|---|---|---|
| Architecture | In-process sub-sessions | Independent processes |
| Communication | One-way parent→child | Full peer-to-peer (DMs, channels, threads) |
| Cross-tool | OpenCode ↔ OpenCode only | OpenCode ↔ any CLI agent |
| Discovery | Parent knows children | All agents visible via `relay_agents` |
| Persistence | Session-scoped | Relaycast-backed (survives restarts) |

---

## 2. Plugin Structure

```
opencode-relay-plugin/
├── package.json
├── tsconfig.json
├── src/
│   └── index.ts          # Plugin entry point — exports tools + hooks
├── README.md
└── tests/
    ├── tools.test.ts
    ├── spawn.test.ts
    └── polling.test.ts
```

### package.json

```json
{
  "name": "opencode-relay-plugin",
  "version": "0.1.0",
  "description": "Agent Relay plugin for OpenCode — multi-instance messaging and orchestration",
  "main": "dist/index.js",
  "type": "module",
  "keywords": ["opencode-plugin", "agent-relay", "multi-agent"],
  "peerDependencies": {
    "opencode": ">=0.1.0"
  }
}
```

> **Architecture note**: Unlike the Claude Code and Gemini plugins which use an MCP server for transport, OpenCode's native `tool()` API means the plugin talks to Relaycast directly via HTTP. There is no WebSocket client — the plugin polls via HTTP on `relay_inbox` calls and via the `session.idle` hook. This keeps the dependency footprint minimal (no `ws` package) and aligns with the poll-based pattern used by the hooks on all three platforms.

---

## 3. Plugin Entry Point

OpenCode plugins export an async function that receives a plugin context with `tool()`, `hook()`, and other helpers.

```typescript
// src/index.ts
import type { PluginContext } from 'opencode';

export default async function relayPlugin(ctx: PluginContext) {
  // ── State ──
  const state = new RelayState();

  // ── Tools ──
  registerTools(ctx, state);

  // ── Hooks ──
  registerHooks(ctx, state);
}
```

### RelayState

```typescript
class RelayState {
  agentName: string | null = null;
  workspace: string | null = null;
  token: string | null = null;
  spawned: Map<string, SpawnedAgent> = new Map();
  connected = false;
}

interface Message {
  id: string;
  from: string;
  text: string;
  channel?: string;
  thread?: string;
  ts: string;
}

interface SpawnedAgent {
  name: string;
  process: ChildProcess;
  task: string;
  status: 'running' | 'done' | 'error';
}
```

---

## 4. Tools

Six tools exposed to the LLM via OpenCode's `tool()` API.

### 4.1 `relay_connect`

Connects to a Relay workspace. Must be called before other tools.

```typescript
ctx.tool({
  name: 'relay_connect',
  description: 'Connect to an Agent Relay workspace. Call this first.',
  schema: {
    type: 'object',
    properties: {
      workspace: { type: 'string', description: 'Workspace key (rk_live_...)' },
      name: { type: 'string', description: 'Your agent name on the relay' },
    },
    required: ['workspace', 'name'],
  },
  async handler({ workspace, name }) {
    state.workspace = workspace;
    state.agentName = name;

    // Register with Relaycast via HTTP
    const res = await fetch(`https://www.relaycast.dev/api/v1/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace, name, cli: 'opencode' }),
    });
    const data = await res.json();
    state.token = data.token;

    state.connected = true;
    return { ok: true, name, workspace: workspace.slice(0, 12) + '...' };
  },
});
```

### 4.2 `relay_send`

Send a DM to another agent.

```typescript
ctx.tool({
  name: 'relay_send',
  description: 'Send a direct message to another agent on the relay.',
  schema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient agent name' },
      text: { type: 'string', description: 'Message content' },
    },
    required: ['to', 'text'],
  },
  async handler({ to, text }) {
    assertConnected(state);
    await relaycastAPI(state, 'dm/send', { to, text });
    return { sent: true, to };
  },
});
```

### 4.3 `relay_inbox`

Check for new messages.

```typescript
ctx.tool({
  name: 'relay_inbox',
  description: 'Check your inbox for new messages from other agents.',
  schema: { type: 'object', properties: {} },
  async handler() {
    assertConnected(state);
    // Poll Relaycast HTTP API for new messages
    const data = await relaycastAPI(state, 'inbox/check', {});
    const messages = data.messages || [];
    return { count: messages.length, messages };
  },
});
```

### 4.4 `relay_post`

Post a message to a channel.

```typescript
ctx.tool({
  name: 'relay_post',
  description: 'Post a message to a relay channel.',
  schema: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Channel name' },
      text: { type: 'string', description: 'Message content' },
    },
    required: ['channel', 'text'],
  },
  async handler({ channel, text }) {
    assertConnected(state);
    await relaycastAPI(state, 'message/post', { channel, text });
    return { posted: true, channel };
  },
});
```

### 4.5 `relay_agents`

List online agents.

```typescript
ctx.tool({
  name: 'relay_agents',
  description: 'List all agents currently on the relay.',
  schema: { type: 'object', properties: {} },
  async handler() {
    assertConnected(state);
    const data = await relaycastAPI(state, 'agent/list', {});
    return { agents: data.agents };
  },
});
```

### 4.6 `relay_spawn`

Spawn a new OpenCode instance as a worker agent.

```typescript
ctx.tool({
  name: 'relay_spawn',
  description:
    'Spawn a new OpenCode instance as a worker agent on the relay. ' +
    'The worker runs independently and can communicate with any agent.',
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Worker agent name' },
      task: { type: 'string', description: 'Task for the worker' },
      dir: {
        type: 'string',
        description: 'Working directory (defaults to current)',
      },
      model: {
        type: 'string',
        description: 'Model override (e.g., "claude-sonnet-4-6")',
      },
    },
    required: ['name', 'task'],
  },
  async handler({ name, task, dir, model }) {
    assertConnected(state);

    // Register worker with Relaycast
    await relaycastAPI(state, 'agent/add', {
      name,
      cli: 'opencode',
      task,
    });

    // Build the system prompt that bootstraps the worker onto the relay
    // NOTE: workspace key is passed via env var, NOT in the prompt (security)
    const systemPrompt = [
      `You are ${name}, a worker agent on Agent Relay.`,
      `Your task: ${task}`,
      ``,
      `IMPORTANT: At the start, call relay_connect with:`,
      `  workspace: (read from RELAY_WORKSPACE env var)`,
      `  name: "${name}"`,
      ``,
      `Then send a DM to "${state.agentName}" with "ACK: <your understanding of the task>".`,
      `When done, send "DONE: <summary>" to "${state.agentName}".`,
    ].join('\n');

    // Spawn OpenCode process
    const args = ['--prompt', systemPrompt];
    if (dir) args.push('--dir', dir);
    if (model) args.push('--model', model);

    const proc = spawn('opencode', args, {
      cwd: dir || process.cwd(),
      stdio: 'pipe',
      detached: true,
      env: {
        ...process.env,
        RELAY_WORKSPACE: state.workspace!,
        RELAY_AGENT_NAME: name,
      },
    });

    state.spawned.set(name, {
      name,
      process: proc,
      task,
      status: 'running',
    });

    proc.on('exit', (code) => {
      const agent = state.spawned.get(name);
      if (agent) {
        agent.status = code === 0 ? 'done' : 'error';
      }
    });

    return {
      spawned: true,
      name,
      pid: proc.pid,
      hint: `Worker "${name}" is starting. It will ACK via DM when ready.`,
    };
  },
});
```

### 4.7 `relay_dismiss`

Stop and release a spawned worker.

```typescript
ctx.tool({
  name: 'relay_dismiss',
  description: 'Stop and release a spawned worker agent.',
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Worker name to dismiss' },
    },
    required: ['name'],
  },
  async handler({ name }) {
    assertConnected(state);

    const agent = state.spawned.get(name);
    if (agent && agent.status === 'running') {
      agent.process.kill('SIGTERM');
    }

    await relaycastAPI(state, 'agent/remove', { name });
    state.spawned.delete(name);
    return { dismissed: true, name };
  },
});
```

---

## 5. Hooks

> **⚠ OpenCode hook API is provisional.** The hook event names below (`session.idle`, `session.compacting`, `session.end`) are based on early documentation and may change. Verify against the latest OpenCode plugin API before implementation. If OpenCode does not support these hooks natively, fall back to a polling-based approach using a background interval timer within the plugin entry point.

### 5.1 `session.idle` — Inbound Message Polling

When the LLM is idle (waiting for user input), poll for inbound messages and surface them.

```typescript
ctx.hook('session.idle', async () => {
  if (!state.connected) return;

  const data = await relaycastAPI(state, 'inbox/check', {});
  const messages = data.messages || [];
  if (messages.length === 0) return;

  // Format messages for injection into the session
  const formatted = messages
    .map((m) => {
      const prefix = m.channel
        ? `Relay message from ${m.from} [#${m.channel}]`
        : `Relay message from ${m.from}`;
      return `${prefix}: ${m.text}`;
    })
    .join('\n\n');

  return {
    inject: formatted,
    continue: true, // Keep the session active to process the messages
  };
});
```

### 5.2 `session.compacting` — Context Preservation

When OpenCode compacts context, preserve relay state so the agent doesn't lose its identity.

```typescript
ctx.hook('session.compacting', async () => {
  if (!state.connected) return;

  const workers = Array.from(state.spawned.entries())
    .map(([name, a]) => `  - ${name}: ${a.status} — "${a.task}"`)
    .join('\n');

  return {
    preserve: [
      `## Relay State (preserve across compaction)`,
      `- Connected as: ${state.agentName}`,
      `- Workspace: ${state.workspace?.slice(0, 16)}...`,
      `- Spawned workers:\n${workers || '  (none)'}`,
    ].join('\n'),
  };
});
```

### 5.3 `session.end` — Cleanup

Gracefully disconnect and clean up spawned workers on session end.

```typescript
ctx.hook('session.end', async () => {
  if (!state.connected) return;

  // Terminate spawned workers
  for (const [name, agent] of state.spawned) {
    if (agent.status === 'running') {
      agent.process.kill('SIGTERM');
    }
  }

  state.connected = false;
});
```

---

## 6. Helper Functions

```typescript
function assertConnected(state: RelayState) {
  if (!state.connected) {
    throw new Error(
      'Not connected to Relay. Call relay_connect first.'
    );
  }
}

async function relaycastAPI(
  state: RelayState,
  endpoint: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const res = await fetch(
    `https://www.relaycast.dev/api/v1/${endpoint}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${state.token}`,
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    throw new Error(`Relay API error: ${res.status} ${await res.text()}`);
  }
  return res.json();
}
```

---

## 7. Usage Examples

### Basic: Two OpenCode Instances Collaborating

**User session (Lead):**
```
> Connect to relay workspace rk_live_abc123 as "Lead"
> Spawn a worker called "Researcher" to investigate the auth module
> Wait for their findings, then spawn "Implementer" to build the fix
```

The Lead calls `relay_connect`, then `relay_spawn` for "Researcher". Researcher boots, connects, ACKs, does work, sends `DONE: Found the issue in auth/middleware.ts — token expiry not checked`. Lead reads this via `relay_inbox`, then spawns "Implementer" with context from Researcher.

### Cross-Tool: OpenCode + Claude Code

```
> Connect to relay as "Analyzer"
> Send a DM to "CodeReviewer" (a Claude Code instance) asking them to review my changes
```

The OpenCode Analyzer and a Claude Code instance (connected via Relaycast MCP) communicate seamlessly — same workspace, same DM/channel primitives.

### Fan-Out Pattern

```
> Spawn 3 workers: "TestWriter", "DocWriter", "Linter"
> Give each their task, wait for all to ACK, then monitor progress
```

---

## 8. Implementation Phases

### Phase 1: OpenCode Core Tools

**Scope**: `relay_connect`, `relay_send`, `relay_inbox`, `relay_agents`, `relay_post`

**Tests**:
- Unit: Each tool handler with mocked HTTP
- Integration: Connect to test workspace, send/receive a round-trip message

**Exit criteria**: Can connect, send DMs, check inbox, list agents, post to channels.

### Phase 2: OpenCode Spawn & Dismiss

**Scope**: `relay_spawn`, `relay_dismiss`

**Tests**:
- Unit: Process spawning with mocked `spawn()`
- Integration: Spawn a real OpenCode instance, verify it connects and ACKs
- Lifecycle: Spawn → ACK → DONE → dismiss flow

**Exit criteria**: Can spawn workers that self-bootstrap onto the relay and communicate back.

### Phase 3: OpenCode Hooks & Polish

**Scope**: Idle polling, context preservation, cleanup (hook names provisional — see Section 5 note)

**Tests**:
- Unit: Idle hook surfaces messages correctly
- Unit: Compacting hook preserves relay state
- Integration: Full lifecycle — connect, spawn workers, receive messages during idle, compact without losing state, clean up on exit

**Exit criteria**: Messages surface automatically during idle. Context survives compaction. Clean shutdown.

### Phase 4: OpenCode Distribution

**Scope**: npm publish, OpenCode plugin registry submission, documentation

**Exit criteria**: `opencode plugin add agent-relay` works. README covers all tools and examples.

---

## 9. Testing Strategy

### Test Fixtures

```typescript
class MockRelayServer {
  messages: Message[] = [];
  agents: string[] = [];

  /** Simulate an inbound message */
  injectMessage(from: string, text: string) {
    this.messages.push({ id: crypto.randomUUID(), from, text, ts: new Date().toISOString() });
  }

  /** Mock HTTP handler */
  async handle(endpoint: string, body: Record<string, unknown>) {
    switch (endpoint) {
      case 'dm/send':
        this.messages.push({ id: crypto.randomUUID(), from: 'self', text: body.text as string, ts: new Date().toISOString() });
        return { ok: true };
      case 'inbox/check':
        const msgs = [...this.messages];
        this.messages = [];
        return { messages: msgs };
      case 'agent/list':
        return { agents: this.agents };
      case 'register':
        return { token: 'test-token-123' };
      default:
        return { ok: true };
    }
  }
}
```

### Test Matrix

| Test | Phase | Type | Description |
|------|-------|------|-------------|
| connect-success | 1 | unit | Registers via HTTP and sets token |
| connect-bad-workspace | 1 | unit | Rejects invalid workspace key |
| send-dm | 1 | unit | Sends DM via API |
| send-not-connected | 1 | unit | Throws if not connected |
| inbox-poll | 1 | unit | Polls HTTP API and returns messages |
| agents-list | 1 | unit | Returns agent list |
| post-channel | 1 | unit | Posts to channel |
| spawn-worker | 2 | unit | Spawns process with correct args |
| spawn-env-vars | 2 | unit | Workspace key passed via env var, not in prompt |
| spawn-exit-tracking | 2 | unit | Tracks worker exit status |
| dismiss-running | 2 | unit | Kills running process |
| dismiss-already-done | 2 | unit | Handles already-exited worker |
| idle-no-messages | 3 | unit | Returns nothing when inbox empty |
| idle-surfaces-messages | 3 | unit | Formats and injects messages |
| compacting-preserves | 3 | unit | State string includes all workers |
| end-cleanup | 3 | unit | Terminates workers and disconnects |
| round-trip | all | integration | Full send → receive cycle |
| spawn-ack-flow | all | integration | Spawn → ACK → DONE lifecycle |

---

## 10. Performance Constraints

| Metric | Target |
|--------|--------|
| `relay_connect` latency | < 1s (HTTP register) |
| `relay_send` latency | < 500ms |
| `relay_inbox` latency | < 500ms (HTTP poll) |
| `relay_spawn` to worker ACK | < 15s (includes CLI boot) |
| Hook inbox poll interval | 3s min between checks (configurable) |
| BeforeModel rate limit | 5s min between inbox checks |
| HTTP retry backoff | 1s, 2s, 4s (max 3 attempts) |

---

## 11. Error Handling

| Error | Behavior |
|-------|----------|
| HTTP request failure | Retry with exponential backoff, max 3 attempts. Return error on final failure. |
| Workspace key invalid | Throw with clear message: "Invalid workspace key. Get one at relaycast.dev" |
| Agent name taken | Throw: "Agent name already registered. Choose a different name." |
| Concurrent name registration | First registration wins. Second attempt gets "name taken" error. Callers should add a suffix and retry (e.g., `Worker-1` → `Worker-1a`). |
| Spawn failure | Return error with stderr. Don't crash parent session. |
| Worker crash | Update status to 'error'. Don't auto-restart. Notify via next inbox check. |
| API rate limit | Retry with backoff, max 3 attempts. |

---

## 12. Relaycast API Contract

The OpenCode plugin talks to Relaycast via HTTP. The Claude Code and Gemini plugins use the Relaycast MCP server which handles transport internally. No new backend endpoints required.

> **Note**: The endpoint paths below mirror the MCP tool names. Verify these against the actual Relaycast API — the MCP server may use different internal endpoints. The `/api/v1/register` endpoint in particular needs confirmation as it may be handled differently (e.g., via the MCP server's own registration flow).

| Endpoint | Method | Body | Response |
|----------|--------|------|----------|
| `/api/v1/register` | POST | `{ workspace, name, cli }` | `{ token }` |
| `/api/v1/dm/send` | POST | `{ to, text }` | `{ ok }` |
| `/api/v1/inbox/check` | POST | `{}` | `{ messages }` |
| `/api/v1/message/post` | POST | `{ channel, text }` | `{ ok }` |
| `/api/v1/agent/list` | POST | `{}` | `{ agents }` |
| `/api/v1/agent/add` | POST | `{ name, cli, task }` | `{ ok }` |
| `/api/v1/agent/remove` | POST | `{ name }` | `{ ok }` |

---

## 13. Claude Code Companion Plugin

### Architecture: Brokerless by Default

Claude Code + Relaycast MCP achieves **full agent-to-agent communication without a broker**. The Relaycast MCP server connects directly to Relaycast over WebSocket. Any Claude Code instance with the MCP server configured can:

- Send DMs (`mcp__relaycast__dm_send`)
- Post to channels (`mcp__relaycast__message_post`)
- Check inbox (`mcp__relaycast__inbox_check`)
- Spawn independent agents (`mcp__relaycast__agent_add`)
- List/dismiss agents (`mcp__relaycast__agent_list`, `mcp__relaycast__agent_remove`)

No `agent-relay-broker` binary needed. Each spawned Claude Code instance is fully independent with its own context, tools, and peer-to-peer messaging.

### Hooks: Reliable Message Injection

Claude Code's hook system provides multiple hook events with robust injection mechanisms. The relevant ones for Relay are listed below.

#### Existing Implementation (already in this repo)

The relay codebase already implements inbox injection via hooks:

- **`packages/hooks/src/inbox-check/hook.ts`** — `Stop` hook that checks inbox when Claude tries to stop. Returns `{"decision": "block", "reason": "You have N unread messages..."}` to force Claude to continue and process them.
- **`src/hooks/check-inbox.sh`** — `PostToolUse` hook that checks inbox after every tool call for more frequent polling during active work.

#### Hook-Based Injection Strategy

| Hook Event | When It Fires | Injection Mechanism | Use Case |
|------------|---------------|---------------------|----------|
| `Stop` | Claude tries to stop | `decision: "block"` + `reason` feeds messages as next instruction | Catch messages before going idle |
| `PostToolUse` | After every tool call | `additionalContext` appended to context | Frequent polling during active work |
| `SubagentStart` | Worker is spawned | `additionalContext` injects relay bootstrap | Auto-configure spawned workers |
| `PreCompact` | Before context compaction | Preserve relay state string | Maintain identity across compaction |
| `SessionEnd` | Session terminates | Cleanup spawned workers | Graceful shutdown |

#### Stop Hook with Loop Guard

The `Stop` hook input includes `stop_hook_active: boolean` — `true` when Claude is already continuing from a previous stop-block. This prevents infinite loops.

> **⚠ Gap in existing implementation:** The current hook at `packages/hooks/src/inbox-check/hook.ts` does NOT check `stop_hook_active`. This means infinite loops are possible if messages keep arriving. The plugin must fix this.

```typescript
// Stop hook — with loop guard
const input: HookInput = readStdin();

// Guard: if we already blocked once this cycle, let Claude stop
// to avoid infinite block→retry loops
if (input.stop_hook_active) {
  output({ decision: 'approve' });
  return;
}

const messages = await checkInbox();
if (messages.length > 0) {
  output({
    decision: 'block',
    reason: `You have ${messages.length} unread relay message(s):\n${formatMessages(messages)}\nPlease read and respond.`
  });
} else {
  output({ decision: 'approve' });
}
```

#### PostToolUse Hook for Real-Time Polling

For higher-frequency message checking during active work:

```bash
#!/bin/bash
# PostToolUse hook — check inbox after every tool call
MESSAGES=$(curl -s -H "Authorization: Bearer $RELAY_TOKEN" \
  https://www.relaycast.dev/api/v1/inbox/check)

COUNT=$(echo "$MESSAGES" | jq '.messages | length')
if [ "$COUNT" -gt 0 ]; then
  FORMATTED=$(echo "$MESSAGES" | jq -r '.messages[] | "Relay message from \(.from): \(.text)"')
  echo "$FORMATTED"  # Plain text stdout → additionalContext
fi
```

### Plugin Structure

```
claude-relay-plugin/
├── plugin.json              # MCP server config + hook registration
├── hooks/
│   ├── stop-inbox.ts        # Stop hook: block if unread messages
│   ├── post-tool-inbox.sh   # PostToolUse hook: frequent polling
│   ├── subagent-bootstrap.sh # SubagentStart hook: inject relay config
│   └── pre-compact.sh       # PreCompact hook: preserve relay state
├── skills/
│   ├── relay-team.md        # /relay-team — spawn a coordinated team
│   ├── relay-fanout.md      # /relay-fanout — fan-out pattern
│   └── relay-pipeline.md    # /relay-pipeline — sequential pipeline
├── agents/
│   └── relay-worker/        # Pre-built worker agent definition
│       ├── agent.md         # Worker persona with ACK/DONE protocol
│       └── config.json      # MCP + hook config for workers
└── README.md
```

### plugin.json

```json
{
  "name": "agent-relay",
  "description": "Multi-agent communication via Agent Relay",
  "mcp": {
    "relaycast": {
      "command": "npx",
      "args": ["@relaycast/mcp"],
      "env": {
        "RELAY_WORKSPACE": "${RELAY_WORKSPACE}"
      }
    }
  },
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "node ./hooks/stop-inbox.js"
      }]
    }],
    "PostToolUse": [{
      "hooks": [{
        "type": "command",
        "command": "./hooks/post-tool-inbox.sh"
      }]
    }],
    "SubagentStart": [{
      "hooks": [{
        "type": "command",
        "command": "./hooks/subagent-bootstrap.sh"
      }]
    }],
    "PreCompact": [{
      "hooks": [{
        "type": "command",
        "command": "./hooks/pre-compact.sh"
      }]
    }]
  }
}
```

### What the Plugin Provides

| Capability | Without Plugin | With Plugin |
|---|---|---|
| **Tools (send/inbox/spawn)** | Manual MCP server config in settings.json | Auto-configured via plugin.json |
| **Inbound message injection** | No automatic injection | Stop + PostToolUse hooks surface messages automatically |
| **Worker spawning** | Works but workers need manual relay instructions | SubagentStart hook auto-bootstraps workers onto relay |
| **Context preservation** | Relay state lost on compaction | PreCompact hook preserves agent identity + worker list |
| **Common patterns** | Write orchestration prompts from scratch | `/relay-team`, `/relay-fanout`, `/relay-pipeline` skills |
| **Worker personas** | Ad-hoc task prompts | Pre-built agent definition with ACK/DONE protocol |

### Capability Comparison: OpenCode vs Claude Code

| Capability | OpenCode Plugin | Claude Code Plugin |
|---|---|---|
| Tool definition | Native `tool()` API | MCP server (Relaycast) |
| Spawn processes | Native `spawn()` | MCP `agent_add` tool |
| Stop-time injection | `session.idle` hook (provisional) | `Stop` hook with `decision: "block"` |
| Mid-work injection | Depends on OpenCode hook API | `PostToolUse` hook with `additionalContext` |
| Worker bootstrap | System prompt + env vars | `SubagentStart` hook injects config |
| Context preservation | `session.compacting` (provisional) | `PreCompact` hook |
| Cleanup on exit | `session.end` (provisional) | `SessionEnd` hook |
| Loop guard | TBD (depends on hook API) | `stop_hook_active` boolean |

Both plugins target the same end-user experience: connect, send, receive, spawn, dismiss — all without a broker. Claude Code's hook system is more mature and documented. OpenCode's hook API needs verification; if mid-work injection hooks are unavailable, agents will only see messages when they explicitly call `relay_inbox` or at idle time.

### Implementation Phases

**Phase 5: Claude Code Core Plugin**
- Package MCP config + Stop hook (with `stop_hook_active` guard) + PostToolUse hook
- One-command install
- Test: install → connect → send/receive round-trip

**Phase 6: Claude Code Skills & Agents**
- `/relay-team`, `/relay-fanout`, `/relay-pipeline` skills
- Worker agent definition with ACK/DONE protocol
- SubagentStart bootstrap hook
- PreCompact state preservation + SessionEnd cleanup

### Recommendation

Build the Claude Code plugin in **parallel with Phase 3-4** of the OpenCode plugin, not after. The core hooks (Stop + PostToolUse inbox injection) already exist in this repo — the plugin is largely packaging and distribution. The skills and agent definitions are net-new but straightforward.

---

## 14. Gemini CLI Extension

### Architecture: Same Pattern, Richer Hooks

> **Source**: Hook capabilities documented at [geminicli.com/docs/hooks/reference](https://geminicli.com/docs/hooks/reference/). Extension structure from [geminicli.com/docs/extensions/writing-extensions](https://geminicli.com/docs/extensions/writing-extensions). Gemini CLI's extension system is newer than Claude Code's — verify capabilities against latest docs before implementation.

Gemini CLI extensions bundle MCP servers, hooks, commands, sub-agents, skills, and themes into a single installable package via `gemini extensions install <github-url>`. Like Claude Code, tools come via MCP servers — so Relaycast provides full send/inbox/spawn/dismiss without a broker.

What makes Gemini interesting is the **hook system offers more injection points than Claude Code**:

| Hook Event | When | Injection Mechanism | Relay Use Case |
|------------|------|---------------------|----------------|
| `AfterTool` | After every tool call | `additionalContext` appended to results | Frequent inbox polling (like Claude's PostToolUse) |
| `AfterAgent` | After agent responds | `reason` forces retry with new instructions | Block stop + inject unread messages |
| `BeforeAgent` | Before planning begins | `additionalContext` extends prompt | Inject relay context at turn start |
| `BeforeModel` | Before LLM request | Modify `llm_request.messages` directly | Prepend inbox messages to next model call |
| `BeforeToolSelection` | Before tool routing | Filter/whitelist tools | Context-aware tool availability |
| `SessionStart` | Session begins | `additionalContext` loads initial context | Auto-connect to relay workspace |
| `SessionEnd` | Session ends | Cleanup | Disconnect + terminate workers |
| `PreCompress` | Before context compression | — | Preserve relay state |
| `Notification` | System alerts | Logging | Log relay events |

#### Key Advantages Over Claude Code

1. **`BeforeModel` hook** — Can directly modify the LLM request messages array. This means we can prepend inbox messages to the very next model call, not just append context after a tool. This is the most reliable injection point possible.

2. **`AfterAgent` with retry** — When the agent finishes its response, this hook can force a full retry with a new `reason`. This is equivalent to Claude's `Stop` hook but more explicit — the agent gets a clean retry with the inbox messages as its prompt.

3. **`BeforeToolSelection` filtering** — Can dynamically whitelist/blacklist tools based on relay state. For example, hide `relay_spawn` if the agent has already hit a worker limit.

4. **Matcher patterns** — Hooks can target specific MCP tools via regex: `"matcher": "mcp_relaycast_.*"` to only fire on relay tool calls.

5. **Sub-agents as `.md` files** — Worker definitions live in `agents/` as markdown files, loaded natively by Gemini CLI. No MCP wrapper needed for agent personas.

6. **Custom commands via TOML** — `/relay:status`, `/relay:team` as lightweight command shortcuts without needing full skill definitions.

### Extension Structure

```
gemini-relay-extension/
├── gemini-extension.json     # Manifest: MCP + hooks + settings
├── relay-server.js           # MCP server (Relaycast proxy or direct)
├── hooks/
│   ├── hooks.json            # Hook registration
│   ├── after-tool-inbox.sh   # AfterTool: poll inbox after each tool
│   ├── after-agent-inbox.sh  # AfterAgent: block stop if unread messages
│   ├── before-model-inject.sh # BeforeModel: prepend inbox to next call
│   ├── session-start.sh      # SessionStart: auto-connect
│   └── session-end.sh        # SessionEnd: cleanup
├── commands/
│   ├── status/
│   │   └── status.toml       # /relay:status — show connection + workers
│   ├── team/
│   │   └── team.toml         # /relay:team — spawn a coordinated team
│   └── fanout/
│       └── fanout.toml       # /relay:fanout — fan-out pattern
├── skills/
│   ├── relay-orchestration/
│   │   └── SKILL.md          # Multi-agent orchestration patterns
│   └── relay-protocol/
│       └── SKILL.md          # ACK/DONE communication protocol
├── agents/
│   ├── relay-worker.md       # Generic worker sub-agent
│   ├── relay-researcher.md   # Research-focused worker
│   └── relay-reviewer.md     # Code review worker
├── GEMINI.md                 # Context: relay instructions for the LLM
├── package.json
└── README.md
```

### gemini-extension.json

```json
{
  "name": "agent-relay",
  "version": "0.1.0",
  "description": "Multi-agent communication via Agent Relay",
  "contextFileName": "GEMINI.md",
  "settings": [
    {
      "name": "Workspace Key",
      "description": "Your Relay workspace key (rk_live_...)",
      "envVar": "RELAY_WORKSPACE",
      "sensitive": true
    }
  ],
  "mcpServers": {
    "relaycast": {
      "command": "node",
      "args": ["${extensionPath}${/}relay-server.js"],
      "cwd": "${extensionPath}"
    }
  }
}
```

### hooks/hooks.json

```json
{
  "AfterTool": [
    {
      "matcher": ".*",
      "hooks": [{
        "type": "command",
        "command": "sh ${extensionPath}/hooks/after-tool-inbox.sh",
        "name": "Relay Inbox Poll",
        "timeout": 5000
      }]
    }
  ],
  "AfterAgent": [
    {
      "hooks": [{
        "type": "command",
        "command": "sh ${extensionPath}/hooks/after-agent-inbox.sh",
        "name": "Relay Stop Guard"
      }]
    }
  ],
  "BeforeModel": [
    {
      "hooks": [{
        "type": "command",
        "command": "sh ${extensionPath}/hooks/before-model-inject.sh",
        "name": "Relay Message Injection"
      }]
    }
  ],
  "SessionStart": [
    {
      "hooks": [{
        "type": "command",
        "command": "sh ${extensionPath}/hooks/session-start.sh",
        "name": "Relay Auto-Connect"
      }]
    }
  ],
  "SessionEnd": [
    {
      "hooks": [{
        "type": "command",
        "command": "sh ${extensionPath}/hooks/session-end.sh",
        "name": "Relay Cleanup"
      }]
    }
  ]
}
```

### Hook Implementations

#### AfterTool — Frequent Inbox Polling

```bash
#!/bin/bash
# Fires after every tool call — check for new messages
TOKEN=$(cat ~/.relay/token 2>/dev/null) || exit 0
MESSAGES=$(curl -s -H "Authorization: Bearer $TOKEN" \
  https://www.relaycast.dev/api/v1/inbox/check)

COUNT=$(echo "$MESSAGES" | jq -r '.messages | length')
if [ "$COUNT" -gt 0 ]; then
  FORMATTED=$(echo "$MESSAGES" | jq -r '.messages[] | "Relay message from \(.from): \(.text)"' | head -20)
  # Inject as additionalContext
  cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "AfterTool",
    "additionalContext": "You have $COUNT new relay message(s):\n$FORMATTED\nPlease read and respond to these messages."
  }
}
EOF
else
  echo '{}'
fi
```

#### AfterAgent — Stop Guard (Equivalent to Claude's Stop Hook)

```bash
#!/bin/bash
# Fires after agent responds — if unread messages exist, force retry
# Loop guard: file-based counter prevents infinite retries
TOKEN=$(cat ~/.relay/token 2>/dev/null) || exit 0
GUARD_FILE="/tmp/relay-afteragent-guard-$$"
RETRY_COUNT=0

if [ -f "$GUARD_FILE" ]; then
  RETRY_COUNT=$(cat "$GUARD_FILE")
fi

# Max 3 consecutive retries, then let the agent stop
if [ "$RETRY_COUNT" -ge 3 ]; then
  rm -f "$GUARD_FILE"
  echo '{"decision": "allow"}'
  exit 0
fi

MESSAGES=$(curl -s -H "Authorization: Bearer $TOKEN" \
  https://www.relaycast.dev/api/v1/inbox/check)

COUNT=$(echo "$MESSAGES" | jq -r '.messages | length')
if [ "$COUNT" -gt 0 ]; then
  FORMATTED=$(echo "$MESSAGES" | jq -r '.messages[] | "Relay message from \(.from): \(.text)"' | head -20)
  # Increment retry counter
  echo $((RETRY_COUNT + 1)) > "$GUARD_FILE"
  # Block the stop and retry with messages as the reason
  cat <<EOF
{
  "decision": "block",
  "reason": "You have $COUNT unread relay message(s). Please process them before stopping:\n$FORMATTED"
}
EOF
else
  # No messages — reset counter and allow stop
  rm -f "$GUARD_FILE"
  echo '{"decision": "allow"}'
fi
```

#### BeforeModel — Direct Message Injection

```bash
#!/bin/bash
# Fires before every LLM call — prepend buffered messages to the request
# This is the most reliable injection point: messages go directly into the model context
# Rate-limited: checks inbox at most once every 5 seconds to avoid latency on rapid model calls
TOKEN=$(cat ~/.relay/token 2>/dev/null) || exit 0
RATE_FILE="/tmp/relay-beforemodel-last-check"
NOW=$(date +%s)

if [ -f "$RATE_FILE" ]; then
  LAST_CHECK=$(cat "$RATE_FILE")
  ELAPSED=$((NOW - LAST_CHECK))
  if [ "$ELAPSED" -lt 5 ]; then
    echo '{}'  # Skip — checked too recently
    exit 0
  fi
fi
echo "$NOW" > "$RATE_FILE"

# Read the current llm_request from stdin
INPUT=$(cat)
MESSAGES=$(curl -s -H "Authorization: Bearer $TOKEN" \
  https://www.relaycast.dev/api/v1/inbox/check)

COUNT=$(echo "$MESSAGES" | jq -r '.messages | length')
if [ "$COUNT" -gt 0 ]; then
  FORMATTED=$(echo "$MESSAGES" | jq -r '.messages[] | "Relay message from \(.from): \(.text)"')

  # Modify llm_request to prepend relay messages as a system message
  LLM_REQUEST=$(echo "$INPUT" | jq -r '.llm_request')
  MODIFIED=$(echo "$LLM_REQUEST" | jq --arg msgs "$FORMATTED" \
    '.messages = [{"role": "system", "content": ("New relay messages:\n" + $msgs)}] + .messages')

  cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "BeforeModel",
    "llm_request": $MODIFIED
  }
}
EOF
else
  echo '{}'
fi
```

### Custom Commands

#### commands/status/status.toml

```toml
prompt = """Check the relay status:
1. Call mcp_relaycast_agent_list to see who's online
2. Call mcp_relaycast_inbox_check to see unread messages
3. Report a summary of agents and any pending messages"""
```

#### commands/team/team.toml

```toml
prompt = """Spawn a coordinated team of relay agents for: {{args}}

Follow this protocol:
1. Analyze the task and determine how many workers are needed (max 5)
2. For each worker, call mcp_relaycast_agent_add with a clear name and task
3. Monitor their ACK messages via mcp_relaycast_inbox_check
4. Coordinate their work by relaying information between them
5. Collect DONE messages and synthesize the final result"""
```

### Sub-Agent Definitions

#### agents/relay-worker.md

```markdown
---
name: relay-worker
description: A worker agent that communicates via Agent Relay
model: gemini-2.5-flash
---

You are a Relay worker agent. When you start:

1. Check your inbox with mcp_relaycast_inbox_check for your task assignment
2. Send an ACK to your lead: mcp_relaycast_dm_send(to: "<lead>", text: "ACK: <your understanding>")
3. Complete the assigned task
4. Report back: mcp_relaycast_dm_send(to: "<lead>", text: "DONE: <summary of what you accomplished>")

Always check your inbox periodically during long tasks in case your lead has updates.
```

### Capability Comparison: All Platforms

| Capability | OpenCode | Claude Code | Gemini CLI | Codex (deferred) |
|---|---|---|---|---|
| Tool definition | Native `tool()` | MCP server | MCP server | MCP server |
| Spawn processes | Native `spawn()` | MCP `agent_add` | MCP `agent_add` | MCP `agent_add` |
| Stop-time injection | `session.idle` (provisional) | `Stop` hook + block | `AfterAgent` hook + block | `Stop` hook + block |
| Mid-work injection | TBD | `PostToolUse` + context | `AfterTool` + context | **Not available** |
| Pre-model injection | — | — | **`BeforeModel` + modify request** (rate-limited) | — |
| Worker bootstrap | System prompt + env vars | `SubagentStart` hook | Sub-agent `.md` files | — |
| Context preservation | `session.compacting` (provisional) | `PreCompact` | `PreCompress` | — |
| Cleanup | `session.end` (provisional) | `SessionEnd` | `SessionEnd` | — |
| Custom commands | — | Skills (slash commands) | **TOML commands + Skills** | — |
| Loop guard | TBD | `stop_hook_active` | File-based counter (max 3 retries) | `stop_hook_active` |
| Install method | `opencode plugin add` | Plugin install | `gemini extensions install` | `npx agent-relay setup codex` |
| **Real-time ready?** | TBD | **Yes** | **Yes** | **No** — Stop hook only |

**Summary**: Claude Code and Gemini CLI are implementation-ready with mid-work injection hooks. OpenCode needs hook API verification. Codex is deferred — its `Stop` hook only fires at task completion, making real-time communication impractical. Codex becomes viable when `AfterToolUse` hooks are exposed or via app-server `turn/steer` integration (separate relay core spec).

### Implementation Phases

**Phase 7: Gemini Core Extension**
- gemini-extension.json with Relaycast MCP server
- AfterTool inbox polling hook + AfterAgent stop guard (with file-based loop guard)
- SessionStart/SessionEnd hooks
- Test: `gemini extensions install` → connect → send/receive

**Phase 8: Gemini BeforeModel + Commands**
- BeforeModel hook for direct message injection (with rate limiting)
- BeforeToolSelection for context-aware tool filtering
- `/relay:status`, `/relay:team`, `/relay:fanout` commands
- Orchestration + protocol skills
- Worker/researcher/reviewer sub-agent definitions
- GEMINI.md context file

### Recommendation

Build the Gemini extension **alongside the Claude Code plugin** (Phase 5-6). The structure is nearly identical — same MCP server, similar hooks, same ACK/DONE protocol. The main unique work is the `BeforeModel` hook (which is worth prioritizing as it's the best injection mechanism available on any platform) and the TOML command definitions.

---

## 15. Codex — Future (Not Implementing Now)

Codex is **deferred** from this spec's implementation scope. While Codex has a hooks engine ([PR #13276](https://github.com/openai/codex/pull/13276)) with `SessionStart` and `Stop` hooks, it lacks the mid-work injection needed for real-time communication.

### Why Not Now

The `Stop` hook only fires **when the agent finishes its entire response** — after all tool calls are done. There is no `PostToolUse` / `AfterTool` equivalent. If an agent is working for 5 minutes making 20 tool calls, it won't check its inbox until the very end.

| CLI | When inbox is checked | Worst-case latency |
|---|---|---|
| Claude Code | After every tool call (`PostToolUse`) | Seconds |
| Gemini CLI | After every tool call (`AfterTool`) | Seconds |
| **Codex (hooks only)** | **When agent finishes entire task (`Stop`)** | **Minutes** |

The `AfterToolUse` infrastructure exists in Codex's Rust codebase (`codex-rs/core/src/tools/registry.rs` dispatches after every tool call) but is not wired to the config system — the hooks vector is initialized empty and the `HookEventName` enum only has `SessionStart` and `Stop`.

### When to Revisit

Codex becomes viable for real-time relay communication when **either**:

1. **`AfterToolUse` hooks are exposed** — OpenAI adds `AfterToolUse` to the `HookEventName` enum and wires it through the config/discovery system. The dispatch infrastructure is already production-ready.
2. **App-server integration via relay core** — The Codex app-server (JSON-RPC 2.0) exposes `turn/steer` for mid-execution message injection. This is the more powerful path but belongs in a separate relay core injection spec — similar to how relay achieves OpenCode injection today.

### What a Future Plugin Would Look Like

When ready, the Codex plugin would follow the same MCP + hooks pattern as Claude Code and Gemini:

```bash
npx agent-relay setup codex  # writes MCP + hooks to Codex config
codex                         # just works
```

The Stop hook implementation can be shared directly with Claude Code (same block/allow/inject pattern, same `stop_hook_active` loop guard). Adding `AfterToolUse` would bring it to full parity.

---

## 16. Open Questions

1. **OpenCode plugin API stability** — The plugin system is evolving. Pin to specific API version? Hook event names (`session.idle`, `session.compacting`, `session.end`) are unverified.
2. **Worker bootstrap** — Should workers install the relay plugin themselves, or should the system prompt include raw tool definitions as a fallback?
3. **Multi-workspace** — Should a single session support connecting to multiple workspaces simultaneously?
4. **Auth flow** — Should `relay_connect` support OAuth in addition to workspace keys?
5. **Process isolation** — Should spawned workers use Bun's shell API instead of Node's `child_process` for better integration with OpenCode's runtime?
6. **Shared MCP server** — Claude Code and Gemini both use MCP servers natively, so they share the Relaycast MCP server. OpenCode uses native `tool()` with direct HTTP calls. If OpenCode adds MCP support, it could share the same server. For now, OpenCode is the only one with a separate transport layer.
7. **Migration from file-based inbox** — The existing hooks (`packages/hooks/src/inbox-check/`) read from `/tmp/agent-relay/{agent}/inbox.md` (file-based, broker-backed). The plugins described here use Relaycast HTTP API (brokerless). This is a different architecture. The existing hooks should be updated to support both backends, or the plugin should fully replace them.
8. **Relaycast API endpoint verification** — The HTTP endpoints listed in Section 12 (e.g., `/api/v1/register`) need verification against the actual Relaycast API. The MCP server may use different internal endpoints.
9. **Model passthrough on spawn** — The OpenCode plugin passes `--model` to spawned workers. The Claude Code and Gemini plugins spawn via MCP `agent_add` — does this tool support model selection? (Ref: recent fix in commit `4b0eb5a6`)
10. **Relay core injection spec** — The Codex app-server's `turn/steer` capability (and similar patterns for OpenCode injection) should be specced separately as a relay core injection layer. This would generalize mid-execution message delivery across CLIs that expose programmatic control APIs. This is also what unblocks Codex for real-time communication.

### Resolved

- ~~**BeforeModel injection frequency**~~ — Resolved: rate-limited to once per 5 seconds via timestamp file (see BeforeModel hook implementation).
- ~~**Gemini AfterAgent retry loop**~~ — Resolved: file-based counter with max 3 retries (see AfterAgent hook implementation).

---

## 17. Success Criteria

### OpenCode Plugin
- [ ] `opencode plugin add agent-relay` installs and registers tools
- [ ] Single OpenCode instance can connect, send, and receive messages
- [ ] Can spawn 3+ workers that all communicate independently
- [ ] Workers survive parent context compaction
- [ ] All tests pass (unit + integration)
- [ ] < 50ms overhead per tool call (excluding network)
- [ ] Clean shutdown — no orphaned processes

### Claude Code Plugin
- [ ] One-command plugin install configures MCP + hooks
- [ ] Stop hook blocks when unread messages exist
- [ ] PostToolUse hook surfaces messages during active work
- [ ] SubagentStart hook auto-bootstraps spawned workers
- [ ] PreCompact hook preserves relay state
- [ ] Skills (`/relay-team`, `/relay-fanout`, `/relay-pipeline`) work correctly
- [ ] Worker agent definition follows ACK/DONE protocol

### Gemini CLI Extension
- [ ] `gemini extensions install` registers MCP + hooks + commands
- [ ] AfterTool hook polls inbox after each tool call
- [ ] AfterAgent hook blocks stop when unread messages exist
- [ ] BeforeModel hook injects messages directly into LLM request
- [ ] Custom commands (`/relay:status`, `/relay:team`) work
- [ ] Sub-agent definitions spawn correctly
- [ ] SessionStart auto-connects, SessionEnd cleans up

### Cross-Platform
- [ ] OpenCode ↔ Claude Code messaging works via shared workspace
- [ ] OpenCode ↔ Gemini CLI messaging works via shared workspace
- [ ] Claude Code ↔ Gemini CLI messaging works via shared workspace
- [ ] Mixed team (all three platforms) can coordinate on a single task

### Codex (deferred — revisit when `AfterToolUse` hooks are available)
- [ ] Monitor Codex hooks API for `AfterToolUse` support
- [ ] Spec relay core injection layer for app-server `turn/steer` integration
