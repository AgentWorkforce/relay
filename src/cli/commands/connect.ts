import { Command } from 'commander';

import {
  CliDetectError,
  SUPPORTED_CLIS,
  type SupportedCli,
  connectCli,
  type DetectCliDeps,
  type ConnectCliResult,
} from '../lib/detect-cli.js';

export interface ConnectCommandDeps {
  connect?: (cli: SupportedCli, deps?: DetectCliDeps) => Promise<ConnectCliResult>;
  log?: (message: string) => void;
  error?: (message: string) => void;
  exit?: (code: number) => never;
  detectDeps?: DetectCliDeps;
}

const DEPRECATION_BANNER = (providerArg: string): string =>
  '\x1b[33m[DEPRECATED]\x1b[0m `agent-relay connect <provider>` has moved. Use:\n\n' +
  `  agent-relay cloud connect ${providerArg}\n`;

export function registerConnectCommands(
  program: Command,
  deps: ConnectCommandDeps = {},
): void {
  const connect = deps.connect ?? connectCli;
  const log = deps.log ?? ((m: string) => process.stdout.write(`${m}\n`));
  const error = deps.error ?? ((m: string) => process.stderr.write(`${m}\n`));
  const exit = deps.exit ?? ((code: number) => process.exit(code) as never);

  program
    .command('connect <cli>')
    .description(
      `Connect a local AI CLI (${SUPPORTED_CLIS.join(' | ')}). Detects on PATH, version-checks, and writes ~/.config/agent-relay/connections.json. ` +
        'Other provider arguments still print the legacy deprecation banner.',
    )
    .option('--timeout <seconds>', 'Deprecated cloud connect timeout option')
    .option('--language <lang>', 'Deprecated cloud connect language/image option')
    .option('--cloud-url <url>', 'Deprecated cloud connect API URL option')
    .action(async (cliArg: string) => {
      const normalized = cliArg.toLowerCase().trim();
      if (!isSupportedCli(normalized)) {
        error(DEPRECATION_BANNER(cliArg));
        exit(1);
        return;
      }
      try {
        const result = await connect(normalized, deps.detectDeps);
        log(`\x1b[32m✓\x1b[0m Connected ${result.cli} ${result.version} (${result.binPath})`);
        log(`  Manifest: ${result.manifestPath}`);
      } catch (err) {
        if (err instanceof CliDetectError) {
          error(err.message);
          exit(err.exitCode);
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        error(message);
        exit(4);
      }
    });
}

function isSupportedCli(value: string): value is SupportedCli {
  return (SUPPORTED_CLIS as readonly string[]).includes(value);
}
