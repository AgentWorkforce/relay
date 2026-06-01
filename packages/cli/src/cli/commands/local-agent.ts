import type { Command } from 'commander';

import type { RuntimeClient } from '@agent-relay/runtime';

import { defaultExit } from '../lib/exit.js';
import { createRuntimeClient, spawnAgentWithClient } from '../lib/client-factory.js';
import { attachDrive } from '../lib/attach-drive.js';
import { attachView } from '../lib/attach-view.js';
import { attachPassthrough } from '../lib/attach-passthrough.js';

export type AttachMode = 'drive' | 'view' | 'passthrough';

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
  connect: (cwd: string) => Promise<RuntimeClient>;
  attach: (
    name: string,
    mode: AttachMode,
    options: { brokerUrl?: string; apiKey?: string; stateDir?: string }
  ) => Promise<number>;
  cwd: () => string;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}

function withDefaults(overrides: Partial<LocalAgentDependencies> = {}): LocalAgentDependencies {
  return {
    connect: (cwd: string) => createRuntimeClient({ cwd, preferConnect: true }),
    attach: runAttach,
    cwd: () => process.cwd(),
    log: (...args: unknown[]) => console.log(...args),
    error: (...args: unknown[]) => console.error(...args),
    exit: defaultExit,
    ...overrides,
  };
}

async function run(
  deps: LocalAgentDependencies,
  fn: (client: RuntimeClient) => Promise<void>
): Promise<void> {
  let client: RuntimeClient | undefined;
  try {
    client = await deps.connect(deps.cwd());
    await fn(client);
  } catch (err) {
    deps.error(err instanceof Error ? err.message : String(err));
    deps.exit(1);
  }
}

/**
 * Register the `local agent …` subtree (and `runtime tail`) onto the driver
 * group. List/spawn/release/kill talk to a running local broker; attach/new/tail
 * are interactive PTY operations and point the user at the dashboard.
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
    .argument('<provider>', 'CLI provider (claude, codex, gemini, …)')
    .option('--name <name>', 'Agent name (defaults to the provider)')
    .option('--channels <channels...>', 'Channels to join', ['general'])
    .option('--task <task>', 'Initial task prompt')
    .option('--model <model>', 'Model override')
    .action(async (provider: string, opts: Record<string, unknown>) => {
      await run(deps, async (client) => {
        const name = (opts.name as string | undefined) ?? provider;
        await spawnAgentWithClient(client, {
          name,
          cli: provider,
          channels: (opts.channels as string[] | undefined) ?? ['general'],
          task: opts.task as string | undefined,
          model: opts.model as string | undefined,
        });
        deps.log(`Spawned ${name} (${provider}).`);
      });
    });

  agent
    .command('new')
    .description('Spawn an agent and attach to it')
    .argument('<provider>', 'CLI provider (claude, codex, gemini, …)')
    .option('--name <name>', 'Agent name (defaults to the provider)')
    .option('--mode <mode>', 'Attach mode: drive | view | passthrough', 'drive')
    .option('--channels <channels...>', 'Channels to join', ['general'])
    .option('--task <task>', 'Initial task prompt')
    .option('--model <model>', 'Model override')
    .option('--broker-url <url>', 'Broker base URL (overrides RELAY_BROKER_URL and connection.json)')
    .option('--api-key <key>', 'Broker API key (overrides RELAY_BROKER_API_KEY and connection.json)')
    .option('--state-dir <dir>', 'Directory containing connection.json (default: .agent-relay/)')
    .action(async (provider: string, options: Record<string, unknown>) => {
      const mode = (options.mode as string) ?? 'drive';
      if (mode !== 'drive' && mode !== 'view' && mode !== 'passthrough') {
        deps.error(`Unknown attach mode "${mode}". Expected one of: drive, view, passthrough.`);
        deps.exit(1);
        return;
      }
      const name = (options.name as string | undefined) ?? provider;
      await run(deps, async (client) => {
        await spawnAgentWithClient(client, {
          name,
          cli: provider,
          channels: (options.channels as string[] | undefined) ?? ['general'],
          task: options.task as string | undefined,
          model: options.model as string | undefined,
        });
        deps.log(`Spawned ${name} (${provider}). Attaching (${mode})…`);
      });
      const code = await deps.attach(name, mode as AttachMode, {
        brokerUrl: options.brokerUrl as string | undefined,
        apiKey: options.apiKey as string | undefined,
        stateDir: options.stateDir as string | undefined,
      });
      if (code !== 0) {
        deps.exit(code);
      }
    });

  agent
    .command('release')
    .description('Release an agent (graceful, or hard-kill with --kill)')
    .argument('<name>', 'Agent name')
    .option('--kill', 'Hard-kill the agent process instead of a graceful release')
    .action(async (name: string, options: { kill?: boolean }) => {
      await run(deps, async (client) => {
        if (options.kill) {
          await client.release(name, 'kill');
          deps.log(`Killed ${name}.`);
        } else {
          await client.release(name);
          deps.log(`Released ${name}.`);
        }
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
    .option('--state-dir <dir>', 'Directory containing connection.json (default: .agent-relay/)')
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
        await new Promise<void>((_resolve, reject) => {
          client.onEvent((event) => {
            deps.log(JSON.stringify(event));
          });
          process.once('SIGINT', () => reject(new Error('interrupted')));
        });
      });
    });
}
