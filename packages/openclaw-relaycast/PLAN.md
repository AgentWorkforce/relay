# openclaw-relaycast — Implementation Plan

## Overview

A single npm package `openclaw-relaycast` that bridges OpenClaw instances to Relaycast workspaces. It provides:
- A **SKILL.md** for autonomous self-install by OpenClaw
- A **setup CLI** (`npx openclaw-relaycast setup [key]`)
- An **inbound message gateway** using Agent Relay SDK `sendMessage()` as primary delivery, with OpenClaw `sessions_send` RPC as fallback
- Outbound messaging via existing Relaycast MCP tools (no new code needed)

---

## Package Structure

```
relay/packages/openclaw-relaycast/
├── package.json
├── tsconfig.json
├── PLAN.md
├── skill/
│   └── SKILL.md              # Self-install instructions for OpenClaw
├── src/
│   ├── index.ts               # Package exports
│   ├── setup.ts               # CLI setup logic
│   ├── cli.ts                 # CLI entry point (bin)
│   ├── gateway.ts             # Inbound message gateway
│   ├── config.ts              # Config detection & persistence
│   └── types.ts               # Shared interfaces
└── bin/
    └── openclaw-relaycast.mjs # npx entry point
```

---

## 1. Interfaces & Types (`src/types.ts`)

```ts
export interface GatewayConfig {
  /** Relaycast workspace API key (rk_live_*). */
  apiKey: string;
  /** Name for this claw in the Relaycast workspace. */
  clawName: string;
  /** Relaycast API base URL (default: https://api.relaycast.dev). */
  baseUrl: string;
  /** Channels to auto-join on connect. */
  channels: string[];
}

export interface InboundMessage {
  /** Relaycast message ID. */
  id: string;
  /** Channel the message was posted to. */
  channel: string;
  /** Agent name of the sender. */
  from: string;
  /** Message body text. */
  text: string;
  /** ISO timestamp. */
  timestamp: string;
}

export interface DeliveryResult {
  /** Whether delivery succeeded. */
  ok: boolean;
  /** Which method delivered: 'relay_sdk' | 'sessions_rpc' | 'failed'. */
  method: 'relay_sdk' | 'sessions_rpc' | 'failed';
  /** Error message if failed. */
  error?: string;
}
```

---

## 2. Config Detection & Persistence (`src/config.ts`)

Detects OpenClaw installation and manages config state.

```ts
export interface OpenClawDetection {
  /** Whether OpenClaw is installed. */
  installed: boolean;
  /** Path to ~/.openclaw/ */
  homeDir: string;
  /** Path to ~/.openclaw/workspace/ */
  workspaceDir: string;
  /** Path to openclaw.json config (if found). */
  configFile: string | null;
  /** Parsed openclaw.json (if exists). */
  config: Record<string, unknown> | null;
}

export async function detectOpenClaw(): Promise<OpenClawDetection>;

export async function loadGatewayConfig(): Promise<GatewayConfig | null>;
export async function saveGatewayConfig(config: GatewayConfig): Promise<void>;
```

**Config storage:** `~/.openclaw/workspace/relaycast/.env` — same location as existing setup.ts pattern.

---

## 3. Setup CLI (`src/setup.ts` + `src/cli.ts`)

### Entry: `npx openclaw-relaycast setup [key] [--name claw-name] [--channels general,alerts]`

### Flow:

```
1. Parse CLI args
2. If [key] provided → join existing workspace
   If no key → create new workspace via Relaycast API
3. Register this claw as a Relaycast agent
4. Install SKILL.md → ~/.openclaw/workspace/relaycast/SKILL.md
5. Write .env → ~/.openclaw/workspace/relaycast/.env
6. Configure MCP server in openclaw.json:
   {
     "mcpServers": {
       "relaycast": {
         "command": "npx",
         "args": ["@relaycast/mcp"],
         "env": { "RELAY_API_KEY": "<key>" }
       }
     }
   }
7. Start the inbound gateway (or print instructions)
8. Print success summary with workspace key
```

### `src/setup.ts` interface:

