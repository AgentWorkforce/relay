import type { Command } from 'commander';

import {
  addSdkOptions,
  printJson,
  runSdk,
  sdkOptionsFromOpts,
  withSdkDefaults,
  type SdkCommandDeps,
} from '../lib/sdk-command.js';
import {
  AgentRemovalPendingError,
  isNotFoundError,
  parseRemovalWaitTimeout,
  waitForAgentRemoval,
} from '../lib/agent-removal.js';

import { withAgentRegistrationDeadline, withDeadline } from '../lib/agent-registration.js';
import { isAgentAlreadyExists, takeOverAgent } from '../lib/agent-takeover.js';
import { saveAgentToken } from '../lib/agent-token-store.js';
import { guardCredentialOrigin } from '../lib/relaycast-origin-binding.js';
import { resolveWorkspaceTransport } from '../lib/sdk-client.js';
import { attributableReleaseReason } from '../lib/release-reason.js';

export interface AgentCommandDependencies extends SdkCommandDeps {
  /** Issue a fresh token for an existing agent with the workspace key. */
  takeOverAgent: typeof takeOverAgent;
}

/** Save a freshly issued token by name so `--as <name>` works in any shell. */
function rememberToken(
  deps: AgentCommandDependencies,
  opts: Record<string, unknown>,
  name: string,
  token: string | undefined
): void {
  if (!token) return;
  try {
    const { workspaceKey, baseUrl } = resolveWorkspaceTransport(sdkOptionsFromOpts(opts));
    saveAgentToken(workspaceKey, baseUrl, name, token);
    // The token belongs to the same server as the key that minted it.
    if (baseUrl) guardCredentialOrigin(token, baseUrl);
    deps.error(`Saved the token for "${name}". Act as this agent with --as ${name}.`);
  } catch (error) {
    // The token is still printed; only the convenience of --as is lost.
    const reason = error instanceof Error ? error.message : String(error);
    deps.error(`Could not save the token for "${name}" (${reason}). Use the printed token instead.`);
  }
}

function withAgentDefaults(overrides: Partial<AgentCommandDependencies> = {}): AgentCommandDependencies {
  return {
    ...withSdkDefaults(overrides),
    takeOverAgent,
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
      let registration: { id: string; name: string; token?: string };
      try {
        registration = await withAgentRegistrationDeadline(
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
      } catch (error) {
        // Relaycast refuses to re-register a taken name. Without --strict,
        // re-registering means "give me a working token for this agent".
        if (opts.strict === true || !isAgentAlreadyExists(error)) throw error;
        registration = await deps.takeOverAgent(
          resolveWorkspaceTransport(sdkOptionsFromOpts(opts)),
          name,
          'agent-relay agent register: issue a new token for an existing agent'
        );
      }
      rememberToken(deps, opts, registration.name, registration.token);
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
      // Only rotate an agent that exists: a typo must not mint a new identity.
      // A confirmed "not found" becomes that message; any other failure is
      // rethrown unchanged rather than claiming the agent is missing.
      const existing = await withDeadline(
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
      // An owner rotation needs only the workspace key, so a lost token can
      // always be replaced. It revokes the agent's previous token.
      const registration = await withAgentRegistrationDeadline(
        () =>
          deps.takeOverAgent(
            resolveWorkspaceTransport(sdkOptionsFromOpts(opts)),
            name,
            'agent-relay agent rotate',
            (existing as { id?: string } | undefined)?.id
          ),
        name
      );
      rememberToken(deps, opts, registration.name, registration.token);
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
      .option('--wait', 'Wait until the registration is cleared', false)
      .option('--no-wait', 'Return after the removal is accepted')
      .option('--wait-timeout <ms>', 'Registration clearance timeout', '30000')
  ).action(async (name: string, opts: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      const relay = deps.createWorkspaceRelay(sdkOptionsFromOpts(opts));
      const reason = attributableReleaseReason(
        opts.reason,
        process.env.RELAY_AGENT_NAME ?? 'agent-relay CLI',
        'agent removed'
      );
      const waitTimeoutMs = opts.wait === true ? parseRemovalWaitTimeout(opts.waitTimeout) : undefined;
      const result = await relay.workspace.release({ name, reason, deleteAgent: true });
      if (waitTimeoutMs !== undefined) {
        const removal = await waitForAgentRemoval({
          name,
          getAgent: (name) => relay.agents.get(name),
          listAgents: () => relay.agents.list(),
          timeoutMs: waitTimeoutMs,
        });
        if (removal.cleared) {
          deps.log(`Removed agent ${name}.`);
          return;
        }
        if (removal.observedPresent) throw new AgentRemovalPendingError(name);
        // Unverifiable clearance keeps the asynchronous acknowledgement.
        deps.error(`Could not verify removal: ${removal.readError ?? 'registration unavailable'}`);
        deps.log(
          `Removal of agent ${name} was initiated (status: ${result.status ?? 'pending'}) and is processed asynchronously; registration clearance could not be verified.`
        );
        return;
      }
      deps.log(
        `Removal of agent ${name} was initiated (status: ${result.status ?? 'pending'}) and is processed asynchronously. Use --wait to verify the name is reusable.`
      );
    });
  });
}
