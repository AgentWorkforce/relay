import { RelayClient as SdkRelayClient, type AckPayload, type AgentInfo, type HealthResponsePayload, type InboxMessage, type MetricsResponsePayload, type MessagesResponsePayload, type SpawnResult, type ReleaseResultPayload } from '@agent-relay/sdk';
import { PROTOCOL_VERSION, type Envelope } from '@agent-relay/protocol';
import { randomUUID } from 'node:crypto';

export type QueryMessage = MessagesResponsePayload['messages'][number];
export type HealthResponse = HealthResponsePayload;
export type MetricsResponse = MetricsResponsePayload;
export type MessagesResponse = MessagesResponsePayload;

export interface RelayClient {
  send(to: string, message: string, options?: { thread?: string; kind?: string; data?: Record<string, unknown> }): Promise<void>;
  sendAndWait(
    to: string,
    message: string,
    options?: { thread?: string; timeoutMs?: number; kind?: string; data?: Record<string, unknown> }
  ): Promise<AckPayload>;
  broadcast(message: string, options?: { kind?: string; data?: Record<string, unknown> }): Promise<void>;

  spawn(options: { name: string; cli: string; task?: string; model?: string; cwd?: string }): Promise<SpawnResult>;
  release(name: string, reason?: string): Promise<ReleaseResultPayload>;

  subscribe(topic: string): Promise<{ success: boolean; error?: string }>;
  unsubscribe(topic: string): Promise<{ success: boolean; error?: string }>;

  joinChannel(channel: string, displayName?: string): Promise<{ success: boolean; error?: string }>;
  leaveChannel(channel: string, reason?: string): Promise<{ success: boolean; error?: string }>;
  sendChannelMessage(channel: string, message: string, options?: { thread?: string }): Promise<void>;
  adminJoinChannel(channel: string, member: string): Promise<{ success: boolean; error?: string }>;
  adminRemoveMember(channel: string, member: string): Promise<{ success: boolean; error?: string }>;

  bindAsShadow(primaryAgent: string, options?: { speakOn?: string[] }): Promise<{ success: boolean; error?: string }>;
  unbindAsShadow(primaryAgent: string): Promise<{ success: boolean; error?: string }>;

  createProposal(options: {
    id: string;
    description: string;
    options: string[];
    votingMethod?: string;
    deadline?: number;
  }): Promise<{ success: boolean; error?: string }>;

  vote(options: { proposalId: string; vote: string; reason?: string }): Promise<{ success: boolean; error?: string }>;

  getStatus(): Promise<{
    connected: boolean;
    agentName: string;
    project: string;
    socketPath: string;
    daemonVersion?: string;
    uptime?: string;
  }>;

  getInbox(options?: { limit?: number; unread_only?: boolean; from?: string; channel?: string }): Promise<
    Array<{
      id: string;
      from: string;
      content: string;
      channel?: string;
      thread?: string;
    }>
  >;

  listAgents(options?: { include_idle?: boolean; project?: string }): Promise<AgentInfo[]>;
  listConnectedAgents(options?: { project?: string }): Promise<AgentInfo[]>;
  removeAgent(name: string, options?: { removeMessages?: boolean }): Promise<{ success: boolean; removed: boolean; message?: string }>;
  getHealth(options?: { include_crashes?: boolean; include_alerts?: boolean }): Promise<HealthResponsePayload>;
  getMetrics(options?: { agent?: string }): Promise<MetricsResponsePayload>;

  queryMessages(options?: {
    limit?: number;
    sinceTs?: number;
    since_ts?: number;
    from?: string;
    to?: string;
    thread?: string;
    order?: 'asc' | 'desc';
  }): Promise<QueryMessage[]>;

  sendLog(data: string): Promise<void>;
}

export interface RelayClientAdapterOptions {
  agentName: string;
  project?: string;
  projectRoot?: string;
  socketPath?: string;
}

async function ensureReady(client: SdkRelayClient): Promise<void> {
  if ((client as any).state !== 'READY') {
    await client.connect();
  }
}

function boolResult(ok: boolean, action: string): { success: boolean; error?: string } {
  return ok ? { success: true } : { success: false, error: `Failed to ${action}` };
}

