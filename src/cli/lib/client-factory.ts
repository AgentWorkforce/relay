import { AgentRelayClient } from '@agent-relay/broker-sdk';

export interface CreateAgentRelayClientOptions {
  cwd: string;
  channels?: string[];
  binaryPath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ClientSpawnOptions {
  name: string;
  cli: string;
  channels: string[];
  args?: string[];
  task?: string;
  team?: string;
  model?: string;
  cwd?: string;
  shadowOf?: string;
  shadowMode?: 'subagent' | 'process';
}
type SpawnCapableClient = AgentRelayClient & {
  spawnPty?: (input: ClientSpawnOptions) => Promise<unknown>;
};

export function createAgentRelayClient(options: CreateAgentRelayClientOptions): AgentRelayClient {
  const {
    cwd,
    channels = ['general'],
    binaryPath = process.env.AGENT_RELAY_BIN,
    env = process.env,
  } = options;

  return new AgentRelayClient({
    binaryPath,
    channels,
    cwd,
    env,
  });
}

export async function spawnAgentWithClient(
  client: AgentRelayClient,
  options: ClientSpawnOptions
): Promise<void> {
  const spawnClient = client as SpawnCapableClient;
  if (typeof spawnClient.spawnPty !== 'function') {
    throw new Error('Agent relay client does not support spawning agents');
  }

  await spawnClient.spawnPty(options);
}
