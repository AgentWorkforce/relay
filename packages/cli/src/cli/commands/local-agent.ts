import type { Command } from 'commander';

import { HarnessDriverClient } from '@agent-relay/harness-driver';

import { createBrokerClient } from '../lib/attach-broker.js';
import {
  defaultStateDir,
  readConnectionFileFromDisk,
  resolveBrokerConnection,
  type BrokerConnectionOptions,
} from '../lib/broker-connection.js';
import { defaultExit } from '../lib/exit.js';
import { spawnAgentWithClient } from '../lib/client-factory.js';
import { attachDrive } from '../lib/attach-drive.js';
import { attachView } from '../lib/attach-view.js';
import { attachPassthrough } from '../lib/attach-passthrough.js';
import { classifyTask, composeTeam, buildDirectorPrompt } from '../../auto/index.js';

// ── Auto-routing model resolution ─────────────────────────────────────────────

// Maps the routing tier to a concrete Claude model ID.
const CLAUDE_MODEL_IDS: Record<'haiku' | 'sonnet' | 'opus', string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-8',
};

/**
 * If `model === 'auto'`, run the task classifier → team composer → Director
 * meta-prompt builder and return resolved spawn options.
 *
 * Only applies to the 'claude' provider — other CLIs use model=auto as a
 * passthrough until their routing tables are defined.
 */
function resolveAutoSpawn(
  provider: string,
  name: string,
  task: string | undefined,
  model: string | undefined
): { name: string; task: string | undefined; model: string | undefined } {
  if (model !== 'auto' || provider !== 'claude' || !task) {
    return { name, task, model };
  }
  const assessment = classifyTask(task);
  const team = composeTeam(assessment, task);
  const directorPrompt = buildDirectorPrompt(task, team);
  return {
    name: name === provider ? 'Director' : name,
    task: directorPrompt,
    model: CLAUDE_MODEL_IDS[team.lead.model],
  };
}

export type AttachMode = 'drive' | 'view' | 'passthrough';
export type LocalAgentMessageBrokerOptions = BrokerConnectionOptions;

/** Dispatch `local agent attach --mode` to the drive/view/passthrough session runners. */
export function runAttach(
  name: string,
  mode: AttachMode,
  options: { brokerUrl?: string; apiKey?: string; stateDir?: string }
): Promise<number> {
  switch (mode) {
    case 'view':
      return attachView(name, options);
    case 'passthrough':
      return attachPassthrough(name, options);
    case 'drive':
    default:
      return attachDrive(name, options);
  }
}

type ExitFn = (code: number) => never;

export interface LocalAgentDependencies {
  connect: (cwd: string) => Promise<HarnessDriverClient>;
  connectLocal: (cwd: string, options: LocalAgentMessageBrokerOptions) => Promise<HarnessDriverClient>;
  attach: (
    name: string,
    mode: AttachMode,
    options: { brokerUrl?: string; apiKey?: string; stateDir?: string }
  ) => Promise<number>;
  cwd: () => string;
  readConnectionFile: (stateDir: string) => unknown;
  getDefaultStateDir: () => string;
  env: NodeJS.ProcessEnv;
  fetch: typeof globalThis.fetch;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}

function withDefaults(overrides: Partial<LocalAgentDependencies> = {}): LocalAgentDependencies {
  const deps = {
    connect: async (cwd: string) => HarnessDriverClient.connect({ cwd }),
    cwd: () => process.cwd(),
    readConnectionFile: readConnectionFileFromDisk,
    getDefaultStateDir: defaultStateDir,
    env: process.env,
    fetch: globalThis.fetch,
    attach: runAttach,
    log: (...args: unknown[]) => console.log(...args),
    error: (...args: unknown[]) => console.error(...args),
    exit: defaultExit,
    ...overrides,
  } as LocalAgentDependencies;
  deps.connectLocal ??= async (_cwd: string, options: LocalAgentMessageBrokerOptions) => {
    const connection = resolveBrokerConnection(options, {
      readConnectionFile: deps.readConnectionFile,
      getDefaultStateDir: deps.getDefaultStateDir,
      env: deps.env,
    });
    if (!connection) {
      throw new Error(
        'Error: could not locate broker connection. Pass --broker-url, set RELAY_BROKER_URL, ' +
          'or run from a directory containing .agentworkforce/relay/connection.json.'
      );
    }
    return createBrokerClient(connection, deps.fetch);
  };
  return deps;
}

async function run(
  deps: LocalAgentDependencies,
  fn: (client: HarnessDriverClient) => Promise<void>
): Promise<void> {
  let client: HarnessDriverClient | undefined;
  try {
    client = await deps.connect(deps.cwd());
    await fn(client);
  } catch (err) {
    deps.error(err instanceof Error ? err.message : String(err));
    deps.exit(1);
  } finally {
    client?.disconnect?.();
  }
}

async function runLocalBroker(
  deps: LocalAgentDependencies,
  options: LocalAgentMessageBrokerOptions,
  fn: (client: HarnessDriverClient) => Promise<void>
): Promise<void> {
  try {
    await fn(await deps.connectLocal(deps.cwd(), options));
  } catch (err) {
    deps.error(err instanceof Error ? err.message : String(err));
    deps.exit(1);
  }
}

