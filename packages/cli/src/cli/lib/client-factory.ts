import { HarnessDriverClient, type BrokerInitArgs } from '@agent-relay/harness-driver';
import {
  createNativeHarnessLaunch,
  resolveHarnessBackend,
  type HarnessBackend,
  type SelectedHarnessBackend,
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
  /** Harness execution backend. `auto` preserves each adapter's rollout default. */
  backend?: HarnessBackend;
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

export function resolvedSpawnBackend(
  options: Pick<ClientSpawnOptions, 'cli' | 'backend'>
): SelectedHarnessBackend {
  return resolveHarnessBackend(options.cli, options.backend);
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
  const backend = resolvedSpawnBackend(options);
  if (backend === 'pty') {
    const { backend: _backend, ...ptyOptions } = options;
    await client.spawnPty(ptyOptions);
    return;
  }

  if (options.spawnMode && options.spawnMode !== 'interactive') {
    throw new Error('Native AI SDK harnesses currently support only interactive spawn mode');
  }
  if (options.exitAfterTask) {
    throw new Error('Native AI SDK harnesses do not currently support --exit-after-task');
  }

  const launch = createNativeHarnessLaunch(
    options.cli,
    {
      backend: 'ai-sdk',
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
