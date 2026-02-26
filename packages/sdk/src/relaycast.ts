import { randomBytes } from 'node:crypto';
import { RelayCast, RelayError, type AgentClient } from '@relaycast/sdk';

export type { AgentClient } from '@relaycast/sdk';

// ── Simple function-based API (PR refactor) ─────────────────────────────────

export interface CreateRelaycastClientOptions {
  apiKey?: string;
  baseUrl?: string;
  agentName?: string;
  /** Relaycast registration type. Defaults to "agent". */
  agentType?: 'agent' | 'human';
}

/**
 * Create an authenticated @relaycast/sdk AgentClient.
 * Handles API key resolution (options > RELAY_API_KEY env) and agent registration
 * with 409 conflict retry.
 */
export async function createRelaycastClient(
  options: CreateRelaycastClientOptions = {}
): Promise<AgentClient> {
  const baseUrl = options.baseUrl ?? process.env.RELAYCAST_BASE_URL ?? 'https://api.relaycast.dev';
  const agentName = options.agentName ?? `sdk-${randomBytes(4).toString('hex')}`;
  const agentType = options.agentType ?? 'agent';

  const apiKey = options.apiKey ?? process.env.RELAY_API_KEY;
  if (!apiKey) {
    throw new Error('Relaycast API key not found in options or RELAY_API_KEY env var');
  }

  const relay = new RelayCast({ apiKey, baseUrl });

  // Register with 409 conflict retry
  let name = agentName;
  let registration;
  try {
    registration = await relay.agents.register({ name, type: agentType });
  } catch (err) {
    if (err instanceof RelayError && err.code === 'name_conflict') {
      name = `${agentName}-${randomBytes(4).toString('hex')}`;
      registration = await relay.agents.register({ name, type: agentType });
    } else {
      throw err;
    }
  }

  return relay.as(registration.token);
}

// ── Class-based API (used by workflows/runner) ──────────────────────────────

export interface RelaycastWorkspace {
  workspaceId: string;
  apiKey: string;
}

export interface RelaycastApiOptions {
  /** Workspace API key. If omitted, falls back to RELAY_API_KEY env var. */
  apiKey?: string;
  baseUrl?: string;
  /** Agent name to register with. Defaults to a unique "sdk-<hex>" name. */
  agentName?: string;
}

const DEFAULT_BASE_URL = 'https://api.relaycast.dev';

/**
 * Convenience wrapper around `@relaycast/sdk` that manages workspace
 * creation, agent registration, and message sending.
 */
export class RelaycastApi {
  private readonly baseUrl: string;
  private readonly agentName: string;
  private readonly apiKeyOverride?: string;
  private agentClient?: AgentClient;

  constructor(options: RelaycastApiOptions = {}) {
    this.baseUrl = options.baseUrl ?? process.env.RELAYCAST_BASE_URL ?? DEFAULT_BASE_URL;
    this.agentName = options.agentName ?? `sdk-${randomBytes(4).toString('hex')}`;
    this.apiKeyOverride = options.apiKey;
  }

