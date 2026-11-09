import { connectCore, CoreRpcError, spawnTargets } from '@agent-relay/core-bridge';
import type { CoreClient } from '@agent-relay/core-bridge';
import type { NodePort } from './ports.js';

export type ConnectCore = () => Promise<CoreClient>;

interface SpawnSettingsView {
  accept_spawns?: unknown;
  spawn_requester_approvals?: unknown;
  [key: string]: unknown;
}

/**
 * The dedicated node through the local core bridge. No credential crosses it.
 *
 * Full access off is checked here. The scrubbed environment and HOME cannot be read back
 * from a core, so they rest on the operator's attestation in the configuration.
 */
export class CoreNode implements NodePort {
  private readonly connect: ConnectCore;

  constructor(options: { socket?: string; connect?: ConnectCore } = {}) {
    this.connect = options.connect ?? (() => connectCore(options.socket ? { socket: options.socket } : {}));
  }

  private async withCore<T>(run: (client: CoreClient) => Promise<T>): Promise<T> {
    const client = await this.connect();
    try {
      return await run(client);
    } finally {
      await client.close();
    }
  }

  async preflight(harness: string, node: { id: string; name: string }): Promise<string | undefined> {
    try {
      return await this.withCore(async (client) => {
        const settings = (await client.call('settings.get')) as SpawnSettingsView;
        if (settings.accept_spawns !== true) return 'spawns_not_accepted';
        // Anything but an explicit false counts as full access.
        if (settings[`spawn_full_access_${harness}`] !== false) return 'full_access_enabled';
        if (settings.spawn_requester_approvals !== false) return 'requester_approvals_enabled';
        const { targets } = await spawnTargets(client);
        const target = targets.find((t) => t.id === node.id && t.name === node.name);
        if (!target) return 'node_not_found';
        if (!target.live || !target.handlers_live || target.stale) return 'node_not_live';
        if (!target.capabilities.includes(`spawn:${harness}`)) return 'harness_not_available';
        // Zero means the node has no limit.
        if (target.max_agents > 0 && target.active_agents + target.reserved_agents >= target.max_agents) {
          return 'node_at_capacity';
        }
        return undefined;
      });
    } catch {
      return 'core_unavailable';
    }
  }

  async endAgent(name: string): Promise<'ended' | 'not_found' | 'refused'> {
    return this.withCore(async (client) => {
      try {
        await client.call('agents.end', { name });
        return 'ended';
      } catch (error) {
        if (error instanceof CoreRpcError && error.kind === 'not_found') return 'not_found';
        if (error instanceof CoreRpcError && error.kind === 'refused') return 'refused';
        throw error;
      }
    });
  }
}