function addBrokerOptions(command: Command): Command {
  return command
    .option('--broker-url <url>', 'Broker base URL (overrides RELAY_BROKER_URL and connection.json)')
    .option('--api-key <key>', 'Broker API key (overrides RELAY_BROKER_API_KEY and connection.json)')
    .option('--state-dir <dir>', 'Directory containing connection.json (default: .agentworkforce/relay/)');
}

function brokerOptionsFromOpts(opts: Record<string, unknown>): LocalAgentMessageBrokerOptions {
  return {
    brokerUrl: opts.brokerUrl as string | undefined,
    apiKey: opts.apiKey as string | undefined,
    stateDir: opts.stateDir as string | undefined,
  };
}

/**
 * Register the `local agent …` subtree (and `runtime tail`) onto the driver
 * group. List/spawn/release/kill talk to a running local broker.
 */
export function registerLocalAgentCommands(
  group: Command,
  overrides: Partial<LocalAgentDependencies> = {}
): void {
  const deps = withDefaults(overrides);
  const agent = group.command('agent').description('Inspect and manage broker-spawned agents');

  agent
    .command('list')
    .description('List agents running on the local broker')
    .action(async () => {
      await run(deps, async (client) => {
        deps.log(JSON.stringify(await client.listAgents(), null, 2));
      });
    });

  agent
    .command('spawn')
    .description('Spawn an agent with the given provider CLI')
    .argument(
      '<provider>',
      'CLI provider (claude, codex, gemini, droid, …); droid is high-risk for delegation/spawn tasks'
    )
    .option('--name <name>', 'Agent name (defaults to the provider)')
    .option('--channels <channels...>', 'Channels to join', ['general'])
    .option('--task <task>', 'Initial task prompt')
    .option('--model <model>', 'Model override')
    .option('--cwd <path>', 'Working directory for the spawned agent')
    .option('--spawn-mode <mode>', 'Spawn lifecycle: interactive | task-exit', 'interactive')
    .option('--exit-after-task', 'Exit the spawned agent after it completes the injected task')
    .action(async (provider: string, opts: Record<string, unknown>) => {
      await run(deps, async (client) => {
        const spawnMode = opts.spawnMode as string | undefined;
        if (
          spawnMode &&
          spawnMode !== 'interactive' &&
          spawnMode !== 'task-exit' &&
          spawnMode !== 'task_exit'
        ) {
          deps.error(`Unknown spawn mode "${spawnMode}". Expected one of: interactive, task-exit.`);
          deps.exit(1);
          return;
        }
        const baseName = (opts.name as string | undefined) ?? provider;
        const resolved = resolveAutoSpawn(
          provider,
          baseName,
          opts.task as string | undefined,
          opts.model as string | undefined
        );
        await spawnAgentWithClient(client, {
          name: resolved.name,
          cli: provider,
          channels: (opts.channels as string[] | undefined) ?? ['general'],
          task: resolved.task,
          model: resolved.model,
          cwd: opts.cwd as string | undefined,
          spawnMode:
            spawnMode === 'task-exit' ? 'task_exit' : (spawnMode as 'interactive' | 'task_exit' | undefined),
          exitAfterTask: opts.exitAfterTask as boolean | undefined,
        });
        const autoNote = opts.model === 'auto' ? ' (auto-routed)' : '';
        deps.log(`Spawned ${resolved.name} (${provider})${autoNote}.`);
      });
    });

  agent
    .command('new')
    .description('Spawn an agent and attach to it')
    .argument(
      '<provider>',
      'CLI provider (claude, codex, gemini, droid, …); droid is high-risk for delegation/spawn tasks'
    )
    .option('--name <name>', 'Agent name (defaults to the provider)')
    .option('--mode <mode>', 'Attach mode: drive | view | passthrough', 'drive')
    .option('--channels <channels...>', 'Channels to join', ['general'])
    .option('--task <task>', 'Initial task prompt')
    .option('--model <model>', 'Model override')
    .option('--cwd <path>', 'Working directory for the spawned agent')
    .option('--spawn-mode <mode>', 'Spawn lifecycle: interactive | task-exit', 'interactive')
    .option('--exit-after-task', 'Exit the spawned agent after it completes the injected task')
    .action(async (provider: string, options: Record<string, unknown>) => {
      const mode = (options.mode as string) ?? 'drive';
      if (mode !== 'drive' && mode !== 'view' && mode !== 'passthrough') {
        deps.error(`Unknown attach mode "${mode}". Expected one of: drive, view, passthrough.`);
        deps.exit(1);
        return;
      }
      const spawnMode = options.spawnMode as string | undefined;
      if (
        spawnMode &&
        spawnMode !== 'interactive' &&
        spawnMode !== 'task-exit' &&
        spawnMode !== 'task_exit'
      ) {
        deps.error(`Unknown spawn mode "${spawnMode}". Expected one of: interactive, task-exit.`);
        deps.exit(1);
        return;
      }
      const baseName = (options.name as string | undefined) ?? provider;
      const resolved = resolveAutoSpawn(
        provider,
        baseName,
        options.task as string | undefined,
        options.model as string | undefined
      );
      await run(deps, async (client) => {
        await spawnAgentWithClient(client, {
          name: resolved.name,
          cli: provider,
          channels: (options.channels as string[] | undefined) ?? ['general'],
          task: resolved.task,
          model: resolved.model,
          cwd: options.cwd as string | undefined,
          spawnMode:
            spawnMode === 'task-exit' ? 'task_exit' : (spawnMode as 'interactive' | 'task_exit' | undefined),
          exitAfterTask: options.exitAfterTask as boolean | undefined,
        });
        const autoNote = options.model === 'auto' ? ' (auto-routed)' : '';
        deps.log(`Spawned ${resolved.name} (${provider}). Attaching (${mode})${autoNote}…`);
      });
      // `new` spawns and attaches on the same default local broker — broker
      // override flags belong on the standalone `attach` command.
      const code = await deps.attach(resolved.name, mode as AttachMode, {});
      if (code !== 0) {
        deps.exit(code);
      }
    });

  agent
    .command('release')
    .description('Release an agent (graceful stop)')
    .argument('<name>', 'Agent name')
    .action(async (name: string) => {
      await run(deps, async (client) => {
        await client.release(name);
        deps.log(`Released ${name}.`);
      });
    });

  agent
    .command('set-model')
    .description("Switch a running agent's model (sends `/model` to its TUI; best-effort)")
    .argument('<name>', 'Agent name')
    .argument('<model>', 'Model identifier to switch to')
    .action(async (name: string, model: string) => {
      await run(deps, async (client) => {
        await client.setModel(name, model);
        deps.log(`Sent \`/model ${model}\` to ${name} (best-effort — the agent's TUI applies it).`);
      });
    });

  agent
    .command('attach')
    .description('Attach to a running agent interactively (drive | view | passthrough)')
    .argument('<name>', 'Agent name')
    .option('--mode <mode>', 'drive | view | passthrough', 'view')
    .option('--broker-url <url>', 'Broker base URL (overrides RELAY_BROKER_URL and connection.json)')
    .option('--api-key <key>', 'Broker API key (overrides RELAY_BROKER_API_KEY and connection.json)')
    .option('--state-dir <dir>', 'Directory containing connection.json (default: .agentworkforce/relay/)')
    .action(async (name: string, options: Record<string, unknown>) => {
      const mode = (options.mode as string) ?? 'view';
      if (mode !== 'drive' && mode !== 'view' && mode !== 'passthrough') {
        deps.error(`Unknown attach mode "${mode}". Expected one of: drive, view, passthrough.`);
        deps.exit(1);
        return;
      }
      const code = await deps.attach(name, mode, {
        brokerUrl: options.brokerUrl as string | undefined,
        apiKey: options.apiKey as string | undefined,
        stateDir: options.stateDir as string | undefined,
      });
      if (code !== 0) {
        deps.exit(code);
      }
    });

  const message = agent.command('message').description('Control local broker message delivery for an agent');

  addBrokerOptions(
    message
      .command('flush')
      .description('Flush queued relay messages into a held local agent')
      .argument('<name>', 'Agent name')
  ).action(async (name: string, opts: Record<string, unknown>) => {
    await runLocalBroker(deps, brokerOptionsFromOpts(opts), async (client) => {
      deps.log(JSON.stringify({ name, ...(await client.flushPending(name)) }, null, 2));
    });
  });

  addBrokerOptions(
    message
      .command('hold')
      .description('Hold new relay messages for a local agent until flushed')
      .argument('<name>', 'Agent name')
  ).action(async (name: string, opts: Record<string, unknown>) => {
    await runLocalBroker(deps, brokerOptionsFromOpts(opts), async (client) => {
      deps.log(
        JSON.stringify({ name, ...(await client.setInboundDeliveryMode(name, 'manual_flush')) }, null, 2)
      );
    });
  });

  addBrokerOptions(
    message
      .command('auto')
      .description('Resume automatic relay message injection for a local agent')
      .argument('<name>', 'Agent name')
  ).action(async (name: string, opts: Record<string, unknown>) => {
    await runLocalBroker(deps, brokerOptionsFromOpts(opts), async (client) => {
      deps.log(
        JSON.stringify({ name, ...(await client.setInboundDeliveryMode(name, 'auto_inject')) }, null, 2)
      );
    });
  });

  group
    .command('tail')
    .description('Stream broker events (optionally filtered to one agent)')
    .option('--agent <name>', "Filter to a single agent's output stream")
    .action(async (options: { agent?: string }) => {
      await run(deps, async (client) => {
        if (options.agent) {
          for await (const chunk of client.subscribeWorkerStream(options.agent)) {
            process.stdout.write(chunk);
          }
          return;
        }
        client.connectEvents();
        await new Promise<void>((resolve) => {
          client.onEvent((event) => {
            deps.log(JSON.stringify(event));
          });
          // Ctrl+C ends a streaming tail cleanly (exit 0, no error output).
          process.once('SIGINT', () => resolve());
        });
      });
    });
}
