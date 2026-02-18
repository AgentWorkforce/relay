import {
  AgentRelayClient,
  ConsensusEngine,
  ShadowManager,
  createRelaycastClient,
  getLogs as getBrokerLogs,
  type AgentClient as RelaycastAgentClient,
  type AgentRuntime,
  type ListAgent,
  type LogsResult,
  type SendMessageInput,
  type SpeakOnTrigger,
  type SpawnPtyInput,
} from '@agent-relay/broker-sdk';
import os from 'node:os';
import path from 'node:path';

export interface AckPayload {
  ack_id: string;
  seq: number;
  correlationId?: string;
  response?: string;
  responseData?: unknown;
}

export interface QueryMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  channel?: string;
  thread?: string;
  timestamp: number;
  status?: string;
  isBroadcast?: boolean;
  replyCount?: number;
  data?: Record<string, unknown>;
}

export interface MessagesResponse {
  messages: QueryMessage[];
}

export interface HealthResponse {
  healthScore: number;
  summary: string;
  issues: Array<{ severity: string; message: string }>;
  recommendations: string[];
  crashes: Array<{
    id: string;
    agentName: string;
    crashedAt: string;
    likelyCause: string;
    summary?: string;
  }>;
  alerts: Array<{
    id: string;
    agentName: string;
    alertType: string;
    message: string;
    createdAt: string;
  }>;
  stats: {
    totalCrashes24h: number;
    totalAlerts24h: number;
    agentCount: number;
  };
}

export interface MetricsResponse {
  agents: Array<{
    name: string;
    pid?: number;
    status: string;
    rssBytes?: number;
    cpuPercent?: number;
    trend?: string;
    alertLevel?: string;
    highWatermark?: number;
    uptimeMs?: number;
  }>;
  system: {
    totalMemory: number;
    freeMemory: number;
    heapUsed: number;
  };
}

export interface AgentInfo {
  name: string;
  cli?: string;
  idle?: boolean;
  parent?: string;
  task?: string;
  team?: string;
  pid?: number;
  connectedAt?: number;
}

export interface InboxMessage {
  id: string;
  from: string;
  body: string;
  channel?: string;
  thread?: string;
  timestamp: number;
}

export interface SpawnResult {
  success: boolean;
  error?: string;
  name?: string;
  runtime?: AgentRuntime;
}

export interface ReleaseResultPayload {
  success: boolean;
  error?: string;
  name?: string;
}

export interface WorkspaceStats {
  agents?: {
    total?: number;
    online?: number;
    offline?: number;
  };
  channels?: {
    total?: number;
    archived?: number;
  };
  messages?: {
    total?: number;
    today?: number;
  };
  dms?: {
    total_conversations?: number;
  };
  files?: {
    total?: number;
    storage_bytes?: number;
  };
}

export interface RelayClient {
  send(to: string, message: string, options?: { thread?: string; kind?: string; data?: Record<string, unknown> }): Promise<void>;
  sendAndWait(
    to: string,
    message: string,
    options?: { thread?: string; timeoutMs?: number; kind?: string; data?: Record<string, unknown> }
  ): Promise<AckPayload>;
  sendMessage(input: SendMessageInput): Promise<{ event_id: string; targets: string[] }>;
  broadcast(message: string, options?: { kind?: string; data?: Record<string, unknown> }): Promise<void>;

  spawn(options: { name: string; cli: string; task?: string; model?: string; cwd?: string }): Promise<SpawnResult>;
  spawnPty(options: SpawnPtyInput): Promise<{ name: string; runtime: AgentRuntime }>;
  release(name: string, reason?: string): Promise<ReleaseResultPayload>;
  setModel(name: string, model: string, options?: { timeoutMs?: number }): Promise<{
    success: boolean;
    name: string;
    model: string;
    previousModel?: string;
    error?: string;
  }>;
  setWorkerModel(name: string, model: string, options?: { timeoutMs?: number }): Promise<{
    success: boolean;
    name: string;
    model: string;
    previousModel?: string;
    error?: string;
  }>;

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
  getHealth(options?: { include_crashes?: boolean; include_alerts?: boolean }): Promise<HealthResponse>;
  getMetrics(options?: { agent?: string }): Promise<MetricsResponse>;

  queryMessages(options?: {
    limit?: number;
    sinceTs?: number;
    since_ts?: number;
    from?: string;
    to?: string;
    thread?: string;
    order?: 'asc' | 'desc';
  }): Promise<QueryMessage[]>;

  getLogs(agent: string, options?: { lines?: number }): Promise<LogsResult>;
  sendLog(data: string): Promise<void>;
  shutdown(): Promise<void>;
}

export interface RelayClientAdapterOptions {
  agentName: string;
  project?: string;
  projectRoot?: string;
  socketPath?: string;
}

