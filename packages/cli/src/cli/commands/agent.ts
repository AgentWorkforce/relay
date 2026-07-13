import type { Command } from 'commander';

import {
  addSdkOptions,
  printJson,
  runSdk,
  sdkOptionsFromOpts,
  withSdkDefaults,
  type SdkCommandDeps,
} from '../lib/sdk-command.js';

export type AgentCommandDependencies = SdkCommandDeps;

function withAgentDefaults(overrides: Partial<AgentCommandDependencies> = {}): AgentCommandDependencies {
  return {
    ...withSdkDefaults(overrides),
    ...overrides,
  };
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
}
