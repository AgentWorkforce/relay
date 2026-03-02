# @agent-relay/acp-bridge

ACP (Agent Client Protocol) bridge for Agent Relay. Exposes relay agents to ACP-compatible editors like [Zed](https://zed.dev).

## What is ACP?

The [Agent Client Protocol (ACP)](https://agentclientprotocol.com) is an open standard that enables AI agents to integrate with code editors. It's like LSP (Language Server Protocol) but for AI coding agents.

## Architecture

```
┌─────────────────┐     ACP (stdio)    ┌─────────────────┐
│   Zed Editor    │ ◄────────────────► │  relay-acp      │
│   (or other)    │   JSON-RPC 2.0     │  (this bridge)  │
└─────────────────┘                    └────────┬────────┘
                                                │
                                       Relay Protocol
                                                │
                                       ┌────────▼────────┐
                                       │  Relay Broker   │
                                       └────────┬────────┘
                                                │
                        ┌───────────────────────┼───────────────────────┐
                        │                       │                       │
                ┌───────▼───────┐       ┌───────▼───────┐       ┌───────▼───────┐
                │   Agent 1     │       │   Agent 2     │       │   Agent N     │
                │ (Claude Code) │       │ (Codex CLI)   │       │ (any CLI)     │
                └───────────────┘       └───────────────┘       └───────────────┘
```

## Installation

```bash
npm install @agent-relay/acp-bridge
```

## CLI Usage

```bash
# Start the bridge
relay-acp --name my-agent --debug

# With custom socket path
relay-acp --socket /path/to/.agent-relay/relay.sock

# Show help
relay-acp --help
```

### CLI Options

| Option | Description |
|--------|-------------|
| `--name <name>` | Agent name for relay identification (default: `relay-acp`) |
| `--socket <path>` | Path to relay broker socket |
| `--debug` | Enable debug logging to stderr |
| `--help, -h` | Show help message |
| `--version, -v` | Show version |

## Zed Integration

### Quick Setup

Let the CLI configure Zed automatically:

```bash
agent-relay up --zed
```

This adds an `agent_servers` entry to your Zed settings with the correct socket path.

### Manual Setup

1. Start the relay broker:
   ```bash
   agent-relay up
   ```

2. Spawn relay agents:
   ```bash
   agent-relay spawn Worker1 claude "Help with coding tasks"
   ```

3. Add to Zed settings (`~/.config/zed/settings.json`):
   ```json
   {
     "agent_servers": {
       "Agent Relay": {
         "type": "custom",
         "command": "relay-acp",
         "args": ["--name", "zed-bridge"]
       }
     }
   }
   ```

4. Open the Agent Panel in Zed (`Cmd+?` on macOS) and select "Agent Relay"

### In-Panel Commands

Manage agents directly from the Zed Agent Panel:

```
agent-relay spawn Worker claude "Review the current changes"
agent-relay release Worker
agent-relay agents
agent-relay help
```

## Programmatic Usage

```typescript
import { RelayACPAgent } from '@agent-relay/acp-bridge';

const agent = new RelayACPAgent({
  agentName: 'my-agent',
  socketPath: '/tmp/relay.sock',
  debug: true,
});

await agent.start();
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `agentName` | string | `'relay-acp'` | Name used when connecting to relay broker |
| `socketPath` | string | auto | Path to relay broker socket |
| `debug` | boolean | `false` | Enable debug logging |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `WORKSPACE_ID` | Used to determine default socket path |

## ACP Compatibility

Implements ACP version `2025-03-26`:

**Supported:**
- Session management (new sessions)
- Prompt handling with streaming responses
- Cancellation

**Not yet supported:**
- Session loading/resumption
- Tool calls
- File operations via ACP

## License

Apache-2.0
