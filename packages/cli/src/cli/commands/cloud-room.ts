import type { Command } from 'commander';

import { defaultExit } from '../lib/exit.js';
import { removedCloudRoomCommandMessage } from '../lib/removed-cloud-room-command.js';

type ExitFn = (code: number) => never;

/**
 * The `cloud room` verbs that called Cloud's workspace room API. Cloud rooms
 * were retired in favor of Relay Connect and the `/room/` routes now answer
 * 404, so every verb fails with a pointer to the replacement instead.
 */
export const REMOVED_CLOUD_ROOM_COMMANDS = [
  'invite',
  'invites',
  'revoke-invite',
  'members',
  'remove-member',
  'accept',
  'revoke-session',
  'session',
] as const;

export interface CloudRoomDependencies {
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}

/**
 * Register `cloud room` as a hidden command that explains the removal.
 *
 * Any verb, option or argument is accepted so existing scripts fail with the
 * migration notice and exit 1 rather than a Commander usage error.
 * @param cloudCommand - The `cloud` command group
 * @param overrides - Dependency overrides for tests
 */
export function registerCloudRoomCommands(
  cloudCommand: Command,
  overrides: Partial<CloudRoomDependencies> = {}
): void {
  const deps: CloudRoomDependencies = {
    error: (...args: unknown[]) => console.error(...args),
    exit: defaultExit,
    ...overrides,
  };

  cloudCommand
    .command('room', { hidden: true })
    .description('Removed: Cloud rooms were replaced by Relay Connect')
    .argument('[args...]')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .helpOption(false)
    .action((args: string[] = []) => {
      const verb = args[0] && !args[0].startsWith('-') ? `cloud room ${args[0]}` : 'cloud room';
      deps.error(removedCloudRoomCommandMessage(verb));
      deps.exit(1);
    });
}
