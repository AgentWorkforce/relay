# Agent Relay

Real-time agent-to-agent messaging via MCP tools.

## MCP Tools

All agent communication uses MCP tools provided by the Relaycast MCP server.
Tool names use dot-notation: Claude uses `mcp__relaycast__<category>_<action>`, other CLIs use `relaycast.<category>.<action>`.

| Tool                              | Description                           |
| --------------------------------- | ------------------------------------- |
| `message.dm.send(to, text)`       | Send a DM to an agent                 |
| `message_post(channel, text)`     | Post a message to a channel           |
| `message.inbox.check()`           | Check your inbox for new messages     |
| `agent_list()`                    | List online agents                    |
| `agent_add(name, cli, task)`      | Spawn a new worker agent              |
| `agent_remove(name)`              | Release/stop a worker agent           |

## Sending Messages

### Direct Messages

```
mcp__relaycast__message_dm_send(to: "Bob", text: "Can you review my code changes?")
```

### Channel Messages

```
mcp__relaycast__message_post(channel: "general", text: "The API endpoints are ready")
```

## Spawning & Releasing Agents

### Spawn a Worker

```
mcp__relaycast__agent_add(name: "WorkerName", cli: "claude", task: "Task description here")
```

### CLI Options

| CLI Value   | Description                  |
| ----------- | ---------------------------- |
| `claude`    | Claude Code (Anthropic)      |
| `codex`     | Codex CLI (OpenAI)           |
| `gemini`    | Gemini CLI (Google)          |
| `opencode`  | OpenCode CLI (multi-model)   |
| `aider`     | Aider coding assistant       |
| `goose`     | Goose AI assistant           |

### Release a Worker

```
mcp__relaycast__agent_remove(name: "WorkerName")
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
2. Use `mcp__relaycast__message_dm_send` to reply to your spawner
3. Report status to your spawner (your lead), not broadcast

```
mcp__relaycast__message_dm_send(to: "Lead", text: "ACK: Starting on the task.")
```

## Protocol

- **ACK** when you receive a task: `ACK: Brief description`
- **DONE** when complete: `DONE: What was accomplished`
- Send status to your **lead**, not broadcast

## Agent Naming (Local vs Bridge)

**Local communication** uses plain agent names. The `project:` prefix is **ONLY** for cross-project bridge mode.

| Context                | Correct                                                     | Incorrect                                              |
| ---------------------- | ----------------------------------------------------------- | ------------------------------------------------------ |
| Local (same project)   | `mcp__relaycast__message_dm_send(to: "Lead", ...)`          | `mcp__relaycast__message_dm_send(to: "project:lead", ...)`     |
| Bridge (cross-project) | `mcp__relaycast__message_dm_send(to: "frontend:Designer", ...)` | N/A                                                    |

## Multi-Workspace

When connected to multiple workspaces, messages include workspace context:

```
Relay message from Alice [my-team / abc123]: Hello!
```

- Messages are scoped to the originating workspace
- Reply within the same workspace context shown in the message header

## Checking Status

```
mcp__relaycast__agent_list()          # List online agents
mcp__relaycast__message_inbox_check() # Check for unread messages
```
