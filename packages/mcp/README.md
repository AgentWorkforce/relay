# @agent-relay/mcp

MCP (Model Context Protocol) server for Agent Relay - gives AI agents native tools for inter-agent communication.

## Quick Start

The fastest way to get started with Agent Relay and MCP:

```bash
# Install Agent Relay globally
npm install -g agent-relay

# Run the setup wizard
agent-relay init
```

The wizard will:
1. Configure MCP for your AI editors (Claude Code, Cursor, Codex, and more)
2. Offer to start the daemon
3. Show you how to use the relay tools

## Breaking Changes

### v1.x: Client Module Restructure

The internal client module has been restructured. **Main package exports are unchanged** - only direct file imports are affected.

**If you import from the main package (recommended), no changes needed:**

```typescript
// This still works - no changes required
import { createRelayClient } from '@agent-relay/mcp';
```

**If you import directly from source files, update your imports:**

```typescript
// OLD (no longer works):
import { createRelayClient } from '@agent-relay/mcp/src/client.js';

// NEW:
import { createRelayClient } from '@agent-relay/mcp';

// Alternative (if you need direct file import):
import { createRelayClient } from '@agent-relay/mcp/src/client-adapter.js';
```

**What changed:**
- `packages/mcp/src/client.ts` has been deleted
- Functionality moved to `packages/mcp/src/client-adapter.ts`
- Main package exports (`@agent-relay/mcp`) continue to work unchanged

## Manual Installation

### Install MCP for Editors

```bash
# Auto-detect and configure all supported editors
npx @agent-relay/mcp install

# Or configure specific editors
npx @agent-relay/mcp install --editor claude    # Claude Code
npx @agent-relay/mcp install --editor cursor    # Cursor
npx @agent-relay/mcp install --editor codex     # Codex (OpenAI)
npx @agent-relay/mcp install --editor vscode    # VS Code
npx @agent-relay/mcp install --editor windsurf  # Windsurf
npx @agent-relay/mcp install --editor gemini    # Gemini CLI
npx @agent-relay/mcp install --editor opencode  # OpenCode
npx @agent-relay/mcp install --editor droid     # Droid (Factory)
```

### Global vs Project-Local Installation

By default, MCP is installed to your project directory (project-local). Use `--global` to install to your home directory:

```bash
# Project-local (default) - writes to ./codex.toml, ./.cursor/mcp.json, etc.
npx @agent-relay/mcp install --editor codex

# Global - writes to ~/.codex/config.toml, ~/.cursor/mcp.json, etc.
npx @agent-relay/mcp install --editor codex --global
```

### Start the Daemon

```bash
# Start with dashboard
agent-relay up

# Or just the daemon
agent-relay up --no-dashboard
```

### Verify It Works

Open Claude Code (or Cursor) and ask:
> "Use relay_who to see online agents"

You should see yourself listed!

## Available Tools

Once configured, AI agents have access to these tools:

### `relay_send` - Send Messages
```
relay_send(to="Alice", message="Hello!")           # Direct message
relay_send(to="#general", message="Team update")   # Channel message
relay_send(to="*", message="Announcement")         # Broadcast
relay_send(to="Worker", message="Do this", await_response=true)  # Wait for reply
```

### `relay_inbox` - Check Messages
```
relay_inbox()                        # Get unread messages
relay_inbox(from="Lead", limit=5)    # Filter by sender
relay_inbox(channel="#general")       # Filter by channel
```

### `relay_who` - List Agents
```
relay_who()                          # List all online agents
relay_who(include_idle=false)        # Only active agents
```

### `relay_spawn` - Create Workers
```
relay_spawn(name="TestRunner", cli="claude", task="Run the test suite")
relay_spawn(name="Reviewer", cli="codex", task="Review this PR", model="gpt-4")
```

### `relay_release` - Stop Workers
```
relay_release(name="TestRunner")
relay_release(name="TestRunner", reason="Tests completed")
```

### `relay_status` - Connection Info
```
relay_status()   # Shows: connected, agent name, project, daemon version
```

## Troubleshooting

### "Daemon not running" error

The relay daemon must be running for MCP tools to work:

```bash
# Check status
agent-relay status

# Start daemon
agent-relay up
```

### Tools not showing in editor

1. Restart your editor after installing MCP
2. Check the MCP configuration was created:
   - Claude Code: `~/.claude/settings.json` (global) or `.mcp.json` (project)
   - Cursor: `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project)
   - Codex: `~/.codex/config.toml` (global) or `codex.toml` (project)
   - VS Code: `~/.vscode/mcp.json` (global) or `.vscode/mcp.json` (project)
   - Gemini CLI: `~/.gemini/settings.json`
   - OpenCode: `~/.config/opencode/opencode.json`
   - Droid: `~/.factory/mcp.json`

### Check installation status

```bash
npx @agent-relay/mcp install --status
```

## CLI Reference

```bash
# Installation
npx @agent-relay/mcp install              # Auto-detect editors
npx @agent-relay/mcp install --editor X   # Specific editor
npx @agent-relay/mcp install --status     # Show status
npx @agent-relay/mcp install --list       # List supported editors
npx @agent-relay/mcp install --uninstall  # Remove configuration
npx @agent-relay/mcp install --dry-run    # Preview changes

# Server (used by editors)
npx @agent-relay/mcp serve
```

## Resources & Prompts

The MCP server provides:

**Resources** (live data):
- `relay://agents` - Online agents list
- `relay://inbox` - Your inbox contents
- `relay://project` - Project configuration

**Prompts** (documentation):
- `relay_protocol` - Full protocol documentation

## Environment Variables

| Variable | Description |
|----------|-------------|
| `RELAY_SOCKET` | Override daemon socket path |
| `RELAY_PROJECT` | Override project name |
| `RELAY_AGENT_NAME` | Override agent name |
| `DEBUG` or `RELAY_DEBUG` | Enable debug logging |

## Cloud Workspaces

In cloud environments (with `WORKSPACE_ID` set), MCP is pre-configured and uses workspace-specific sockets automatically.

## Programmatic Usage

Use relay tools directly in your code (no MCP protocol needed):

```typescript
import { createTools } from '@agent-relay/mcp';

const tools = createTools('MyAgent');

// Send messages
await tools.send('OtherAgent', 'Hello!');
await tools.send('#general', 'Channel message');
await tools.send('*', 'Broadcast');

// Check inbox
const messages = await tools.inbox();
for (const msg of messages) {
  console.log(`${msg.from}: ${msg.content}`);
}

// List online agents
const agents = await tools.who();

// Spawn workers
await tools.spawn({
  name: 'Worker1',
  cli: 'claude',
  task: 'Run tests',
});

// Release workers
await tools.release('Worker1');
```

### One-liners

```typescript
import { send, inbox, who } from '@agent-relay/mcp/simple';

await send('MyAgent', 'Bob', 'Hello!');
const messages = await inbox('MyAgent');
const agents = await who();
```

## Requirements

- Node.js 18+
- Agent Relay daemon running

## License

MIT
