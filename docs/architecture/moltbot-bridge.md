# Moltbot Bridge Architecture

> Integration design for connecting Agent Relay with Moltbot's Gateway

## Overview

This document describes the architecture for bridging Agent Relay's agent-to-agent messaging system with Moltbot's multi-channel assistant platform. The integration enables:

1. **Relay agents → Moltbot channels**: Send messages to WhatsApp, Telegram, Slack, Discord, etc.
2. **Moltbot → Relay agents**: Route incoming messages to specialized AI agents
3. **Session bridging**: Connect Moltbot sessions with Relay agent teams
4. **Skill integration**: Expose Relay as a Moltbot skill for agent orchestration
5. **Cloud orchestration**: Manage Moltbot-connected agents via relay-cloud

## System Context (Local Mode)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            User Ecosystem                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                 │
│  │  WhatsApp   │    │  Telegram   │    │   Slack     │  ... more       │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘                 │
│         │                  │                  │                         │
│         └──────────────────┼──────────────────┘                         │
│                            ▼                                            │
│              ┌─────────────────────────────┐                           │
│              │     Moltbot Gateway         │                           │
│              │   ws://127.0.0.1:18789      │                           │
│              └─────────────┬───────────────┘                           │
│                            │                                            │
│                            ▼                                            │
│              ┌─────────────────────────────┐                           │
│              │   @agent-relay/moltbot      │  ◄── NEW PACKAGE          │
│              │      Bridge Service         │                           │
│              └─────────────┬───────────────┘                           │
│                            │                                            │
│                            ▼                                            │
│              ┌─────────────────────────────┐                           │
│              │   Agent Relay Daemon        │                           │
│              │   (Unix Socket)             │                           │
│              └─────────────┬───────────────┘                           │
│                            │                                            │
│         ┌──────────────────┼──────────────────┐                        │
│         ▼                  ▼                  ▼                         │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                 │
│  │   Lead      │    │   Worker    │    │   Worker    │                 │
│  │   Agent     │    │   Agent     │    │   Agent     │                 │
│  └─────────────┘    └─────────────┘    └─────────────┘                 │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## System Context (Cloud Mode)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                                  Cloud Infrastructure                                 │
├──────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                      │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                              │
│  │  WhatsApp   │    │  Telegram   │    │   Slack     │  ... more                    │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘                              │
│         │                  │                  │                                      │
│         └──────────────────┼──────────────────┘                                      │
│                            ▼                                                         │
│              ┌─────────────────────────────┐                                        │
│              │     Moltbot Gateway         │  (User's machine or cloud)             │
│              └─────────────┬───────────────┘                                        │
│                            │                                                         │
│         ┌──────────────────┴──────────────────┐                                     │
│         ▼                                     ▼                                      │
│  ┌─────────────────────┐           ┌─────────────────────────────────┐              │
│  │  Local Bridge       │           │       relay-cloud               │              │
│  │  (optional)         │           │   api.agent-relay.com           │              │
│  └─────────┬───────────┘           └───────────────┬─────────────────┘              │
│            │                                       │                                 │
│            │              ┌────────────────────────┼────────────────────────┐       │
│            │              │                        │                        │       │
│            ▼              ▼                        ▼                        ▼       │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐│
│  │ Linked Daemon   │  │ Cloud Workspace │  │ Cloud Workspace │  │ Linked Daemon   ││
│  │ (Alice laptop)  │  │ (Fly.io)        │  │ (Railway)       │  │ (Bob desktop)   ││
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘│
│           │                    │                    │                    │          │
│           ▼                    ▼                    ▼                    ▼          │
│       [Agents]             [Agents]             [Agents]             [Agents]       │
│                                                                                      │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

## Architecture Layers

### Layer 1: Transport Adapter

Connects to Moltbot's WebSocket gateway and translates between WebSocket frames and internal events.

```typescript
// packages/moltbot/src/transport.ts

interface MoltbotTransport {
  connect(url: string): Promise<void>;
  disconnect(): Promise<void>;
  send(message: MoltbotMessage): void;
  onMessage: (handler: (msg: MoltbotMessage) => void) => void;
  onSessionEvent: (handler: (event: SessionEvent) => void) => void;
}

interface MoltbotMessage {
  type: 'tool_call' | 'tool_result' | 'message' | 'event';
  sessionId: string;
  channel?: string;  // 'whatsapp', 'telegram', 'slack', etc.
  content: unknown;
  metadata?: Record<string, unknown>;
}

interface SessionEvent {
  type: 'session_start' | 'session_end' | 'session_list';
  sessionId: string;
  metadata?: Record<string, unknown>;
}
```

### Layer 2: Protocol Translator

Maps between Moltbot's message format and Agent Relay's envelope protocol.

```typescript
// packages/moltbot/src/translator.ts

interface ProtocolTranslator {
  // Moltbot → Relay
  toRelayEnvelope(msg: MoltbotMessage): Envelope<SendPayload>;

  // Relay → Moltbot
  toMoltbotMessage(envelope: DeliverEnvelope): MoltbotMessage;

  // Session mapping
  mapSessionToAgent(sessionId: string): string;
  mapAgentToSession(agentName: string): string | null;
}

// Translation mappings
const CHANNEL_MAPPINGS = {
  // Moltbot channel → Relay channel naming
  'whatsapp': '#moltbot-whatsapp',
  'telegram': '#moltbot-telegram',
  'slack': '#moltbot-slack',
  'discord': '#moltbot-discord',
  'webchat': '#moltbot-web',
} as const;
```

### Layer 3: Session Manager

Manages the relationship between Moltbot sessions and Relay agents.

```typescript
// packages/moltbot/src/session-manager.ts

interface SessionManager {
  // Session lifecycle
  createSession(sessionId: string, config: SessionConfig): Promise<void>;
  endSession(sessionId: string): Promise<void>;

  // Agent assignment
  assignAgent(sessionId: string, agentName: string): void;
  getAssignedAgent(sessionId: string): string | null;

  // Session queries (maps to Moltbot's sessions_* tools)
  listSessions(): Promise<SessionInfo[]>;
  getSessionHistory(sessionId: string): Promise<Message[]>;
  sendToSession(sessionId: string, message: string): Promise<void>;
}

interface SessionConfig {
  channel: string;
  userId?: string;
  metadata?: Record<string, unknown>;
  // Auto-spawn a dedicated agent for this session?
  autoSpawnAgent?: boolean;
  agentCli?: string;  // 'claude', 'codex', etc.
}
```

### Layer 4: Bridge Service

The main orchestration layer that ties everything together.

```typescript
// packages/moltbot/src/bridge.ts

interface MoltbotBridge {
  // Lifecycle
  start(config: BridgeConfig): Promise<void>;
  stop(): Promise<void>;

  // Status
  getStatus(): BridgeStatus;
  getConnectedSessions(): SessionInfo[];

  // Manual routing (for custom logic)
  routeToAgent(sessionId: string, agentName: string, message: string): Promise<void>;
  routeToSession(agentName: string, sessionId: string, message: string): Promise<void>;

  // Events
  onSessionStart: (handler: (session: SessionInfo) => void) => void;
  onSessionEnd: (handler: (sessionId: string) => void) => void;
}

interface BridgeConfig {
  // Moltbot connection
  moltbot: {
    gatewayUrl: string;  // ws://127.0.0.1:18789
    authToken?: string;
  };

  // Relay connection
  relay: {
    socketPath?: string;  // Auto-discovered if not set
    agentName: string;    // Bridge's identity in Relay
  };

  // Routing configuration
  routing: {
    // Default agent to handle incoming messages
    defaultAgent?: string;

    // Channel-specific routing
    channelRouting?: Record<string, string>;  // channel → agentName

    // Auto-spawn agents for new sessions
    autoSpawn?: {
      enabled: boolean;
      cli: string;
      namePrefix: string;
      maxAgents?: number;
    };
  };

  // Channels to bridge (empty = all)
  channels?: string[];
}
```

## Message Flow Diagrams

### Flow 1: Incoming Message (Moltbot → Relay)

```
User sends WhatsApp message
         │
         ▼
┌─────────────────────┐
│  Moltbot Gateway    │
│  (receives message) │
└──────────┬──────────┘
           │ WebSocket frame
           ▼
┌─────────────────────┐
│  Transport Adapter  │
│  (parse WS frame)   │
└──────────┬──────────┘
           │ MoltbotMessage
           ▼
┌─────────────────────┐
│  Protocol Translator│
│  (convert format)   │
└──────────┬──────────┘
           │ Envelope<SendPayload>
           ▼
┌─────────────────────┐
│  Session Manager    │
│  (resolve agent)    │
└──────────┬──────────┘
           │ agentName
           ▼
┌─────────────────────┐
│  Relay Daemon       │
│  (route to agent)   │
└──────────┬──────────┘
           │ DELIVER
           ▼
┌─────────────────────┐
│  Target Agent       │
│  (process message)  │
└─────────────────────┘
```

### Flow 2: Outgoing Message (Relay → Moltbot)

```
Agent sends ->relay:#moltbot-whatsapp Hello!
         │
         ▼
┌─────────────────────┐
│  Relay Daemon       │
│  (channel message)  │
└──────────┬──────────┘
           │ CHANNEL_MESSAGE
           ▼
┌─────────────────────┐
│  Bridge Service     │
│  (intercept)        │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  Session Manager    │
│  (resolve session)  │
└──────────┬──────────┘
           │ sessionId
           ▼
┌─────────────────────┐
│  Protocol Translator│
│  (convert format)   │
└──────────┬──────────┘
           │ MoltbotMessage
           ▼
┌─────────────────────┐
│  Transport Adapter  │
│  (send WS frame)    │
└──────────┬──────────┘
           │ WebSocket
           ▼
┌─────────────────────┐
│  Moltbot Gateway    │
│  (route to channel) │
└──────────┬──────────┘
           │
           ▼
    User receives WhatsApp message
```

### Flow 3: Cross-Session Communication

```
Agent A wants to message Moltbot Session X
         │
         ▼
Agent A: ->relay:MoltbotBridge [session:xyz] Check status
         │
         ▼
┌─────────────────────┐
│  Bridge Service     │
│  (parse directive)  │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  sessions_send      │
│  (Moltbot tool)     │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  Moltbot Session X  │
│  (receives message) │
└─────────────────────┘
```

## Moltbot Skill Integration

Expose Agent Relay as a Moltbot skill, allowing natural language orchestration.

### Skill Definition

```yaml
# ~/clawd/skills/agent-relay/skill.yaml
name: agent-relay
version: 1.0.0
description: Orchestrate AI agent teams via Agent Relay
author: AgentWorkforce

tools:
  - name: relay_spawn
    description: Spawn a new AI agent to work on a task
    parameters:
      name: Agent name
      task: Task description
      cli: CLI to use (claude, codex, gemini)

  - name: relay_send
    description: Send a message to an agent
    parameters:
      to: Target agent name
      message: Message content

  - name: relay_team
    description: Get status of the agent team

  - name: relay_broadcast
    description: Send message to all agents
    parameters:
      message: Message content
```

### Skill Implementation

```typescript
// ~/clawd/skills/agent-relay/index.ts

import { createTools } from '@agent-relay/mcp';

export const tools = createTools({
  projectRoot: process.cwd(),
});

export async function handleToolCall(name: string, params: unknown) {
  switch (name) {
    case 'relay_spawn':
      return tools.spawn(params as SpawnParams);
    case 'relay_send':
      return tools.send(params as SendParams);
    case 'relay_team':
      return tools.who();
    case 'relay_broadcast':
      return tools.send({ to: '*', ...(params as SendParams) });
  }
}
```

### Usage in Moltbot

```
User (WhatsApp): "I need help refactoring my authentication code"

Moltbot: "I'll assemble a team to help. Let me spawn some specialists."
         [Uses relay_spawn: {name: "Architect", task: "Review auth architecture"}]
         [Uses relay_spawn: {name: "SecurityExpert", task: "Audit auth security"}]
         [Uses relay_spawn: {name: "Implementer", task: "Execute refactoring"}]

         "I've assembled a team:
          - Architect: Reviewing your auth architecture
          - SecurityExpert: Auditing for vulnerabilities
          - Implementer: Ready to execute changes

          The team is analyzing your code now. I'll update you with findings."
```

## MCP Integration Strategy

Both Moltbot and Agent Relay support MCP. We can create a unified MCP server.

### Shared MCP Server

```typescript
// packages/moltbot/src/mcp-server.ts

import { createMCPServer as createRelayMCP } from '@agent-relay/mcp';

export function createUnifiedMCPServer(config: UnifiedConfig) {
  const server = createRelayMCP(config.relay);

  // Add Moltbot-specific tools
  server.addTool({
    name: 'moltbot_send_channel',
    description: 'Send message to a Moltbot channel (WhatsApp, Telegram, etc.)',
    schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', enum: ['whatsapp', 'telegram', 'slack', 'discord'] },
        message: { type: 'string' },
        sessionId: { type: 'string' },
      },
      required: ['channel', 'message'],
    },
    handler: async (params) => {
      const bridge = getBridgeInstance();
      return bridge.routeToChannel(params.channel, params.message, params.sessionId);
    },
  });

  server.addTool({
    name: 'moltbot_list_sessions',
    description: 'List active Moltbot sessions across all channels',
    handler: async () => {
      const bridge = getBridgeInstance();
      return bridge.sessionManager.listSessions();
    },
  });

  return server;
}
```

## Configuration Schema

### Bridge Configuration File

```typescript
// .agent-relay/moltbot.json

interface MoltbotBridgeConfig {
  /** Moltbot Gateway URL */
  gateway: string;

  /** Authentication (if required) */
  auth?: {
    type: 'token' | 'oauth';
    token?: string;
    oauthProvider?: 'anthropic' | 'openai';
  };

  /** Channel configuration */
  channels: {
    /** Channels to bridge (empty = all) */
    enabled?: string[];

    /** Channel-specific routing */
    routing?: Record<string, {
      /** Default agent for this channel */
      defaultAgent?: string;
      /** Auto-spawn config */
      autoSpawn?: boolean;
      /** Prefix for auto-spawned agents */
      agentPrefix?: string;
    }>;
  };

  /** Agent spawn defaults */
  agents: {
    /** Default CLI for spawned agents */
    defaultCli: string;
    /** Maximum concurrent agents */
    maxAgents: number;
    /** Auto-release idle agents after (ms) */
    idleTimeout?: number;
  };

  /** Message handling */
  messages: {
    /** Include channel metadata in relay messages */
    includeMetadata: boolean;
    /** Format for agent-bound messages */
    inboundFormat: 'plain' | 'structured';
    /** Format for channel-bound messages */
    outboundFormat: 'plain' | 'markdown';
  };
}
```

### Example Configuration

```json
{
  "gateway": "ws://127.0.0.1:18789",
  "channels": {
    "enabled": ["whatsapp", "telegram", "slack"],
    "routing": {
      "whatsapp": {
        "defaultAgent": "PersonalAssistant",
        "autoSpawn": false
      },
      "slack": {
        "autoSpawn": true,
        "agentPrefix": "SlackWorker"
      }
    }
  },
  "agents": {
    "defaultCli": "claude",
    "maxAgents": 10,
    "idleTimeout": 300000
  },
  "messages": {
    "includeMetadata": true,
    "inboundFormat": "structured",
    "outboundFormat": "markdown"
  }
}
```

## Package Structure

```
packages/moltbot/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # Public exports
│   ├── bridge.ts             # Main bridge service
│   ├── transport.ts          # WebSocket transport adapter
│   ├── translator.ts         # Protocol translation
│   ├── session-manager.ts    # Session lifecycle management
│   ├── mcp-server.ts         # Unified MCP server
│   ├── skill/                # Moltbot skill files
│   │   ├── skill.yaml
│   │   ├── SKILL.md
│   │   └── index.ts
│   ├── config/
│   │   ├── schema.ts         # Config validation
│   │   └── defaults.ts       # Default values
│   └── types.ts              # TypeScript types
├── bin/
│   └── moltbot-bridge.ts     # CLI entry point
└── tests/
    ├── bridge.test.ts
    ├── translator.test.ts
    └── session-manager.test.ts
```

## CLI Commands

```bash
# Start the bridge
agent-relay moltbot start

# Start with custom config
agent-relay moltbot start --config ./moltbot.json

# Check bridge status
agent-relay moltbot status

# List active Moltbot sessions
agent-relay moltbot sessions

# Send to a specific channel
agent-relay moltbot send --channel whatsapp --message "Hello from Relay!"

# Install as Moltbot skill
agent-relay moltbot install-skill
```

## Security Considerations

1. **Local-only by default**: Bridge connects to local Moltbot gateway (127.0.0.1)
2. **No credential storage**: OAuth tokens handled by Moltbot, not the bridge
3. **Channel isolation**: Agents can only access channels explicitly configured
4. **Rate limiting**: Configurable limits on message throughput
5. **Audit logging**: All cross-system messages logged for debugging

---

## Relay-Cloud Integration

The Moltbot bridge can integrate with relay-cloud for team collaboration, centralized monitoring, and multi-machine orchestration.

### Cloud Integration Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              relay-cloud                                         │
│                         api.agent-relay.com                                      │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐              │
│  │ Workspace API    │  │ Moltbot Registry │  │ Monitoring API   │              │
│  │ - Provision      │  │ - Link gateways  │  │ - Agent metrics  │              │
│  │ - Team members   │  │ - Route messages │  │ - Session stats  │              │
│  │ - Agent policies │  │ - Sync sessions  │  │ - Channel usage  │              │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘              │
│           │                     │                     │                         │
│           └─────────────────────┼─────────────────────┘                         │
│                                 │                                               │
│                    ┌────────────┴────────────┐                                  │
│                    │   Cloud Message Bus     │                                  │
│                    │   (Cross-machine relay) │                                  │
│                    └────────────┬────────────┘                                  │
│                                 │                                               │
└─────────────────────────────────┼───────────────────────────────────────────────┘
                                  │
          ┌───────────────────────┼───────────────────────┐
          │                       │                       │
          ▼                       ▼                       ▼
┌─────────────────────┐ ┌─────────────────────┐ ┌─────────────────────┐
│  Linked Daemon A    │ │  Linked Daemon B    │ │  Cloud Workspace    │
│  + Moltbot Gateway  │ │  (No Moltbot)       │ │  (Fly.io)           │
│  + Local Bridge     │ │                     │ │  + Moltbot Bridge   │
└─────────────────────┘ └─────────────────────┘ └─────────────────────┘
```

### Integration Modes

#### Mode 1: Cloud-Linked Local Bridge

The Moltbot bridge runs locally alongside the user's Moltbot gateway, but links to relay-cloud for team features.

```typescript
// Local bridge with cloud linking
const bridge = new MoltbotBridge({
  moltbot: { gatewayUrl: 'ws://127.0.0.1:18789' },
  relay: { agentName: 'MoltbotBridge' },
  cloud: {
    enabled: true,
    workspaceId: 'ws_abc123',
    apiKey: 'ar_live_xxxxx',
    syncSessions: true,      // Sync Moltbot sessions to cloud
    syncMetrics: true,       // Report channel usage metrics
    teamRouting: true,       // Allow team members to route messages
  },
});
```

**Features:**
- Session visibility across team members
- Centralized agent monitoring
- Cross-machine message routing
- Shared agent policies

#### Mode 2: Cloud-Hosted Bridge

The Moltbot bridge runs in a relay-cloud workspace, connecting to a remote Moltbot gateway via Tailscale/SSH tunnel.

```typescript
// Cloud workspace with remote Moltbot connection
const bridge = new MoltbotBridge({
  moltbot: {
    // Connect to user's Moltbot via Tailscale
    gatewayUrl: 'ws://100.x.x.x:18789',  // Tailscale IP
    // Or via SSH tunnel
    // gatewayUrl: 'ws://localhost:18789',
    // tunnel: { type: 'ssh', host: 'user@machine.local', localPort: 18789 }
  },
  relay: {
    agentName: 'CloudMoltbotBridge',
    workspaceId: 'ws_abc123',
  },
});
```

**Features:**
- Always-on bridge (cloud workspace stays running)
- No local daemon required
- Scales with cloud infrastructure
- Auto-recovery on failures

#### Mode 3: Federated Multi-Gateway

Multiple Moltbot gateways across team members, unified through relay-cloud.

```typescript
// Cloud routes to appropriate gateway based on channel ownership
const federatedConfig = {
  gateways: [
    {
      id: 'alice-gateway',
      owner: 'alice@team.com',
      channels: ['whatsapp-alice', 'telegram-alice'],
      endpoint: 'tailscale://alice-machine:18789',
    },
    {
      id: 'bob-gateway',
      owner: 'bob@team.com',
      channels: ['slack-workspace', 'discord-server'],
      endpoint: 'tailscale://bob-machine:18789',
    },
  ],
  routing: {
    // Route based on channel
    '#moltbot-whatsapp-alice': 'alice-gateway',
    '#moltbot-slack': 'bob-gateway',
    // Default gateway for unmatched channels
    default: 'alice-gateway',
  },
};
```

### Cloud API Extensions

New endpoints for Moltbot integration:

```
# Moltbot Gateway Registry
POST   /api/moltbot/gateways              # Register a Moltbot gateway
GET    /api/moltbot/gateways              # List registered gateways
DELETE /api/moltbot/gateways/:id          # Unregister gateway
PATCH  /api/moltbot/gateways/:id          # Update gateway config

# Moltbot Session Sync
GET    /api/moltbot/sessions              # List all synced sessions
GET    /api/moltbot/sessions/:id          # Get session details
POST   /api/moltbot/sessions/:id/route    # Route session to agent

# Moltbot Channel Management
GET    /api/moltbot/channels              # List available channels
POST   /api/moltbot/channels/:id/policy   # Set channel routing policy

# Moltbot Metrics
GET    /api/monitoring/moltbot            # Moltbot-specific metrics
GET    /api/monitoring/moltbot/channels   # Per-channel statistics
```

### Database Schema Extensions

```typescript
// New tables for Moltbot integration

export const moltbotGateways = pgTable('moltbot_gateways', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').references(() => workspaces.id),
  name: text('name').notNull(),
  endpoint: text('endpoint').notNull(),  // WebSocket URL or Tailscale address
  ownerId: text('owner_id').references(() => users.id),
  status: text('status').default('offline'),  // online, offline, error
  lastSeen: timestamp('last_seen'),
  channels: jsonb('channels'),  // Available channels on this gateway
  config: jsonb('config'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const moltbotSessions = pgTable('moltbot_sessions', {
  id: text('id').primaryKey(),
  gatewayId: text('gateway_id').references(() => moltbotGateways.id),
  workspaceId: text('workspace_id').references(() => workspaces.id),
  channel: text('channel').notNull(),  // whatsapp, telegram, etc.
  externalId: text('external_id'),  // Moltbot's session ID
  assignedAgent: text('assigned_agent'),
  status: text('status').default('active'),
  metadata: jsonb('metadata'),
  startedAt: timestamp('started_at').defaultNow(),
  endedAt: timestamp('ended_at'),
});

export const moltbotChannelPolicies = pgTable('moltbot_channel_policies', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').references(() => workspaces.id),
  channel: text('channel').notNull(),  // Channel pattern: 'whatsapp', 'slack-*'
  defaultAgent: text('default_agent'),
  autoSpawn: boolean('auto_spawn').default(false),
  agentCli: text('agent_cli').default('claude'),
  maxConcurrentSessions: integer('max_concurrent_sessions'),
  allowedUsers: jsonb('allowed_users'),  // Team members who can interact
  createdAt: timestamp('created_at').defaultNow(),
});
```

### Notifications via Moltbot

Relay-cloud can send notifications to users via their Moltbot channels:

```typescript
// Cloud service sends notification through Moltbot
class CloudNotificationService {
  async notifyUser(userId: string, notification: Notification) {
    const user = await this.db.users.findOne(userId);
    const gateway = await this.findUserGateway(userId);

    if (gateway && user.moltbotPreferences?.notificationChannel) {
      await this.moltbotBridge.sendToChannel(
        gateway.id,
        user.moltbotPreferences.notificationChannel,
        this.formatNotification(notification)
      );
    }
  }
}

// Example notifications
- "Agent 'Architect' completed task: Auth refactoring done"
- "CI failure detected in repo/branch - Agent spawned to investigate"
- "Team member @bob requested review on PR #123"
- "Workspace 'acme-corp' approaching agent limit (9/10)"
```

### Use Cases

#### 1. Mobile Agent Control

Control your agent team from your phone via WhatsApp:

```
You (WhatsApp): "Status of the refactoring task?"

Moltbot → Cloud → Lead Agent → Response

Moltbot: "Team status:
- Architect: Completed design review
- Implementer: 60% through file migrations
- Tester: Waiting for implementation

ETA: ~2 hours for full completion."

You: "Tell Implementer to prioritize the auth module"

Moltbot → Cloud → Implementer Agent

Moltbot: "Message delivered to Implementer.
They acknowledged: 'Switching to auth module now.'"
```

#### 2. Team Collaboration via Channels

Multiple team members interact with shared agent teams:

```
Alice (Slack): "@relay spawn SecurityAuditor to review PR #456"

Cloud spawns agent in shared workspace

Bob (Discord): "@relay what's SecurityAuditor working on?"

Cloud: "SecurityAuditor is reviewing PR #456:
- Found 2 potential issues
- Currently analyzing auth flow
- ETA: 15 minutes"

Charlie (Telegram): "@relay tell SecurityAuditor to also check rate limiting"

Cloud routes message to SecurityAuditor
```

#### 3. CI/CD Notifications

GitHub CI failures trigger Moltbot notifications:

```
GitHub → relay-cloud webhook → CI failure detected

Cloud: Spawns fix agent, notifies team

Team Lead (WhatsApp): "CI failed on main branch.
Agent 'CIFixer' spawned to investigate.

Error: TypeScript compilation failed
Files: src/auth/session.ts

Reply 'details' for full error log."

Team Lead: "details"

Moltbot: "[Full compilation error...]

CIFixer says: 'Missing type import. Fix ready -
should I create PR or wait for review?'"

Team Lead: "create pr"

CIFixer → creates PR → Cloud notifies

Moltbot: "PR #789 created: 'Fix missing type import'
https://github.com/org/repo/pull/789"
```

### Configuration Schema (Cloud-Enabled)

```typescript
interface MoltbotBridgeConfig {
  // ... existing config ...

  /** Cloud integration settings */
  cloud?: {
    /** Enable cloud features */
    enabled: boolean;

    /** Workspace ID to link with */
    workspaceId: string;

    /** API key for cloud authentication */
    apiKey: string;

    /** Sync Moltbot sessions to cloud */
    syncSessions?: boolean;

    /** Report metrics to cloud monitoring */
    syncMetrics?: boolean;

    /** Allow team members to route messages */
    teamRouting?: boolean;

    /** Notification preferences */
    notifications?: {
      /** Send agent status updates */
      agentStatus: boolean;
      /** Send CI/CD notifications */
      cicd: boolean;
      /** Send team activity notifications */
      teamActivity: boolean;
      /** Preferred channel for notifications */
      defaultChannel?: string;
    };

    /** Federation settings (multi-gateway) */
    federation?: {
      enabled: boolean;
      /** This gateway's unique ID */
      gatewayId: string;
      /** Channels owned by this gateway */
      ownedChannels: string[];
    };
  };
}
```

### Cloud CLI Commands

```bash
# Link local Moltbot bridge to cloud
agent-relay moltbot link --workspace ws_abc123

# Register gateway with cloud
agent-relay moltbot register-gateway --name "My Moltbot"

# Sync sessions to cloud
agent-relay moltbot sync

# View cloud-wide Moltbot status
agent-relay moltbot cloud-status

# Configure notification preferences
agent-relay moltbot notifications --channel whatsapp --enable ci,agents

# Federation commands
agent-relay moltbot federation join --gateway-id my-gateway
agent-relay moltbot federation list-gateways
agent-relay moltbot federation set-routing --channel slack --gateway bob-gateway
```

## Implementation Phases

### Phase 1: Core Bridge (MVP)
- [ ] WebSocket transport to Moltbot gateway
- [ ] Basic protocol translation
- [ ] Single-agent routing (all messages → one agent)
- [ ] Manual session management

### Phase 2: Multi-Agent Routing
- [ ] Session manager with agent assignment
- [ ] Channel-based routing rules
- [ ] Auto-spawn agents for sessions
- [ ] Agent lifecycle management

### Phase 3: Skill Integration
- [ ] Moltbot skill package
- [ ] Natural language agent orchestration
- [ ] Team status reporting
- [ ] Cross-session communication

### Phase 4: Cloud Integration
- [ ] Cloud API endpoints for Moltbot
- [ ] Gateway registration and discovery
- [ ] Session sync to cloud database
- [ ] Team routing through cloud message bus
- [ ] Notification service via Moltbot channels

### Phase 5: Advanced Features
- [ ] Unified MCP server
- [ ] Multi-gateway federation
- [ ] Tailscale/SSH tunnel support
- [ ] Analytics and monitoring dashboard
- [ ] Mobile-first agent control workflows

## API Reference

### Bridge Service API

```typescript
import { MoltbotBridge } from '@agent-relay/moltbot';

const bridge = new MoltbotBridge({
  moltbot: { gatewayUrl: 'ws://127.0.0.1:18789' },
  relay: { agentName: 'MoltbotBridge' },
  routing: { defaultAgent: 'Assistant' },
});

// Start bridge
await bridge.start();

// Listen for new sessions
bridge.onSessionStart((session) => {
  console.log(`New session: ${session.id} on ${session.channel}`);
});

// Manual routing
await bridge.routeToAgent('session-123', 'SpecialistAgent', 'Please help with this');

// Stop bridge
await bridge.stop();
```

### SDK Integration

```typescript
import { RelayClient } from '@agent-relay/sdk';

const client = new RelayClient({ agentName: 'MyAgent' });
await client.connect();

// Join Moltbot channel
await client.joinChannel('#moltbot-whatsapp');

// Send to WhatsApp users
client.sendChannelMessage('#moltbot-whatsapp', 'Hello WhatsApp users!');

// Listen for WhatsApp messages
client.onChannelMessage = (channel, from, message) => {
  if (channel === '#moltbot-whatsapp') {
    console.log(`WhatsApp message from ${from}: ${message}`);
  }
};
```

## Testing Strategy

```typescript
// Mock Moltbot gateway for testing
import { createMockMoltbotGateway } from '@agent-relay/moltbot/testing';

const mockGateway = createMockMoltbotGateway();
await mockGateway.start(18789);

// Simulate incoming WhatsApp message
mockGateway.simulateMessage({
  channel: 'whatsapp',
  sessionId: 'test-session',
  content: 'Hello from test!',
});

// Verify message reached Relay agent
// ...

await mockGateway.stop();
```

## Related Documents

- [Agent Relay Protocol Specification](../protocol.md)
- [Bridge Package Documentation](../../packages/bridge/README.md)
- [MCP Integration Guide](../../packages/mcp/README.md)
- [Cloud Package Documentation](../../packages/cloud/README.md)
- [Cloud API Reference](../../packages/cloud/API.md)
- [Moltbot Documentation](https://github.com/moltbot/moltbot)

---

## Appendix: Strategic Value

### Why Moltbot + Relay-Cloud?

| Capability | Moltbot Alone | Relay-Cloud Alone | Combined |
|------------|---------------|-------------------|----------|
| Multi-channel messaging | Yes | No | Yes |
| Agent orchestration | Limited | Yes | Yes |
| Team collaboration | No | Yes | Yes |
| Mobile control | Yes | Limited | Yes |
| Persistent workspaces | No | Yes | Yes |
| CI/CD integration | No | Yes | Yes + notifications |
| Cross-machine agents | No | Yes | Yes |

### Market Position

```
                    ┌─────────────────────────────────────┐
                    │                                     │
   Moltbot Users    │    Moltbot + Agent Relay Cloud     │    Enterprise Teams
   (63k+ stars)     │                                     │    (relay-cloud)
        ────────────►    "AI Agent Teams on WhatsApp"    ◄────────────
                    │                                     │
                    └─────────────────────────────────────┘

   Value prop:                                            Value prop:
   - Orchestrate agents                                   - Mobile/messaging control
     from any messaging app                               - User-friendly interface
   - Team collaboration                                   - Broader channel reach
   - Always-on cloud agents                               - Consumer accessibility
```

### Growth Opportunities

1. **Moltbot Skill Registry**: Publish agent-relay skill to Moltbot's managed skills registry
2. **Cross-promotion**: Feature in Moltbot's Discord (1.4M+ members)
3. **Enterprise offering**: White-label Moltbot + relay-cloud for enterprise customers
4. **Template workspaces**: Pre-configured "Agent Team via WhatsApp" workspace templates
