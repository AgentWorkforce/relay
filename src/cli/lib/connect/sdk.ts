import { AgentRelay } from '@agent-relay/sdk';

export type ConnectProvider = 'codex' | 'claude';

export interface SdkConnectOptions {
  provider: ConnectProvider;
  cwd: string;
  timeoutMs: number;
  model?: string;
  task?: string;
  agentName?: string;
}

export interface SdkConnectDeps {
  createRelay: (input: { cwd: string; requestTimeoutMs: number }) => AgentRelay;
  now: () => number;
  log: (...args: unknown[]) => void;
}

function defaultSdkConnectDeps(): SdkConnectDeps {
  return {
    createRelay: ({ cwd, requestTimeoutMs }) =>
      new AgentRelay({
        cwd,
        requestTimeoutMs,
      }),
    now: () => Date.now(),
    log: (...args: unknown[]) => console.log(...args),
  };
}

export async function runSdkConnect(
  options: SdkConnectOptions,
  overrides: Partial<SdkConnectDeps> = {}
): Promise<void> {
  const deps = {
    ...defaultSdkConnectDeps(),
    ...overrides,
  };

  const relay = deps.createRelay({
    cwd: options.cwd,
    requestTimeoutMs: options.timeoutMs,
  });

  const agentName =
    options.agentName ?? `connect-${options.provider}-${Math.floor(deps.now() / 1000).toString(36)}`;

  try {
    const agent = await relay.spawn(agentName, options.provider, options.task, {
      model: options.model,
      channels: ['connect'],
      cwd: options.cwd,
    });
    await agent.waitForReady(options.timeoutMs);
    deps.log(`[connect] sdk path connected: ${agent.name} (${options.provider})`);

    if (options.task) {
      try {
        await relay.waitForAgentMessage(agent.name, options.timeoutMs);
        deps.log(`[connect] sdk path received first relay message from ${agent.name}`);
      } catch {
        deps.log('[connect] sdk path did not receive a relay message before timeout');
      }
    }

    await agent.release('connect_complete');
  } finally {
    await relay.shutdown().catch(() => undefined);
  }
}
