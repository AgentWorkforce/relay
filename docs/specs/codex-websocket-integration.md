# Codex WebSocket Integration Spec

## Overview

Replace CLI-based Codex spawning with direct WebSocket connection to Codex's app-server JSON-RPC 2.0 API. This eliminates stdin injection and provides richer event streaming.

## Current vs Proposed

### Current (CLI Spawning)
```
agent-relay → spawn CLI process → inject stdin → parse stdout
```
- Limited control over agent lifecycle
- Text-based message injection
- No structured events
- Process management overhead

### Proposed (WebSocket)
```
agent-relay → WebSocket connection → JSON-RPC 2.0 → structured events
```
- Direct bidirectional communication
- Full lifecycle control (start, steer, interrupt)
- Structured event streaming
- No process spawning

## Protocol Flow

### 1. Connection Setup

When spawning a Codex agent, agent-relay:

```javascript
// Start codex app-server (one per project or shared)
spawn('codex', ['app-server', '--listen', 'ws://127.0.0.1:4500']);

// Connect via WebSocket
const ws = new WebSocket('ws://127.0.0.1:4500');
```

### 2. Initialization Handshake

```javascript
// After connection opens
ws.send(JSON.stringify({
  method: 'initialize',
  id: 0,
  params: {
    clientInfo: {
      name: 'agent-relay',
      title: 'Agent Relay',
      version: '1.0.0'
    }
  }
}));

// Then send initialized notification
ws.send(JSON.stringify({
  method: 'initialized',
  params: {}
}));
```

### 3. Thread Creation (Per Agent)

Each spawned Codex agent gets its own thread:

```javascript
ws.send(JSON.stringify({
  method: 'thread/start',
  id: requestId++,
  params: {
    model: 'gpt-5.1-codex',
    cwd: projectRoot
  }
}));
// Response: { id: 1, result: { thread: { id: 'thr_xxx' } } }
```

### 4. Message Translation

**Agent Relay → Codex**

When agent-relay delivers a message to Codex agent:

```javascript
// Incoming relay message
{ to: 'CodexWorker', from: 'Lead', body: 'Implement auth module' }

// Translated to Codex turn
ws.send(JSON.stringify({
  method: 'turn/start',
  id: requestId++,
  params: {
    threadId: agentThreadId,
    input: [{
      type: 'text',
      text: `[Relay message from Lead]\n\n${body}`
    }]
  }
}));
```

**Codex → Agent Relay**

Monitor for `item/agentMessage/delta` and `turn/completed`:

```javascript
ws.on('message', (frame) => {
  const msg = JSON.parse(frame);

  if (msg.method === 'turn/completed') {
    // Extract final agent response
    const response = extractResponse(msg.params.turn);

    // Parse for relay triggers (->relay-file:xxx)
    const relayMessages = parseRelayTriggers(response);

    // Dispatch to agent-relay
    relayMessages.forEach(m => relay.dispatch(m));
  }
});
```

## Spawn Protocol Changes

### Current Format
```
KIND: spawn
NAME: CodexWorker
CLI: codex

Task description here.
```

### New Format (Backward Compatible)
```
KIND: spawn
NAME: CodexWorker
CLI: codex
TRANSPORT: websocket  # Optional, defaults to 'cli'

Task description here.
```

Or auto-detect:
```
KIND: spawn
NAME: CodexWorker
CLI: codex-ws  # New CLI identifier for WebSocket mode

Task description here.
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Agent Relay                          │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │   Claude    │  │   Codex     │  │   Gemini    │     │
│  │   Adapter   │  │   Adapter   │  │   Adapter   │     │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘     │
│         │                │                │             │
│    CLI spawn       WebSocket RPC      CLI spawn        │
│         │                │                │             │
│         ▼                ▼                ▼             │
│  ┌──────────┐     ┌───────────┐    ┌──────────┐        │
│  │  claude  │     │  codex    │    │  gemini  │        │
│  │  process │     │app-server │    │  process │        │
│  └──────────┘     └───────────┘    └──────────┘        │
└─────────────────────────────────────────────────────────┘
```

## CodexAdapter Implementation

