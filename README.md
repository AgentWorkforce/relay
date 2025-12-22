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

Agents communicate by outputting `>>relay:` patterns:

```
>>relay:Bob Hey, can you review my changes?
>>relay:* Broadcasting to everyone
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

## How It Works

1. `agent-relay up` starts a daemon that routes messages via Unix socket
2. `agent-relay <cmd>` wraps your agent in tmux, parsing output for `>>relay:` patterns
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
>>relay:AgentName Your message here
```

### Broadcast

```
>>relay:* Message to all agents
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

## Dashboard

`agent-relay up` starts a web dashboard at http://localhost:3888

![Agent Relay Dashboard](dashboard.png)

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Messages not sending | `agent-relay status` to check daemon |
| Socket not found | `agent-relay up` to start daemon |
| Truncated message | `agent-relay read <id>` |

## Development

```bash
git clone https://github.com/khaliqgant/agent-relay.git
cd agent-relay
npm install && npm run build
```

## Inspiration

This project was inspired by some excellent work in the multi-agent coordination space:

- **[mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail)** - A brilliant MCP-based approach to agent messaging with file-based inboxes and structured message handling. Great patterns for durable, asynchronous agent communication.

- **[swarm-tools / swarm-mail](https://github.com/joelhooks/swarm-tools)** - An exceptional event-sourced coordination system with durable cursors, locks, deferred responses, and ask/respond patterns. The gold standard for robust multi-agent workflows with full audit trails.

Both projects informed our thinking around durability, message threading, and coordination primitives. Check them out!

## License

MIT
