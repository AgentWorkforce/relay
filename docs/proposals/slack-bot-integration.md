# Slack Bot Integration Proposal

**Author:** Claude
**Date:** 2025-12-30
**Status:** Draft
**Estimated Effort:** 5-7 days

---

## Executive Summary

This proposal outlines a plan to integrate agent-relay messaging with Slack, following the **cloud-first architecture** established in PR #35. The integration enables:

- AI agents to communicate in Slack channels alongside humans
- Humans to interact with agents via @mentions and slash commands
- Real-time bidirectional sync between relay daemon and Slack
- Thread preservation across both systems
- **Cloud-managed OAuth and credentials** via Nango integration platform
- **Multi-workspace support** through the daemon orchestrator
- **Plan-based access** (Pro/Team/Enterprise tiers)

---

## Table of Contents

1. [Goals & Non-Goals](#1-goals--non-goals)
2. [Architecture Overview](#2-architecture-overview)
3. [Cloud Components](#3-cloud-components)
4. [Daemon Components](#4-daemon-components)
5. [Database Schema](#5-database-schema)
6. [Dashboard UI](#6-dashboard-ui)
7. [Implementation Phases](#7-implementation-phases)
8. [API Specifications](#8-api-specifications)
9. [Security & Plan Limits](#9-security--plan-limits)
10. [Testing Strategy](#10-testing-strategy)
11. [Open Questions](#11-open-questions)

---

## 1. Goals & Non-Goals

### Goals

| Goal | Description |
|------|-------------|
| **Cloud-managed credentials** | Slack OAuth tokens stored in encrypted vault, not local files |
| **Multi-workspace support** | Each workspace can have its own Slack integration |
| **Bidirectional messaging** | Messages flow Slack ↔ Relay in real-time |
| **Thread preservation** | Relay threads map to Slack threads and vice versa |
| **Plan-gated access** | Slack integration available on Pro+ plans |
| **Dashboard configuration** | Connect/disconnect Slack via UI |
| **Self-hosted parity** | Works in cloud-hosted, self-hosted, and hybrid modes |

### Non-Goals (v1)

| Non-Goal | Rationale |
|----------|-----------|
| Multi-Slack-workspace per relay workspace | Complexity; one Slack workspace per relay workspace |
| Slack-only agents | Agents should exist in relay first |
| Rich Block Kit formatting | Plain text first; enhance later |
| Slack Enterprise Grid | Requires org-level OAuth; v2 |

---

## 2. Architecture Overview

### High-Level Design (Cloud Paradigm)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              SLACK WORKSPACE                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                         │
│  │ #agents     │  │ #alerts     │  │ @agent-bot  │                         │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘                         │
│         └────────────────┴────────────────┘                                 │
│                          │                                                  │
│                    Slack Events API (Socket Mode)                           │
└──────────────────────────┼──────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                         AGENT RELAY CLOUD                                    │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                        src/cloud/                                      │ │
│  │  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐    │ │
│  │  │ api/integrations │  │ services/slack   │  │ Nango            │    │ │
│  │  │ /slack.ts        │  │ SlackService     │  │ (external)       │    │ │
│  │  │                  │  │                  │  │                  │    │ │
│  │  │ • OAuth trigger  │  │ • Token fetch    │  │ • OAuth flow     │    │ │
│  │  │ • Disconnect     │  │ • Workspace sync │  │ • Token storage  │    │ │
│  │  │ • Status         │  │ • Health check   │  │ • Auto refresh   │    │ │
│  │  └──────────────────┘  └──────────────────┘  └──────────────────┘    │ │
│  │                                                                        │ │
│  │  ┌──────────────────┐  ┌──────────────────┐                           │ │
│  │  │ db/schema.ts     │  │ api/middleware/  │                           │ │
│  │  │                  │  │ planLimits.ts    │                           │ │
│  │  │ • slack_integrations│ • requirePro()  │                           │ │
│  │  │ • slack_channels │  │ • checkSlackLimit│                           │ │
│  │  └──────────────────┘  └──────────────────┘                           │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                    │                                        │
│                              Cloud Sync API                                 │
│                                    │                                        │
└────────────────────────────────────┼────────────────────────────────────────┘
                                     │
                                     ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                         LOCAL DAEMON                                         │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                        src/daemon/                                     │ │
│  │  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐    │ │
│  │  │ orchestrator.ts  │  │ slack-bridge.ts  │  │ cloud-sync.ts    │    │ │
│  │  │                  │  │ (NEW)            │  │                  │    │ │
│  │  │ • Manages        │  │                  │  │ • Pulls Slack    │    │ │
│  │  │   workspaces     │  │ • Slack ↔ Relay  │  │   credentials    │    │ │
│  │  │ • Starts bridge  │  │ • Thread mapping │  │ • Syncs config   │    │ │
│  │  │   per workspace  │  │ • Event handling │  │ • Token refresh  │    │ │
│  │  └──────────────────┘  └──────────────────┘  └──────────────────┘    │ │
│  │                                                                        │ │
│  │  ┌──────────────────┐  ┌──────────────────┐                           │ │
│  │  │ router.ts        │  │ agent-manager.ts │                           │ │
│  │  │                  │  │                  │                           │ │
│  │  │ • Routes msgs    │  │ • Agent lifecycle│                           │ │
│  │  │ • SlackBridge    │  │ • Health monitor │                           │ │
│  │  │   as agent       │  │                  │                           │ │
│  │  └──────────────────┘  └──────────────────┘                           │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                    │                                        │
│                            Unix Domain Socket                               │
│                                    │                                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │   Alice     │  │    Bob      │  │ SlackBridge │  │  Dashboard  │        │
│  │  (Claude)   │  │  (Claude)   │  │  (daemon)   │  │  (observer) │        │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘        │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Deployment Model Alignment

| Mode | How Slack Integration Works |
|------|----------------------------|
| **Cloud Hosted** | OAuth via cloud, credentials in vault, daemon bridge runs in cloud workspace |
| **Self-Hosted** | OAuth via cloud servers, credentials synced to local daemon |
| **Hybrid/Local** | OAuth via cloud, daemon runs locally with synced credentials |

This follows the same pattern as provider credentials (Claude API keys, etc.) established in PR #35.

---

## 3. Cloud Components

### 3.1 Nango Integration

[Nango](https://www.nango.dev/) handles all OAuth complexity:
- OAuth flow (authorization URL, token exchange)
- Secure token storage (encrypted at rest)
- Automatic token refresh before expiry
- Connection status monitoring

**Nango Setup:**
```yaml
# nango.yaml - Integration configuration
integrations:
  slack:
    provider: slack
    syncs: []
    actions:
      - name: post-message
      - name: list-channels
    scopes:
      - app_mentions:read
      - channels:history
      - channels:read
      - chat:write
      - groups:history
      - groups:read
      - im:history
      - im:read
      - im:write
      - users:read
```

### 3.2 API Routes (`src/cloud/api/integrations/slack.ts`)

```typescript
// src/cloud/api/integrations/slack.ts

import { Router } from 'express';
import { Nango } from '@nangohq/node';
import { requireAuth } from '../middleware/auth';
import { requirePlan } from '../middleware/planLimits';
import { SlackService } from '../../services/slack';
import { db, eq } from '../../db';
import { slackIntegrations } from '../../db/schema';

const router = Router();
const nango = new Nango({ secretKey: process.env.NANGO_SECRET_KEY });

// All Slack routes require Pro+ plan
router.use(requireAuth, requirePlan('pro'));

/**
 * GET /api/integrations/slack/status
 * Get Slack integration status for current workspace
 */
router.get('/status', async (req, res) => {
  const { workspaceId } = req.query;

  const integration = await db.query.slackIntegrations.findFirst({
    where: eq(slackIntegrations.workspaceId, workspaceId),
  });

  if (!integration) {
    return res.json({ connected: false });
  }

  // Check Nango connection status
  try {
    const connection = await nango.getConnection('slack', integration.nangoConnectionId);

    res.json({
      connected: true,
      valid: connection.credentials?.access_token != null,
      slackWorkspace: integration.slackWorkspaceName,
      slackTeamId: integration.slackTeamId,
      channels: {
        broadcast: integration.broadcastChannel,
        alerts: integration.alertsChannel,
      },
      connectedAt: integration.createdAt,
      connectedBy: integration.connectedByUserId,
    });
  } catch (error) {
    res.json({ connected: true, valid: false, error: 'Token expired' });
  }
});

/**
 * GET /api/integrations/slack/connect
 * Get Nango connect URL for Slack OAuth
 */
router.get('/connect', async (req, res) => {
  const { workspaceId } = req.query;

  // Generate unique connection ID for this workspace
  const connectionId = `workspace-${workspaceId}-slack`;

  // Nango handles the entire OAuth flow
  const connectUrl = await nango.auth('slack', connectionId, {
    detectClosedAuthWindow: true,
  });

  // Store pending connection
  await db.insert(slackIntegrations).values({
    id: generateId(),
    workspaceId,
    nangoConnectionId: connectionId,
    status: 'pending',
    connectedByUserId: req.user.id,
  }).onConflictDoUpdate({
    target: slackIntegrations.workspaceId,
    set: { status: 'pending', updatedAt: new Date() },
  });

  res.json({ connectUrl });
});

/**
 * POST /api/integrations/slack/webhook
 * Nango webhook for connection events
 */
router.post('/webhook', async (req, res) => {
  const { type, connectionId, provider } = req.body;

  if (provider !== 'slack') {
    return res.json({ ok: true });
  }

  // Extract workspaceId from connectionId
  const match = connectionId.match(/^workspace-(.+)-slack$/);
  if (!match) {
    return res.status(400).json({ error: 'Invalid connection ID' });
  }
  const workspaceId = match[1];

  if (type === 'auth') {
    // OAuth completed - fetch team info
    const connection = await nango.getConnection('slack', connectionId);
    const teamInfo = connection.connection_config?.team;

    await db.update(slackIntegrations)
      .set({
        status: 'connected',
        slackTeamId: teamInfo?.id,
        slackWorkspaceName: teamInfo?.name,
        updatedAt: new Date(),
      })
      .where(eq(slackIntegrations.workspaceId, workspaceId));

    // Notify daemon to connect
    await SlackService.notifyDaemonConnect(workspaceId);
  }

  if (type === 'token_refreshed') {
    // Token was refreshed - notify daemon to reconnect
    await SlackService.notifyDaemonReconnect(workspaceId);
  }

  res.json({ ok: true });
});

/**
 * POST /api/integrations/slack/disconnect
 * Disconnect Slack integration
 */
router.post('/disconnect', async (req, res) => {
  const { workspaceId } = req.body;

  const integration = await db.query.slackIntegrations.findFirst({
    where: eq(slackIntegrations.workspaceId, workspaceId),
  });

  if (!integration) {
    return res.status(404).json({ error: 'No Slack integration found' });
  }

  // Delete connection from Nango (revokes token)
  await nango.deleteConnection('slack', integration.nangoConnectionId);

  // Delete integration record
  await db.delete(slackIntegrations)
    .where(eq(slackIntegrations.id, integration.id));

  // Notify daemon to disconnect
  await SlackService.notifyDaemonDisconnect(workspaceId);

  res.json({ success: true });
});

/**
 * PUT /api/integrations/slack/config
 * Update Slack integration configuration
 */
router.put('/config', async (req, res) => {
  const { workspaceId, broadcastChannel, alertsChannel, showAgentToAgent, showThinking } = req.body;

  await db.update(slackIntegrations)
    .set({
      broadcastChannel,
      alertsChannel,
      config: { showAgentToAgent, showThinking },
      updatedAt: new Date(),
    })
    .where(eq(slackIntegrations.workspaceId, workspaceId));

  // Notify daemon to reload config
  await SlackService.notifyDaemonConfigUpdate(workspaceId);

  res.json({ success: true });
});

/**
 * GET /api/integrations/slack/channels
 * List available Slack channels for configuration
 */
router.get('/channels', async (req, res) => {
  const { workspaceId } = req.query;

  const channels = await SlackService.listChannels(workspaceId);
  res.json({ channels });
});

export default router;
```

### 3.3 Slack Service (`src/cloud/services/slack.ts`)

```typescript
// src/cloud/services/slack.ts

import { Nango } from '@nangohq/node';
import { WebClient } from '@slack/web-api';
import { db, eq } from '../db';
import { slackIntegrations } from '../db/schema';

const nango = new Nango({ secretKey: process.env.NANGO_SECRET_KEY });

export class SlackService {
  /**
   * Get Slack access token from Nango
   * Nango automatically refreshes expired tokens
   */
  static async getAccessToken(workspaceId: string): Promise<string | null> {
    const integration = await db.query.slackIntegrations.findFirst({
      where: eq(slackIntegrations.workspaceId, workspaceId),
    });

    if (!integration?.nangoConnectionId) return null;

    try {
      const connection = await nango.getConnection('slack', integration.nangoConnectionId);
      return connection.credentials?.access_token || null;
    } catch {
      return null;
    }
  }

  /**
   * List channels the bot can access
   */
  static async listChannels(workspaceId: string): Promise<SlackChannel[]> {
    const token = await this.getAccessToken(workspaceId);
    if (!token) throw new Error('No Slack connection found');

    const client = new WebClient(token);
    const result = await client.conversations.list({
      types: 'public_channel,private_channel',
      exclude_archived: true,
    });

    return result.channels?.map(ch => ({
      id: ch.id!,
      name: ch.name!,
      isPrivate: ch.is_private || false,
      isMember: ch.is_member || false,
    })) || [];
  }

  /**
   * Get credentials for daemon sync
   * Called by daemon cloud-sync to retrieve Slack config
   */
  static async getCredentialsForDaemon(workspaceId: string): Promise<SlackDaemonConfig | null> {
    const integration = await db.query.slackIntegrations.findFirst({
      where: eq(slackIntegrations.workspaceId, workspaceId),
    });

    if (!integration?.nangoConnectionId) return null;

    try {
      const connection = await nango.getConnection('slack', integration.nangoConnectionId);

      if (!connection.credentials?.access_token) return null;

      return {
        botToken: connection.credentials.access_token,
        // App token for Socket Mode - stored in connection metadata or env
        appToken: process.env.SLACK_APP_TOKEN,
        teamId: integration.slackTeamId!,
        teamName: integration.slackWorkspaceName!,
        broadcastChannel: integration.broadcastChannel,
        alertsChannel: integration.alertsChannel,
        config: integration.config || {},
      };
    } catch {
      return null;
    }
  }

  /**
   * Notify daemon of Slack connection changes
   */
  static async notifyDaemonConnect(workspaceId: string): Promise<void> {
    await this.sendDaemonNotification(workspaceId, 'slack:connect');
  }

  static async notifyDaemonDisconnect(workspaceId: string): Promise<void> {
    await this.sendDaemonNotification(workspaceId, 'slack:disconnect');
  }

  static async notifyDaemonConfigUpdate(workspaceId: string): Promise<void> {
    await this.sendDaemonNotification(workspaceId, 'slack:config-update');
  }

  static async notifyDaemonReconnect(workspaceId: string): Promise<void> {
    await this.sendDaemonNotification(workspaceId, 'slack:reconnect');
  }

  private static async sendDaemonNotification(workspaceId: string, event: string): Promise<void> {
    // Implementation depends on daemon connection method
    // Could be WebSocket push, Redis pub/sub, or polling
  }
}

interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
}

interface SlackDaemonConfig {
  botToken: string;
  appToken: string;
  teamId: string;
  teamName: string;
  broadcastChannel: string | null;
  alertsChannel: string | null;
  config: {
    showAgentToAgent?: boolean;
    showThinking?: boolean;
  };
}
```

### 3.4 Why Nango?

| Concern | Without Nango | With Nango |
|---------|---------------|------------|
| OAuth flow | Custom implementation | Hosted UI, handles edge cases |
| Token storage | Custom vault, encryption | Encrypted at rest, compliant |
| Token refresh | Manual refresh logic | Automatic, before expiry |
| Multiple providers | Per-provider code | Unified API |
| Maintenance | Security updates needed | Managed service |

**Dependencies:**
```json
{
  "dependencies": {
    "@nangohq/node": "^0.40.0"
  }
}
```

---

## 4. Daemon Components

### 4.1 Slack Bridge (`src/daemon/slack-bridge.ts`)

```typescript
// src/daemon/slack-bridge.ts

import { App, LogLevel } from '@slack/bolt';
import { RelayClient } from '../wrapper/client';
import { SlackThreadStore } from './slack-thread-store';
import { SlackMessageFormatter } from './slack-formatter';
import { logger } from '../resiliency/logger';

export interface SlackBridgeConfig {
  botToken: string;
  appToken: string;
  teamId: string;
  teamName: string;
  broadcastChannel: string | null;
  alertsChannel: string | null;
  config: {
    showAgentToAgent?: boolean;
    showThinking?: boolean;
  };
  // Relay connection
  socketPath: string;
  workspaceId: string;
}

export class SlackBridge {
  private slackApp: App | null = null;
  private relayClient: RelayClient | null = null;
  private threadStore: SlackThreadStore;
  private formatter: SlackMessageFormatter;
  private config: SlackBridgeConfig;
  private running = false;

  constructor(config: SlackBridgeConfig) {
    this.config = config;
    this.threadStore = new SlackThreadStore();
    this.formatter = new SlackMessageFormatter();
  }

  async start(): Promise<void> {
    if (this.running) return;

    logger.info('Starting Slack bridge', {
      workspaceId: this.config.workspaceId,
      slackTeam: this.config.teamName,
    });

    // 1. Initialize Slack App (Socket Mode)
    this.slackApp = new App({
      token: this.config.botToken,
      appToken: this.config.appToken,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });

    // 2. Register event handlers
    this.registerSlackHandlers();

    // 3. Connect to local relay daemon
    this.relayClient = new RelayClient({
      socketPath: this.config.socketPath,
      agentName: 'SlackBridge',
      cli: 'slack',
      reconnect: true,
    });

    this.relayClient.onMessage = this.onRelayMessage.bind(this);
    this.relayClient.onStateChange = this.onRelayStateChange.bind(this);

    await this.relayClient.connect();

    // 4. Subscribe to all messages
    this.relayClient.subscribe('*');

    // 5. Start Slack app
    await this.slackApp.start();

    this.running = true;
    logger.info('Slack bridge started successfully');
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    logger.info('Stopping Slack bridge');

    if (this.slackApp) {
      await this.slackApp.stop();
      this.slackApp = null;
    }

    if (this.relayClient) {
      await this.relayClient.disconnect();
      this.relayClient = null;
    }

    this.running = false;
  }

  async updateConfig(newConfig: Partial<SlackBridgeConfig>): Promise<void> {
    // Update config without full restart for channel changes
    this.config = { ...this.config, ...newConfig };
    logger.info('Slack bridge config updated', { workspaceId: this.config.workspaceId });
  }

  isRunning(): boolean {
    return this.running;
  }

  // ─────────────────────────────────────────────────────────────
  // Slack → Relay handlers
  // ─────────────────────────────────────────────────────────────

  private registerSlackHandlers(): void {
    if (!this.slackApp) return;

    // Handle @mentions
    this.slackApp.event('app_mention', async ({ event, say }) => {
      await this.handleMention(event, say);
    });

    // Handle DMs
    this.slackApp.event('message', async ({ event, say }) => {
      if (event.channel_type === 'im' && !event.bot_id) {
        await this.handleDirectMessage(event, say);
      }
    });

    // Handle thread replies
    this.slackApp.event('message', async ({ event }) => {
      if (event.thread_ts && event.thread_ts !== event.ts && !event.bot_id) {
        await this.handleThreadReply(event);
      }
    });

    // Slash command
    this.slackApp.command('/relay', async ({ command, ack, respond }) => {
      await ack();
      await this.handleSlashCommand(command, respond);
    });
  }

  private async handleMention(event: any, say: Function): Promise<void> {
    // Extract agent name from message (e.g., "@relay Alice please help")
    const agentMatch = event.text.match(/<@[A-Z0-9]+>\s*@?(\w+)\s*(.*)/s);

    if (!agentMatch) {
      await say({
        text: 'Usage: @AgentRelay AgentName your message',
        thread_ts: event.ts,
      });
      return;
    }

    const [, agentName, messageBody] = agentMatch;
    const slackUser = await this.resolveUser(event.user);
    const thread = this.threadStore.getOrCreate(event.thread_ts || event.ts, event.channel);

    this.relayClient?.sendMessage(
      agentName,
      messageBody.trim(),
      'message',
      {
        slack_user: slackUser,
        slack_channel: event.channel,
        slack_ts: event.ts,
        slack_thread_ts: event.thread_ts,
      },
      thread
    );

    logger.debug('Forwarded Slack mention to relay', { agentName, slackUser });
  }

  private async handleDirectMessage(event: any, say: Function): Promise<void> {
    // Parse agent target from DM: "Alice: help me" or just broadcast
    const match = event.text.match(/^@?(\w+):\s*(.+)$/s);

    const agentName = match ? match[1] : '*';
    const messageBody = match ? match[2] : event.text;
    const slackUser = await this.resolveUser(event.user);

    this.relayClient?.sendMessage(
      agentName,
      messageBody.trim(),
      'message',
      {
        slack_user: slackUser,
        slack_channel: event.channel,
        slack_ts: event.ts,
        slack_dm: true,
      }
    );
  }

  private async handleThreadReply(event: any): Promise<void> {
    const relayThread = this.threadStore.getRelayThread(event.thread_ts, event.channel);
    if (!relayThread) return;  // Not a relay thread

    const slackUser = await this.resolveUser(event.user);
    const threadMeta = this.threadStore.getMeta(event.thread_ts, event.channel);

    this.relayClient?.sendMessage(
      threadMeta?.targetAgent || '*',
      event.text,
      'message',
      {
        slack_user: slackUser,
        slack_thread_ts: event.thread_ts,
      },
      relayThread
    );
  }

  private async handleSlashCommand(command: any, respond: Function): Promise<void> {
    const match = command.text.match(/^@?(\w+)\s+(.+)$/s);

    if (!match) {
      await respond('Usage: /relay @AgentName your message');
      return;
    }

    const [, agentName, messageBody] = match;
    const slackUser = await this.resolveUser(command.user_id);

    this.relayClient?.sendMessage(
      agentName,
      messageBody.trim(),
      'message',
      {
        slack_user: slackUser,
        slack_channel: command.channel_id,
        slack_command: true,
      }
    );

    await respond(`Message sent to ${agentName}`);
  }

  // ─────────────────────────────────────────────────────────────
  // Relay → Slack handlers
  // ─────────────────────────────────────────────────────────────

  private async onRelayMessage(
    from: string,
    payload: { kind: string; body: string; data?: Record<string, unknown>; thread?: string },
    messageId: string,
    meta?: { importance?: number }
  ): Promise<void> {
    // Skip self-messages
    if (from === 'SlackBridge') return;

    // Skip messages originating from Slack (prevent loop)
    if (payload.data?.slack_ts) return;

    // Skip thinking unless configured
    if (payload.kind === 'thinking' && !this.config.config.showThinking) return;

    // Determine channel
    let channel = this.config.broadcastChannel;
    let threadTs: string | undefined;

    // Reply to Slack conversation
    if (payload.data?.slack_channel) {
      channel = payload.data.slack_channel as string;
      threadTs = payload.data.slack_thread_ts as string;
    }
    // High importance → alerts channel
    else if (meta?.importance && meta.importance >= 80 && this.config.alertsChannel) {
      channel = this.config.alertsChannel;
    }
    // Map relay thread to Slack thread
    else if (payload.thread) {
      const slackThread = this.threadStore.getSlackThread(payload.thread);
      if (slackThread) {
        channel = slackThread.channel;
        threadTs = slackThread.ts;
      }
    }

    if (!channel) {
      logger.warn('No channel configured for Slack message');
      return;
    }

    const formatted = this.formatter.format(from, payload);

    try {
      const result = await this.slackApp?.client.chat.postMessage({
        channel,
        text: formatted,
        thread_ts: threadTs,
        unfurl_links: false,
        unfurl_media: false,
      });

      // Track thread mapping
      if (result?.ts && payload.thread) {
        this.threadStore.map(payload.thread, {
          ts: result.ts,
          channel,
          targetAgent: from,
        });
      }
    } catch (error) {
      logger.error('Failed to post to Slack', { error, channel });
    }
  }

  private onRelayStateChange(state: string): void {
    logger.info('Slack bridge relay connection state', { state });
  }

  private async resolveUser(userId: string): Promise<string> {
    try {
      const result = await this.slackApp?.client.users.info({ user: userId });
      return result?.user?.real_name || result?.user?.name || userId;
    } catch {
      return userId;
    }
  }
}
```

### 4.2 Integration with Orchestrator (`src/daemon/orchestrator.ts`)

```typescript
// Addition to src/daemon/orchestrator.ts

import { SlackBridge, SlackBridgeConfig } from './slack-bridge';

export class DaemonOrchestrator {
  private slackBridges: Map<string, SlackBridge> = new Map();

  // Called during workspace initialization or when Slack is connected
  async initializeSlackBridge(workspaceId: string): Promise<void> {
    // Check if already running
    if (this.slackBridges.has(workspaceId)) {
      return;
    }

    // Get Slack config from cloud sync
    const slackConfig = await this.cloudSync.getSlackConfig(workspaceId);
    if (!slackConfig) {
      logger.debug('No Slack integration for workspace', { workspaceId });
      return;
    }

    const bridge = new SlackBridge({
      ...slackConfig,
      socketPath: this.getSocketPath(workspaceId),
      workspaceId,
    });

    try {
      await bridge.start();
      this.slackBridges.set(workspaceId, bridge);
      logger.info('Slack bridge initialized', { workspaceId });
    } catch (error) {
      logger.error('Failed to initialize Slack bridge', { workspaceId, error });
    }
  }

  async stopSlackBridge(workspaceId: string): Promise<void> {
    const bridge = this.slackBridges.get(workspaceId);
    if (bridge) {
      await bridge.stop();
      this.slackBridges.delete(workspaceId);
      logger.info('Slack bridge stopped', { workspaceId });
    }
  }

  // Called when cloud sync receives Slack notification
  async handleSlackNotification(workspaceId: string, event: string): Promise<void> {
    switch (event) {
      case 'slack:connect':
        await this.initializeSlackBridge(workspaceId);
        break;
      case 'slack:disconnect':
        await this.stopSlackBridge(workspaceId);
        break;
      case 'slack:config-update':
        const bridge = this.slackBridges.get(workspaceId);
        if (bridge) {
          const newConfig = await this.cloudSync.getSlackConfig(workspaceId);
          if (newConfig) {
            await bridge.updateConfig(newConfig);
          }
        }
        break;
    }
  }

  // Health check includes Slack bridges
  getHealth(): DaemonHealth {
    return {
      ...this.baseHealth(),
      slackBridges: Array.from(this.slackBridges.entries()).map(([id, bridge]) => ({
        workspaceId: id,
        running: bridge.isRunning(),
      })),
    };
  }
}
```

### 4.3 Cloud Sync Extension (`src/daemon/cloud-sync.ts`)

```typescript
// Addition to src/daemon/cloud-sync.ts

export class CloudSync {
  /**
   * Get Slack configuration for a workspace
   * Called by orchestrator when initializing Slack bridge
   */
  async getSlackConfig(workspaceId: string): Promise<SlackBridgeConfig | null> {
    try {
      const response = await this.apiClient.get(
        `/api/integrations/slack/daemon-config?workspaceId=${workspaceId}`
      );

      if (!response.data.connected) {
        return null;
      }

      return response.data.config;
    } catch (error) {
      logger.error('Failed to fetch Slack config', { workspaceId, error });
      return null;
    }
  }

  /**
   * Subscribe to Slack notifications
   */
  subscribeToSlackNotifications(callback: (workspaceId: string, event: string) => void): void {
    // WebSocket subscription or polling
    this.on('slack:notification', callback);
  }
}
```

---

## 5. Database Schema

### 5.1 Drizzle Schema (`src/cloud/db/schema.ts`)

```typescript
// Addition to src/cloud/db/schema.ts

import { pgTable, text, timestamp, jsonb, boolean } from 'drizzle-orm/pg-core';

export const slackIntegrations = pgTable('slack_integrations', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),

  // Nango connection (handles OAuth, token storage, refresh)
  nangoConnectionId: text('nango_connection_id').notNull(),
  status: text('status').notNull().default('pending'), // pending, connected, error

  // Slack workspace info (populated after OAuth)
  slackTeamId: text('slack_team_id'),
  slackWorkspaceName: text('slack_workspace_name'),

  // Channel configuration
  broadcastChannel: text('broadcast_channel'),
  alertsChannel: text('alerts_channel'),

  // Behavior configuration
  config: jsonb('config').$type<{
    showAgentToAgent?: boolean;
    showThinking?: boolean;
    threadTTLHours?: number;
  }>().default({}),

  // Metadata
  connectedByUserId: text('connected_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const slackChannelMappings = pgTable('slack_channel_mappings', {
  id: text('id').primaryKey(),
  integrationId: text('integration_id').notNull().references(() => slackIntegrations.id, { onDelete: 'cascade' }),

  // Relay topic → Slack channel mapping
  relayTopic: text('relay_topic').notNull(),
  slackChannelId: text('slack_channel_id').notNull(),
  slackChannelName: text('slack_channel_name'),

  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Index for fast lookup
export const slackIntegrationsWorkspaceIdx = index('slack_integrations_workspace_idx')
  .on(slackIntegrations.workspaceId);
```

### 5.2 SQL Migration

```sql
-- deploy/migrations/004_slack_integrations.sql

CREATE TABLE slack_integrations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  nango_connection_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  slack_team_id TEXT,
  slack_workspace_name TEXT,
  broadcast_channel TEXT,
  alerts_channel TEXT,
  config JSONB DEFAULT '{}',
  connected_by_user_id TEXT REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX slack_integrations_workspace_idx ON slack_integrations(workspace_id);

CREATE TABLE slack_channel_mappings (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL REFERENCES slack_integrations(id) ON DELETE CASCADE,
  relay_topic TEXT NOT NULL,
  slack_channel_id TEXT NOT NULL,
  slack_channel_name TEXT,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX slack_channel_mappings_integration_idx ON slack_channel_mappings(integration_id);
```

---

## 6. Dashboard UI

### 6.1 Slack Integration Panel (`src/dashboard/react-components/SlackIntegrationPanel.tsx`)

```typescript
// src/dashboard/react-components/SlackIntegrationPanel.tsx

import React, { useState, useEffect } from 'react';
import { useSession } from './hooks/useSession';
import { api } from '../lib/api';

interface SlackStatus {
  connected: boolean;
  valid?: boolean;
  slackWorkspace?: string;
  channels?: {
    broadcast: string | null;
    alerts: string | null;
  };
  connectedAt?: string;
}

export function SlackIntegrationPanel({ workspaceId }: { workspaceId: string }) {
  const { plan } = useSession();
  const [status, setStatus] = useState<SlackStatus | null>(null);
  const [channels, setChannels] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [configuring, setConfiguring] = useState(false);

  // Config form state
  const [broadcastChannel, setBroadcastChannel] = useState('');
  const [alertsChannel, setAlertsChannel] = useState('');
  const [showAgentToAgent, setShowAgentToAgent] = useState(true);

  useEffect(() => {
    loadStatus();
  }, [workspaceId]);

  async function loadStatus() {
    setLoading(true);
    try {
      const res = await api.get(`/api/integrations/slack/status?workspaceId=${workspaceId}`);
      setStatus(res.data);
      if (res.data.connected) {
        setBroadcastChannel(res.data.channels?.broadcast || '');
        setAlertsChannel(res.data.channels?.alerts || '');
        loadChannels();
      }
    } catch (error) {
      console.error('Failed to load Slack status', error);
    }
    setLoading(false);
  }

  async function loadChannels() {
    try {
      const res = await api.get(`/api/integrations/slack/channels?workspaceId=${workspaceId}`);
      setChannels(res.data.channels);
    } catch (error) {
      console.error('Failed to load channels', error);
    }
  }

  async function handleConnect() {
    try {
      const res = await api.get(`/api/integrations/slack/oauth/start?workspaceId=${workspaceId}`);
      window.location.href = res.data.authUrl;
    } catch (error) {
      console.error('Failed to start OAuth', error);
    }
  }

  async function handleDisconnect() {
    if (!confirm('Disconnect Slack integration?')) return;

    try {
      await api.post('/api/integrations/slack/disconnect', { workspaceId });
      setStatus({ connected: false });
    } catch (error) {
      console.error('Failed to disconnect', error);
    }
  }

  async function handleSaveConfig() {
    setConfiguring(true);
    try {
      await api.put('/api/integrations/slack/config', {
        workspaceId,
        broadcastChannel,
        alertsChannel,
        showAgentToAgent,
      });
      await loadStatus();
    } catch (error) {
      console.error('Failed to save config', error);
    }
    setConfiguring(false);
  }

  // Plan check
  if (plan === 'free') {
    return (
      <div className="slack-panel disabled">
        <h3>Slack Integration</h3>
        <p>Slack integration is available on Pro plans and above.</p>
        <a href="/pricing" className="upgrade-btn">Upgrade to Pro</a>
      </div>
    );
  }

  if (loading) {
    return <div className="slack-panel loading">Loading...</div>;
  }

  return (
    <div className="slack-panel">
      <h3>Slack Integration</h3>

      {!status?.connected ? (
        <div className="slack-connect">
          <p>Connect Slack to see agent messages in your workspace.</p>
          <button onClick={handleConnect} className="connect-btn">
            <SlackLogo /> Connect to Slack
          </button>
        </div>
      ) : (
        <div className="slack-connected">
          <div className="status-row">
            <span className={`status-dot ${status.valid ? 'green' : 'red'}`} />
            <span>Connected to <strong>{status.slackWorkspace}</strong></span>
            <button onClick={handleDisconnect} className="disconnect-btn">Disconnect</button>
          </div>

          <div className="config-section">
            <h4>Channel Configuration</h4>

            <label>
              Broadcast Channel
              <select value={broadcastChannel} onChange={e => setBroadcastChannel(e.target.value)}>
                <option value="">Select channel...</option>
                {channels.map(ch => (
                  <option key={ch.id} value={ch.id}>#{ch.name}</option>
                ))}
              </select>
            </label>

            <label>
              Alerts Channel (optional)
              <select value={alertsChannel} onChange={e => setAlertsChannel(e.target.value)}>
                <option value="">None</option>
                {channels.map(ch => (
                  <option key={ch.id} value={ch.id}>#{ch.name}</option>
                ))}
              </select>
            </label>

            <label className="checkbox">
              <input
                type="checkbox"
                checked={showAgentToAgent}
                onChange={e => setShowAgentToAgent(e.target.checked)}
              />
              Show agent-to-agent messages
            </label>

            <button onClick={handleSaveConfig} disabled={configuring}>
              {configuring ? 'Saving...' : 'Save Configuration'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

### 6.2 Integration into Settings Page

```typescript
// In src/dashboard/app/workspace/[id]/settings/page.tsx

import { SlackIntegrationPanel } from '@/react-components/SlackIntegrationPanel';

export default function WorkspaceSettings({ params }) {
  return (
    <div className="settings-page">
      <h2>Workspace Settings</h2>

      {/* Other settings... */}

      <section className="integrations-section">
        <h3>Integrations</h3>
        <SlackIntegrationPanel workspaceId={params.id} />
        {/* Future: Discord, Teams, etc. */}
      </section>
    </div>
  );
}
```

---

## 7. Implementation Phases

### Phase 1: Cloud Infrastructure (Days 1-2)

- [ ] Database schema and migration
- [ ] Slack OAuth API routes
- [ ] SlackService for token management
- [ ] Vault integration for credentials
- [ ] Plan limit middleware

### Phase 2: Daemon Bridge (Days 2-4)

- [ ] SlackBridge class (Slack ↔ Relay)
- [ ] Thread store for mapping
- [ ] Message formatter
- [ ] Orchestrator integration
- [ ] Cloud sync for credentials

### Phase 3: Dashboard UI (Days 4-5)

- [ ] SlackIntegrationPanel component
- [ ] OAuth flow UI
- [ ] Channel configuration
- [ ] Status display

### Phase 4: Testing & Polish (Days 5-7)

- [ ] Unit tests for services
- [ ] Integration tests
- [ ] E2E flow testing
- [ ] Documentation
- [ ] Error handling & edge cases

---

## 8. API Specifications

### 8.1 Cloud API Endpoints

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/api/integrations/slack/status` | Get integration status | Pro+ |
| GET | `/api/integrations/slack/oauth/start` | Start OAuth flow | Pro+ |
| GET | `/api/integrations/slack/oauth/callback` | OAuth callback | Pro+ |
| POST | `/api/integrations/slack/disconnect` | Remove integration | Pro+ |
| PUT | `/api/integrations/slack/config` | Update config | Pro+ |
| GET | `/api/integrations/slack/channels` | List Slack channels | Pro+ |
| GET | `/api/integrations/slack/daemon-config` | Get config for daemon | Internal |

### 8.2 Daemon Sync API

```typescript
// Called by daemon cloud-sync
GET /api/integrations/slack/daemon-config?workspaceId=xxx
Authorization: Bearer <daemon-token>

Response:
{
  "connected": true,
  "config": {
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "teamId": "T123",
    "teamName": "My Workspace",
    "broadcastChannel": "C456",
    "alertsChannel": null,
    "config": { "showAgentToAgent": true }
  }
}
```

---

## 9. Security & Plan Limits

### 9.1 Plan-Based Access

| Plan | Slack Integration |
|------|-------------------|
| Free | ❌ Not available |
| Pro | ✅ 1 Slack workspace |
| Team | ✅ 1 Slack workspace per relay workspace |
| Enterprise | ✅ Multiple + Enterprise Grid |

### 9.2 Credential Security (via Nango)

- **Encrypted storage**: Nango encrypts all tokens at rest (SOC 2 compliant)
- **Token refresh**: Automatic refresh before expiry, no manual logic needed
- **Revocation**: `nango.deleteConnection()` revokes and removes tokens
- **No local storage**: Credentials fetched on-demand, never written to disk
- **Audit logging**: Nango provides connection activity logs

### 9.3 Plan Limit Middleware

```typescript
// src/cloud/api/middleware/planLimits.ts

export function requireSlackAccess(req, res, next) {
  const plan = req.user.plan;

  if (plan === 'free') {
    return res.status(403).json({
      error: 'Slack integration requires Pro plan or above',
      upgrade: '/pricing',
    });
  }

  next();
}
```

---

## 10. Testing Strategy

### 10.1 Unit Tests

```typescript
// src/cloud/services/__tests__/slack.test.ts
describe('SlackService', () => {
  it('builds correct OAuth URL', () => { ... });
  it('validates tokens correctly', () => { ... });
  it('handles token revocation', () => { ... });
});

// src/daemon/__tests__/slack-bridge.test.ts
describe('SlackBridge', () => {
  it('forwards relay broadcasts to Slack', () => { ... });
  it('forwards Slack mentions to relay', () => { ... });
  it('maps threads bidirectionally', () => { ... });
  it('prevents message loops', () => { ... });
});
```

### 10.2 Integration Tests

```typescript
describe('Slack Integration E2E', () => {
  it('completes OAuth flow and stores credentials', async () => { ... });
  it('daemon receives credentials via cloud sync', async () => { ... });
  it('messages flow relay → slack → relay', async () => { ... });
});
```

---

## 11. Open Questions

### Q1: Slack App Distribution?

**Options:**
1. **Single Anthropic-owned app**: Users install our app
2. **Per-customer apps**: Customers create their own Slack apps
3. **Both**: Managed app for cloud, bring-your-own for self-hosted

**Recommendation:** Single managed app for cloud, instructions for self-hosted.

### Q2: Enterprise Grid Support?

Enterprise Grid requires org-level OAuth and cross-workspace routing.

**Recommendation:** Defer to v2, design schema to support it.

### Q3: Rate Limit Handling?

Slack has strict rate limits (1 msg/sec/channel).

**Recommendation:** Implement queue with backoff in SlackBridge.

---

## Summary

This revised proposal aligns Slack integration with the **cloud-first architecture** from PR #35:

| Component | Location | Purpose |
|-----------|----------|---------|
| OAuth & API | `src/cloud/api/integrations/slack.ts` | Cloud endpoints |
| Slack Service | `src/cloud/services/slack.ts` | Token retrieval via Nango |
| Credentials | Nango (external) | OAuth, storage, refresh |
| Database | `src/cloud/db/schema.ts` | Integration config (channels, settings) |
| Daemon Bridge | `src/daemon/slack-bridge.ts` | Message routing |
| Orchestrator | `src/daemon/orchestrator.ts` | Lifecycle management |
| Cloud Sync | `src/daemon/cloud-sync.ts` | Credential retrieval |
| Dashboard | `src/dashboard/react-components/` | Configuration UI |

The integration uses Nango for OAuth/credentials (same pattern planned for other providers like Discord, Teams), keeping our code focused on the Slack ↔ Relay bridge logic.
