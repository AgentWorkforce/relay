import { Option, type Command } from 'commander';

import {
  addSdkOptions,
  printJson,
  runSdk,
  sdkOptionsFromOpts,
  withSdkDefaults,
  type SdkCommandDeps,
} from '../lib/sdk-command.js';
import { RelayError, safeRelayErrorMessage } from '@agent-relay/sdk';

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

function isCurrentIdentityName(env: NodeJS.ProcessEnv, name: string): boolean {
  const current = env.RELAY_AGENT_NAME?.trim().replace(/^@/, '');
  return Boolean(current) && current!.toLowerCase() === name.trim().replace(/^@/, '').toLowerCase();
}

function isNameConflictError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, rawCode } = error as { code?: unknown; rawCode?: unknown };
  return code === 'name_conflict' || code === 'agent_already_exists' || rawCode === 'agent_already_exists';
}

export interface AgentCommandDependencies extends SdkCommandDeps {
  /** Environment used to recognise this session's own identity (`RELAY_AGENT_NAME`). */
  env: NodeJS.ProcessEnv;
}

function withAgentDefaults(overrides: Partial<AgentCommandDependencies> = {}): AgentCommandDependencies {
  return {
    env: process.env,
    ...withSdkDefaults(overrides),
    ...overrides,
  };
}

const CURRENT_IDENTITY_HINT =
  'To act as an identity you already hold, keep using its existing token (RELAY_AGENT_TOKEN), the ' +
  'Agent Relay desktop session socket, or the Agent Relay MCP tools; do not re-register its name.';

function existingNameError(name: string): Error {
  return new Error(
    `Agent "${name}" already exists. "agent register" is create-only and left its token unchanged. ` +
      `${CURRENT_IDENTITY_HINT} To register a separate identity, choose a new name. ` +
      `Pass --rotate only if you mean to replace "${name}"'s token and disconnect any session still using it.`
  );
}

function rotationRefusedError(name: string): Error {
  return new Error(
    `The Relay service refused to rotate "${name}": it no longer lets a workspace key rotate an ` +
      `existing agent's token, and its current token was left unchanged. ${CURRENT_IDENTITY_HINT}`
  );
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
      .description(
        'Register a new agent identity and print its token. Create-only: an existing name fails ' +
          'and keeps its token unless --rotate is passed'
      )
      .argument('<name>', 'Agent name')
      .option('--type <type>', 'Agent type (agent | human | system)')
      .option('--persona <persona>', 'Persona string')
      .option(
        '--rotate',
        'If the name already exists, replace its token instead of failing. Any session still using the ' +
          'old token is disconnected; servers that enforce create-only registration refuse this'
      )
      .addOption(new Option('--strict', 'Deprecated: registration is create-only by default').hideHelp())
      .addHelpText(
        'after',
        '\nTo act as an identity this session already holds, keep using its existing token ' +
          '(RELAY_AGENT_TOKEN), the desktop session socket, or the MCP tools; never re-register its name.'
      )
  ).action(async (name: string, opts: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      const rotate = opts.rotate === true;
      if (rotate && opts.strict === true) {
        throw new Error('--rotate and --strict cannot be combined.');
      }
      const relay = deps.createWorkspaceRelay(sdkOptionsFromOpts(opts));
      const input = {
        name,
        type: opts.type as 'agent' | 'human' | 'system' | undefined,
        persona: opts.persona as string | undefined,
      };
      let registration;
      try {
        registration = await withAgentRegistrationDeadline(
          () => relay.workspace.register(input, { strict: true }),
          name
        );
      } catch (error) {
        if (!isNameConflictError(error)) throw error;
        if (!rotate) throw existingNameError(name);
        if (isCurrentIdentityName(deps.env, name)) {
          deps.error(
            `Warning: rotating "${name}", this session's own identity (RELAY_AGENT_NAME). ` +
              'The token this session is using stops working.'
          );
        }
        registration = await withAgentRegistrationDeadline(
          () => relay.workspace.register(input, { strict: false }),
          name
        ).catch((rotateError: unknown) => {
          throw isNameConflictError(rotateError) ? rotationRefusedError(name) : rotateError;
        });
      }
      printJson(deps, { id: registration.id, name: registration.name, token: registration.token });
    });
  });

  addSdkOptions(
    group
      .command('rotate')
      .description(
        'Explicitly rotate the token for an existing agent name. Any session still using the old token ' +
          'is disconnected; servers that enforce create-only registration refuse this'
      )
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
      ).catch((error: unknown) => {
        throw isNameConflictError(error) ? rotationRefusedError(name) : error;
      });
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
