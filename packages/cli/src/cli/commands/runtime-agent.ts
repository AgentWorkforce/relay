import type { Command } from 'commander';

import type { RuntimeClient } from '@agent-relay/runtime';

import { defaultExit } from '../lib/exit.js';
import { createRuntimeClient, spawnAgentWithClient } from '../lib/client-factory.js';

type ExitFn = (code: number) => never;

export interface RuntimeAgentDependencies {
  connect: (cwd: string) => Promise<RuntimeClient>;
  cwd: () => string;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}

function withDefaults(overrides: Partial<RuntimeAgentDependencies> = {}): RuntimeAgentDependencies {
  return {
    connect: (cwd: string) => createRuntimeClient({ cwd, preferConnect: true }),
    cwd: () => process.cwd(),
    log: (...args: unknown[]) => console.log(...args),
    error: (...args: unknown[]) => console.error(...args),
    exit: defaultExit,
    ...overrides,
  };
}

async function run(deps: RuntimeAgentDependencies, fn: (client: RuntimeClient) => Promise<void>): Promise<void> {
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
 * Register the `runtime agent …` subtree (and `runtime tail`) onto the driver
 * group. List/spawn/release/kill talk to a running local broker; attach/new/tail
 * are interactive PTY operations and point the user at the dashboard.
 */
export function registerRuntimeAgentCommands(
  group: Command,
  overrides: Partial<RuntimeAgentDependencies> = {}
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
    .action(async (provider: string, opts: Record<string, unknown>) => {
      await run(deps, async (client) => {
        const name = (opts.name as string | undefined) ?? provider;
        await spawnAgentWithClient(client, { name, cli: provider, channels: ['general'] });
        deps.log(
          `Spawned ${name} (${provider}). Attach interactively with the dashboard (\`relay driver up\`) or \`relay runtime agent attach ${name}\`.`
        );
      });
    });

  agent
    .command('release')
    .description('Release an agent (graceful)')
    .argument('<name>', 'Agent name')
    .action(async (name: string) => {
      await run(deps, async (client) => {
        await client.release(name);
        deps.log(`Released ${name}.`);
      });
    });

  agent
    .command('kill')
    .description('Hard-kill an agent process')
    .argument('<name>', 'Agent name')
    .action(async (name: string) => {
      await run(deps, async (client) => {
        await client.release(name, 'kill');
        deps.log(`Killed ${name}.`);
      });
    });

  agent
    .command('attach')
    .description('Attach to a running agent (interactive)')
    .argument('<name>', 'Agent name')
    .option('--mode <mode>', 'drive | view | passthrough', 'drive')
    .action((name: string) => {
      deps.error(
        `Interactive attach is provided by the dashboard. Start it with \`relay driver up\` and open the agent "${name}", or use a PTY harness.`
      );
      deps.exit(1);
    });

  group
    .command('tail')
    .description('Stream broker events')
    .option('--agent <name>', 'Filter to a single agent')
    .action(() => {
      deps.error(
        'Live event tailing is provided by the dashboard. Start it with `relay driver up` to watch broker and agent events.'
      );
      deps.exit(1);
    });
}
