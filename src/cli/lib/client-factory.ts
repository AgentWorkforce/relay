import { AgentRelayClient } from '@agent-relay/sdk';

export interface CreateAgentRelayClientOptions {
  cwd: string;
  channels?: string[];
  binaryPath?: string;
  binaryArgs?: string[];
  env?: NodeJS.ProcessEnv;
  preferConnect?: boolean;
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

export async function createAgentRelayClient(
  options: CreateAgentRelayClientOptions
): Promise<AgentRelayClient> {
  const {
    cwd,
    channels = ['general'],
    binaryPath = process.env.AGENT_RELAY_BIN,
    binaryArgs,
    env = process.env,
    preferConnect = false,
  } = options;

  if (preferConnect) {
    try {
      return AgentRelayClient.connect({ cwd });
    } catch {
      // Fall through to spawning a fresh broker.
    }
  }

  return AgentRelayClient.spawn({
    binaryPath: binaryPath || undefined,
    binaryArgs,
    channels,
    cwd,
    env: env as Record<string, string>,
  });
}

export async function spawnAgentWithClient(
  client: AgentRelayClient,
  options: ClientSpawnOptions
): Promise<void> {
  await client.spawnPty(options);
}
