import { HarnessDriverClient, type BrokerInitArgs } from '@agent-relay/harness-driver';
import type { ResolvedHarnessConfig } from '@agent-relay/harness-driver';
import {
  createNativeHarnessLaunch,
  resolveHarnessRuntime,
  type HarnessRuntime,
  type SelectedHarnessRuntime,
} from '@agent-relay/harnesses';

export interface CreateRuntimeClientOptions {
  cwd: string;
  channels?: string[];
  binaryPath?: string;
  binaryArgs?: BrokerInitArgs;
  brokerName?: string;
  env?: NodeJS.ProcessEnv;
  preferConnect?: boolean;
  /** Forward broker stderr lines to this callback (e.g. for `--verbose`). */
  onStderr?: (line: string) => void;
  /** Forward human-readable startup step markers to this callback (e.g. for `--verbose`). */
  onStep?: (message: string) => void;
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
  spawnMode?: 'interactive' | 'task_exit' | 'task-exit' | 'single_shot' | 'single-shot';
  exitAfterTask?: boolean;
  /** Harness execution runtime. `auto` preserves each adapter's rollout default. */
  runtime?: HarnessRuntime | 'headless';
  /** Explicit attached AppServer configuration for the public headless lane. */
  harnessConfig?: ResolvedHarnessConfig;
}

const NATIVE_SIDECAR_COMMAND = '__ai-sdk-sidecar';

/** Bun standalone executables must re-enter the bundled CLI to run embedded sidecar code. */
export function nativeSidecarLaunch(
  argv: readonly string[] = process.argv,
  execPath = process.execPath
): { command: string; args: string[] } | undefined {
  const bundledEntrypoint = argv[1] ?? '';
  if (argv[0] === 'bun' && bundledEntrypoint.startsWith('/$bunfs/root/')) {
    return { command: execPath, args: [NATIVE_SIDECAR_COMMAND] };
  }
  return undefined;
}

export function resolvedSpawnRuntime(
  options: Pick<ClientSpawnOptions, 'cli' | 'runtime'>
): SelectedHarnessRuntime {
  return resolveHarnessRuntime(options.cli, options.runtime as HarnessRuntime | undefined);
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
    onStderr,
    onStep,
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
    onStderr,
    onStep,
  });
}

export async function spawnAgentWithClient(
  client: HarnessDriverClient,
  options: ClientSpawnOptions
): Promise<void> {
  if (options.runtime === 'headless') {
    if (options.harnessConfig?.runtime !== 'headless') {
      throw new Error(
        'Headless runtime requires --protocol, --endpoint, and --session-id AppServer configuration'
      );
    }
    const { runtime: _runtime, harnessConfig, ...headlessOptions } = options;
    await client.spawnHeadless({ ...headlessOptions, harnessConfig });
    return;
  }
  const runtime = resolvedSpawnRuntime({
    cli: options.cli,
    runtime: options.runtime as HarnessRuntime | undefined,
  });
  if (runtime === 'pty') {
    const { runtime: _runtime, ...ptyOptions } = options;
    await client.spawnPty(ptyOptions);
    return;
  }

  if (options.spawnMode && options.spawnMode !== 'interactive') {
    throw new Error('Native harnesses currently support only interactive spawn mode');
  }
  if (options.exitAfterTask) {
    throw new Error('Native harnesses do not currently support --exit-after-task');
  }

  const launch = createNativeHarnessLaunch(
    options.cli,
    {
      runtime: 'native',
      name: options.name,
      channels: options.channels,
      task: options.task,
      model: options.model,
      cwd: options.cwd,
    },
    nativeSidecarLaunch()
  );
  const { transport: _transport, ...headlessInput } = launch;
  await client.spawnHeadless(headlessInput);
}
