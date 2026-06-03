import type { Command } from 'commander';
import { HarnessDriverClient } from '@agent-relay/harness-driver';

import {
  addSdkOptions,
  printJson,
  runSdk,
  sdkOptionsFromOpts,
  withSdkDefaults,
  type SdkCommandDeps,
} from '../lib/sdk-command.js';

export interface AgentCommandDependencies extends SdkCommandDeps {
  connectLocal: (cwd: string) => Promise<HarnessDriverClient>;
  cwd: () => string;
}

function withAgentDefaults(overrides: Partial<AgentCommandDependencies> = {}): AgentCommandDependencies {
  return {
    ...withSdkDefaults(overrides),
    connectLocal: (cwd: string) => Promise.resolve(HarnessDriverClient.connect({ cwd })),
    cwd: () => process.cwd(),
    ...overrides,
  };
}

async function runLocalBroker(
  deps: AgentCommandDependencies,
  fn: (client: HarnessDriverClient) => Promise<void>
): Promise<void> {
  try {
    await fn(await deps.connectLocal(deps.cwd()));
  } catch (err) {
    deps.error(err instanceof Error ? err.message : String(err));
    deps.exit(1);
  }
}

export function registerAgentCommands(
  program: Command,
  overrides: Partial<AgentCommandDependencies> = {}
): void {
  const deps = withAgentDefaults(overrides);
  const group = program.command('agent').description('Manage workspace agents and local delivery controls');

  addSdkOptions(
    group
      .command('register')
      .description('Register a new agent and print its token')
      .argument('<name>', 'Agent name')
      .option('--type <type>', 'Agent type (agent | human | system)')
      .option('--persona <persona>', 'Persona string')
  ).action(async (name: string, opts: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      const relay = deps.createWorkspaceRelay(sdkOptionsFromOpts(opts));
      const registration = await relay.agents.register({
        name,
        type: opts.type as 'agent' | 'human' | 'system' | undefined,
        persona: opts.persona as string | undefined,
      });
      printJson(deps, registration);
    });
  });

  addSdkOptions(
    group.command('list').description('List agents').option('--status <status>', 'Filter by status')
  ).action(async (opts: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      const relay = deps.createWorkspaceRelay(sdkOptionsFromOpts(opts));
      printJson(deps, await relay.agents.list({ status: opts.status as never }));
    });
  });

  addSdkOptions(
    group
      .command('add')
      .description('Add an agent to the workspace')
      .argument('<name>', 'Agent name')
      .option('--type <type>', 'Agent type (agent | human | system)')
  ).action(async (name: string, opts: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      const relay = deps.createWorkspaceRelay(sdkOptionsFromOpts(opts));
      printJson(
        deps,
        await relay.agents.register({ name, type: opts.type as 'agent' | 'human' | 'system' | undefined })
      );
    });
  });

  addSdkOptions(
    group.command('remove').description('Remove an agent').argument('<name>', 'Agent name')
  ).action(async (name: string, opts: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      const relay = deps.createWorkspaceRelay(sdkOptionsFromOpts(opts));
      await relay.agents.delete(name);
      deps.log(`Removed agent ${name}.`);
    });
  });

  const message = group.command('message').description('Control local broker message delivery for an agent');

  message
    .command('flush')
    .description('Flush queued relay messages into a held local agent')
    .argument('<name>', 'Agent name')
    .action(async (name: string) => {
      await runLocalBroker(deps, async (client) => {
        printJson(deps, { name, ...(await client.flushPending(name)) });
      });
    });

  message
    .command('hold')
    .description('Hold new relay messages for a local agent until flushed')
    .argument('<name>', 'Agent name')
    .action(async (name: string) => {
      await runLocalBroker(deps, async (client) => {
        printJson(deps, { name, ...(await client.setInboundDeliveryMode(name, 'manual_flush')) });
      });
    });

  message
    .command('auto')
    .description('Resume automatic relay message injection for a local agent')
    .argument('<name>', 'Agent name')
    .action(async (name: string) => {
      await runLocalBroker(deps, async (client) => {
        printJson(deps, { name, ...(await client.setInboundDeliveryMode(name, 'auto_inject')) });
      });
    });
}
