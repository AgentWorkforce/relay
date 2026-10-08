import { spawn } from 'node:child_process';

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
import { readAgentTokenFile, writeAgentTokenFile } from '../lib/agent-token-file.js';
import { attributableReleaseReason } from '../lib/release-reason.js';
import { resolveAgentToken } from '../lib/sdk-client.js';

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

function safeErrorDetail(error: unknown): string {
  // Never echo a credential that an upstream error might quote back.
  return safeRelayErrorMessage(error).replace(/\b(at|rk)_live_[A-Za-z0-9_-]+/g, '<redacted>');
}

function isNameConflictError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, rawCode } = error as { code?: unknown; rawCode?: unknown };
  return code === 'name_conflict' || code === 'agent_already_exists' || rawCode === 'agent_already_exists';
}

/** Run `command` with `env` and resolve with its exit code. */
export type RunWithEnv = (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<number>;

export interface AgentCommandDependencies extends SdkCommandDeps {
  /** Environment used to find the current identity (`RELAY_AGENT_NAME`, `RELAY_AGENT_TOKEN`). */
  env: NodeJS.ProcessEnv;
  runWithEnv: RunWithEnv;
}

const defaultRunWithEnv: RunWithEnv = (command, args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });

function withAgentDefaults(overrides: Partial<AgentCommandDependencies> = {}): AgentCommandDependencies {
  return {
    env: process.env,
    runWithEnv: defaultRunWithEnv,
    ...withSdkDefaults(overrides),
    ...overrides,
  };
}

const CURRENT_IDENTITY_HINT =
  'To act as an identity you already hold, run "agent-relay agent token --current" ' +
  '(it reads the token this session already has and never mints or rotates one).';

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

function resolveCurrentToken(
  opts: Record<string, unknown>,
  env: NodeJS.ProcessEnv
): { token: string | undefined; source: 'file' | 'flag' | 'env' } {
  const fromFile = typeof opts.fromFile === 'string' ? opts.fromFile : undefined;
  const flagToken = typeof opts.token === 'string' && opts.token.trim() ? opts.token : undefined;
  if (fromFile && flagToken) {
    throw new Error('Pass either --from-file or --token, not both.');
  }
  if (fromFile) return { token: readAgentTokenFile(fromFile), source: 'file' };
  return { token: resolveAgentToken({ token: flagToken, env }), source: flagToken ? 'flag' : 'env' };
}

function noCurrentTokenError(): Error {
  return new Error(
    'This session has no agent token: neither --from-file, --token, nor RELAY_AGENT_TOKEN is set. ' +
      'Nothing was minted or rotated. Do not re-register your own name to get one. Instead: send through ' +
      'the Agent Relay desktop session socket, use the Agent Relay MCP tools (for example send_dm) if they ' +
      'are loaded, or register a new, unused name with "agent-relay agent register <new-name>".'
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
        '\nTo act as an identity this session already holds, use "agent-relay agent token --current" ' +
          'instead; it never mints or rotates a token.'
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

  group
    .command('token')
    .description(
      "Use this session's existing agent identity without printing, minting, or rotating its token"
    )
    .option('--current', "Required: act on this session's existing identity")
    .option('--from-file <path>', 'Read the token from an owner-only (0600) file written by --out')
    .option('--out <path>', 'Write the token to a new owner-only (0600) file and print only its path')
    .option('--force', 'With --out, replace an existing regular file')
    .option('--token <token>', 'Agent token (defaults to RELAY_AGENT_TOKEN); prefer --from-file')
    .option('--base-url <url>', 'Override the API base URL (defaults to RELAY_BASE_URL)')
    .argument('[command...]', 'After "--": run this command with RELAY_AGENT_TOKEN set to the token')
    .addHelpText(
      'after',
      [
        '',
        'The token comes from --from-file, --token, or RELAY_AGENT_TOKEN, and is verified with a read-only',
        'identity lookup. It is never written to stdout or stderr.',
        '',
        'Examples:',
        '  agent-relay agent token --current',
        '  agent-relay agent token --current --out ~/.config/agent-relay/me.token',
        '  agent-relay agent token --current --from-file ~/.config/agent-relay/me.token -- \\',
        '    agent-relay message dm send reviewer "Ready for review"',
      ].join('\n')
    )
    .action(async (command: string[], opts: Record<string, unknown>) => {
      let childExitCode = 0;
      await runSdk(deps, async () => {
        if (opts.current !== true) {
          throw new Error(
            'Pass --current. "agent token" only uses the identity this session already holds; ' +
              'it never mints or rotates a token.'
          );
        }
        const { token, source } = resolveCurrentToken(opts, deps.env);
        if (!token) throw noCurrentTokenError();

        const relay = deps.createAgentRelay({ token, baseUrl: opts.baseUrl as string | undefined });
        const me = await withDeadline(
          () => relay.agents.me(),
          (effectiveTimeoutMs) =>
            new Error(`Verifying the current agent identity did not complete within ${effectiveTimeoutMs}ms.`)
        ).catch((error: unknown) => {
          if (error instanceof Error && error.message.startsWith('Verifying the current agent identity')) {
            throw error;
          }
          throw new Error(
            `The current agent token was rejected (${safeErrorDetail(error)}). It may have been rotated or ` +
              'revoked. Nothing was minted or rotated.'
          );
        });

        const expectedName = deps.env.RELAY_AGENT_NAME?.trim();
        if (expectedName && me.name && me.name !== expectedName) {
          deps.error(
            `Warning: the token belongs to "${me.name}", but RELAY_AGENT_NAME is "${expectedName}".`
          );
        }

        const tokenFile =
          typeof opts.out === 'string'
            ? writeAgentTokenFile(opts.out, token, { force: opts.force === true })
            : undefined;

        if (command.length > 0) {
          const [executable, ...args] = command;
          const env: NodeJS.ProcessEnv = { ...deps.env, RELAY_AGENT_TOKEN: token };
          if (me.name) env.RELAY_AGENT_NAME = me.name;
          childExitCode = await deps.runWithEnv(executable, args, env);
          return;
        }

        printJson(deps, {
          id: me.id,
          name: me.name,
          source,
          ...(tokenFile ? { tokenFile } : {}),
        });
      });
      // Outside runSdk so the wrapped command's own exit code is preserved.
      if (childExitCode !== 0) deps.exit(childExitCode);
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
