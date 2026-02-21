import { Command } from 'commander';

import { runAuthCommand, type AuthCommandOptions, type AuthCommandIo } from '../lib/auth-ssh.js';

type ExitFn = (code: number) => never;

export type { AuthCommandOptions };

export interface AuthDependencies extends AuthCommandIo {
  runAuth: (providerArg: string, options: AuthCommandOptions) => Promise<void>;
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
    runAuth:
      overrides.runAuth ??
      ((providerArg: string, options: AuthCommandOptions) => runAuthCommand(providerArg, options, io)),
    defaultCloudUrl:
      overrides.defaultCloudUrl ?? (process.env.AGENT_RELAY_CLOUD_URL || 'https://agent-relay.com'),
    log,
    error,
    exit,
  };
}

export function registerAuthCommands(program: Command, overrides: Partial<AuthDependencies> = {}): void {
  const deps = withDefaults(overrides);

  program
    .command('auth <provider>')
    .description('Authenticate a provider CLI in a cloud workspace over SSH (interactive)')
    .option('--workspace <id>', 'Workspace ID to authenticate in')
    .option('--token <token>', 'One-time CLI token from dashboard (skips cloud config requirement)')
    .option('--cloud-url <url>', 'Cloud API URL (overrides linked config and AGENT_RELAY_CLOUD_URL)')
    .option('--timeout <seconds>', 'Timeout in seconds (default: 300)', '300')
    .option(
      '--use-auth-broker',
      'Use dedicated auth broker instead of workspace SSH (for Daytona/sandboxed environments)'
    )
    .action(async (providerArg: string, options: AuthCommandOptions) => {
      await deps.runAuth(providerArg, options);
    });
}
