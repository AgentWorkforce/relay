/**
 * Main OpenClaw <-> Relaycast adapter.
 *
 * Orchestrates the bridge: connects to both systems, maps agents,
 * and forwards messages bidirectionally.
 */

import { RelayCast } from '@relaycast/sdk';
import type { AgentClient, MessageWithMeta } from '@relaycast/sdk';
import { OpenClawClient } from './openclaw-client.js';
import { AgentMap } from './agent-map.js';
import type { OpenClawAdapterOptions } from './types.js';

const DEFAULT_CHANNEL = 'openclaw';
const DEFAULT_PREFIX = 'oc';
const DEFAULT_SYNC_INTERVAL_MS = 30_000;
const INBOX_POLL_INTERVAL_MS = 2_000;
const MAX_BUFFER_SIZE = 1_000;

export class OpenClawAdapter {
  private readonly options: Required<
    Pick<OpenClawAdapterOptions, 'gatewayUrl' | 'workspaceKey' | 'channel' | 'prefix' | 'syncIntervalMs' | 'debug'>
  > & Pick<OpenClawAdapterOptions, 'gatewayToken' | 'relaycastBaseUrl'>;

  private openclawClient!: OpenClawClient;
  private relay!: RelayCast;
  private bridgeClient!: AgentClient;
  private agentMap!: AgentMap;

  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private inboxTimer: ReturnType<typeof setInterval> | null = null;
  private messageBuffer: Array<{ channel: string; text: string; from: string }> = [];
  private lastSeenMessageId: string | null = null;
  private running = false;

  constructor(options: OpenClawAdapterOptions) {
    this.options = {
      gatewayUrl: options.gatewayUrl,
      gatewayToken: options.gatewayToken,
      workspaceKey: options.workspaceKey,
      relaycastBaseUrl: options.relaycastBaseUrl,
      channel: options.channel || DEFAULT_CHANNEL,
      prefix: options.prefix || DEFAULT_PREFIX,
      syncIntervalMs: options.syncIntervalMs || DEFAULT_SYNC_INTERVAL_MS,
      debug: options.debug || false,
    };
  }

  /** Start the adapter bridge */
  async start(): Promise<void> {
    this.log('Starting OpenClaw adapter...');

    // 1. Connect to OpenClaw gateway
    this.openclawClient = new OpenClawClient({
      url: this.options.gatewayUrl,
      token: this.options.gatewayToken,
      reconnect: true,
    });

    this.openclawClient.on('error', (err: Error) => {
      this.log(`OpenClaw error: ${err.message}`, 'error');
    });

    this.openclawClient.on('close', () => {
      this.log('OpenClaw gateway disconnected');
    });

    await this.openclawClient.connect();
    this.log(`Connected to OpenClaw gateway at ${this.options.gatewayUrl}`);

    // 2. Authenticate with Relaycast
    this.relay = new RelayCast({
      apiKey: this.options.workspaceKey,
      ...(this.options.relaycastBaseUrl && { baseUrl: this.options.relaycastBaseUrl }),
    });

    // 3. Register bridge agent in Relaycast and get an AgentClient
    const { token } = await this.relay.agent({
      name: 'openclaw-bridge',
      persona: 'OpenClaw gateway bridge — forwards messages between OpenClaw and Relaycast agents',
    });
    this.bridgeClient = this.relay.as(token);
    this.log('Registered as "openclaw-bridge" in Relaycast');

    // 4. Create/join dedicated channel
    try {
      await this.bridgeClient.channels.create({ name: this.options.channel });
    } catch {
      // Channel may already exist
    }
    await this.bridgeClient.channels.join(this.options.channel);
    this.log(`Joined #${this.options.channel} channel`);

    // 5. Initialize agent map and do initial sync
    this.agentMap = new AgentMap(this.relay, this.options.prefix);
    await this.syncAgents();

    // 6. Start message forwarding (OpenClaw -> Relaycast)
    this.openclawClient.on(
      'agent:output',
      (data: { sessionKey: string; text: string }) => {
        this.handleOpenClawOutput(data);
      },
    );

    // 7. Start periodic agent sync
    this.syncTimer = setInterval(() => {
      this.syncAgents().catch((err) =>
        this.log(`Agent sync failed: ${err}`, 'error'),
      );
    }, this.options.syncIntervalMs);

    // 8. Start Relaycast inbox polling (Relaycast -> OpenClaw)
    this.inboxTimer = setInterval(() => {
      this.pollRelaycastMessages().catch((err) =>
        this.log(`Message poll failed: ${err}`, 'error'),
      );
    }, INBOX_POLL_INTERVAL_MS);

    this.running = true;
    this.log('Adapter started successfully');
  }

  /** Stop the adapter and clean up */
  async stop(): Promise<void> {
    this.log('Stopping OpenClaw adapter...');
    this.running = false;

    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    if (this.inboxTimer) {
      clearInterval(this.inboxTimer);
      this.inboxTimer = null;
    }

    if (this.bridgeClient) {
      try {
        await this.bridgeClient.presence.markOffline();
      } catch {
        // Best effort
      }
    }

    await this.openclawClient.disconnect();
    this.log('Adapter stopped');
  }