```typescript
interface CodexAdapter {
  // Connection management
  connect(endpoint: string): Promise<void>;
  disconnect(): Promise<void>;

  // Agent lifecycle
  createAgent(name: string, task: string): Promise<CodexAgent>;
  destroyAgent(name: string): Promise<void>;

  // Message handling
  sendMessage(agentName: string, message: RelayMessage): Promise<void>;
  onResponse(handler: (agentName: string, response: string) => void): void;

  // Turn control
  interruptAgent(name: string): Promise<void>;
  steerAgent(name: string, additionalInput: string): Promise<void>;
}

class CodexAgent {
  threadId: string;
  name: string;
  status: 'idle' | 'processing' | 'completed';

  async sendTurn(input: string): Promise<void>;
  async interrupt(): Promise<void>;
  async steer(input: string): Promise<void>;
}
```

## Event Mapping

| Codex Event | Agent Relay Action |
|-------------|-------------------|
| `turn/started` | Log agent activity |
| `item/agentMessage/delta` | Stream to observers (optional) |
| `item/completed` (type: command) | Log command execution |
| `item/completed` (type: fileChange) | Log file modification |
| `turn/completed` | Parse response, dispatch relay messages |
| Error `-32001` (overloaded) | Retry with backoff |

## Benefits

1. **No stdin injection** - Clean JSON-RPC instead of text manipulation
2. **Structured events** - Know exactly when commands run, files change
3. **Interrupt support** - Can stop runaway agents mid-turn
4. **Steering** - Append guidance to in-flight turns
5. **Single server** - One app-server can handle multiple agent threads
6. **Better error handling** - Typed errors vs parsing stderr

## Considerations

1. **Experimental** - WebSocket transport marked experimental by OpenAI
2. **Server lifecycle** - Need to manage app-server process
3. **Connection pooling** - Shared server vs per-agent connections
4. **Fallback** - Keep CLI mode as backup

## Implementation Phases

### Phase 1: Proof of Concept
- [ ] Manual WebSocket connection to Codex app-server
- [ ] Send/receive JSON-RPC messages
- [ ] Parse relay triggers from responses

### Phase 2: Adapter Integration
- [ ] Create `CodexAdapter` class
- [ ] Integrate with agent-relay spawn flow
- [ ] Handle connection lifecycle

### Phase 3: Full Integration
- [ ] Auto-start app-server when needed
- [ ] Connection pooling for multiple agents
- [ ] Streaming event support
- [ ] Interrupt/steer commands via relay

## Hooks via App Server Events

### Background

