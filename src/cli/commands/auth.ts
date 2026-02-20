import { Command } from 'commander';

import {
  runAuthCommand,
  type AuthCommandOptions,
  type AuthCommandIo,
} from '../lib/auth-ssh.js';
import {
  runCliAuthCommand,
  type CliAuthOptions,
} from '../lib/auth-cli.js';

type ExitFn = (code: number) => never;

export type { AuthCommandOptions, CliAuthOptions };

export interface AuthDependencies extends AuthCommandIo {
  runAuth: (providerArg: string, options: AuthCommandOptions) => Promise<void>;
  runCliAuth: (providerArg: string, options: CliAuthOptions) => Promise<void>;
  defaultCloudUrl: string;
}

function defaultExit(code: number): never {
  process.exit(code);
}

function withDefaults(overrides: Partial<AuthDependencies> = {}): AuthDependencies {
  const log = overrides.log ?? ((...args: unknown[]) => console.log(...args));
  const error = overrides.error ?? ((...args: unknown[]) => console.error(...args));
  const exit = overrides.exit ?? defaultExit;
  const io: AuthCommandIo = { log, error, exit };

  return {
    runAuth: overrides.runAuth ?? ((providerArg: string, options: AuthCommandOptions) => runAuthCommand(providerArg, options, io)),
    runCliAuth:
      overrides.runCliAuth ??
      ((providerArg: string, options: CliAuthOptions) => runCliAuthCommand(providerArg, options, io)),
    defaultCloudUrl: overrides.defaultCloudUrl ?? (process.env.AGENT_RELAY_CLOUD_URL || 'https://agent-relay.com'),
    log,
    error,
    exit,
  };
}

export function registerAuthCommands(
  program: Command,
  overrides: Partial<AuthDependencies> = {}
): void {
  const deps = withDefaults(overrides);

  const cliAuthOptions = {
    workspace: '--workspace <id>',
    cloudUrl: '--cloud-url <url>',
    token: '--token <token>',
    sessionCookie: '--session-cookie <cookie>',
    timeout: '--timeout <seconds>',
  };

  program
    .command('auth <provider>')
    .description('Authenticate a provider CLI in a cloud workspace over SSH (interactive)')
    .option('--workspace <id>', 'Workspace ID to authenticate in')
    .option('--token <token>', 'One-time CLI token from dashboard (skips cloud config requirement)')
    .option('--cloud-url <url>', 'Cloud API URL (overrides linked config and AGENT_RELAY_CLOUD_URL)')
    .option('--timeout <seconds>', 'Timeout in seconds (default: 300)', '300')
    .option('--use-auth-broker', 'Use dedicated auth broker instead of workspace SSH (for Daytona/sandboxed environments)')
    .action(async (providerArg: string, options: AuthCommandOptions) => {
      await deps.runAuth(providerArg, options);
    });

  program
    .command('cli-auth <provider>')
    .description('Connect a provider via SSH tunnel to workspace (Claude, Codex, Cursor, etc.)')
    .option(cliAuthOptions.workspace, 'Workspace ID to connect to')
    .option(cliAuthOptions.cloudUrl, 'Cloud API URL', deps.defaultCloudUrl)
    .option(cliAuthOptions.token, 'CLI authentication token (from dashboard)')
    .option(cliAuthOptions.sessionCookie, 'Session cookie for authentication (deprecated, use --token)')
    .option(cliAuthOptions.timeout, 'Timeout in seconds (default: 300)', '300')
    .action(async (providerArg: string, options: CliAuthOptions) => {
      await deps.runCliAuth(providerArg, options);
    });

  program
    .command('codex-auth')
    .description('Connect Codex via SSH tunnel to workspace (alias for cli-auth codex)')
    .option(cliAuthOptions.workspace, 'Workspace ID to connect to')
    .option(cliAuthOptions.cloudUrl, 'Cloud API URL', deps.defaultCloudUrl)
    .option(cliAuthOptions.token, 'CLI authentication token (from dashboard)')
    .option(cliAuthOptions.sessionCookie, 'Session cookie for authentication (deprecated, use --token)')
    .option(cliAuthOptions.timeout, 'Timeout in seconds (default: 300)', '300')
    .action(async (options: CliAuthOptions) => {
      await deps.runCliAuth('codex', options);
    });

  program
    .command('claude-auth')
    .description('Connect Claude via SSH tunnel to workspace (alias for cli-auth claude)')
    .option(cliAuthOptions.workspace, 'Workspace ID to connect to')
    .option(cliAuthOptions.cloudUrl, 'Cloud API URL', deps.defaultCloudUrl)
    .option(cliAuthOptions.token, 'CLI authentication token (from dashboard)')
    .option(cliAuthOptions.sessionCookie, 'Session cookie for authentication (deprecated, use --token)')
    .option(cliAuthOptions.timeout, 'Timeout in seconds (default: 300)', '300')
    .action(async (options: CliAuthOptions) => {
      await deps.runCliAuth('claude', options);
    });

  program
    .command('cursor-auth')
    .description('Connect Cursor via SSH tunnel to workspace (alias for cli-auth cursor)')
    .option(cliAuthOptions.workspace, 'Workspace ID to connect to')
    .option(cliAuthOptions.cloudUrl, 'Cloud API URL', deps.defaultCloudUrl)
    .option(cliAuthOptions.token, 'CLI authentication token (from dashboard)')
    .option(cliAuthOptions.sessionCookie, 'Session cookie for authentication (deprecated, use --token)')
    .option(cliAuthOptions.timeout, 'Timeout in seconds (default: 300)', '300')
    .action(async (options: CliAuthOptions) => {
      await deps.runCliAuth('cursor', options);
    });
}
