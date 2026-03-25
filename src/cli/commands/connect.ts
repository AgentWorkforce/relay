import { Command } from 'commander';

export function registerConnectCommands(program: Command): void {
  program
    .command('connect <provider>')
    .description('[DEPRECATED] Use `agent-relay cloud connect <provider>` instead')
    .option('--timeout <seconds>', 'Timeout in seconds (default: 300)', '300')
    .option('--language <lang>', 'Sandbox language/image (default: typescript)', 'typescript')
    .option('--cloud-url <url>', 'Cloud API URL')
    .action(async (providerArg: string) => {
      console.error(
        '\x1b[33m[DEPRECATED]\x1b[0m `agent-relay connect` has moved. Use:\n\n' +
        `  agent-relay cloud connect ${providerArg}\n`
      );
      process.exit(1);
    });
}
