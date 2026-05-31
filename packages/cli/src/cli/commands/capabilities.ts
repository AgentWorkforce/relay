import type { Command } from 'commander';

import {
  addSdkOptions,
  printJson,
  runSdk,
  sdkOptionsFromOpts,
  withSdkDefaults,
  type SdkCommandDeps,
} from '../lib/sdk-command.js';

export type CapabilitiesCommandDependencies = SdkCommandDeps;

export function registerCapabilitiesCommands(
  program: Command,
  overrides: Partial<CapabilitiesCommandDependencies> = {}
): void {
  const deps = withSdkDefaults(overrides);
  const opts = (o: Record<string, unknown>) => sdkOptionsFromOpts(o);
  const group = program.command('capabilities').description('Register and invoke agent capabilities (commands)');

  addSdkOptions(
    group
      .command('register')
      .description('Register a new capability')
      .argument('<command>', 'Command name')
      .requiredOption('--description <text>', 'What the capability does')
      .requiredOption('--handler <agent>', 'Agent that handles the command')
  ).action(async (command: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      printJson(
        deps,
        await deps.createAgentRelay(opts(o)).capabilities.register({
          command,
          description: o.description as string,
          handlerAgent: o.handler as string,
        })
      );
    });
  });

  addSdkOptions(group.command('list').description('List available capabilities')).action(
    async (o: Record<string, unknown>) => {
      await runSdk(deps, async () => {
        printJson(deps, await deps.createAgentRelay(opts(o)).capabilities.list());
      });
    }
  );

  addSdkOptions(
    group.command('delete').description('Delete a registered capability').argument('<command>', 'Command name')
  ).action(async (command: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      await deps.createAgentRelay(opts(o)).capabilities.delete(command);
      deps.log(`Deleted capability ${command}.`);
    });
  });
}
