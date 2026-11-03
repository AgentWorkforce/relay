import type { Command } from 'commander';

import { defaultExit } from '../lib/exit.js';
import { removedBrokerCommandMessage } from '../lib/removed-broker-command.js';
import { registerLocalWorkflowCommands } from './local-workflow.js';

type ExitFn = (code: number) => never;

/**
 * The `node` verbs that drove the local Rust broker. The broker was retired:
 * the Agent Relay core started by `relay init` now delivers messages and
 * spawns, lists and releases agents on this machine.
 */
export const REMOVED_BROKER_COMMANDS = [
  'up',
  'down',
  'status',
  'metrics',
  'deadletters',
  'redeliver',
  'agent',
  'tail',
] as const;

export interface RemovedCommandDependencies {
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}

/**
 * Register hidden stubs for the removed broker verbs on `group`, so an old
 * script gets the replacement instead of Commander's bare unknown-command
 * error. Each stub swallows any arguments and options the old verb took.
 * @param group - The `node` group or its deprecated `local` alias
 * @param overrides - Output and exit, as tests inject
 */
export function registerRemovedBrokerCommands(
  group: Command,
  overrides: Partial<RemovedCommandDependencies> = {}
): void {
  const deps: RemovedCommandDependencies = {
    error: (...args: unknown[]) => console.error(...args),
    exit: defaultExit,
    ...overrides,
  };
  for (const name of REMOVED_BROKER_COMMANDS) {
    group
      .command(name, { hidden: true })
      .description('Removed: the local broker was retired; use relay init')
      .argument('[args...]')
      .allowUnknownOption(true)
      .allowExcessArguments(true)
      .helpOption(false)
      .action(() => {
        deps.error(removedBrokerCommandMessage(`${group.name()} ${name}`));
        deps.exit(1);
      });
  }
}

/**
 * Register the `node` command group: `node workflow run|logs|sync`, plus
 * hidden removal notices for the broker verbs it used to carry.
 */
export function registerNodeCommands(
  program: Command,
  overrides: Partial<RemovedCommandDependencies> = {}
): void {
  const node = program.command('node').description('Run and inspect workflows on this machine');
  registerLocalWorkflowCommands(
    node.command('workflow').description('Run and inspect workflows on this node')
  );
  registerRemovedBrokerCommands(node, overrides);
}
