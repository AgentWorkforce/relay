import { Command } from 'commander';
import { runConnectCommand, type ConnectCommandOptions } from '../lib/connect-daytona.js';

export function registerConnectCommands(program: Command): void {
  program
    .command('connect <provider>')
    .description('Authenticate a provider CLI via Daytona sandbox (stores credentials in volume)')
    .option('--timeout <seconds>', 'Timeout in seconds (default: 300)', '300')
    .option('--language <lang>', 'Sandbox language/image (default: typescript)', 'typescript')
    .option('--cloud-url <url>', 'Cloud API URL (or set AGENT_RELAY_CLOUD_URL env var)')
    .action(async (providerArg: string, options: ConnectCommandOptions) => {
      const io = {
        log: (...args: unknown[]) => console.log(...args),
        error: (...args: unknown[]) => console.error(...args),
        exit: ((code: number) => process.exit(code)) as (code: number) => never,
      };
      await runConnectCommand(providerArg, options, io);
    });
}