export function createRelayClientAdapter(client: SdkRelayClient, ctx: RelayClientAdapterOptions): RelayClient {
  const project = ctx.projectRoot ?? ctx.project ?? 'default';
  const socketPath = ctx.socketPath ?? '';

  return {
    async send(to, message, opts = {}) {
      await ensureReady(client);
      const ok = client.sendMessage(to, message, (opts.kind as any) ?? 'message', opts.data, opts.thread);
      if (!ok) throw new Error('Failed to send message');
    },

    async sendAndWait(to, message, opts = {}) {
      await ensureReady(client);
      return client.sendAndWait(to, message, {
        thread: opts.thread,
        timeoutMs: opts.timeoutMs,
        kind: opts.kind as any,
        data: opts.data,
      });
    },

    async broadcast(message, opts = {}) {
      await ensureReady(client);
      const ok = client.broadcast(message, (opts.kind as any) ?? 'message', opts.data);
      if (!ok) throw new Error('Failed to broadcast message');
    },

    async subscribe(topic) {
      await ensureReady(client);
      const ok = client.subscribe(topic);
      return boolResult(ok, 'subscribe');
    },

    async unsubscribe(topic) {
      await ensureReady(client);
      const ok = client.unsubscribe(topic);
      return boolResult(ok, 'unsubscribe');
    },

    async joinChannel(channel, displayName) {
      await ensureReady(client);
      const ok = client.joinChannel(channel, displayName);
      return boolResult(ok, 'join channel');
    },

    async leaveChannel(channel, reason) {
      await ensureReady(client);
      const ok = client.leaveChannel(channel, reason);
      return boolResult(ok, 'leave channel');
    },

    async sendChannelMessage(channel, message, options = {}) {
      await ensureReady(client);
      const ok = client.sendChannelMessage(channel, message, { thread: options.thread });
      if (!ok) throw new Error('Failed to send channel message');
    },

    async adminJoinChannel(channel, member) {
      await ensureReady(client);
      const ok = client.adminJoinChannel(channel, member);
      return boolResult(ok, 'add member to channel');
    },

    async adminRemoveMember(channel, member) {
      await ensureReady(client);
      const ok = client.adminRemoveMember(channel, member);
      return boolResult(ok, 'remove member from channel');
    },

    async bindAsShadow(primaryAgent, opts = {}) {
      await ensureReady(client);
      const ok = client.bindAsShadow(primaryAgent, { speakOn: opts.speakOn as any });
      return boolResult(ok, 'bind as shadow');
    },

    async unbindAsShadow(primaryAgent) {
      await ensureReady(client);
      const ok = client.unbindAsShadow(primaryAgent);
      return boolResult(ok, 'unbind shadow');
    },

    async createProposal(opts) {
      await ensureReady(client);
      const envelope: Envelope = {
        v: PROTOCOL_VERSION,
        type: 'PROPOSAL_CREATE',
        id: randomUUID(),
        ts: Date.now(),
        payload: {
          id: opts.id,
          description: opts.description,
          options: opts.options,
          votingMethod: opts.votingMethod ?? 'majority',
          deadline: opts.deadline,
        },
      };

      const ok = (client as any).send?.(envelope) ?? false;
      return boolResult(ok, 'create proposal');
    },

    async vote(opts) {
      await ensureReady(client);
      const envelope: Envelope = {
        v: PROTOCOL_VERSION,
        type: 'VOTE',
        id: randomUUID(),
        ts: Date.now(),
        payload: {
          proposalId: opts.proposalId,
          vote: opts.vote,
          reason: opts.reason,
        },
      };

      const ok = (client as any).send?.(envelope) ?? false;
      return boolResult(ok, 'vote');
    },

    async spawn(options) {
      await ensureReady(client);
      return client.spawn(options);
    },

    async release(name, reason) {
      await ensureReady(client);
      return client.release(name, reason);
    },

    async getStatus() {
      try {
        await ensureReady(client);
        const status = await client.getStatus();
        return {
          connected: true,
          agentName: ctx.agentName,
          project,
          socketPath,
          daemonVersion: status.version,
          uptime: status.uptime ? `${Math.floor(status.uptime / 1000)}s` : undefined,
        };
      } catch {
        return {
          connected: false,
          agentName: ctx.agentName,
          project,
          socketPath,
        };
      }
    },

    async getInbox(options = {}) {
      await ensureReady(client);
      const messages: InboxMessage[] = await client.getInbox({
        limit: options.limit,
        unreadOnly: options.unread_only,
        from: options.from,
        channel: options.channel,
      });

      return messages.map((m) => ({
        id: m.id,
        from: m.from,
        content: m.body,
        channel: m.channel,
        thread: m.thread,
      }));
    },

    async listAgents(options = {}) {
      await ensureReady(client);
      return client.listAgents({
        includeIdle: options.include_idle,
        project: options.project,
      });
    },

    async listConnectedAgents(options = {}) {
      await ensureReady(client);
      return client.listConnectedAgents({
        project: options.project,
      });
    },

    async removeAgent(name, options = {}) {
      await ensureReady(client);
      return client.removeAgent(name, { removeMessages: options.removeMessages });
    },

    async getHealth(options = {}) {
      await ensureReady(client);
      return client.getHealth({
        includeCrashes: options.include_crashes,
        includeAlerts: options.include_alerts,
      });
    },

    async getMetrics(options = {}) {
      await ensureReady(client);
      return client.getMetrics({ agent: options.agent });
    },

    async queryMessages(options = {}) {
      await ensureReady(client);
      const response = await client.queryMessages({
        limit: options.limit,
        sinceTs: options.sinceTs ?? options.since_ts,
        from: options.from,
        to: options.to,
        thread: options.thread,
        order: options.order,
      });
      return response || [];
    },

    async sendLog(data: string) {
      await ensureReady(client);
      const ok = client.sendLog(data);
      if (!ok) throw new Error('Failed to send log');
    },
  };
}

export interface RelayClientOptions {
  agentName: string;
  socketPath?: string;
  project?: string;
  quiet?: boolean;
  timeout?: number;
}

/**
 * Factory that creates an SDK RelayClient and wraps it with the MCP adapter.
 */
export function createRelayClient(options: RelayClientOptions): RelayClient {
  const sdkClient = new SdkRelayClient({
    agentName: options.agentName,
    socketPath: options.socketPath,
    quiet: options.quiet,
    reconnect: true,
  });

  return createRelayClientAdapter(sdkClient, {
    agentName: options.agentName,
    project: options.project,
    socketPath: options.socketPath,
  });
}
