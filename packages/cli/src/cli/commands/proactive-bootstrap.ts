import { Command } from 'commander';
import { track } from '@agent-relay/telemetry';
import {
  REFRESH_WINDOW_MS,
  createWorkspace,
  defaultApiUrl,
  ensureAuthenticated,
  issueWorkspaceToken,
  readStoredAuth,
  type WorkspaceCreateResponse,
  type WorkspaceTokenIssueResponse,
} from '@agent-relay/cloud';

import { defaultExit } from '../lib/exit.js';
import { errorClassName } from '../lib/telemetry-helpers.js';

type ExitFn = (code: number) => never;

export interface ProactiveBootstrapDependencies {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}

function withDefaults(
  overrides: Partial<ProactiveBootstrapDependencies> = {}
): ProactiveBootstrapDependencies {
  return {
    log: (...args: unknown[]) => console.log(...args),
    error: (...args: unknown[]) => console.error(...args),
    exit: defaultExit,
    ...overrides,
  };
}

function printWorkspaceCreateResult(
  result: WorkspaceCreateResponse,
  log: (...args: unknown[]) => void
): void {
  log(`Workspace created: ${result.workspaceId}`);
  if (result.name) {
    log(`Name: ${result.name}`);
  }
  if (result.relayfileUrl) {
    log(`Relayfile URL: ${result.relayfileUrl}`);
  }
  if (result.relaycronUrl) {
    log(`Relaycron URL: ${result.relaycronUrl}`);
  }
  if (result.relaycastUrl) {
    log(`Relaycast URL: ${result.relaycastUrl}`);
  }
  if (result.relayauthUrl) {
    log(`Relayauth URL: ${result.relayauthUrl}`);
  }
  if (result.joinCommand) {
    log(`Join command: ${result.joinCommand}`);
  }
}

function printWorkspaceTokenResult(
  result: WorkspaceTokenIssueResponse,
  log: (...args: unknown[]) => void
): void {
  log(`RELAY_API_KEY=${result.key}`);
  log('Export this value before starting SDK-backed proactive runtime commands.');
}

export function registerProactiveBootstrapCommands(
  program: Command,
  overrides: Partial<ProactiveBootstrapDependencies> = {}
): void {
  const deps = withDefaults(overrides);
  const runWorkspaceCreate = async (
    name: string,
    options: { apiUrl?: string; json?: boolean }
  ): Promise<void> => {
    try {
      const result = await createWorkspace(name, { apiUrl: options.apiUrl });
      if (options.json) {
        deps.log(JSON.stringify(result, null, 2));
      } else {
        printWorkspaceCreateResult(result, deps.log);
      }
    } catch (err) {
      deps.error(err instanceof Error ? err.message : String(err));
      deps.exit(1);
    }
  };

  program
    .command('login')
    .description('Authenticate with Agent Relay Cloud via browser')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--force', 'Force re-authentication even if already logged in')
    .action(async (options: { apiUrl?: string; force?: boolean }) => {
      const started = Date.now();
      let success = false;
      let errorClass: string | undefined;
      try {
        const apiUrl = options.apiUrl || defaultApiUrl();

        if (!options.force) {
          const existing = await readStoredAuth();
          if (existing && existing.apiUrl === apiUrl) {
            const expiresAt = Date.parse(existing.accessTokenExpiresAt);
            if (!Number.isNaN(expiresAt) && expiresAt - Date.now() > REFRESH_WINDOW_MS) {
              deps.log(`Already logged in to ${existing.apiUrl}`);
              success = true;
              return;
            }
          }
        }

        await ensureAuthenticated(apiUrl, { force: options.force });
        success = true;
      } catch (err) {
        errorClass = errorClassName(err);
        throw err;
      } finally {
        track('cloud_auth', {
          action: 'login',
          success,
          duration_ms: Date.now() - started,
          ...(errorClass ? { error_class: errorClass } : {}),
        });
      }
    });

  program
    .command('init <name>')
    .description('Create a proactive-runtime workspace through the canonical bootstrap path')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--json', 'Print raw JSON response', false)
    .action(async (name: string, options: { apiUrl?: string; json?: boolean }) => {
      await runWorkspaceCreate(name, options);
    });

  const workspaces = program.command('workspaces').description('Manage proactive-runtime workspaces');

  workspaces
    .command('create <name>')
    .description('Create a proactive-runtime workspace')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--json', 'Print raw JSON response', false)
    .action(async (name: string, options: { apiUrl?: string; json?: boolean }) => {
      await runWorkspaceCreate(name, options);
    });

  const tokens = program.command('tokens').description('Issue proactive-runtime workspace tokens');

  tokens
    .command('issue')
    .description('Issue a workspace token for RELAY_API_KEY')
    .requiredOption('--workspace <workspace>', 'Workspace name or ID')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--json', 'Print raw JSON response', false)
    .action(async (options: { workspace: string; apiUrl?: string; json?: boolean }) => {
      try {
        const result = await issueWorkspaceToken(options.workspace, { apiUrl: options.apiUrl });
        if (options.json) {
          deps.log(JSON.stringify(result, null, 2));
        } else {
          printWorkspaceTokenResult(result, deps.log);
        }
      } catch (err) {
        deps.error(err instanceof Error ? err.message : String(err));
        deps.exit(1);
      }
    });
}