export interface RelayClientOptions extends RelayClientAdapterOptions {
  quiet?: boolean;
  timeout?: number;
  binaryPath?: string;
  binaryArgs?: string[];
}

const DEFAULT_CHANNEL = 'general';
const SUPPORTED_SPEAK_ON = new Set<SpeakOnTrigger>([
  'ALL_MESSAGES',
  'EXPLICIT_ASK',
  'SESSION_END',
  'CODE_WRITTEN',
  'REVIEW_REQUEST',
]);

function getProjectRoot(ctx: RelayClientAdapterOptions): string {
  return ctx.projectRoot ?? ctx.project ?? process.cwd();
}

function getSocketPath(ctx: RelayClientAdapterOptions, projectRoot: string): string {
  return ctx.socketPath ?? path.join(projectRoot, '.agent-relay', 'relay.sock');
}

function getLogsDir(projectRoot: string): string {
  return path.join(projectRoot, '.agent-relay', 'worker-logs');
}

function boolResult(ok: boolean, action: string): { success: boolean; error?: string } {
  return ok ? { success: true } : { success: false, error: `Failed to ${action}` };
}

function unsupported(action: string): { success: boolean; error?: string } {
  return { success: false, error: `${action} is not supported by @agent-relay/broker-sdk` };
}

function toAgentInfo(agent: ListAgent): AgentInfo {
  return {
    name: agent.name,
    cli: agent.runtime === 'headless_claude' ? 'claude' : 'pty',
    idle: false,
    parent: agent.parent,
    pid: agent.pid,
  };
}

function normalizeSpeakOn(speakOn?: string[]): SpeakOnTrigger[] | undefined {
  if (!speakOn || speakOn.length === 0) {
    return undefined;
  }
  const valid = speakOn.filter((item): item is SpeakOnTrigger => SUPPORTED_SPEAK_ON.has(item as SpeakOnTrigger));
  return valid.length > 0 ? valid : undefined;
}

function normalizeVote(value: string, options?: string[]): 'approve' | 'reject' | 'abstain' {
  const lowered = value.toLowerCase();
  if (lowered === 'approve' || lowered === 'yes' || lowered === 'y') return 'approve';
  if (lowered === 'reject' || lowered === 'no' || lowered === 'n') return 'reject';
  if (lowered === 'abstain') return 'abstain';

  if (options && options.length > 0) {
    if (value === options[0]) return 'approve';
    if (value === options[options.length - 1]) return 'reject';
  }

  return 'abstain';
}

function toMetricsResponse(raw: {
  agents: Array<{ name: string; pid: number; memory_bytes: number; uptime_secs: number }>;
}): MetricsResponse {
  return {
    agents: raw.agents.map((agent) => ({
      name: agent.name,
      pid: agent.pid,
      status: 'active',
      rssBytes: agent.memory_bytes,
      uptimeMs: agent.uptime_secs * 1000,
    })),
    system: {
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      heapUsed: process.memoryUsage().heapUsed,
    },
  };
}

function toHealthResponse(stats: WorkspaceStats): HealthResponse {
  const totalAgents = stats.agents?.total ?? 0;
  const onlineAgents = stats.agents?.online ?? 0;
  const offlineAgents = stats.agents?.offline ?? Math.max(totalAgents - onlineAgents, 0);
  const healthScore = totalAgents === 0 ? 100 : Math.round((onlineAgents / totalAgents) * 100);

  const issues: HealthResponse['issues'] = [];
  const recommendations: string[] = [];

  if (offlineAgents > 0) {
    issues.push({
      severity: offlineAgents > 2 ? 'high' : 'medium',
      message: `${offlineAgents} agent(s) are currently offline`,
    });
    recommendations.push('Check offline agents and restart workers as needed.');
  }

  if (issues.length === 0) {
    recommendations.push('No immediate action needed.');
  }

  return {
    healthScore,
    summary: `${onlineAgents}/${totalAgents} agents online`,
    issues,
    recommendations,
    crashes: [],
    alerts: [],
    stats: {
      totalCrashes24h: 0,
      totalAlerts24h: 0,
      agentCount: totalAgents,
    },
  };
}

function toInboxMessages(inbox: {
  mentions?: Array<{ id: string; channel_name: string; agent_name: string; text: string; created_at: string }>;
  unread_dms?: Array<{ conversation_id: string; from: string; unread_count: number; last_message: string | null }>;
  unread_channels?: Array<{ channel_name: string; unread_count: number }>;
}): InboxMessage[] {
  const now = Date.now();
  const fromMentions = (inbox.mentions ?? []).map((item) => ({
    id: item.id,
    from: item.agent_name,
    body: item.text,
    channel: item.channel_name,
    timestamp: Date.parse(item.created_at) || now,
  }));
  const fromDms = (inbox.unread_dms ?? []).map((item, index) => ({
    id: `dm:${item.conversation_id}:${index}`,
    from: item.from,
    body: item.last_message ?? `${item.unread_count} unread DM message(s)`,
    timestamp: now,
  }));
  const fromChannels = (inbox.unread_channels ?? []).map((item, index) => ({
    id: `channel:${item.channel_name}:${index}`,
    from: item.channel_name,
    body: `${item.unread_count} unread message(s)`,
    channel: item.channel_name,
    timestamp: now,
  }));
  return [...fromMentions, ...fromDms, ...fromChannels];
}

