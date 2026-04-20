import { Command } from 'commander';
import { track } from '@agent-relay/telemetry';

import { runAuthCommand, type AuthCommandOptions, type AuthCommandIo } from '../lib/auth-ssh.js';
import { defaultExit } from '../lib/exit.js';
import { errorClassName } from '../lib/telemetry-helpers.js';

const PROVIDER_ALIASES: Record<string, string> = {
  claude: 'anthropic',
  codex: 'openai',
  gemini: 'google',
};

function normalizeProviderForTelemetry(providerArg: string): string {
  const normalized = providerArg.toLowerCase().trim();
  return PROVIDER_ALIASES[normalized] || normalized;
}

type ExitFn = (code: number) => never;

export type { AuthCommandOptions };

export interface AuthDependencies extends AuthCommandIo {
  runAuth: (providerArg: string, options: AuthCommandOptions) => Promise<void>;
  defaultCloudUrl: string;
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
      overrides.defaultCloudUrl ?? (process.env.AGENT_RELAY_CLOUD_URL || 'https://agentrelay.com/cloud'),
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
      const started = Date.now();
      let success = false;
      let errorClass: string | undefined;
      try {
        await deps.runAuth(providerArg, options);
        success = true;
      } catch (err) {
        errorClass = errorClassName(err);
        throw err;
      } finally {
        track('provider_auth', {
          provider: normalizeProviderForTelemetry(providerArg),
          success,
          duration_ms: Date.now() - started,
          use_auth_broker: Boolean(options.useAuthBroker),
          used_token: Boolean(options.token),
          ...(errorClass ? { error_class: errorClass } : {}),
        });
      }
    });
}
