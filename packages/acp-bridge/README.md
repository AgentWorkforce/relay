# @agent-relay/acp-bridge

ACP (Agent Client Protocol) bridge for Agent Relay. Exposes relay agents to ACP-compatible editors like [Zed](https://zed.dev).

## What is ACP?

The [Agent Client Protocol (ACP)](https://agentclientprotocol.com) is an open standard that enables AI agents to integrate with code editors. It's like LSP (Language Server Protocol) but for AI coding agents.

## What does this bridge do?

This bridge allows ACP-compatible editors to communicate with Agent Relay agents:

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

## Usage

### CLI

```bash
# Start the bridge
relay-acp --name my-agent --debug

# With custom socket path
relay-acp --socket /tmp/relay/my-workspace/sockets/relay.sock
```

### With Zed Editor

1. Start the relay broker:
   ```bash
   agent-relay up
   ```

2. Start some relay agents:
   ```bash
   relay spawn Worker1 claude "Help with coding tasks"
   ```

3. Configure Zed to use the bridge. Add to your Zed settings:
   ```json
   {
     "agent": {
       "custom_agents": [
         {
            "name": "Agent Relay",
            "command": "relay-acp",
            "args": ["--name", "zed-bridge"]
         }
       ]
     }
   }
   ```

4. Open the Agent Panel in Zed (`Cmd+?` on macOS) and select "Agent Relay"

Or let the CLI configure Zed for you (writes `agent_servers` with the correct socket path):

```bash
agent-relay up --zed
```

This adds an entry similar to:

```json
{
  "agent_servers": {
    "Agent Relay": {
      "type": "custom",
      "command": "relay-acp",
      "args": ["--name", "zed-bridge", "--socket", "/path/to/project/.agent-relay/relay.sock"]
    }
  }
}
```

### Programmatic Usage

```typescript
import { RelayACPAgent } from '@agent-relay/acp-bridge';

const agent = new RelayACPAgent({
  agentName: 'my-agent',
  socketPath: '/tmp/relay.sock',
  debug: true,
  capabilities: {
    supportsSessionLoading: false,
    modes: [
      { slug: 'default', name: 'Default', description: 'Standard mode' },
      { slug: 'review', name: 'Code Review', description: 'Focus on code review' },
    ],
  },
});

await agent.start();
```

### Relay CLI commands from the Agent Panel

The bridge intercepts basic `agent-relay` commands typed in the Zed Agent Panel, so you can manage agents without a shell:

- `agent-relay spawn Worker claude "Review the current changes"`
- `agent-relay release Worker`
- `agent-relay agents` (list connected agents)

Supported commands today: spawn/create-agent, release, agents/who. Others fall back to normal broadcast handling.
The panel shows a help block on first message; type `agent-relay help` anytime to see it again.

## How it Works

1. **Initialization**: When an editor connects, the bridge advertises its capabilities
2. **Session Creation**: Each conversation creates a new session
3. **Prompt Handling**: User prompts are broadcast to all relay agents
4. **Response Streaming**: Agent responses are streamed back to the editor

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `agentName` | string | `'relay-acp'` | Name used when connecting to relay broker |
| `socketPath` | string | auto | Path to relay broker socket |
| `debug` | boolean | `false` | Enable debug logging |
| `capabilities` | object | - | ACP capabilities to advertise |

Connections to the broker go through `@agent-relay/sdk`, so socket discovery and reconnection match the rest of the Relay tooling. Provide `socketPath` to override detection when needed.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `WORKSPACE_ID` | Used to determine default socket path |

## ACP Compatibility

This bridge implements ACP version `2025-03-26` and supports:

- Session management (new sessions)
- Prompt handling with streaming responses
- Cancellation

Not yet supported:
- Session loading/resumption
- Tool calls
- File operations via ACP (use relay agents directly)

## License

Apache-2.0
