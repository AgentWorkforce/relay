import { Command } from 'commander';

import { checkPrereqs } from './on/prereqs.js';
import { scanPermissions } from './on/scan.js';
import { goOnTheRelay } from './on/start.js';
import { goOffTheRelay } from './on/stop.js';

type ExitFn = (code: number) => never;

export interface OnDependencies {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}

function defaultExit(code: number): never {
  process.exit(code);
}

function withDefaults(overrides: Partial<OnDependencies> = {}): OnDependencies {
  return {
    log: overrides.log ?? ((...args: unknown[]) => console.log(...args)),
    error: overrides.error ?? ((...args: unknown[]) => console.error(...args)),
    exit: overrides.exit ?? defaultExit,
  };
}

export function registerOnCommands(program: Command, overrides: Partial<OnDependencies> = {}): void {
  const deps = withDefaults(overrides);

  // agent-relay on <cli> [-- args...]
  program
    .command('on')
    .description('Launch an agent on the relay — sandboxed workspace with dotfile permissions')
    .argument('[cli]', 'Agent CLI to launch (codex, claude, gemini, aider)')
    .option('--agent <name>', 'Agent identity name (default: CLI basename)')
    .option('--workspace <id>', 'Join an existing relay workspace')
    .option('--shared', 'Enable multi-agent shared workspace via relayfile (local)')
    .option('--cloud', 'Run in cloud mode with remote relayfile')
    .option(
      '--url <url>',
      'Cloud API URL (used with --cloud)',
      process.env.RELAY_AUTH_URL ?? 'https://agentrelay.dev/cloud'
    )
    .option('--scan', 'Preview what the agent will see without launching')
    .option('--doctor', 'Check prerequisites and exit')
    .option(
      '--port-auth <port>',
      'Auth service URL or local port',
      process.env.RELAY_AUTH_URL ?? 'https://agentrelay.dev/cloud'
    )
    .option(
      '--port-file <port>',
      'Relayfile service URL or local port',
      process.env.RELAY_FILE_URL ?? 'https://api.relayfile.dev'
    )
    .allowUnknownOption(true) // pass extra args to agent CLI
    .action(async (cli: string | undefined, options: any, command: Command) => {
      if (options.doctor) {
        await checkPrereqs(deps, options);
        return;
      }
      if (options.scan) {
        await scanPermissions(deps);
        return;
      }
      if (!cli) {
        deps.error('Usage: agent-relay on <cli> [--agent name] [--workspace id] [-- args...]');
        return deps.exit(1);
      }
      await goOnTheRelay(cli, options, command.args.slice(1), deps);
    });

  // agent-relay off
  program
    .command('off')
    .description('Stop relay services and clean up mounts')
    .action(async () => {
      await goOffTheRelay(deps);
    });
}