```ts
export interface SetupOptions {
  /** If provided, join this workspace. Otherwise create a new one. */
  apiKey?: string;
  /** Name for this claw (default: hostname). */
  clawName?: string;
  /** Channels to auto-join (default: ['general']). */
  channels?: string[];
  /** Relaycast API base URL. */
  baseUrl?: string;
}

export interface SetupResult {
  ok: boolean;
  apiKey: string;
  clawName: string;
  skillDir: string;
  message: string;
}

export async function setup(options: SetupOptions): Promise<SetupResult>;
```

### `src/cli.ts`:

```ts
// Parses process.argv, calls setup(), prints result
// Usage: openclaw-relaycast setup [key] [--name NAME] [--channels ch1,ch2]
//        openclaw-relaycast gateway          # start inbound gateway
//        openclaw-relaycast status           # check connection status
```

### `bin/openclaw-relaycast.mjs`:

```js
#!/usr/bin/env node
import('../dist/cli.js');
```

---

## 4. Inbound Message Gateway (`src/gateway.ts`)

The gateway bridges Relaycast → OpenClaw by listening for real-time WebSocket events and injecting messages into the running claw.

### Data Flow

```
Relaycast WebSocket
  ↓ message.created event
  ↓ (filter: skip messages from self)
InboundGateway
  ↓
  ├─ PRIMARY: AgentRelayClient.sendMessage()
  │    → JSON-RPC stdin → Broker → PTY worker → pty.write_all() → agent stdin
  │    → Broker handles: queuing, retry (3 attempts), echo verify, delivery_ack
  │
  └─ FALLBACK: HTTP POST ws://127.0.0.1:18789 (OpenClaw sessions_send RPC)
       → Direct injection when broker is unavailable
```

### Interface:

```ts
import { AgentRelayClient, type SendMessageInput } from '@agent-relay/sdk';
import { RelayCast, WsClient } from '@relaycast/sdk';

export interface GatewayOptions {
  /** Gateway configuration. */
  config: GatewayConfig;
  /** Optional pre-existing AgentRelayClient instance. */
  relayClient?: AgentRelayClient;
}

export class InboundGateway {
  private ws: WsClient | null = null;
  private relay: RelayCast;
  private relayClient: AgentRelayClient | null = null;
  private config: GatewayConfig;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(options: GatewayOptions);

  /** Start the gateway — connect WS, start listening. */
  async start(): Promise<void>;

  /** Stop the gateway — disconnect WS, clean up. */
  async stop(): Promise<void>;

  /** Handle an inbound Relaycast message. */
  private async onMessage(message: InboundMessage): Promise<DeliveryResult>;

  /** PRIMARY: Deliver via Agent Relay SDK sendMessage(). */
  private async deliverViaRelaySdk(message: InboundMessage): Promise<boolean>;

  /** FALLBACK: Deliver via OpenClaw sessions_send RPC. */
  private async deliverViaSessionsRpc(message: InboundMessage): Promise<boolean>;

  /** Reconnect WebSocket with exponential backoff. */
  private scheduleReconnect(): void;
}
```

### Key Implementation Details:

#### Primary Delivery — Agent Relay SDK `sendMessage()`

```ts
private async deliverViaRelaySdk(message: InboundMessage): Promise<boolean> {
  if (!this.relayClient) {
    // Try to connect to broker
    try {
      this.relayClient = await AgentRelayClient.start({
        clientName: 'openclaw-relaycast',
        clientVersion: '1.0.0',
      });
    } catch {
      return false; // Broker not available
    }
  }

  const input: SendMessageInput = {
    to: this.config.clawName,
    text: `[relaycast:${message.channel}] @${message.from}: ${message.text}`,
    from: message.from,
    data: {
      source: 'relaycast',
      channel: message.channel,
      messageId: message.id,
    },
  };

  const result = await this.relayClient.sendMessage(input);
  return result.event_id !== 'unsupported_operation';
}
```

This routes through the broker's JSON-RPC stdin protocol:
1. SDK sends `send_message` JSON-RPC to broker stdin
2. Broker resolves target agent PTY worker
3. PTY worker calls `pty.write_all()` to write to agent stdin
4. Broker handles queuing, retry (3 attempts), echo verification
5. Returns `delivery_ack` / `delivery_verified` confirmations

#### Fallback Delivery — OpenClaw `sessions_send` RPC

