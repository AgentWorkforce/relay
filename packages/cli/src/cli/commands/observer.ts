/**
 * `agent-relay observer` — mint a scoped, read-only observer link.
 *
 * The engine rejects a workspace key (`rk_live_`) on the realtime endpoint, and
 * a workspace key is an administrative credential that has no business in a URL
 * or a terminal transcript. This command mints a scoped `ot_live_` token instead
 * and prints the observer URL built from it, so "let a human follow along" is a
 * single command rather than a hand-rolled API call.
 */

import type { Command } from 'commander';
import { InvalidArgumentError } from 'commander';

import {
  createObserverToken,
  listObserverTokens,
  revokeObserverToken,
  type RelayObserverToken,
} from '@agent-relay/sdk';

import {
  DEFAULT_OBSERVER_EXPIRES,
  DEFAULT_OBSERVER_URL,
  observerUrl,
  resolveObserverBaseUrl,
} from '../lib/observer-url.js';
import { printJson, runSdk, withSdkDefaults, type SdkCommandDeps } from '../lib/sdk-command.js';
import { resolveBaseUrl, resolveWorkspaceKey } from '../lib/sdk-client.js';

const MAX_CHANNEL_FILTERS = 50;

export interface ObserverCommandDependencies extends SdkCommandDeps {
  createObserverToken: typeof createObserverToken;
  listObserverTokens: typeof listObserverTokens;
  revokeObserverToken: typeof revokeObserverToken;
  /** Injected so tests get deterministic token names and expiry timestamps. */
  now: () => number;
  randomSuffix: () => string;
}

function withObserverDefaults(
  overrides: Partial<ObserverCommandDependencies> = {}
): ObserverCommandDependencies {
  return {
    ...withSdkDefaults(overrides),
    createObserverToken,
    listObserverTokens,
    revokeObserverToken,
    now: () => Date.now(),
    randomSuffix: () => Math.random().toString(36).slice(2, 10),
    ...overrides,
  };
}

/**
 * Parse a `30m` / `24h` / `7d` duration into milliseconds. Bare digits are
 * rejected rather than guessed at — `--expires 24` is far more likely to mean
 * hours than milliseconds, and silently picking either would be wrong.
 */
export function parseDuration(value: string): number {
  const match = /^(\d+)([mhd])$/.exec(value.trim());
  if (!match) {
    throw new InvalidArgumentError('Expected a duration like 30m, 24h, or 7d.');
  }
  const amount = Number(match[1]);
  if (amount <= 0) {
    throw new InvalidArgumentError('Expected a positive duration.');
  }
  const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 'm' | 'h' | 'd'];
  const total = amount * unitMs;
  // The engine caps nothing here, but a token outliving the workspace is a
  // liability rather than a convenience.
  if (total > 90 * 86_400_000) {
    throw new InvalidArgumentError('Expected a duration of 90d or less.');
  }
  return total;
}

