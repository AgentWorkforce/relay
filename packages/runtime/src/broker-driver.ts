import { AgentRelayClient, type AgentRelaySpawnOptions } from './client.js';
import type { ListAgent, SpawnAgentResult } from './types.js';
import type {
  AgentDriver,
  DriverRuntimeStatus,
  SpawnRuntimeInput,
  SpawnedAgentRuntime,
} from './driver-types.js';

function statusFromManagedAgent(agent: ListAgent | SpawnAgentResult | undefined): DriverRuntimeStatus {
  if (!agent) {
    return 'offline';
  }

  const currentState =
    'current_state' in agent && typeof agent.current_state === 'string' ? agent.current_state : undefined;
  if (currentState === 'working' || currentState === 'blocked_on_send') {
    return 'busy';
  }
  if (currentState === 'idle') {
    return 'idle';
  }
  return 'unknown';
}

export interface BrokerDriverOptions extends AgentRelaySpawnOptions {
  client?: AgentRelayClient;
}

export class BrokerDriver implements AgentDriver {
  readonly kind = 'broker';

  private client?: AgentRelayClient;

  constructor(private readonly options: BrokerDriverOptions = {}) {
    this.client = options.client;
  }

  async spawn(input: SpawnRuntimeInput): Promise<SpawnedAgentRuntime> {
    const client = await this.ensureClient();
    const transport = input.transport ?? 'pty';
    const { transport: _transport, ...spawnInput } = input;
    const result =
      transport === 'headless' ? await client.spawnHeadless(spawnInput) : await client.spawnPty(spawnInput);

    return this.runtimeHandle(client, result);
  }

  private async ensureClient(): Promise<AgentRelayClient> {
    if (!this.client) {
      this.client = await AgentRelayClient.spawn(this.options);
    }
    return this.client;
  }

  private runtimeHandle(client: AgentRelayClient, result: SpawnAgentResult): SpawnedAgentRuntime {
    return {
      agent: { name: result.name, id: result.sessionId },
      delivery: { mode: 'managed' },
      status: async () => this.status(result.name),
      release: async (reason?: string) => {
        await client.release(result.name, reason);
      },
    };
  }

  async release(name: string, reason?: string): Promise<void> {
    const client = await this.ensureClient();
    await client.release(name, reason);
  }

  async status(name: string): Promise<DriverRuntimeStatus> {
    const client = await this.ensureClient();
    const agents = await client.listAgents();
    return statusFromManagedAgent(agents.find((agent) => agent.name === name));
  }
}