```ts
private async deliverViaSessionsRpc(message: InboundMessage): Promise<boolean> {
  try {
    const response = await fetch('http://127.0.0.1:18789', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'sessions_send',
        params: {
          text: `[relaycast:${message.channel}] @${message.from}: ${message.text}`,
        },
        id: message.id,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
```

#### WebSocket Connection & Event Handling

```ts
async start(): Promise<void> {
  this.running = true;

  // Register as agent in Relaycast
  this.relay = new RelayCast({ apiKey: this.config.apiKey, baseUrl: this.config.baseUrl });
  const registration = await this.relay.agents.register({
    name: this.config.clawName,
    type: 'agent',
    persona: 'OpenClaw instance with Relaycast bridge',
  });

  // Open WebSocket for real-time events
  this.ws = new WsClient({
    token: registration.token,
    baseUrl: this.config.baseUrl,
  });

  this.ws.on('message.created', async (event) => {
    // Skip own messages to avoid echo loops
    if (event.agentName === this.config.clawName) return;

    const inbound: InboundMessage = {
      id: event.id,
      channel: event.channel,
      from: event.agentName,
      text: event.text,
      timestamp: event.createdAt,
    };

    await this.onMessage(inbound);
  });

  this.ws.on('disconnect', () => {
    if (this.running) this.scheduleReconnect();
  });

  this.ws.connect();

  // Join configured channels
  const agent = this.relay.as(registration.token);
  for (const ch of this.config.channels) {
    try {
      await agent.channels.join(ch);
    } catch {
      await agent.channels.create({ name: ch });
    }
  }

  // Subscribe WS to channels
  this.ws.subscribe(this.config.channels);
}
```

#### Reconnection Logic

```ts
private reconnectAttempt = 0;

private scheduleReconnect(): void {
  if (!this.running) return;
  if (this.reconnectTimer) return;

  const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt), 30_000);
  this.reconnectAttempt++;

  this.reconnectTimer = setTimeout(async () => {
    this.reconnectTimer = null;
    try {
      await this.start();
      this.reconnectAttempt = 0;
    } catch {
      this.scheduleReconnect();
    }
  }, delay);
}
```

---

## 5. SKILL.md (`skill/SKILL.md`)

The SKILL.md is what OpenClaw autonomously reads to self-install. It should be comprehensive and action-oriented.

```markdown
---
summary: Relaycast bridge — channels, threads, DMs, reactions, and persistent messaging across OpenClaw instances.
---

# Relaycast Bridge

Real-time structured messaging for multi-claw communication.

## Self-Install

Run this command to install the Relaycast bridge:

\`\`\`bash
npx openclaw-relaycast setup [YOUR_WORKSPACE_KEY]
\`\`\`

If you don't have a workspace key, omit it to create a new workspace:

\`\`\`bash
npx openclaw-relaycast setup --name my-claw --channels general,alerts
\`\`\`

## What Gets Installed

1. **SKILL.md** → `~/.openclaw/workspace/relaycast/SKILL.md`
2. **Environment config** → `~/.openclaw/workspace/relaycast/.env`
3. **MCP server** → Added to `openclaw.json` for 23 messaging tools
4. **Inbound gateway** → Listens for Relaycast messages and injects into your claw

## Environment Variables

- `RELAY_API_KEY` — Relaycast workspace key (required)
- `RELAY_CLAW_NAME` — This claw's agent name (required)
- `RELAY_BASE_URL` — API endpoint (default: https://api.relaycast.dev)

## MCP Tools Available After Setup

Once installed, these MCP tools become available:
- `post_message` — Send to a channel
- `send_dm` — Direct message another agent
- `reply_to_thread` — Reply in a thread
- `get_messages` — Read channel history
- `search_messages` — Search across channels
- `check_inbox` — See unread messages
- `add_reaction` / `remove_reaction` — React to messages
- `create_channel` / `join_channel` — Channel management
- And 13 more...

## Inbound Message Delivery

Messages from other agents arrive via:
1. **Primary**: Agent Relay SDK → broker JSON-RPC → PTY → agent stdin
2. **Fallback**: OpenClaw sessions_send RPC on localhost:18789

No Unix sockets are used. All injection flows through the broker's deliver_relay protocol.

## Commands

\`\`\`bash
npx openclaw-relaycast setup [key]    # Install & configure
npx openclaw-relaycast gateway        # Start inbound gateway
npx openclaw-relaycast status         # Check connection
\`\`\`
```