  /** Whether the adapter is currently running */
  get isRunning(): boolean {
    return this.running;
  }

  // ── Private ─────────────────────────────────────────────────────

  /** Discover OpenClaw agents and sync with Relaycast */
  private async syncAgents(): Promise<void> {
    const agents = await this.openclawClient.listAgents();
    const mappings = await this.agentMap.sync(agents);

    // Update session keys from active sessions
    const sessions = await this.openclawClient.listSessions({ active: 1 });
    for (const session of sessions) {
      this.agentMap.updateSessionKey(session.agentId, session.key);
    }

    // Join mapped agents to the dedicated channel
    for (const mapping of mappings) {
      if (mapping.client) {
        try {
          await mapping.client.channels.join(this.options.channel);
        } catch {
          // Best effort
        }
      }
    }

    this.log(`Synced ${mappings.length} agent(s)`);
  }

  /** Forward OpenClaw agent output -> Relaycast channel */
  private handleOpenClawOutput(data: {
    sessionKey: string;
    text: string;
  }): void {
    // Find which agent produced this output
    const mapping = this.agentMap
      .all()
      .find((m) => m.sessionKey === data.sessionKey);

    if (!mapping) {
      this.log(`Ignoring output from unknown session: ${data.sessionKey}`);
      return;
    }

    // Post to Relaycast as the mapped agent (using their own client)
    const client = mapping.client || this.bridgeClient;
    client
      .send(this.options.channel, data.text)
      .catch((err: Error) => {
        this.log(
          `Failed to forward to Relaycast: ${err.message}`,
          'error',
        );
        // Buffer if Relaycast is down
        if (this.messageBuffer.length < MAX_BUFFER_SIZE) {
          this.messageBuffer.push({
            channel: this.options.channel,
            text: data.text,
            from: mapping.relaycastName,
          });
        }
      });
  }

  /** Poll Relaycast channel for messages targeting OpenClaw agents */
  private async pollRelaycastMessages(): Promise<void> {
    if (!this.running) return;

    const opts = this.lastSeenMessageId
      ? { after: this.lastSeenMessageId, limit: 50 }
      : { limit: 10 };

    const messages: MessageWithMeta[] = await this.bridgeClient.messages(
      this.options.channel,
      opts,
    );

    if (!messages || messages.length === 0) return;

    // Track the latest message ID for pagination
    this.lastSeenMessageId = messages[0].id;

    for (const msg of messages) {
      // Skip messages from bridge or from mapped agents (avoid loops)
      const authorName = msg.agentName ?? msg.agentId ?? '';
      if (
        authorName === 'openclaw-bridge' ||
        authorName.startsWith(`${this.options.prefix}-`)
      ) {
        continue;
      }

      // Check if message mentions an OpenClaw agent
      const mentionPattern = new RegExp(
        `@(${this.options.prefix}-\\S+)`,
        'g',
      );
      const text = msg.text ?? '';
      const mentions = text.match(mentionPattern);

      if (mentions) {
        for (const mention of mentions) {
          const agentName = mention.slice(1); // Remove @
          const mapping = this.agentMap.byRelaycastName(agentName);
          if (mapping && mapping.sessionKey) {
            try {
              await this.openclawClient.sendToSession(
                mapping.sessionKey,
                text,
              );
              this.log(
                `Forwarded message to OpenClaw session: ${mapping.sessionKey}`,
              );
            } catch (err) {
              this.log(
                `Failed to forward to OpenClaw: ${err}`,
                'error',
              );
            }
          } else if (mapping) {
            // No active session — try running the agent
            try {
              const { runId } = await this.openclawClient.runAgent(
                mapping.openclawId,
                text,
              );
              this.log(
                `Started agent run ${runId} for ${mapping.openclawId}`,
              );
            } catch (err) {
              this.log(`Failed to run OpenClaw agent: ${err}`, 'error');
            }
          }
        }
      }
    }

    // Flush buffered messages if we have connectivity
    await this.flushBuffer();
  }

  /** Retry sending buffered messages */
  private async flushBuffer(): Promise<void> {
    if (this.messageBuffer.length === 0) return;

    const toSend = [...this.messageBuffer];
    this.messageBuffer = [];

    for (const msg of toSend) {
      try {
        await this.bridgeClient.send(msg.channel, `[${msg.from}] ${msg.text}`);
      } catch {
        // Put back in buffer if still failing
        if (this.messageBuffer.length < MAX_BUFFER_SIZE) {
          this.messageBuffer.push(msg);
        }
        break; // Stop trying if Relaycast is still down
      }
    }
  }

  private log(message: string, level: 'info' | 'error' = 'info'): void {
    if (level === 'error' || this.options.debug) {
      const prefix = '[openclaw-adapter]';
      if (level === 'error') {
        console.error(`${prefix} ERROR: ${message}`);
      } else {
        console.log(`${prefix} ${message}`);
      }
    }
  }
}
