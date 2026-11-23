/**
 * `agent-relay delegates`: name the agents that relay your approval for
 * named actions (owner-named trusted delegates), through Agent Relay Cloud's
 * human-only routes under `/api/v1/workspaces/{ws}/delegates`, with your own
 * Cloud login. Cloud refuses these routes for agent tokens, and while the
 * workspace's `delegation_enabled` is off (except list and revocation).
 */

import { Command, InvalidArgumentError } from 'commander';

import { authorizedApiFetch, defaultApiUrl, ensureCloudSession } from '@agent-relay/cloud';

import { describeError } from '../lib/describe-error.js';

export interface DelegatesDependencies {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => never;
  ensureCloudSession: typeof ensureCloudSession;
  authorizedApiFetch: typeof authorizedApiFetch;
}

/** Action classes a grant may name (wire contract v1). */
export const DELEGATION_CLASSES = [
  'merge',
  'pr_ops',
  'deploy',
  'release',
  'secret_change',
  'destructive',
  'spend',
  'external_comms',
  'prompt_approval',
  'config_change',
] as const;

const WORKSPACE_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|rw_[a-z0-9]{8})$/i;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function workspacePath(workspace: string, rest = ''): string {
  const id = workspace.trim();
  if (!WORKSPACE_PATTERN.test(id)) {
    throw new Error('Use a Cloud workspace UUID or unified rw_ workspace ID for --workspace.');
  }
  return `/api/v1/workspaces/${encodeURIComponent(id)}/delegates${rest}`;
}

function requireId(value: string, label: string): string {
  const id = value.trim();
  if (!ID_PATTERN.test(id)) {
    throw new InvalidArgumentError(`Invalid ${label}.`);
  }
  return id;
}

/**
 * `class=target[,target…]`, e.g. `merge=AgentWorkforce/*` or
 * `prompt_approval=*`. Repeatable.
 */
export function parseScope(
  value: string,
  previous: Array<{ class: string; targets: string[] }> = []
): Array<{ class: string; targets: string[] }> {
  const [cls, targets] = value.split('=', 2);
  if (!cls || !(DELEGATION_CLASSES as readonly string[]).includes(cls) || !targets) {
    throw new InvalidArgumentError(
      `Use class=target[,target…] with a class of ${DELEGATION_CLASSES.join(', ')}.`
    );
  }
  const list = targets
    .split(',')
    .map((target) => target.trim())
    .filter(Boolean);
  if (list.length === 0 || list.some((target) => target.length > 256)) {
    throw new InvalidArgumentError('Each target is 1 to 256 characters.');
  }
  return [...previous, { class: cls, targets: list }];
}

/** Days from now as an ISO time, 1 to 90 (Cloud caps it at the org policy). */
export function expiryFromDays(value: string, now = Date.now()): string {
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw new InvalidArgumentError('Use a whole number of days from 1 to 90.');
  }
  return new Date(now + days * 24 * 60 * 60 * 1000).toISOString();
}

async function request(
  deps: DelegatesDependencies,
  path: string,
  init: RequestInit,
  apiUrl?: string
): Promise<unknown> {
  const { auth } = await deps.ensureCloudSession({ apiUrl: apiUrl ?? defaultApiUrl(), interactive: false });
  const result = await deps.authorizedApiFetch(auth, path, init, { interactive: false });
  const payload = (await result.response.json().catch(() => null)) as unknown;
  if (!result.response.ok) {
    const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    const code = typeof record.error === 'string' ? record.error : undefined;
    const message = typeof record.message === 'string' ? record.message : undefined;
    throw new Error(
      `Agent Relay Cloud refused the request (${result.response.status}${code ? ` ${code}` : ''})${
        message ? `: ${message}` : '.'
      }`
    );
  }
  return payload;
}

function json(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function run(deps: DelegatesDependencies, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    deps.error(describeError(error));
    deps.exit(1);
  }
}

function defaults(overrides: Partial<DelegatesDependencies>): DelegatesDependencies {
  return {
    log: (...args: unknown[]) => console.log(...args),
    error: (...args: unknown[]) => console.error(...args),
    exit: (code: number) => process.exit(code),
    ensureCloudSession,
    authorizedApiFetch,
    ...overrides,
  };
}

