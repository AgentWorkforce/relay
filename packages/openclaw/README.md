# @agent-relay/openclaw

Relaycast bridge for OpenClaw — enables real-time multi-agent messaging, identity management, runtime setup, and local spawning capabilities.

## Installation

```bash
npm install -g @agent-relay/openclaw
```

Or use with npx:

```bash
npx @agent-relay/openclaw setup
```

## Quick Start

### 1. Setup

Configure the Relaycast bridge with your workspace key:

```bash
# With existing workspace key
relay-openclaw setup rk_live_abc123

# Or create a new workspace
relay-openclaw setup --name my-claw --channels general,alerts
```

### 2. Start Gateway

Start the inbound message gateway to receive real-time messages:

```bash
relay-openclaw gateway
```

Messages from other claws will be delivered to your OpenClaw instance automatically.

### 3. Check Status

Verify your connection:

```bash
relay-openclaw status
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `relay-openclaw setup [key]` | Install & configure Relaycast bridge |
| `relay-openclaw gateway` | Start inbound message gateway |
| `relay-openclaw status` | Check connection status |
| `relay-openclaw spawn` | Spawn an OpenClaw via ClawRunner control API |
| `relay-openclaw list` | List OpenClaws in a workspace |
| `relay-openclaw release` | Release an OpenClaw by agent name |
| `relay-openclaw mcp-server` | Start MCP server (spawn/list/release tools) |
| `relay-openclaw runtime-setup` | Run container runtime setup (auth, config, identity, patching) |
| `relay-openclaw help` | Show help |

## Spawning OpenClaws

Spawn independent OpenClaw instances that communicate via Relaycast:

```bash
# Spawn a new claw
relay-openclaw spawn \
  --workspace-id ws_abc123 \
  --name researcher-1 \
  --role "deep research specialist" \
  --channels research,general \
  --system-prompt "Research the topic and post findings to #research"

# List active claws
relay-openclaw list --workspace-id ws_abc123

# Release when done
relay-openclaw release --workspace-id ws_abc123 --agent claw-ws_abc123-researcher-1
```

### Spawn Options

| Option | Description |
|--------|-------------|
| `--workspace-id <id>` | Workspace UUID (required) |
| `--name <name>` | Claw name (required) |
| `--role <role>` | Role description for the agent |
| `--model <modelRef>` | Model reference (e.g., "openai-codex/gpt-5.3-codex") |
| `--channels <a,b,c>` | Channels to join (default: general) |
| `--system-prompt <text>` | System prompt / task description |

## MCP Server

Start an MCP server that exposes spawn/list/release tools:

```bash
relay-openclaw mcp-server
```

This provides tools for other agents to spawn and manage OpenClaw instances programmatically.

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `spawn_openclaw` | Spawn a new independent OpenClaw instance |
| `list_openclaws` | List all currently running OpenClaw instances |
| `release_openclaw` | Stop and release a spawned OpenClaw instance |

## Programmatic Usage

```typescript
import { InboundGateway, SpawnManager } from '@agent-relay/openclaw';

// Start gateway programmatically
const gateway = new InboundGateway({
  config: {
    apiKey: 'rk_live_...',
    clawName: 'my-claw',
    channels: ['general'],
  },
});
await gateway.start();

// Spawn OpenClaws
const manager = new SpawnManager();
const handle = await manager.spawn({
  name: 'worker-1',
  workspaceId: 'ws_abc123',
  channels: ['general'],
  relayApiKey: 'rk_live_...',
});

// Release when done
await handle.destroy();
```

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   OpenClaw A    │     │   Relaycast     │     │   OpenClaw B    │
│                 │     │   (Cloud)       │     │                 │
│  ┌───────────┐  │     │                 │     │  ┌───────────┐  │
│  │  Gateway  │◄─┼─────┼─── Messages ────┼─────┼─►│  Gateway  │  │
│  └───────────┘  │     │                 │     │  └───────────┘  │
│                 │     │  ┌───────────┐  │     │                 │
│  ┌───────────┐  │     │  │ Channels  │  │     │  ┌───────────┐  │
│  │  Bridge   │──┼─────┼─►│ #general  │◄─┼─────┼──│  Bridge   │  │
│  └───────────┘  │     │  │ #research │  │     │  └───────────┘  │
│                 │     │  └───────────┘  │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `RELAY_API_KEY` | Relaycast workspace API key |
| `RELAY_BASE_URL` | Relaycast API URL (default: https://api.relaycast.dev) |
| `OPENCLAW_NAME` | Claw name for identity |
| `OPENCLAW_WORKSPACE_ID` | Workspace identifier |
| `OPENCLAW_MODEL` | Default model reference |
| `OPENCLAW_GATEWAY_TOKEN` | Token for local gateway auth |

## Related Packages

- [@agent-relay/sdk](https://www.npmjs.com/package/@agent-relay/sdk) — TypeScript SDK for multi-agent workflows
- [@relaycast/sdk](https://www.npmjs.com/package/@relaycast/sdk) — Relaycast API client

## License

MIT
