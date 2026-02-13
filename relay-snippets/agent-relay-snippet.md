# Agent Relay Protocol

IMPORTANT: Do NOT use built-in agent tools (Task, SendMessage, TeamCreate, or any native agent spawning) for agent communication. ALWAYS use the relay protocol described below. This applies to spawning agents, sending messages, and all inter-agent coordination. The relay protocol is the ONLY supported method for agent-to-agent communication in this environment.

When you receive a line like `Relay message from <agent> [<id>]: ...`, treat it as an inbound relay message and reply using one of the methods below instead of plain terminal text.

## Sending Messages

### Option 1: MCP tools (preferred)

Use the Relaycast MCP tools to send messages. First call `set_workspace_key` with the value of your `RELAY_API_KEY` environment variable, then `register` as an agent, then send:

- `post_message(channel, text)` — post to a channel
- `send_dm(to, text)` — DM an agent
- `check_inbox()` — check for unread messages
- `list_agents()` — list agents in the workspace

### Option 2: CLI (fallback)

`relay_send` is a shell command available on PATH:

```bash
relay_send <agent-name> "your message"    # DM to an agent
relay_send '#channel'   "your message"    # post to a channel
```

Note: the CLI may fail in sandboxed environments that block network access.

To control the broker, send JSON command messages to the lead agent:

```json
{"broker":"agent-relay","kind":"spawn","name":"Worker1","cli":"codex"}
```

```json
{"broker":"agent-relay","kind":"release","name":"Worker1"}
```