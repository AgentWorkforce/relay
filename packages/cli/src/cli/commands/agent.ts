import type { Command } from 'commander';

import {
  addSdkOptions,
  printJson,
  runSdk,
  sdkOptionsFromOpts,
  withSdkDefaults,
  type SdkCommandDeps,
} from '../lib/sdk-command.js';
import { withAgentRegistrationDeadline } from '../lib/agent-registration.js';
import { attributableReleaseReason } from '../lib/release-reason.js';

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
      .description('Register an agent, rotating an existing identity token when needed')
      .argument('<name>', 'Agent name')
      .option('--type <type>', 'Agent type (agent | human | system)')
      .option('--persona <persona>', 'Persona string')
      .option('--strict', 'Fail instead of rotating the token when the name already exists')
  ).action(async (name: string, opts: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      const relay = deps.createWorkspaceRelay(sdkOptionsFromOpts(opts));
      const registration = await withAgentRegistrationDeadline(
        () =>
          relay.workspace.register(
            {
              name,
              type: opts.type as 'agent' | 'human' | 'system' | undefined,
              persona: opts.persona as string | undefined,
            },
            { strict: opts.strict === true }
          ),
        name
      );
      printJson(deps, { id: registration.id, name: registration.name, token: registration.token });
    });
  });

  addSdkOptions(
    group
      .command('rotate')
      .description('Rotate the token for an existing agent name')
      .argument('<name>', 'Agent name')
  ).action(async (name: string, opts: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      const relay = deps.createWorkspaceRelay(sdkOptionsFromOpts(opts));
      const registration = await withAgentRegistrationDeadline(
        () => relay.workspace.register({ name }),
        name
      );
      printJson(deps, { id: registration.id, name: registration.name, token: registration.token });
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

  addSdkOptions(group.command('me').description('Show the current agent identity')).action(
    async (opts: Record<string, unknown>) => {
      await runSdk(deps, async () => {
        const relay = deps.createAgentRelay(sdkOptionsFromOpts(opts));
        printJson(deps, await relay.agents.me());
      });
    }
  );

  addSdkOptions(group.command('presence').description('List visible agent presence')).action(
    async (opts: Record<string, unknown>) => {
      await runSdk(deps, async () => {
        const relay = deps.createAgentRelay(sdkOptionsFromOpts(opts));
        printJson(deps, await relay.agents.presence());
      });
    }
  );

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
    group
      .command('remove')
      .description('Remove an agent while preserving attributed message history')
      .argument('<name>', 'Agent name')
      .option('--reason <reason>', 'Removal reason')
  ).action(async (name: string, opts: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      const relay = deps.createWorkspaceRelay(sdkOptionsFromOpts(opts));
      const reason = attributableReleaseReason(
        opts.reason,
        process.env.RELAY_AGENT_NAME ?? 'agent-relay CLI',
        'agent removed'
      );
      await relay.workspace.release({ name, reason, deleteAgent: true });
      deps.log(`Removed agent ${name}.`);
    });
  });
}