/** Registers `agent-relay delegates list|add|revoke|revoke-all|claim`. */
export function registerDelegatesCommands(
  program: Command,
  overrides: Partial<DelegatesDependencies> = {}
): void {
  const deps = defaults(overrides);
  const delegates = program
    .command('delegates')
    .description('Name the agents that relay your approval for named actions (owner-named delegates)');
  const common = (command: Command) =>
    command
      .requiredOption('--workspace <workspace>', 'Cloud workspace UUID or unified rw_ workspace ID')
      .option('--api-url <url>', 'Cloud API base URL');
  const print = (payload: unknown) => deps.log(JSON.stringify(payload, null, 2));

  common(delegates.command('list').description('List your grants (admins: --all for the workspace)'))
    .option('--all', 'Every grant in the workspace (admins only)')
    .action(async (options: { workspace: string; apiUrl?: string; all?: boolean }) => {
      await run(deps, async () => {
        print(
          await request(
            deps,
            workspacePath(options.workspace, options.all ? '?all=1' : ''),
            { method: 'GET' },
            options.apiUrl
          )
        );
      });
    });

  common(delegates.command('add').description('Name an agent, by its immutable id, as your delegate'))
    .argument('<agent-id>', 'The delegate agent id (claim an external bot first)')
    .requiredOption(
      '--scope <class=targets>',
      'Action class and targets it may approve, e.g. merge=AgentWorkforce/*; repeatable',
      parseScope
    )
    .option('--expires-in-days <days>', 'Days until the grant expires (default 30, at most 90)', '30')
    .option(
      '--require-tier-o <classes>',
      'Classes that need the owner to approve in Agent Relay (comma list)'
    )
    .action(
      async (
        agentId: string,
        options: {
          workspace: string;
          apiUrl?: string;
          scope: Array<{ class: string; targets: string[] }>;
          expiresInDays: string;
          requireTierO?: string;
        }
      ) => {
        await run(deps, async () => {
          const tierO = options.requireTierO
            ?.split(',')
            .map((cls) => cls.trim())
            .filter(Boolean);
          if (tierO?.some((cls) => !(DELEGATION_CLASSES as readonly string[]).includes(cls))) {
            throw new Error(`--require-tier-o takes classes of ${DELEGATION_CLASSES.join(', ')}.`);
          }
          print(
            await request(
              deps,
              workspacePath(options.workspace),
              json({
                delegate_agent_id: requireId(agentId, 'agent id'),
                scopes: options.scope,
                expires_at: expiryFromDays(options.expiresInDays),
                ...(tierO?.length ? { require_tier_o: tierO } : {}),
              }),
              options.apiUrl
            )
          );
        });
      }
    );

  common(delegates.command('revoke').description('Revoke one grant'))
    .argument('<grant-id>', 'The grant id (grt_…)')
    .action(async (grantId: string, options: { workspace: string; apiUrl?: string }) => {
      await run(deps, async () => {
        print(
          await request(
            deps,
            workspacePath(options.workspace, `/${encodeURIComponent(requireId(grantId, 'grant id'))}`),
            { method: 'DELETE' },
            options.apiUrl
          )
        );
      });
    });

  common(delegates.command('revoke-all').description('Revoke every grant you made (admins: --all)'))
    .option('--all', 'Every grant in the workspace (admins only)')
    .action(async (options: { workspace: string; apiUrl?: string; all?: boolean }) => {
      await run(deps, async () => {
        print(
          await request(
            deps,
            workspacePath(options.workspace, '/revoke-all'),
            json(options.all ? { all: true } : {}),
            options.apiUrl
          )
        );
      });
    });

  common(
    delegates
      .command('claim')
      .description('Start a claim: a one-time code an external bot completes with its own agent token')
  ).action(async (options: { workspace: string; apiUrl?: string }) => {
    await run(deps, async () => {
      print(await request(deps, workspacePath(options.workspace, '/claims'), json({}), options.apiUrl));
    });
  });
}
