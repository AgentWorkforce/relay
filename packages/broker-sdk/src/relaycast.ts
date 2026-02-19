import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { RelayCast, RelayError, type AgentClient } from "@relaycast/sdk";

export interface RelaycastCredentials {
  workspace_id: string;
  agent_id: string;
  api_key: string;
  agent_name?: string;
}

export interface RelaycastWorkspace {
  workspaceId: string;
  apiKey: string;
}

export interface RelaycastApiOptions {
  /** Workspace API key. If provided, skips reading from the cache file. */
  apiKey?: string;
  baseUrl?: string;
  cachePath?: string;
  /** Agent name to register with. Defaults to a unique "sdk-<hex>" name. */
  agentName?: string;
}

const DEFAULT_BASE_URL = "https://api.relaycast.dev";

/**
 * Convenience wrapper around `@relaycast/sdk` that manages workspace
 * creation, agent registration, and message sending.
 */
export class RelaycastApi {
  private readonly baseUrl: string;
  private readonly cachePath: string;
  private readonly agentName: string;
  private readonly apiKeyOverride?: string;
  private agentClient?: AgentClient;

  constructor(options: RelaycastApiOptions = {}) {
    this.baseUrl = options.baseUrl ?? process.env.RELAYCAST_BASE_URL ?? DEFAULT_BASE_URL;
    // Default to per-project cache (matches the relay daemon's storage) so
    // concurrent workflows from different repos never share credentials.
    // Falls back to the legacy global path when no project-local cache exists.
    this.cachePath = options.cachePath ?? join(process.cwd(), ".agent-relay", "relaycast.json");
    this.agentName = options.agentName ?? `sdk-${randomBytes(4).toString("hex")}`;
    this.apiKeyOverride = options.apiKey;
  }

  /**
   * Create a new Relaycast workspace. Returns the workspace ID and API key.
   * No authentication required — this is the bootstrap entry point.
   */
  static async createWorkspace(
    name: string,
    baseUrl = DEFAULT_BASE_URL,
  ): Promise<RelaycastWorkspace> {
    const res = await fetch(`${baseUrl}/v1/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
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
      throw new Error("Workspace response missing workspace_id or api_key");
    }
    return { workspaceId, apiKey };
  }

  /** Resolve the workspace API key from explicit option, env, or cache file.
   *  Tries the configured (per-project) cache first, then falls back to the
   *  legacy global cache at ~/.agent-relay/relaycast.json. */
  private async resolveApiKey(): Promise<string> {
    if (this.apiKeyOverride) return this.apiKeyOverride;
    if (process.env.RELAY_API_KEY) return process.env.RELAY_API_KEY;

    // Try per-project cache first, then fall back to global (deduplicated)
    const globalPath = join(homedir(), ".agent-relay", "relaycast.json");
    const candidates = this.cachePath === globalPath
      ? [this.cachePath]
      : [this.cachePath, globalPath];
    for (const cachePath of candidates) {
      if (!existsSync(cachePath)) continue;
      try {
        const raw = await readFile(cachePath, "utf-8");
        const creds: RelaycastCredentials = JSON.parse(raw);
        if (creds.api_key) return creds.api_key;
      } catch {
        // Cache corrupt — try next path
      }
    }

    throw new Error(
      `No Relaycast API key found (checked ${this.cachePath} and ${globalPath})`,
    );
  }

  /** Lazily register and return an authenticated AgentClient. */
  private async ensure(): Promise<AgentClient> {
    if (this.agentClient) return this.agentClient;

    const apiKey = await this.resolveApiKey();
    const relay = new RelayCast({ apiKey, baseUrl: this.baseUrl });

    // Register — retry with a suffixed name on 409 conflict.
    let name = this.agentName;
    let registration;
    try {
      registration = await relay.agents.register({ name, type: "agent" });
    } catch (err) {
      if (err instanceof RelayError && err.code === "agent_already_exists") {
        name = `${this.agentName}-${randomBytes(4).toString("hex")}`;
        registration = await relay.agents.register({ name, type: "agent" });
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
    if (to.startsWith("#")) {
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
      if (err instanceof RelayError && err.code === "channel_already_exists") {
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
   *  No-op if the agent already exists. */
  async registerExternalAgent(name: string, persona?: string): Promise<void> {
    const apiKey = await this.resolveApiKey();
    const relay = new RelayCast({ apiKey, baseUrl: this.baseUrl });
    try {
      await relay.agents.register({ name, type: "agent", ...(persona ? { persona } : {}) });
    } catch (err) {
      if (err instanceof RelayError && err.code === "agent_already_exists") {
        return;
      }
      throw err;
    }
  }

  /** Fetch message history from a channel. */
  async getMessages(
    channel: string,
    opts?: { limit?: number; before?: string; after?: string },
  ): Promise<Array<{ id: string; agent_name: string; text: string; created_at: string }>> {
    const agent = await this.ensure();
    const messages = await agent.messages(channel, opts);
    return messages.map((m) => ({
      id: m.id,
      agent_name: m.agent_name,
      text: m.text,
      created_at: m.created_at,
    }));
  }
}
