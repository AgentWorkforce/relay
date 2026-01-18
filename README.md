# agent-relay

Real-time messaging between AI agents. Sub-5ms latency, any CLI, any language.

## Install

```bash
npm install -g agent-relay
```

**Requirements:** Node.js 20+

**Linux:** Install build tools first:
```bash
sudo apt-get update && sudo apt-get install -y build-essential
```

### Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| macOS Apple Silicon | **Full support** | Native relay-pty binary |
| macOS Intel | **Full support** | Native relay-pty binary |
| Linux x64 | **Full support** | Native relay-pty binary |
| Linux arm64 | Fallback | Uses tmux (install separately) |
| Windows | Fallback | Uses tmux via WSL |

## Quick Start

```bash
# Start daemon + coordinator agent
agent-relay claude

# Or with other CLI tools
agent-relay codex
```

Agents communicate via file-based messaging:

```bash
# Write message to outbox
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/msg << 'EOF'
TO: Bob

Hey, can you help with this task?
EOF

# Trigger send
echo "->relay-file:msg"
```

Synchronous messaging (wait for ACK):
```
->relay:Bob [await] Please confirm
->relay:Bob [await:30s] Please confirm within 30 seconds
```

Or broadcast to all:
```bash
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/broadcast << 'EOF'
TO: *

Message to all agents
EOF
echo "->relay-file:broadcast"
```

## CLI Reference

| Command | Description |
|---------|-------------|
| `agent-relay claude` | Start daemon + coordinator with Claude |
| `agent-relay codex` | Start daemon + coordinator with Codex |
| `agent-relay up` | Start daemon + dashboard |
| `agent-relay down` | Stop daemon |
| `agent-relay status` | Check daemon status |
| `agent-relay create-agent -n Name <cmd>` | Create named agent |
| `agent-relay read <id>` | Read truncated message |
| `agent-relay bridge <projects...>` | Bridge multiple projects |

## Architecture

```
┌─────────────┐     ┌─────────────┐
│ Agent Alice │     │  Agent Bob  │
│ (relay-pty) │     │ (relay-pty) │
└──────┬──────┘     └──────┬──────┘
       │                   │
       └─────────┬─────────┘
                 │
        Unix Domain Socket
                 │
        ┌────────┴────────┐
        │  relay daemon   │
        │   (<5ms P2P)    │
        └────────┬────────┘
                 │
        ┌────────┴────────┐
        │    Dashboard    │
        │  (Protocol UI)  │
        └─────────────────┘
```

**relay-pty** is a Rust binary that wraps your CLI tool, providing:
- Direct PTY writes for reliable message injection
- ~550ms injection latency (vs ~1700ms with tmux)
- File-based message parsing for robustness

The **Dashboard** is a reference implementation of the relay protocol, providing real-time visibility into agent communication, message history, and coordinator controls.

## Dashboard

The dashboard starts automatically with any command (`agent-relay claude`, `agent-relay up`, etc.) at http://localhost:3888

Features:
- Real-time agent presence and status
- Message history and threading
- Coordinator panel for multi-agent orchestration
- Log streaming from all agents

## Cloud

For maximum scale and team collaboration, use [**agent-relay cloud**](https://agent-relay.com):

```bash
# Link your machine to cloud
agent-relay cloud link

# Check cloud status
agent-relay cloud status

# List agents across all linked machines
agent-relay cloud agents

# Send message to agent on any machine
agent-relay cloud send AgentName "Your message"
```

Cloud features:
- **Persistent workspaces** - Agents survive disconnects
- **Team collaboration** - Share dashboards, view all agents
- **Cross-machine messaging** - Send to agents on any linked machine
- **Centralized monitoring** - See all daemons and agents in one place

The cloud dashboard is the same protocol implementation, scaled for teams.

## Agent Roles

Create role-based agents by adding markdown files:

```
.claude/agents/
├── lead.md          # Coordinator
├── implementer.md   # Developer
├── reviewer.md      # Code review
└── designer.md      # UI/UX
```

Names automatically match roles (case-insensitive):
```bash
agent-relay create-agent -n Lead claude    # Uses lead.md
```

## Multi-Project Bridge

Orchestrate agents across multiple repositories:

```bash
# Start daemons in each project
cd ~/auth && agent-relay up
cd ~/frontend && agent-relay up

# Bridge from anywhere
agent-relay bridge ~/auth ~/frontend ~/api
```

Cross-project messaging uses `project:agent` format in the TO header:
```bash
cat > /tmp/relay-outbox/$AGENT_RELAY_NAME/msg << 'EOF'
TO: auth:Lead

Please review the token refresh logic
EOF
echo "->relay-file:msg"
```

## Teaching Agents

Install the messaging skill for your agents via [prpm](https://prpm.dev):

```bash
# Install snippet for AGENTS.md
npx prpm install @agent-relay/agent-relay-snippet

# Install snippet for CLAUDE.md
npx prpm install @agent-relay/agent-relay-snippet --location CLAUDE.md
```

View the rest of our packages on our [prpm organization page](https://prpm.dev/orgs?name=Agent%20Relay)

Or manually add the relay patterns to your agent instructions.

## Development

```bash
git clone https://github.com/AgentWorkforce/relay.git
cd relay
npm install && npm run build
npm run dev  # Start daemon + dashboard in dev mode
```

## Philosophy

**Do one thing well**: Real-time agent messaging with <5ms latency.

agent-relay is a messaging layer, not a framework. It integrates with:
- Any CLI tool (Claude, Codex, Gemini, custom agents)
- Any orchestration system (your own, Beads, external)
- Any memory system (Mimir, vector DBs, files)

```
┌──────────────────────────────────────────┐
│           Your Agent System              │
├──────────────────────────────────────────┤
│  Memory │ Orchestration │ UI/Dashboard   │
│  (any)  │    (any)      │    (any)       │
├──────────────────────────────────────────┤
│           agent-relay                    │
│        Real-time messaging               │
├──────────────────────────────────────────┤
│  Claude  │  Codex  │  Gemini  │  Custom  │
└──────────────────────────────────────────┘
```

## License

MIT

---

**Links:** [Documentation](https://github.com/AgentWorkforce/relay/tree/main/docs) | [Issues](https://github.com/AgentWorkforce/relay/issues) | [Cloud](https://agent-relay.com)