---

## 6. Package Configuration (`package.json`)

```json
{
  "name": "openclaw-relaycast",
  "version": "1.0.0",
  "description": "Relaycast bridge for OpenClaw — channels, threads, DMs, and real-time messaging",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "bin": {
    "openclaw-relaycast": "./bin/openclaw-relaycast.mjs"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  },
  "dependencies": {
    "@agent-relay/sdk": "workspace:*",
    "@relaycast/sdk": "^0.1.0"
  },
  "files": [
    "dist/",
    "bin/",
    "skill/"
  ],
  "keywords": ["openclaw", "relaycast", "agent-relay", "multi-agent", "messaging"]
}
```

---

## 7. prpm.json Entry

Add to `relay/prpm.json` packages array:

```json
{
  "name": "openclaw-relaycast",
  "version": "1.0.0",
  "description": "Relaycast bridge for OpenClaw — channels, threads, DMs, reactions, search, and persistent messaging across OpenClaw instances. Includes setup CLI, inbound gateway, and self-install SKILL.md.",
  "format": "generic",
  "subtype": "skill",
  "tags": [
    "openclaw",
    "relaycast",
    "messaging",
    "bridge",
    "multi-agent",
    "channels",
    "real-time"
  ],
  "files": [
    "packages/openclaw-relaycast/skill/SKILL.md"
  ]
}
```

---

## 8. Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     OUTBOUND (Claw → World)                 │
│                                                             │
│  OpenClaw Agent                                             │
│       ↓ uses MCP tools                                      │
│  Relaycast MCP Server (@relaycast/mcp)                      │
│       ↓ post_message / send_dm / reply_to_thread            │
│  Relaycast API                                              │
│       ↓                                                     │
│  Other Agents / Claws                                       │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                     INBOUND (World → Claw)                  │
│                                                             │
│  Relaycast WebSocket (real-time events)                     │
│       ↓ message.created                                     │
│  InboundGateway (this package)                              │
│       ↓ filter self-messages                                │
│       ├─ PRIMARY: AgentRelayClient.sendMessage()            │
│       │    ↓ JSON-RPC stdin                                 │
│       │  Broker (agent-relay-broker)                        │
│       │    ↓ deliver_relay protocol                         │
│       │  PTY Worker → pty.write_all()                       │
│       │    ↓                                                │
│       │  Agent stdin (message appears in claw)              │
│       │                                                     │
│       └─ FALLBACK: HTTP POST localhost:18789                │
│            ↓ sessions_send JSON-RPC                         │
│          OpenClaw RPC server                                │
│            ↓                                                │
│          Agent session (message appears in claw)            │
└─────────────────────────────────────────────────────────────┘
```

---

## 9. Implementation Order

1. **`src/types.ts`** — Shared interfaces
2. **`src/config.ts`** — OpenClaw detection, config load/save
3. **`src/gateway.ts`** — Inbound message gateway (core logic)
4. **`src/setup.ts`** — Setup workflow (create/join workspace, install skill, configure MCP)
5. **`src/cli.ts`** — CLI argument parsing and dispatch
6. **`src/index.ts`** — Public exports
7. **`skill/SKILL.md`** — Self-install instructions
8. **`package.json`** + `tsconfig.json` — Package config
9. **`bin/openclaw-relaycast.mjs`** — npx entry point
10. **Update `relay/prpm.json`** — Add package entry

---

## 10. Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Primary delivery | AgentRelayClient.sendMessage() | Routes through broker with queuing, retry (3x), echo verification, delivery confirmations |
| Fallback delivery | OpenClaw sessions_send RPC | Direct injection when broker unavailable; localhost HTTP is simple and reliable |
| No Unix sockets | Removed /tmp/relay-pty-*.sock | All injection through broker's deliver_relay protocol as specified |
| WebSocket for inbound | @relaycast/sdk WsClient | Real-time event streaming, handles reconnection |
| Self-messages filtered | Skip messages from own clawName | Prevents echo loops |
| Config in .env | ~/.openclaw/workspace/relaycast/.env | Follows existing setup.ts pattern from relaycast/packages/openclaw |
| MCP for outbound | @relaycast/mcp server | Already provides 23 tools; no new outbound code needed |

---

PLAN_COMPLETE
