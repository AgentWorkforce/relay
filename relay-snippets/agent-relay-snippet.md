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

## When You Are Spawned

If you were spawned by another agent:

1. Your first message is your task from your spawner
2. Use `relay_send` to reply to your spawner
3. Report status to your spawner (your lead), not broadcast

```
relay_send(to: "Lead", message: "ACK: Starting on the task.")
```

## Protocol

- **ACK** when you receive a task: `ACK: Brief description`
- **DONE** when complete: `DONE: What was accomplished`
- Send status to your **lead**, not broadcast

## Agent Naming (Local vs Bridge)

**Local communication** uses plain agent names. The `project:` prefix is **ONLY** for cross-project bridge mode.

| Context                | Correct                                    | Incorrect                             |
| ---------------------- | ------------------------------------------ | ------------------------------------- |
| Local (same project)   | `relay_send(to: "Lead", ...)`              | `relay_send(to: "project:lead", ...)` |
| Bridge (cross-project) | `relay_send(to: "frontend:Designer", ...)` | N/A                                   |

## Checking Status

```
relay_who()      # List online agents
relay_inbox()    # Check for unread messages
relay_status()   # Check connection status
```
