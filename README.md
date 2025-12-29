# agent-relay

Real-time messaging between AI agents.

## Install

```bash
npm install -g agent-relay
```

**Requirements:** Node.js 20+, tmux

## Quick Start

```bash
# Terminal 1: Start daemon
agent-relay up

# Terminal 2: Start an agent
agent-relay -n Alice claude

# Terminal 3: Start another agent
agent-relay -n Bob codex
```

Agents communicate by outputting `->relay:` patterns. Always use the fenced format:

```
->relay:Bob <<<
Hey, can you review my changes?>>>

->relay:* <<<
Broadcasting to everyone>>>
```

## CLI

| Command | Description |
|---------|-------------|
| `agent-relay <cmd>` | Wrap agent with messaging |
| `agent-relay -n Name <cmd>` | Wrap with specific name |
| `agent-relay up` | Start daemon + dashboard |
| `agent-relay down` | Stop daemon |
| `agent-relay status` | Check if running |
| `agent-relay read <id>` | Read truncated message |
| `agent-relay bridge <projects...>` | Bridge multiple projects |

## How It Works

1. `agent-relay up` starts a daemon that routes messages via Unix socket
2. `agent-relay <cmd>` wraps your agent in tmux, parsing output for `->relay:` patterns
3. Messages are injected into recipient terminals in real-time

```
┌─────────────┐     ┌─────────────┐
│ Agent Alice │     │  Agent Bob  │
│   (tmux)    │     │   (tmux)    │
└──────┬──────┘     └──────┬──────┘
       │                   │
       └─────────┬─────────┘
                 │
        Unix Domain Socket
                 │
        ┌────────┴────────┐
        │  relay daemon   │
        └─────────────────┘
```

## Agent Communication

### Send Message

```
->relay:AgentName <<<
Your message here>>>
```

### Broadcast

```
->relay:* <<<
Message to all agents>>>
```

### Receive

Messages appear as:

```
Relay message from Alice [abc123]: Your message here
```

### Truncated Messages

Long messages are truncated. Use the ID to read full content:

```bash
agent-relay read abc123
```

## Agent Roles

Agent names automatically match role definitions (case-insensitive):

```bash
# If .claude/agents/lead.md exists:
agent-relay -n Lead claude    # matches lead.md
agent-relay -n LEAD claude    # matches lead.md
agent-relay -n lead claude    # matches lead.md

# Supported locations:
# - .claude/agents/<name>.md
# - .openagents/<name>.md
```

Create role agents for your team:

```
.claude/agents/
├── lead.md          # Coordinator
├── implementer.md   # Developer
├── designer.md      # UI/UX
└── reviewer.md      # Code review
```

## Multi-Project Orchestration

Bridge multiple projects with a single orchestrator:

```bash
# Bridge projects (Architect mode)
agent-relay bridge ~/auth ~/frontend ~/api
```

### Workflow

1. **Start daemons** in each project: `agent-relay up`
2. **Start agents** in each project: `agent-relay -n Alice claude`
3. **Bridge** from anywhere: `agent-relay bridge ~/project1 ~/project2`

### Cross-Project Messaging

```
->relay:projectId:agent <<<
Message to specific agent>>>

->relay:*:lead <<<
Broadcast to all project leads>>>
```

### Spawn Agents

```
->relay:spawn Dev1 claude "Implement login endpoint"
->relay:release Dev1
```

See [docs/DESIGN_BRIDGE_STAFFING.md](docs/DESIGN_BRIDGE_STAFFING.md) for full details.

## Enabling AI Agents

To teach your AI agents how to use agent-relay, you should:

### Install the Skill

```bash
prpm install using-agent-relay
```

This installs the `using-agent-relay` skill which provides agents with messaging patterns, coordination workflows, and troubleshooting guidance.

### Update the AGENTS.md/CLAUDE.md file

Use prpm to install the AGENTS.md snippet or CLAUDE.md snippet
```
prpm install @agent-relay/agent-relay-snippet
```

Or if using CLAUDE.md
```
prpm install @agent-relay/agent-relay-snippet --location CLAUDE.md
```

## Dashboard

`agent-relay up` starts a web dashboard at http://localhost:3888

![Agent Relay Dashboard](dashboard.png)

## Development

```bash
git clone https://github.com/khaliqgant/agent-relay.git
cd agent-relay
npm install && npm run build
```

## Why agent-relay?

### The Composable Approach

Most multi-agent tools try to be complete solutions - handling communication, memory, UI, workflows, and orchestration. agent-relay takes a different approach: **do one thing exceptionally well** (real-time messaging) and integrate with best-of-breed tools for everything else.

```
┌─────────────────────────────────────────────────────────────┐
│                    Your Agent System                        │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │   Mimir     │  │  Maestro    │  │    Beads    │         │
│  │  (Memory)   │  │    (UI)     │  │ (Workflows) │         │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘         │
│         └────────────────┼────────────────┘                 │
│                ┌─────────▼─────────┐                        │
│                │   agent-relay     │  ◄── Messaging layer   │
│                │     <5ms P2P      │                        │
│                └─────────┬─────────┘                        │
│         ┌────────────────┼────────────────┐                 │
│    ┌────▼────┐     ┌────▼────┐     ┌────▼────┐             │
│    │ Claude  │     │  Codex  │     │  Gemini │             │
│    └─────────┘     └─────────┘     └─────────┘             │
└─────────────────────────────────────────────────────────────┘
```

### Unix Philosophy

- **Do one thing well**: Real-time agent messaging with <5ms latency
- **Work with others**: Simple `->relay:` pattern, standard I/O
- **Text streams**: Messages are just text, easy to parse/transform
- **Composability**: Pipe into other tools, wrap any CLI

### When to Use agent-relay

| Use Case | agent-relay? |
|----------|--------------|
| Quick prototyping with multiple agents | **Yes** - 1 min setup |
| Real-time agent collaboration | **Yes** - fastest option |
| CLI-native workflows | **Yes** - no Electron/desktop needed |
| Need persistent knowledge graph | Combine with Mimir |
| Need rich desktop UI | Combine with Maestro |
| Enterprise compliance | Combine with governance layer |

See [docs/COMPETITIVE_ANALYSIS.md](docs/COMPETITIVE_ANALYSIS.md) for detailed comparisons with 16 other multi-agent tools.

---

## Inspiration

This project was inspired by some excellent work in the multi-agent coordination space:

- **[mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail)** - A brilliant MCP-based approach to agent messaging with file-based inboxes and structured message handling. Great patterns for durable, asynchronous agent communication.

- **[swarm-tools / swarm-mail](https://github.com/joelhooks/swarm-tools)** - An exceptional event-sourced coordination system with durable cursors, locks, deferred responses, and ask/respond patterns. The gold standard for robust multi-agent workflows with full audit trails.

Both projects informed our thinking around durability, message threading, and coordination primitives. Check them out!

## License

MIT