Codex users have requested hooks support ([GitHub Discussion #2150](https://github.com/openai/codex/discussions/2150)). Currently, Codex only has a limited `notify` config that supports `agent-turn-complete`. Users want:

- Sound/notification when agent finishes
- Hook when agent needs user feedback
- Command execution events
- File change events

### Opportunity

The app-server **already exposes all these events** via JSON-RPC notifications. Agent-relay can provide hook functionality that Codex doesn't have natively.

### Available Events from App Server

| Event | Description | Hook Use Case |
|-------|-------------|---------------|
| `turn/started` | Agent began processing | Start timer, show spinner |
| `turn/completed` | Agent finished turn | Play sound, send notification |
| `item/started` | Work item began | Progress tracking |
| `item/completed` (command) | Shell command ran | Log command, validate output |
| `item/completed` (fileChange) | File was modified | Run linter, type-check |
| `item/agentMessage/delta` | Streaming response | Live progress UI |
| `approval/requested` | Agent waiting for user | Play alert, send urgent notification |

### Hook Integration Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Agent Relay                             │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐     ┌──────────────┐     ┌─────────────┐  │
│  │ Codex        │────▶│ Event        │────▶│ Hook        │  │
│  │ Adapter      │     │ Processor    │     │ Executor    │  │
│  └──────────────┘     └──────────────┘     └─────────────┘  │
│         │                    │                    │          │
│         │                    │                    ▼          │
│         │                    │          ┌─────────────────┐  │
│         │                    │          │ - Shell commands │  │
│         │                    │          │ - Relay messages │  │
│         │                    │          │ - Webhooks       │  │
│         │                    │          │ - Notifications  │  │
│         │                    │          └─────────────────┘  │
│         ▼                    ▼                               │
│    WebSocket RPC      Map to relay hooks                     │
└─────────────────────────────────────────────────────────────┘
```

### Hook Configuration

```yaml
# agent-relay.yaml
hooks:
  codex:
    on_turn_complete:
      - command: "afplay /System/Library/Sounds/Glass.aiff"
      - relay: "Lead"  # Notify lead agent

    on_file_change:
      - command: "npm run lint -- ${file}"
      - command: "npm run typecheck"

    on_command_executed:
      - relay: "#audit"  # Log to audit channel

    on_approval_needed:
      - command: "/usr/bin/say 'Codex needs input'"
      - command: "terminal-notifier -message 'Codex waiting'"
```

### Implementation

```typescript
class CodexEventProcessor {
  constructor(
    private hooks: CodexHookConfig,
    private relay: AgentRelayClient
  ) {}

  async processEvent(event: CodexEvent): Promise<void> {
    switch (event.method) {
      case 'turn/completed':
        await this.executeHooks('on_turn_complete', event.params);
        break;

      case 'item/completed':
        if (event.params.type === 'fileChange') {
          await this.executeHooks('on_file_change', {
            file: event.params.path,
            ...event.params
          });
        } else if (event.params.type === 'command') {
          await this.executeHooks('on_command_executed', event.params);
        }
        break;

      case 'approval/requested':
        await this.executeHooks('on_approval_needed', event.params);
        break;
    }
  }

  private async executeHooks(
    hookType: string,
    context: Record<string, unknown>
  ): Promise<void> {
    const hooks = this.hooks[hookType] || [];

    for (const hook of hooks) {
      if (hook.command) {
        // Substitute variables like ${file}
        const cmd = this.interpolate(hook.command, context);
        await exec(cmd);
      }

      if (hook.relay) {
        await this.relay.send(hook.relay, {
          type: hookType,
          ...context
        });
      }
    }
  }
}
```

### Why This Matters

1. **Feature parity with Claude Code** - Claude Code has hooks, Codex doesn't (natively)
2. **Linting/type-checking** - Run validation after file changes (highly requested)
3. **Team coordination** - Notify other agents of significant events
4. **Audit logging** - Track all commands and file changes
5. **User notifications** - Sound/popup when agent needs attention

This makes agent-relay the best way to run Codex for teams.

---

## Hosted Architecture (Relaycast Cloud)

### Vision

**User runs one command. Everything else is cloud.**

```bash
npx @agent-relay/connect
```

With WebSocket support from both Claude (`--sdk-url`) and Codex (app-server), agent-relay can become a thin coordination layer with all orchestration happening in the cloud.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         CLOUD (Relaycast)                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐  │
│  │   Message    │  │    Spawn     │  │    Hook      │  │  Workflow   │  │
│  │   Router     │  │   Manager    │  │   Engine     │  │   Engine    │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬──────┘  │
│         │                 │                 │                 │         │
│         └────────────┬────┴────────┬────────┴─────────────────┘         │
│                      │             │                                     │
│               ┌──────┴──────┐ ┌────┴─────┐                              │
│               │  Log Store  │ │ Auth/ACL │                              │
│               └─────────────┘ └──────────┘                              │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │                         Web Dashboard                               │ │
│  │  • Real-time agent activity    • Workflow designer                 │ │
│  │  • Log viewer & search         • Team management                   │ │
│  │  • Permission controls         • Hook configuration                │ │
│  └────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
                    ▲                           ▲
                    │ WebSocket                 │ WebSocket
                    │                           │
┌───────────────────┴───────────┐ ┌─────────────┴───────────────┐
│      User A's Machine         │ │      User B's Machine        │
├───────────────────────────────┤ ├──────────────────────────────┤
│  ┌─────────────────────────┐  │ │  ┌────────────────────────┐  │
│  │  relay-connect (proxy)  │  │ │  │  relay-connect (proxy) │  │
│  └───────────┬─────────────┘  │ │  └───────────┬────────────┘  │
│              │                │ │              │               │
│    ┌─────────┼─────────┐      │ │    ┌─────────┼────────┐      │
│    ▼         ▼         ▼      │ │    ▼         ▼        ▼      │
│ ┌──────┐ ┌──────┐ ┌──────┐    │ │ ┌──────┐ ┌──────┐ ┌──────┐   │
│ │Claude│ │Codex │ │Gemini│    │ │ │Claude│ │Codex │ │Codex │   │
│ └──────┘ └──────┘ └──────┘    │ │ └──────┘ └──────┘ └──────┘   │
│  📁 Local filesystem access   │ │  📁 Local filesystem access  │
└───────────────────────────────┘ └──────────────────────────────┘
```

### Claude WebSocket Protocol

Claude Code CLI supports connecting TO your server via `--sdk-url` ([reversed by The-Vibe-Company/companion](https://github.com/The-Vibe-Company/companion)):

```bash
claude --sdk-url wss://relaycast.dev/session/xxx \
       --output-format stream-json \
       --input-format stream-json
```

**Protocol**: NDJSON (newline-delimited JSON) over WebSocket

**Key message types**:

| Direction | Type | Purpose |
|-----------|------|---------|
| CLI → Server | `system/init` | Session info, capabilities |
| Server → CLI | `user` | Send prompts |
| CLI → Server | `assistant` | LLM responses |
| CLI → Server | `control_request` | Tool approval requests |
| Server → CLI | `control_response` | Approve/deny tools |
| CLI → Server | `result` | Turn completion |

This means Claude connects **outbound** to Relaycast. No tunneling needed.

### Codex Connection Gap

Codex app-server only supports **listen mode**:

```bash
codex app-server --listen ws://127.0.0.1:4500
```

There is no `--connect` outbound mode ([verified in source](https://github.com/openai/codex/tree/main/codex-rs/app-server)).

**Solution**: Thin local proxy that:
1. Connects outbound to Relaycast
2. Bridges to local Codex app-server

### The Thin Proxy (relay-connect)

```typescript
// ~200 lines of code
class RelayConnect {
  private ws: WebSocket;
  private agents: Map<string, AgentProcess> = new Map();

  async connect(cloudUrl: string) {
    this.ws = new WebSocket(cloudUrl);

    this.ws.on('message', (msg) => {
      const cmd = JSON.parse(msg);
      this.handleCommand(cmd);
    });
  }

  private async handleCommand(cmd: ProxyCommand) {
    switch (cmd.type) {
      case 'spawn':
        await this.spawnAgent(cmd.name, cmd.cli, cmd.task);
        break;

      case 'release':
        await this.releaseAgent(cmd.name);
        break;

      case 'message':
        await this.routeToAgent(cmd.to, cmd.body);
        break;
    }
  }

  private async spawnAgent(name: string, cli: string, task: string) {
    if (cli === 'claude') {
      // Claude connects directly to cloud via --sdk-url
      const proc = spawn('claude', [
        '--sdk-url', `${this.cloudUrl}/agent/${name}`,
        '-p', task
      ]);
      this.agents.set(name, { proc, type: 'claude' });

    } else if (cli === 'codex') {
      // Codex needs local bridge
      const port = await getAvailablePort();
      const proc = spawn('codex', ['app-server', '--listen', `ws://localhost:${port}`]);

      // Bridge local Codex to cloud
      await this.bridgeCodex(name, port);
      this.agents.set(name, { proc, type: 'codex', port });
    }
  }

  private async bridgeCodex(name: string, port: number) {
    const localWs = new WebSocket(`ws://localhost:${port}`);

    // Initialize Codex connection
    localWs.on('open', () => {
      localWs.send(JSON.stringify({
        method: 'initialize',
        id: 0,
        params: { clientInfo: { name: 'relay-connect' } }
      }));
    });

    // Bridge messages: cloud <-> local codex
    localWs.on('message', (msg) => {
      this.ws.send(JSON.stringify({ agent: name, data: JSON.parse(msg) }));
    });

    // Route cloud messages to local codex
    this.codexBridges.set(name, localWs);
  }

  private async releaseAgent(name: string) {
    const agent = this.agents.get(name);
    if (agent) {
      agent.proc.kill();
      this.agents.delete(name);
    }
  }
}
```

**What relay-connect is**:
- ~200 lines of code
- Connects outbound to Relaycast
- Spawns agents when told
- Bridges Codex to cloud
- Kills agents when told
- Executes local hook commands

**What it's NOT**:
- Not a message router (cloud does that)
- Not a storage layer (cloud does that)
- Not a workflow engine (cloud does that)

### Capability Matrix

| Capability | How It Works | Where |
|------------|--------------|-------|
| **Agents communicate** | All messages route through Relaycast | Cloud |
| **Spawn agents** | Cloud → proxy → spawn locally → connect back | Both |
| **Release agents** | Cloud → proxy → kill process | Both |
| **Read agent logs** | All output stored in cloud DB | Cloud |
| **Execute hooks** | Cloud triggers, proxy runs local commands | Both |
| **Run workflows** | Orchestrated entirely in cloud | Cloud |
| **Approve tools** | Permission request routed through cloud | Cloud |
| **Share session** | Multiple users connect to same session | Cloud |
| **Cross-machine** | Agents on different machines, cloud routes | Cloud |

### Spawn Flow

```
Lead (Claude)                 Relaycast (Cloud)              Thin Proxy (Local)
     │                              │                              │
     │  relay_spawn("Worker",       │                              │
     │              "codex",        │                              │
     │              "Fix the bug")  │                              │
     │─────────────────────────────►│                              │
     │                              │                              │
     │                              │  SPAWN command               │
     │                              │─────────────────────────────►│
     │                              │                              │
     │                              │                 ┌────────────┤
     │                              │                 │ Spawn:     │
     │                              │                 │ codex      │
     │                              │                 │ app-server │
     │                              │                 └────────────┤
     │                              │                              │
     │                              │◄─────────────────────────────│
     │                              │  Worker connected            │
     │                              │                              │
     │                              │  (Deliver initial task)      │
     │                              │─────────────────────────────►│
     │                              │                      ───────►│ Worker
     │◄─────────────────────────────│                              │
     │  spawn confirmed             │                              │
```

### Release Flow

```
Lead (Claude)                 Relaycast (Cloud)              Thin Proxy (Local)
     │                              │                              │
     │  relay_release("Worker")     │                              │
     │─────────────────────────────►│                              │
     │                              │                              │
     │                              │  RELEASE Worker              │
     │                              │─────────────────────────────►│
     │                              │                              │
     │                              │                 ┌────────────┤
     │                              │                 │ Kill       │
     │                              │                 │ Worker     │
     │                              │                 │ process    │
     │                              │                 └────────────┤
     │                              │                              │
     │                              │◄─────────────────────────────│
     │                              │  Worker terminated           │
     │◄─────────────────────────────│                              │
     │  release confirmed           │                              │
```

### What Lives Where

| Component | Location | Why |
|-----------|----------|-----|
| Agent processes | Local | Need filesystem access, run commands |
| Message routing | Cloud | Central coordination |
| Log storage | Cloud | Queryable, persistent, shareable |
| Hooks config | Cloud | Centralized management |
| Hook execution | Both | Cloud triggers, proxy runs local commands |
| Workflows | Cloud | Orchestration logic |
| Permissions | Cloud | Centralized ACL |
| Dashboard/UI | Cloud | Web accessible |
| File changes | Local | Agents edit local files |

### User Experience

```bash
# One-time install
npm install -g @agent-relay/connect

# Connect to cloud
relay-connect --token <your-token>

# Output:
# ✓ Connected to relaycast.dev
# ✓ Ready to receive agent commands
# Dashboard: https://relaycast.dev/session/abc123
```

Then use the web dashboard or CLI to start tasks. Watch agents spawn, communicate, and complete work in real-time.

### Multi-Machine Scenario

User A's machine has Lead (Claude).
User B's machine has Workers (Codex).

```
User A (proxy)                Relaycast                 User B (proxy)
     │                           │                           │
     │  Lead: spawn Worker       │                           │
     │──────────────────────────►│                           │
     │                           │  spawn Worker             │
     │                           │──────────────────────────►│
     │                           │                           │ spawns Codex
     │                           │◄──────────────────────────│
     │                           │  Worker connected         │
     │◄──────────────────────────│                           │
     │                           │                           │
     │  Lead → Worker: "task"    │                           │
     │──────────────────────────►│──────────────────────────►│
     │                           │                    Worker │
```

Agents on different machines, coordinated through cloud.

### Benefits Over Current Architecture

| Current | Hosted |
|---------|--------|
| Rust broker required | Just Node.js proxy |
| PTY management | WebSocket connections |
| Local process spawning | Cloud-orchestrated |
| Local log storage | Cloud DB with search |
| Single machine | Multi-machine native |
| No web UI | Full dashboard |
| Self-hosted only | Managed service option |

### Implementation Phases

| Phase | Scope | Deliverable |
|-------|-------|-------------|
| 1 | Claude `--sdk-url` handler | Accept Claude connections in cloud |
| 2 | Codex proxy bridge | relay-connect with Codex support |
| 3 | Message routing | Cloud-based agent coordination |
| 4 | Log storage | Append-only DB with search API |
| 5 | Dashboard MVP | Real-time agent activity UI |
| 6 | Hooks | Event → action in cloud/proxy |
| 7 | Workflows | Cloud-orchestrated multi-agent flows |
| 8 | Teams | Shared workspaces, permissions, billing |

### Revenue Model

| Tier | Features | Price |
|------|----------|-------|
| Free | 1 agent, 100 msgs/day, 7-day logs | $0 |
| Pro | 10 agents, unlimited msgs, 90-day logs, hooks | $29/mo |
| Team | Unlimited agents, shared workspaces, audit logs, SSO | $99/mo/seat |

---

## Open Questions

1. Should we expose Codex events (file changes, commands) as relay broadcasts?
2. One app-server per project or global singleton?
3. How to handle auth token refresh in long-running sessions?
4. Should steering be exposed as a relay protocol extension?
5. Should hooks be per-agent or global for all Codex agents?
