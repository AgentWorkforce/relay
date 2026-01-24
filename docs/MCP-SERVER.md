# MCP Server for Agent Relay

The Agent Relay MCP (Model Context Protocol) server provides native tools for AI agents to communicate with each other across different editors and platforms.

## Overview

The MCP server (`@agent-relay/mcp`) is a standalone package that integrates with AI-powered editors like Claude Desktop, Cursor, VS Code, and others. It gives AI agents direct access to the relay messaging system without requiring manual protocol implementation.

## Installation

### One-Time Setup

Configure your AI editor to use the Agent Relay MCP server:

```bash
# Auto-detect and configure all supported editors
npx @agent-relay/mcp install

# Or configure a specific editor
npx @agent-relay/mcp install --editor claude
npx @agent-relay/mcp install --editor cursor
```

Supported editors:
- **Claude Desktop** - Native MCP support
- **Claude Code** - Native MCP support  
- **Cursor** - Via MCP configuration
- **VS Code** - With Continue extension
- **Windsurf** - Via MCP configuration
- **Zed** - Via assistant panel configuration

### How It Works

1. The install command modifies your editor's configuration file to add the agent-relay MCP server
2. When your editor starts, it automatically runs `npx @agent-relay/mcp serve`
3. The MCP server discovers your relay daemon socket automatically
4. AI agents immediately have access to relay tools

## Available Tools

Once configured, AI agents can use these tools:

### relay_send
Send messages to specific agents or channels.

```typescript
relay_send({
  to: "AgentName",      // or "*" for broadcast, "#channel" for channels
  message: "Your message here",
  thread?: "thread-id", // Optional thread identifier
  await?: true,         // Wait for acknowledgment
  timeout?: 30          // Timeout in seconds (with await)
})
```

### relay_inbox
Check pending messages in your inbox.

```typescript
relay_inbox({
  limit?: 10,          // Maximum messages to retrieve
  includeRead?: false  // Include already-read messages
})
```

### relay_who
List all online agents.

```typescript
relay_who()
// Returns: Array of { name, cli, status, lastSeen }
```

### relay_spawn
Spawn a new worker agent.

```typescript
relay_spawn({
  name: "WorkerName",
  cli: "claude",       // or "codex", "gemini", etc.
  task: "Task description for the agent",
  includeWorkflowConventions?: false // Optional: include ACK/DONE conventions
})
```

**Note on `includeWorkflowConventions`**: By default (`false`), spawned agents receive only transport-level instructions (how to send/receive messages). Set to `true` to include ACK/DONE workflow conventions where workers acknowledge tasks and signal completion.

### relay_release
Release a spawned worker agent.

```typescript
relay_release({
  name: "WorkerName"
})
```

### relay_status
Check relay daemon connection status.

```typescript
relay_status()
// Returns: { connected: boolean, socket?: string, error?: string }
```

## MCP Resources

The server also provides MCP resources for reading agent state:

- **relay://agents** - List of all online agents
- **relay://inbox** - Your message inbox
- **relay://project** - Current project configuration

## MCP Prompts

The server includes a comprehensive prompt:

- **relay_protocol** - Full relay protocol documentation

## Socket Discovery

The MCP server automatically discovers the relay daemon socket in this order:

1. **Environment variable**: `RELAY_SOCKET`
2. **Cloud workspace**: Auto-detected via `WORKSPACE_ID`
3. **Project environment**: `RELAY_PROJECT` variable
4. **Current directory**: `.relay/config.json`
5. **Data directory scan**: Searches standard locations

## Requirements

- **Node.js 20+** - Required for running the MCP server
- **Relay daemon** - Must be running (`agent-relay up`)
- **Compatible editor** - One of the supported AI editors

## Troubleshooting

### "Relay daemon is not running"

Start the relay daemon first:
```bash
agent-relay up
```

### "Cannot find socket"

Ensure you're in a project with relay initialized or set the `RELAY_SOCKET` environment variable:
```bash
export RELAY_SOCKET=/path/to/relay.sock
```

### Editor not detecting MCP server

1. Restart your editor after installation
2. Check the configuration file was updated correctly:
   - Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Cursor: `~/.cursor/mcp/mcp.json`
   - VS Code: Check Continue extension settings

### Tools not appearing

1. Verify MCP server is running: Check editor logs
2. Ensure daemon is accessible: `agent-relay status`
3. Check for errors in MCP server output

## Development

### Running Locally

```bash
# Clone and build
git clone https://github.com/AgentWorkforce/relay.git
cd relay
npm install
npm run build

# Test the MCP server
cd packages/mcp
npm test

# Run server directly
npm run serve
```

### Testing Installation

```bash
# Dry run to see what would change
npx @agent-relay/mcp install --dry-run

# Install with verbose output
npx @agent-relay/mcp install --verbose
```

## Architecture

```
┌─────────────────┐
│   AI Editor     │
│ (Claude/Cursor) │
└────────┬────────┘
         │ MCP Protocol
┌────────┴────────┐
│  MCP Server     │
│ @agent-relay/mcp│
└────────┬────────┘
         │ Unix Socket
┌────────┴────────┐
│  Relay Daemon   │
│  (agent-relay)  │
└────────┬────────┘
         │
┌────────┴────────┐
│  Other Agents   │
└─────────────────┘
```

## Package Structure

```
packages/mcp/
├── src/
│   ├── server.ts       # MCP server implementation
│   ├── client.ts       # Relay daemon client
│   ├── cloud.ts        # Cloud workspace support
│   ├── install.ts      # Editor configuration
│   ├── tools/          # MCP tool implementations
│   ├── resources/      # MCP resource providers
│   └── prompts/        # MCP prompt definitions
├── package.json
└── README.md
```

## Publishing

The package is published to npm as `@agent-relay/mcp`:

```bash
cd packages/mcp
npm publish
```

Users can then install globally or use via npx:
```bash
# Global install
npm install -g @agent-relay/mcp

# Or use directly with npx
npx @agent-relay/mcp install
```

## Integration with Main CLI

The MCP server is integrated with the main agent-relay CLI:

```bash
# These commands are equivalent
npx @agent-relay/mcp install
agent-relay mcp install

# Start MCP server manually
agent-relay mcp serve
```

## Security Considerations

- The MCP server only connects to local Unix domain sockets
- No network traffic or remote connections
- Messages stay within your local machine or cloud workspace
- Editor configuration changes require user confirmation

## Future Enhancements

- [ ] Windows native support (currently uses WSL)
- [ ] More editor integrations
- [ ] Custom tool extensions
- [ ] Persistent message history
- [ ] Enhanced cloud workspace features