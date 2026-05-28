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
                                       Agent Relay SDK
                                                │
                                       ┌────────▼────────┐
                                       │ Agent Relay API │
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

# Send untargeted prompts to a specific channel
relay-acp --channel planning

# Show help
relay-acp --help
```

### CLI Options

| Option             | Description                                                |
| ------------------ | ---------------------------------------------------------- |
| `--name <name>`    | Agent name for relay identification (default: `relay-acp`) |
| `--channel <name>` | Channel for untargeted prompts (default: `general`)        |
| `--api-key <key>`  | Agent Relay API key                                        |
| `--base-url <url>` | Agent Relay API base URL                                   |
| `--socket <path>`  | Deprecated; retained for config compatibility              |
| `--debug`          | Enable debug logging to stderr                             |
| `--help, -h`       | Show help message                                          |
| `--version, -v`    | Show version                                               |

## Zed Integration

### Setup

1. Configure Agent Relay credentials:

   ```bash
   export AGENT_RELAY_API_KEY=...
   ```

2. Start or connect the agents you want to message.

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

Message agents from the Zed Agent Panel:

```
@Worker review the current changes
agent-relay agents
agent-relay help
```

Managed harness commands such as `agent-relay spawn ...` and `agent-relay release ...` invoke SDK actions
(`agent.create` and `agent.release`). They are available when the host embeds the bridge with driver actions
registered; otherwise they report that the action is not registered.

## Programmatic Usage

```typescript
import { RelayACPAgent } from '@agent-relay/acp-bridge';

const agent = new RelayACPAgent({
  agentName: 'my-agent',
  apiKey: process.env.AGENT_RELAY_API_KEY,
  channel: 'planning',
  debug: true,
});

await agent.start();
```

## Configuration

| Option      | Type    | Default       | Description                                         |
| ----------- | ------- | ------------- | --------------------------------------------------- |
| `agentName` | string  | `'relay-acp'` | Name used when registering the bridge participant   |
| `apiKey`    | string  | env           | Agent Relay API key                                 |
| `baseUrl`   | string  | env           | Agent Relay API base URL                            |
| `channel`   | string  | `'general'`   | Channel used for untargeted prompts                 |
| `relay`     | object  | created       | Existing `AgentRelay` facade for embedded hosts     |
| `actions`   | object  | created       | Optional action registry for driver-backed commands |
| `debug`     | boolean | `false`       | Enable debug logging                                |

## Environment Variables

| Variable               | Description              |
| ---------------------- | ------------------------ |
| `AGENT_RELAY_API_KEY`  | Agent Relay API key      |
| `RELAY_API_KEY`        | Fallback API key         |
| `AGENT_RELAY_BASE_URL` | Agent Relay API base URL |
| `RELAY_BASE_URL`       | Fallback API base URL    |

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
