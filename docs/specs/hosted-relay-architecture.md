# Hosted Relay Architecture Spec

## Overview

Replace local CLI-based agent management with a cloud-hosted coordination layer. Agents connect via WebSocket (Claude `--sdk-url`, Codex app-server), enabling a thin local proxy (~300 LOC) while all orchestration happens in the cloud.

**User runs one command. Everything else is cloud.**

```bash
npx @agent-relay/connect
```

## Background

### Current Architecture (Heavy)

```
agent-relay-broker (Rust)
  ├── PTY spawning
  ├── Process management
  ├── stdin/stdout injection
  ├── Output parsing
  └── Lifecycle management
```

### Proposed Architecture (Light)

```
relay-connect (thin proxy ~300 LOC)
  ├── WebSocket connection to cloud
  ├── Spawns agents when told
  ├── Bridges Codex to cloud
  └── Executes local hooks

Relaycast (cloud)
  ├── Message routing
  ├── Agent registry
  ├── Log storage
  ├── Workflow engine
  └── Dashboard
```

---

## Architecture Diagram

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

---

## Claude WebSocket Protocol

Claude Code CLI supports connecting TO your server via `--sdk-url` ([protocol reversed by The-Vibe-Company/companion](https://github.com/The-Vibe-Company/companion)):

```bash
claude --sdk-url wss://relaycast.dev/session/xxx \
       --output-format stream-json \
       --input-format stream-json
```

### Protocol Details

- **Transport**: NDJSON (newline-delimited JSON) over WebSocket
- **Direction**: Claude CLI connects OUTBOUND to your server (no tunneling needed)
- **Auth**: `Authorization: Bearer <token>` header on WebSocket upgrade

### Key Message Types

| Direction | Type | Purpose |
|-----------|------|---------|
| CLI → Server | `system/init` | Session info, capabilities |
| Server → CLI | `user` | Send prompts/tasks |
| CLI → Server | `assistant` | LLM responses |
| CLI → Server | `control_request` | Tool approval requests |
| Server → CLI | `control_response` | Approve/deny tools |
| CLI → Server | `result` | Turn completion |

### Connection Lifecycle

1. CLI connects and initiates WebSocket handshake
2. CLI sends `system/init` (session ID, capabilities)
3. Server sends `user` message with prompt
4. CLI streams back `assistant`, `stream_event`, `result` messages
5. Multi-turn: send more `user` messages after `result`

---

## Codex WebSocket Protocol

Codex app-server exposes a JSON-RPC 2.0 API over WebSocket ([OpenAI docs](https://developers.openai.com/codex/app-server)):

```bash
codex app-server --listen ws://127.0.0.1:4500
```

### Protocol Details

- **Transport**: JSON-RPC 2.0, one message per WebSocket frame
- **Direction**: Server LISTENS (requires local proxy bridge)
- **Note**: WebSocket transport marked "experimental" by OpenAI

### Key Methods

| Method | Purpose |
|--------|---------|
| `initialize` | Handshake with client info |
| `thread/start` | Create new conversation |
| `turn/start` | Send user input |
| `turn/completed` | Agent finished (notification) |
| `item/completed` | Work item done (command, file change) |

### Connection Gap

Codex only supports **listen mode** - no `--connect` outbound option. This requires a local proxy to bridge to the cloud.

---

## The Thin Proxy (relay-connect)

### What It Does

1. **Connects** outbound to Relaycast via WebSocket
2. **Spawns** agents when instructed (Claude, Codex, Gemini)
3. **Bridges** Codex (which only listens) to cloud
4. **Kills** agents when instructed
5. **Executes** local hook commands

### What It's NOT

- Not a message router (cloud does that)
- Not a storage layer (cloud does that)
- Not a workflow engine (cloud does that)

### Implementation

```typescript
class RelayConnect {
  private ws: WebSocket;
  private agents: Map<string, AgentProcess> = new Map();

  async connect(cloudUrl: string, token: string) {
    this.ws = new WebSocket(cloudUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });

    this.ws.on('message', (data) => {
      const cmd = JSON.parse(data);
      this.handleCommand(cmd);
    });
  }

  private async handleCommand(cmd: ProxyCommand) {
    switch (cmd.type) {
      case 'spawn':
        await this.spawnAgent(cmd.name, cmd.cli, cmd.task, cmd.spawner);
        break;

      case 'release':
        await this.releaseAgent(cmd.name);
        break;

      case 'message':
        await this.routeToAgent(cmd.to, cmd.body);
        break;

      case 'hook':
        await this.executeHook(cmd.command, cmd.context);
        break;
    }
  }

  private async spawnAgent(name: string, cli: string, task: string, spawner?: string) {
    if (cli === 'claude') {
      // Claude connects directly to cloud via --sdk-url
      const proc = spawn('claude', [
        '--sdk-url', `${this.cloudUrl}/agent/${name}`,
        '--output-format', 'stream-json',
        '--input-format', 'stream-json',
        '-p', ''
      ]);
      this.agents.set(name, { proc, type: 'claude-direct' });
      // Cloud delivers task when Claude connects

    } else if (cli === 'codex') {
      // Codex needs local bridge
      const port = await getAvailablePort();
      const proc = spawn('codex', ['app-server', '--listen', `ws://localhost:${port}`]);

      await waitForPort(port);

      // Connect and initialize
      const localWs = new WebSocket(`ws://localhost:${port}`);
      await this.initializeCodex(localWs);

      // Create thread
      const thread = await this.rpc(localWs, 'thread/start', {
        model: 'codex',
        cwd: process.cwd()
      });

      // Bridge messages
      this.bridgeCodex(name, localWs, thread.id);

      this.agents.set(name, { proc, localWs, threadId: thread.id, port, type: 'codex' });

      // Notify cloud
      this.ws.send(JSON.stringify({ event: 'agent_connected', name, cli: 'codex' }));

      // Deliver initial task
      await this.sendToCodex(name, task, spawner);
    }
  }

  private bridgeCodex(name: string, localWs: WebSocket, threadId: string) {
    localWs.on('message', (data) => {
      const msg = JSON.parse(data);

      if (msg.method === 'turn/completed') {
        // Forward agent output to cloud
        this.ws.send(JSON.stringify({
          event: 'agent_output',
          from: name,
          content: this.extractResponse(msg.params.turn)
        }));
      }

      if (msg.method === 'item/completed') {
        // Forward file changes, commands to cloud
        this.ws.send(JSON.stringify({
          event: 'agent_event',
          from: name,
          type: msg.params.type,
          data: msg.params
        }));
      }
    });
  }

  private async releaseAgent(name: string) {
    const agent = this.agents.get(name);
    if (agent) {
      agent.proc.kill();
      if (agent.localWs) agent.localWs.close();
      this.agents.delete(name);
      this.ws.send(JSON.stringify({ event: 'agent_released', name }));
    }
  }
}
```

---

## Spawn Flow

### Agent Spawns Another Agent

```
Lead (Claude)              Relaycast                 relay-connect
     |                          |                          |
     | relay_spawn("Backend",   |                          |
     |   "codex", "Build API")  |                          |
     |------------------------->|                          |
     |                          |                          |
     |                          | { type: "spawn",         |
     |                          |   name: "Backend",       |
     |                          |   cli: "codex",          |
     |                          |   spawner: "Lead" }      |
     |                          |------------------------->|
     |                          |                          |
     |                          |               [spawns    |
     |                          |                codex     |
     |                          |                app-srv]  |
     |                          |                          |
     |                          |               [connects  |
     |                          |                locally]  |
     |                          |                          |
     |                          |               [init +    |
     |                          |                thread]   |
     |                          |                          |
     |                          |<-------------------------|
     |                          | { event: "connected" }   |
     |                          |                          |
     |                          |------------------------->|
     |                          | [deliver task to Backend]|
     |                          |                          |
     |<-------------------------|                          |
     | spawn confirmed          |                          |
```

### Release Flow

```
Lead (Claude)              Relaycast                 relay-connect
     |                          |                          |
     | relay_release("Backend") |                          |
     |------------------------->|                          |
     |                          |                          |
     |                          | { type: "release",       |
     |                          |   name: "Backend" }      |
     |                          |------------------------->|
     |                          |                          |
     |                          |               [kill      |
     |                          |                process]  |
     |                          |                          |
     |                          |<-------------------------|
     |                          | { event: "released" }    |
     |                          |                          |
     |<-------------------------|                          |
     | release confirmed        |                          |
```

---

## Capability Matrix

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

---

## Hooks via App Server Events

### Background

Codex users have requested hooks support ([GitHub Discussion #2150](https://github.com/openai/codex/discussions/2150)). Currently, Codex only has a limited `notify` config that supports `agent-turn-complete`. Users want:

- Sound/notification when agent finishes
- Hook when agent needs user feedback
- Command execution events
- File change events

### Opportunity

The app-server **already exposes all these events** via JSON-RPC notifications. Agent-relay can provide hook functionality that Codex doesn't have natively.

### Available Events

| Event | Description | Hook Use Case |
|-------|-------------|---------------|
| `turn/started` | Agent began processing | Start timer, show spinner |
| `turn/completed` | Agent finished turn | Play sound, send notification |
| `item/completed` (command) | Shell command ran | Log command, validate output |
| `item/completed` (fileChange) | File was modified | Run linter, type-check |
| `approval/requested` | Agent waiting for user | Play alert, send urgent notification |

### Hook Configuration

```yaml
# In Relaycast dashboard or config
hooks:
  codex:
    on_turn_complete:
      - command: "afplay /System/Library/Sounds/Glass.aiff"
      - relay: "Lead"  # Notify lead agent

    on_file_change:
      - command: "npm run lint -- ${file}"
      - command: "npm run typecheck"

    on_approval_needed:
      - command: "/usr/bin/say 'Codex needs input'"
```

---

## User Experience

### Single Terminal (Interactive Mode)

```bash
$ relay-connect --token xxx

✓ Connected to relaycast.dev
✓ Dashboard: https://relaycast.dev/session/abc123

Type a task to auto-spawn Lead (Claude), or use commands:
  spawn <name> <cli>   - Spawn an agent
  send <name> <msg>    - Send message
  release <name>       - Release agent
  logs [name]          - View logs
  exit                 - Disconnect

relay> Play tic-tac-toe with a Codex agent

✓ Auto-spawning Lead (Claude)...
✓ Lead connected

┌─ Lead (Claude) ──────────────────────────────────────────────┐
│ I'll spawn a Codex opponent and start the game.              │
└──────────────────────────────────────────────────────────────┘

✓ Opponent (Codex) spawned

┌─ Lead → Opponent ────────────────────────────────────────────┐
│ Let's play tic-tac-toe. I'm X, you're O.                     │
│ I play center (5). Your move.                                │
└──────────────────────────────────────────────────────────────┘

┌─ Opponent → Lead ────────────────────────────────────────────┐
│ I'll take the corner.                                        │
│ I play top-left (1). Your turn.                              │
└──────────────────────────────────────────────────────────────┘

... game continues ...
```

### Stream Modes

```bash
# Default: Show all messages
relay-connect --token xxx

# Quiet: Only show final results
relay-connect --token xxx --quiet

# Verbose: Show all messages + tool calls + file changes
relay-connect --token xxx --verbose
```

---

## What Lives Where

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

---

## SDK Compatibility

**SDK API stays identical. Implementation gets simpler.**

```typescript
import { workflow, AgentRelay } from '@agent-relay/sdk';

const relay = new AgentRelay();

// Same API
await relay.spawn('Worker', 'codex', 'Build the feature');
await relay.send('Worker', 'Add error handling');
await relay.release('Worker');

// Workflows - same API
const wf = workflow('build-feature')
  .agent('Backend', { cli: 'codex' })
  .agent('Frontend', { cli: 'claude' })
  .step('implement', { agent: 'Backend', task: 'Build API' });

await wf.run();
```

Under the hood: 50+ lines per method → 5 lines (just send WebSocket message to cloud).

---

## Multi-Machine Scenario

Agents on different machines, coordinated through cloud:

```
User A (proxy)                Relaycast                 User B (proxy)
     │                           │                           │
     │  Lead: spawn Worker       │                           │
     │──────────────────────────>│                           │
     │                           │  spawn Worker             │
     │                           │──────────────────────────>│
     │                           │                           │ spawns Codex
     │                           │<──────────────────────────│
     │                           │  Worker connected         │
     │<──────────────────────────│                           │
     │                           │                           │
     │  Lead → Worker: "task"    │                           │
     │──────────────────────────>│──────────────────────────>│
     │                           │                    Worker │
```

---

## Benefits Over Current Architecture

| Current | Hosted |
|---------|--------|
| Rust broker required | Just Node.js proxy |
| PTY management | WebSocket connections |
| Local process spawning | Cloud-orchestrated |
| Local log storage | Cloud DB with search |
| Single machine | Multi-machine native |
| No web UI | Full dashboard |
| Self-hosted only | Managed service option |

---

## Implementation Phases

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

---

## Revenue Model

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
6. Feature request to OpenAI for Codex `--connect` mode?

---

## References

- [OpenAI Codex App Server Docs](https://developers.openai.com/codex/app-server)
- [Claude WebSocket Protocol (reversed)](https://github.com/The-Vibe-Company/companion/blob/main/WEBSOCKET_PROTOCOL_REVERSED.md)
- [Codex Hooks Discussion #2150](https://github.com/openai/codex/discussions/2150)