function parseError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function getRelaycastAgentClient(cache: { client?: Promise<RelaycastAgentClient> }, agentName: string): Promise<RelaycastAgentClient> {
  if (!cache.client) {
    cache.client = createRelaycastClient({ agentName }).catch((err) => {
      cache.client = undefined;
      throw err;
    });
  }
  return cache.client;
}

export function createRelayClientAdapter(client: AgentRelayClient, ctx: RelayClientAdapterOptions): RelayClient {
  const projectRoot = getProjectRoot(ctx);
  const socketPath = getSocketPath(ctx, projectRoot);
  const logsDir = getLogsDir(projectRoot);
  const shadowManager = new ShadowManager();
  const consensus = new ConsensusEngine();
  const proposalIdMap = new Map<string, string>();
  const relaycastCache: { client?: Promise<RelaycastAgentClient> } = {};

  const sendMessage = async (input: SendMessageInput): Promise<{ event_id: string; targets: string[] }> =>
    client.sendMessage({
      ...input,
      from: input.from ?? ctx.agentName,
    });

  const setModel = async (name: string, model: string, options: { timeoutMs?: number } = {}) => {
    try {
      const result = await client.setModel(name, model, options);
      return {
        success: result.success,
        name: result.name,
        model: result.model,
      };
    } catch (error) {
      return {
        success: false,
        name,
        model,
        error: parseError(error),
      };
    }
  };

  return {
    async send(to, message, options = {}) {
      await sendMessage({
        to,
        text: message,
        threadId: options.thread,
      });
    },

    async sendAndWait(to, message, options = {}) {
      const sent = await sendMessage({
        to,
        text: message,
        threadId: options.thread,
      });
      return {
        ack_id: sent.event_id,
        seq: 0,
        correlationId: sent.event_id,
        response: 'OK',
        responseData: { eventId: sent.event_id, targets: sent.targets },
      };
    },

    sendMessage,

    async broadcast(message) {
      await sendMessage({
        to: '*',
        text: message,
      });
    },

    async spawn(options) {
      try {
        const result = await client.spawnPty({
          name: options.name,
          cli: options.cli,
          task: options.task,
          model: options.model,
          cwd: options.cwd,
          channels: [DEFAULT_CHANNEL],
        });
        return {
          success: true,
          name: result.name,
          runtime: result.runtime,
        };
      } catch (error) {
        return {
          success: false,
          error: parseError(error),
        };
      }
    },

    async spawnPty(options) {
      return client.spawnPty({
        ...options,
        channels: options.channels ?? [DEFAULT_CHANNEL],
      });
    },

    async release(name, reason) {
      try {
        const result = await client.release(name, reason);
        return { success: true, name: result.name };
      } catch (error) {
        return { success: false, error: parseError(error), name };
      }
    },

    setModel,

    setWorkerModel: setModel,

    async subscribe() {
      return unsupported('subscribe');
    },

    async unsubscribe() {
      return unsupported('unsubscribe');
    },

    async joinChannel() {
      return unsupported('join channel');
    },

    async leaveChannel() {
      return unsupported('leave channel');
    },

    async sendChannelMessage(channel, message, options = {}) {
      await sendMessage({
        to: channel,
        text: message,
        threadId: options.thread,
      });
    },

    async adminJoinChannel() {
      return unsupported('admin channel join');
    },

    async adminRemoveMember() {
      return unsupported('admin remove member');
    },

    async bindAsShadow(primaryAgent, options = {}) {
      try {
        const speakOn = normalizeSpeakOn(options.speakOn);
        shadowManager.bind(ctx.agentName, primaryAgent, speakOn ? { speakOn } : {});
        return { success: true };
      } catch (error) {
        return { success: false, error: parseError(error) };
      }
    },

    async unbindAsShadow(primaryAgent) {
      const boundPrimary = shadowManager.getPrimaryFor(ctx.agentName);
      if (!boundPrimary) {
        return boolResult(true, 'unbind shadow');
      }
      if (boundPrimary !== primaryAgent) {
        return { success: false, error: `Shadow is bound to "${boundPrimary}", not "${primaryAgent}"` };
      }
      shadowManager.unbind(ctx.agentName);
      return { success: true };
    },

    async createProposal(options) {
      try {
        const participants = (await client.listAgents()).map((agent) => agent.name);
        if (!participants.includes(ctx.agentName)) {
          participants.push(ctx.agentName);
        }

        const proposal = consensus.createProposal({
          title: options.id,
          description: options.description,
          proposer: ctx.agentName,
          participants,
          consensusType: options.votingMethod as 'majority' | 'supermajority' | 'unanimous' | 'weighted' | 'quorum' | undefined,
          timeoutMs: options.deadline ? Math.max(options.deadline - Date.now(), 1000) : undefined,
          metadata: {
            requestedId: options.id,
            options: options.options,
          },
        });

        proposalIdMap.set(options.id, proposal.id);
        return { success: true };
      } catch (error) {
        return { success: false, error: parseError(error) };
      }
    },

    async vote(options) {
      try {
        const proposalId = proposalIdMap.get(options.proposalId) ?? options.proposalId;
        const proposal = consensus.getProposal(proposalId);
        if (!proposal) {
          return { success: false, error: `Proposal "${options.proposalId}" not found` };
        }

        const configuredOptions = Array.isArray(proposal.metadata?.options)
          ? (proposal.metadata.options as string[])
          : undefined;
        const voteValue = normalizeVote(options.vote, configuredOptions);
        const result = consensus.vote(proposalId, ctx.agentName, voteValue, options.reason);
        return result.success ? { success: true } : { success: false, error: result.error };
      } catch (error) {
        return { success: false, error: parseError(error) };
      }
    },

    async getStatus() {
      try {
        await client.getStatus();
        return {
          connected: true,
          agentName: ctx.agentName,
          project: projectRoot,
          socketPath,
          daemonVersion: 'broker-sdk',
        };
      } catch {
        return {
          connected: false,
          agentName: ctx.agentName,
          project: projectRoot,
          socketPath,
        };
      }
    },

    async getInbox(options = {}) {
      const relaycast = await getRelaycastAgentClient(relaycastCache, ctx.agentName);
      const inbox = await relaycast.inbox();
      let messages = toInboxMessages(inbox);

      if (options.from) {
        messages = messages.filter((message) => message.from === options.from);
      }
      if (options.channel) {
        messages = messages.filter((message) => message.channel === options.channel);
      }
      const limit = options.limit ?? 10;
      messages = messages.slice(0, limit);

      return messages.map((message) => ({
        id: message.id,
        from: message.from,
        content: message.body,
        channel: message.channel,
        thread: message.thread,
      }));
    },

    async listAgents() {
      const agents = await client.listAgents();
      return agents.map(toAgentInfo);
    },

    async listConnectedAgents() {
      const agents = await client.listAgents();
      return agents.map(toAgentInfo);
    },

    async removeAgent() {
      return {
        success: false,
        removed: false,
        message: 'removeAgent is not supported by @agent-relay/broker-sdk',
      };
    },

    async getHealth() {
      try {
        const relaycast = await getRelaycastAgentClient(relaycastCache, ctx.agentName);
        const stats = await relaycast.client.get<WorkspaceStats>('/v1/workspace/stats');
        return toHealthResponse(stats);
      } catch (error) {
        return {
          healthScore: 0,
          summary: 'Unable to query workspace health',
          issues: [{ severity: 'critical', message: parseError(error) }],
          recommendations: ['Set RELAY_API_KEY or ~/.agent-relay/relaycast.json to enable cloud health checks.'],
          crashes: [],
          alerts: [],
          stats: {
            totalCrashes24h: 0,
            totalAlerts24h: 0,
            agentCount: 0,
          },
        };
      }
    },

    async getMetrics(options = {}) {
      const metrics = await client.getMetrics(options.agent);
      return toMetricsResponse(metrics);
    },

    async queryMessages() {
      return [];
    },

    async getLogs(agent, options = {}) {
      return getBrokerLogs(agent, {
        logsDir,
        lines: options.lines,
      });
    },

    async sendLog(data: string) {
      await sendMessage({
        to: '#logs',
        text: data,
      });
    },

    async shutdown() {
      await client.shutdown();
    },
  };
}

/**
 * Factory that creates a broker SDK AgentRelayClient and wraps it with the MCP adapter.
 */
export function createRelayClient(options: RelayClientOptions): RelayClient {
  const projectRoot = options.projectRoot ?? options.project ?? process.cwd();
  const brokerClient = new AgentRelayClient({
    brokerName: options.project ?? options.agentName,
    channels: [DEFAULT_CHANNEL],
    cwd: projectRoot,
    requestTimeoutMs: options.timeout,
    binaryPath: options.binaryPath,
    binaryArgs: options.binaryArgs,
    clientName: options.agentName,
    clientVersion: 'mcp',
  });

  return createRelayClientAdapter(brokerClient, {
    agentName: options.agentName,
    project: options.project,
    projectRoot,
    socketPath: options.socketPath,
  });
}
