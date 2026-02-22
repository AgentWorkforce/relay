---
name: using-agent-relay
description: Use when coordinating multiple AI agents in real-time - provides inter-agent messaging via MCP tools
---

# Agent Relay

Real-time agent-to-agent messaging via MCP tools.

## MCP Tools

All agent communication uses MCP tools provided by the Relaycast MCP server:

| Tool                           | Description                           |
| ------------------------------ | ------------------------------------- |
| `relay_send(to, message)`      | Send a message to an agent or channel |
| `relay_inbox()`                | Check your inbox for new messages     |
| `relay_who()`                  | List online agents                    |
| `relay_spawn(name, cli, task)` | Spawn a new worker agent              |
| `relay_release(name)`          | Release/stop a worker agent           |
| `relay_status()`               | Check relay connection status         |

## Sending Messages

Use the `relay_send` MCP tool:

```
relay_send(to: "AgentName", message: "Your message here")
```

### Direct Messages

```
relay_send(to: "Bob", message: "Can you review my code changes?")
```

### Broadcast to All

```
relay_send(to: "*", message: "I've finished the auth module")
```

### Channel Messages

```
relay_send(to: "#frontend", message: "The API endpoints are ready")
```

## Communication Protocol

**ACK immediately** - When you receive a task, acknowledge it before starting work:

```
relay_send(to: "Lead", message: "ACK: Brief description of task received")
```

**Report completion** - When done, send a completion message:

```
relay_send(to: "Lead", message: "DONE: Brief summary of what was completed")
```

## Receiving Messages

Messages appear as:

```
Relay message from Alice [abc123]: Content here
```

Channel messages include `[#channel]`:

```
Relay message from Alice [abc123] [#general]: Hello!
```

Reply to the channel shown, not the sender.

## Spawning & Releasing Agents

### Spawn a Worker

```
relay_spawn(name: "WorkerName", cli: "claude", task: "Task description here")
```

### CLI Options

| CLI Value | Description             |
| --------- | ----------------------- |
| `claude`  | Claude Code (Anthropic) |
| `codex`   | Codex CLI (OpenAI)      |
| `gemini`  | Gemini CLI (Google)     |
| `aider`   | Aider coding assistant  |
| `goose`   | Goose AI assistant      |

### Release a Worker

```
relay_release(name: "WorkerName")
```

## Status Updates

**Send status updates to your lead, NOT broadcast:**

```
relay_send(to: "Lead", message: "STATUS: Working on auth module")
```

## Checking Status

```
relay_who()      # List online agents
relay_inbox()    # Check for unread messages
relay_status()   # Check connection status
```

## CLI Commands

```bash
agent-relay status              # Check daemon status
agent-relay agents              # List active agents
agent-relay agents:logs <name>  # View agent output
agent-relay agents:kill <name>  # Kill a spawned agent
agent-relay read <id>           # Read truncated message
agent-relay history             # Show recent message history
```

## Troubleshooting

```bash
agent-relay status              # Check daemon
agent-relay agents              # List connected agents
```

## Common Mistakes

| Mistake                   | Fix                                          |
| ------------------------- | -------------------------------------------- |
| Messages not sending      | Check `relay_status()` to verify connection  |
| Agent not receiving       | Use `relay_who()` to confirm agent is online |
| Truncated message content | `agent-relay read <id>` for full text        |
