import { HarnessDriverClient, type BrokerInitArgs } from '@agent-relay/harness-driver';

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

export async function createRuntimeClient(options: CreateRuntimeClientOptions): Promise<HarnessDriverClient> {
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
      // Await so an async connect rejection is caught here, not leaked to the
      // caller — otherwise the fallback spawn below never runs.
      return await HarnessDriverClient.connect({ cwd });
    } catch {
      // Fall through to spawning a fresh broker.
    }
  }

  return HarnessDriverClient.spawn({
    binaryPath: binaryPath || undefined,
    binaryArgs,
    brokerName,
    channels,
    cwd,
    env: env as Record<string, string>,
  });
}

export async function spawnAgentWithClient(
  client: HarnessDriverClient,
  options: ClientSpawnOptions
): Promise<void> {
  await client.spawnPty(options);
}
