import type { Command } from 'commander';

import {
  addSdkOptions,
  printJson,
  runSdk,
  sdkOptionsFromOpts,
  withSdkDefaults,
  type SdkCommandDeps,
} from '../lib/sdk-command.js';
import { RelayError } from '@agent-relay/sdk';

import { withAgentRegistrationDeadline, withDeadline } from '../lib/agent-registration.js';
import { attributableReleaseReason } from '../lib/release-reason.js';

function isNotFoundError(error: unknown): boolean {
  if (error instanceof RelayError) return error.code === 'not_found' || error.statusCode === 404;
  const statusCode =
    error && typeof error === 'object'
      ? ((error as { statusCode?: unknown }).statusCode ?? (error as { status?: unknown }).status)
      : undefined;
  return Number(statusCode) === 404;
}

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
      // `register()` is create-or-rotate by default, so without this existence
      // check a typo'd/never-registered name would silently mint a brand-new
      // identity instead of failing — surprising for a command documented as
      // rotating an *existing* one. Bounded like the registration call below,
      // so a hung upstream `agents.get` can't reintroduce the hang class this
      // PR's deadline wrapper exists to prevent. Only a confirmed "not found"
      // is translated to the existence-check error — a network/auth/5xx
      // failure is rethrown as-is, since treating those as "does not exist"
      // and pointing at `agent register` (create-or-rotate) would rotate and
      // disconnect a still-valid token for an identity that does exist but
      // was merely unreachable.
      await withDeadline(
        () => relay.agents.get(name),
        (effectiveTimeoutMs) =>
          new Error(
            `Checking whether agent "${name}" exists did not complete within ${effectiveTimeoutMs}ms.`
          )
      ).catch((error: unknown) => {
        if (!isNotFoundError(error)) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Agent "${name}" does not exist; use "agent register" to create it. (${detail})`);
      });
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
      const result = await relay.workspace.release({ name, reason, deleteAgent: true });
      // The release endpoint acknowledges an async action invocation — a
      // resolved promise means the request was accepted, not that the
      // deletion has finished. Only claim "Removed" once the invocation
      // itself reports completion; otherwise say what actually happened.
      if (result.status === 'completed') {
        deps.log(`Removed agent ${name}.`);
      } else {
        deps.log(
          `Removal of agent ${name} was initiated (status: ${result.status ?? 'pending'}) and is processed asynchronously.`
        );
      }
    });
  });
}
