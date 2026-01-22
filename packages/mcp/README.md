# @agent-relay/mcp

MCP (Model Context Protocol) server for Agent Relay - gives AI agents native tools for inter-agent communication.

## Installation

### Quick Install (Recommended)

```bash
npx @agent-relay/mcp install
```

This auto-detects supported editors and configures them.

### Editor-Specific Install

```bash
# Claude Desktop
npx @agent-relay/mcp install --editor claude

# Claude Code
npx @agent-relay/mcp install --editor claude-code

# Cursor
npx @agent-relay/mcp install --editor cursor

# VS Code
npx @agent-relay/mcp install --editor vscode

# Windsurf
npx @agent-relay/mcp install --editor windsurf
```

## Available Tools

Once installed, AI agents have access to these tools:

### `relay_send`
Send messages to other agents, channels, or broadcast.

```
relay_send(to="Alice", message="Hello!")
relay_send(to="#general", message="Team update")
relay_send(to="*", message="Broadcast")
```

### `relay_inbox`
Check inbox for pending messages.

```
relay_inbox()
relay_inbox(from="Lead", limit=5)
```

### `relay_who`
List online agents.

```
relay_who()
```

### `relay_spawn`
Spawn a worker agent.

```
relay_spawn(name="Worker1", cli="claude", task="Run tests")
```

### `relay_release`
Release a worker agent.

```
relay_release(name="Worker1")
```

### `relay_status`
Get connection status.

```
relay_status()
```

## CLI Commands

```bash
# Install for all detected editors
npx @agent-relay/mcp install

# Install for specific editor
npx @agent-relay/mcp install --editor cursor

# Show installation status
npx @agent-relay/mcp install --status

# List supported editors
npx @agent-relay/mcp install --list

# Uninstall
npx @agent-relay/mcp install --uninstall

# Dry run (show what would be done)
npx @agent-relay/mcp install --dry-run

# Run server manually (used by editors)
npx @agent-relay/mcp serve
```

## Requirements

- Node.js 18+
- Agent Relay daemon running (`agent-relay daemon start`)

## Resources

The MCP server provides these resources:

- `relay://agents` - Live list of online agents
- `relay://inbox` - Current inbox contents
- `relay://project` - Project configuration

## Prompts

- `relay_protocol` - Full protocol documentation

## Cloud Workspaces

In cloud environments with `WORKSPACE_ID` and `CLOUD_API_URL` set, the server automatically discovers workspace-specific sockets.

## Environment Variables

- `RELAY_SOCKET` - Override socket path
- `RELAY_PROJECT` - Override project name
- `RELAY_AGENT_NAME` - Override agent name

## License

MIT