function parseChannels(value: string): string[] {
  const names = value
    .split(',')
    .map((name) => name.trim().replace(/^#/, ''))
    .filter(Boolean);
  if (names.length === 0) {
    throw new InvalidArgumentError('Expected at least one channel name.');
  }
  if (names.length > MAX_CHANNEL_FILTERS) {
    throw new InvalidArgumentError(`Expected at most ${MAX_CHANNEL_FILTERS} channel names.`);
  }
  return [...new Set(names)];
}

/**
 * Credentials shared by every observer subcommand. `baseUrl` is spread rather
 * than passed as `undefined` because the SDK options treat an explicit
 * `undefined` and an absent key differently.
 */
function connection(options: Record<string, unknown>): { workspaceKey: string; baseUrl?: string } {
  const baseUrl = resolveBaseUrl({ baseUrl: options.baseUrl as string | undefined });
  return {
    workspaceKey: resolveWorkspaceKey({
      workspaceKey: options.workspaceKey as string | undefined,
    }),
    ...(baseUrl ? { baseUrl } : {}),
  };
}

function describeToken(token: RelayObserverToken): Record<string, unknown> {
  return {
    id: token.id,
    name: token.name,
    status: token.status,
    expiresAt: token.expiresAt,
    createdAt: token.createdAt,
    ...(token.lastUsedAt === undefined ? {} : { lastUsedAt: token.lastUsedAt }),
  };
}

export function registerObserverCommands(
  program: Command,
  overrides: Partial<ObserverCommandDependencies> = {}
): void {
  const deps = withObserverDefaults(overrides);
  const env = process.env;

  const group = program
    .command('observer')
    .description('Mint a read-only observer link so a human can follow this workspace');

  group
    .option(
      '--workspace-key <key>',
      'Workspace key (defaults to RELAY_WORKSPACE_KEY or the active workspace)'
    )
    .option('--base-url <url>', 'Override the engine API base URL (defaults to RELAY_BASE_URL)')
    .option('--observer-url <url>', `Observer dashboard URL (defaults to ${DEFAULT_OBSERVER_URL})`)
    .option('--name <name>', 'Token name (defaults to a generated unique name)')
    .option('--channels <names>', 'Restrict to a comma-separated list of channels', parseChannels)
    .option('--include-dms', 'Include agent DM traffic (excluded by default)')
    .option(
      '--expires <duration>',
      `Token lifetime, e.g. 30m, 24h, 7d (default ${DEFAULT_OBSERVER_EXPIRES})`,
      parseDuration
    )
    .option('--json', 'Output the token metadata and URL as JSON')
    .action(async (options: Record<string, unknown>) => {
      await runSdk(deps, async () => {
        const lifetimeMs = (options.expires as number | undefined) ?? parseDuration(DEFAULT_OBSERVER_EXPIRES);
        const name = (options.name as string | undefined)?.trim() || `observer-cli-${deps.randomSuffix()}`;

        const token = await deps.createObserverToken({
          ...connection(options),
          name,
          description: 'Minted by `agent-relay observer` for read-only follow-along',
          filters: {
            includeDms: options.includeDms === true,
            ...(options.channels ? { channelNames: options.channels as string[] } : {}),
          },
          expiresAt: new Date(deps.now() + lifetimeMs).toISOString(),
        });

        if (!token.token) {
          throw new Error('Observer token created, but the response did not include token material.');
        }

        const url = observerUrl(
          resolveObserverBaseUrl(options.observerUrl as string | undefined, env),
          token.token
        );

        if (options.json) {
          printJson(deps, { ...describeToken(token), url });
          return;
        }

        deps.log(url);
        deps.log('');
        deps.log(`Read-only. Expires ${token.expiresAt ?? 'never'}.`);
        deps.log(
          options.includeDms === true ? 'Includes agent DMs.' : 'Channels only — agent DMs are excluded.'
        );
        deps.log(`Revoke with: agent-relay observer revoke ${token.id}`);
      });
    });

  group
    .command('list')
    .description('List observer tokens for this workspace (token material is never shown)')
    .option(
      '--workspace-key <key>',
      'Workspace key (defaults to RELAY_WORKSPACE_KEY or the active workspace)'
    )
    .option('--base-url <url>', 'Override the engine API base URL')
    .option('--json', 'Output as JSON')
    .action(async (options: Record<string, unknown>) => {
      await runSdk(deps, async () => {
        const tokens = await deps.listObserverTokens(connection(options));

        if (options.json) {
          printJson(deps, tokens.map(describeToken));
          return;
        }

        if (tokens.length === 0) {
          deps.log('No observer tokens.');
          return;
        }
        for (const token of tokens) {
          deps.log(`${token.id}  ${token.status}  expires ${token.expiresAt ?? 'never'}  ${token.name}`);
        }
      });
    });

  group
    .command('revoke')
    .description('Revoke an observer token by id')
    .argument('<id>', 'Observer token id')
    .option(
      '--workspace-key <key>',
      'Workspace key (defaults to RELAY_WORKSPACE_KEY or the active workspace)'
    )
    .option('--base-url <url>', 'Override the engine API base URL')
    .action(async (id: string, options: Record<string, unknown>) => {
      await runSdk(deps, async () => {
        await deps.revokeObserverToken({ ...connection(options), id });
        deps.log(`Revoked ${id}.`);
      });
    });
}
