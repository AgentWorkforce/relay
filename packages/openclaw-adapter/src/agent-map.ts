/**
 * Bidirectional agent identity mapping between OpenClaw and Relaycast.
 *
 * Discovers OpenClaw agents and registers them as Relaycast identities
 * with a configurable prefix (default: "oc-") to avoid name collisions.
 */

import type { RelayCast, AgentClient } from '@relaycast/sdk';
import type { OpenClawAgent, AgentMapping } from './types.js';

/** Extended mapping that includes the Relaycast agent client */
export interface AgentMappingWithClient extends AgentMapping {
  client: AgentClient;
}

export class AgentMap {
  private readonly mappings = new Map<string, AgentMappingWithClient>();
  private readonly prefix: string;
  private readonly relay: RelayCast;

  constructor(relay: RelayCast, prefix = 'oc') {
    this.relay = relay;
    this.prefix = prefix;
  }

  /**
   * Sync OpenClaw agent list with Relaycast registrations.
   * Registers new agents, removes stale ones.
   */
  async sync(openclawAgents: OpenClawAgent[]): Promise<AgentMappingWithClient[]> {
    const currentIds = new Set(openclawAgents.map((a) => a.id));
    const existingIds = new Set(this.mappings.keys());

    // Register new agents
    const newAgents = openclawAgents.filter((a) => !existingIds.has(a.id));
    for (const agent of newAgents) {
      await this.register(agent);
    }

    // Remove agents that no longer exist in OpenClaw
    for (const id of existingIds) {
      if (!currentIds.has(id)) {
        await this.unregister(id);
      }
    }

    return Array.from(this.mappings.values());
  }

  /** Register an OpenClaw agent as a Relaycast identity */
  async register(agent: OpenClawAgent): Promise<AgentMapping> {
    const relaycastName = `${this.prefix}-${agent.id}`;

    try {
      const { token } = await this.relay.agent({
        name: relaycastName,
        persona: `OpenClaw agent "${agent.identity?.name || agent.id}" bridged via openclaw-adapter`,
      });

      const client = this.relay.as(token);
      const mapping: AgentMappingWithClient = {
        openclawId: agent.id,
        relaycastName,
        sessionKey: '', // Updated when sessions are discovered
        client,
      };
      this.mappings.set(agent.id, mapping);
      return mapping;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // If the name is already taken by a non-bridge agent, skip with warning
      if (message.includes('already') || message.includes('conflict')) {
        console.warn(
          `[openclaw-adapter] Skipping agent "${agent.id}": Relaycast name "${relaycastName}" already taken`,
        );
        return { openclawId: agent.id, relaycastName, sessionKey: '' };
      }
      throw err;
    }
  }

  /** Unregister an OpenClaw agent from Relaycast */
  async unregister(openclawId: string): Promise<void> {
    const mapping = this.mappings.get(openclawId);
    if (mapping?.client) {
      try {
        await mapping.client.presence.markOffline();
      } catch {
        // Best effort
      }
    }
    this.mappings.delete(openclawId);
  }

  /** Update the session key for a mapped agent */
  updateSessionKey(openclawId: string, sessionKey: string): void {
    const mapping = this.mappings.get(openclawId);
    if (mapping) {
      mapping.sessionKey = sessionKey;
    }
  }

  /** Look up a mapping by OpenClaw agent ID */
  byOpenClawId(id: string): AgentMappingWithClient | undefined {
    return this.mappings.get(id);
  }

  /** Look up a mapping by Relaycast agent name */
  byRelaycastName(name: string): AgentMappingWithClient | undefined {
    for (const mapping of this.mappings.values()) {
      if (mapping.relaycastName === name) {
        return mapping;
      }
    }
    return undefined;
  }

  /** Get all current mappings */
  all(): AgentMappingWithClient[] {
    return Array.from(this.mappings.values());
  }

  /** Number of active mappings */
  get size(): number {
    return this.mappings.size;
  }
}
