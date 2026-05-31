import { RuntimeClient, type BrokerInitArgs } from '@agent-relay/runtime';

export interface CreateRuntimeClientOptions {
  cwd: string;
  channels?: string[];
  binaryPath?: string;
  binaryArgs?: BrokerInitArgs;
  brokerName?: string;
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

export async function createRuntimeClient(options: CreateRuntimeClientOptions): Promise<RuntimeClient> {
  const {
    cwd,
    channels = ['general'],
    binaryPath = process.env.AGENT_RELAY_BIN,
    binaryArgs,
    brokerName,
    env = process.env,
    preferConnect = false,
  } = options;

  if (preferConnect) {
    try {
      return RuntimeClient.connect({ cwd });
    } catch {
      // Fall through to spawning a fresh broker.
    }
  }

  return RuntimeClient.spawn({
    binaryPath: binaryPath || undefined,
    binaryArgs,
    brokerName,
    channels,
    cwd,
    env: env as Record<string, string>,
  });
}

export async function spawnAgentWithClient(
  client: RuntimeClient,
  options: ClientSpawnOptions
): Promise<void> {
  await client.spawnPty(options);
}
