import { AgentRelayClient } from '@agent-relay/sdk';

export interface CreateAgentRelayClientOptions {
  cwd: string;
  channels?: string[];
  binaryPath?: string;
  binaryArgs?: string[];
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
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
    binaryArgs,
    env = process.env,
    requestTimeoutMs,
  } = options;

  return new AgentRelayClient({
    binaryPath,
    binaryArgs,
    channels,
    cwd,
    env,
    requestTimeoutMs,
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