  /**
   * Create a new Relaycast workspace. Returns the workspace ID and API key.
   * No authentication required — this is the bootstrap entry point.
   */
  static async createWorkspace(name: string, baseUrl = DEFAULT_BASE_URL): Promise<RelaycastWorkspace> {
    const res = await fetch(`${baseUrl}/v1/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      throw new Error(`Failed to create workspace: ${res.status} ${await res.text()}`);
    }
    const body = await res.json();
    const data = body.data ?? body;
    const workspaceId = data.workspace_id ?? data.id;
    const apiKey = data.api_key;
    if (!workspaceId || !apiKey) {
      throw new Error('Workspace response missing workspace_id or api_key');
    }
    return { workspaceId, apiKey };
  }

  /** Resolve the workspace API key from explicit option or RELAY_API_KEY env. */
  private resolveApiKey(): string {
    const key = this.apiKeyOverride ?? process.env.RELAY_API_KEY;
    if (!key) {
      throw new Error('No Relaycast API key found. Pass apiKey option or set RELAY_API_KEY env var.');
    }
    return key;
  }

  /** Lazily register and return an authenticated AgentClient. */
  private async ensure(): Promise<AgentClient> {
    if (this.agentClient) return this.agentClient;

    const apiKey = this.resolveApiKey();
    const relay = new RelayCast({ apiKey, baseUrl: this.baseUrl });

    // Register — retry with a suffixed name on 409 conflict.
    let name = this.agentName;
    let registration;
    try {
      registration = await relay.agents.register({ name, type: 'agent' });
    } catch (err) {
      if (err instanceof RelayError && err.code === 'name_conflict') {
        name = `${this.agentName}-${randomBytes(4).toString('hex')}`;
        registration = await relay.agents.register({ name, type: 'agent' });
      } else {
        throw err;
      }
    }

    this.agentClient = relay.as(registration.token);
    return this.agentClient;
  }

  /** Send a direct message to a named agent. */
  async sendDm(to: string, text: string): Promise<void> {
    const agent = await this.ensure();
    await agent.dm(to, text);
  }

  /** Send a message to a channel (without the leading #). */
  async sendToChannel(channel: string, text: string): Promise<void> {
    const agent = await this.ensure();
    await agent.send(channel, text);
  }

  /** Send to a target — prefixed with # for channel, otherwise DM. */
  async send(to: string, text: string): Promise<void> {
    if (to.startsWith('#')) {
      await this.sendToChannel(to.slice(1), text);
    } else {
      await this.sendDm(to, text);
    }
  }

  /** Create a channel. No-op if it already exists. */
  async createChannel(name: string, topic?: string): Promise<void> {
    const agent = await this.ensure();
    try {
      await agent.channels.create({ name, ...(topic ? { topic } : {}) });
    } catch (err) {
      // Ignore "already exists" errors
      if (err instanceof RelayError && err.code === 'name_conflict') {
        return;
      }
      throw err;
    }
  }

  /** Join a channel. Idempotent. */
  async joinChannel(name: string): Promise<void> {
    const agent = await this.ensure();
    await agent.channels.join(name);
  }

  /** Invite another agent to a channel. */
  async inviteToChannel(channel: string, agentName: string): Promise<void> {
    const agent = await this.ensure();
    await agent.channels.invite(channel, agentName);
  }

  /** Register an external agent in the workspace (e.g., a spawned workflow agent).
   *  Uses the workspace API key to register, not an agent token.
   *  No-op if the agent already exists (returns null).
   *  Returns an AgentClient that can send heartbeats. */
  async registerExternalAgent(name: string, persona?: string): Promise<AgentClient | null> {
    const apiKey = this.resolveApiKey();
    const relay = new RelayCast({ apiKey, baseUrl: this.baseUrl });
    try {
      const reg = await relay.agents.register({ name, type: 'agent', ...(persona ? { persona } : {}) });
      return relay.as(reg.token);
    } catch (err) {
      if (err instanceof RelayError && err.code === 'name_conflict') {
        return null;
      }
      throw err;
    }
  }

  /** Start a heartbeat loop for an external agent. Returns a cleanup function. */
  startHeartbeat(agentClient: AgentClient, intervalMs = 30_000): () => void {
    const sendHeartbeat = () => {
      agentClient.client.post('/v1/agents/heartbeat', {}).catch(() => {});
    };
    const timer = setInterval(sendHeartbeat, intervalMs);
    timer.unref();
    // Send first heartbeat immediately
    sendHeartbeat();
    return () => clearInterval(timer);
  }

  /** Fetch message history from a channel. */
  async getMessages(
    channel: string,
    opts?: { limit?: number; before?: string; after?: string }
  ): Promise<Array<{ id: string; agentName: string; text: string; createdAt: string }>> {
    const agent = await this.ensure();
    const messages = await agent.messages(channel, opts);
    return messages.map((m) => ({
      id: m.id,
      agentName: m.agentName,
      text: m.text,
      createdAt: m.createdAt,
    }));
  }
}

// ── Workspace reader (read-only, workspace-key auth) ─────────────────────────

/** Agent as returned by the Relaycast API. */
export interface RelaycastAgent {
  id: string;
  name: string;
  type: string;
  status: string;
  persona: string | null;
  lastSeen: string | null;
  metadata: Record<string, unknown> | null;
}

/** Channel as returned by the Relaycast API. */
export interface RelaycastChannel {
  id: string;
  name: string;
  topic: string | null;
  memberCount: number;
  createdAt: string;
  isArchived: boolean;
}

/** Message as returned by the Relaycast API. */
export interface RelaycastMessage {
  id: string;
  agentName: string;
  text: string;
  createdAt: string;
  replyCount?: number;
  threadId?: string;
}

/** Read-only workspace client for listing agents, channels, and messages. */
export interface WorkspaceReader {
  listAgents(): Promise<RelaycastAgent[]>;
  listChannels(): Promise<RelaycastChannel[]>;
  listMessages(channel: string, opts?: { limit?: number }): Promise<RelaycastMessage[]>;
}

/**
 * Create a read-only workspace client using the workspace API key.
 * Suitable for dashboards and monitoring tools that only need to read data.
 */
export function createWorkspaceReader(options: { apiKey: string; baseUrl?: string }): WorkspaceReader {
  const baseUrl = options.baseUrl ?? process.env.RELAYCAST_BASE_URL ?? DEFAULT_BASE_URL;
  const rc = new RelayCast({ apiKey: options.apiKey, baseUrl });
  return {
    async listAgents(): Promise<RelaycastAgent[]> {
      const agents = await rc.agents.list();
      return (agents ?? []) as RelaycastAgent[];
    },
    async listChannels(): Promise<RelaycastChannel[]> {
      const channels = await rc.channels.list();
      return (channels ?? []) as RelaycastChannel[];
    },
    async listMessages(channel: string, opts?: { limit?: number }): Promise<RelaycastMessage[]> {
      const messages = await rc.messages.list(channel, opts);
      return (messages ?? []) as RelaycastMessage[];
    },
  };
}
