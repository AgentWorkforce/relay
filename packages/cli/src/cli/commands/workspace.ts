import type { Command } from 'commander';

import { printJson, runSdk, withSdkDefaults, type SdkCommandDeps } from '../lib/sdk-command.js';
import { readWorkspaceStore, setWorkspaceKey, switchWorkspace } from '../lib/workspace-store.js';

export type WorkspaceCommandDependencies = SdkCommandDeps;

export function registerWorkspaceCommands(
  program: Command,
  overrides: Partial<WorkspaceCommandDependencies> = {}
): void {
  const deps = withSdkDefaults(overrides);
  const group = program.command('workspace').description('Create and switch between workspaces');

  group
    .command('create')
    .description('Create a new workspace and store its key')
    .argument('<name>', 'Workspace name')
    .option('--base-url <url>', 'Override the API base URL')
    .action(async (name: string, o: Record<string, unknown>) => {
      await runSdk(deps, async () => {
        const relay = await deps.createWorkspace(name, o.baseUrl as string | undefined);
        if (relay.workspaceKey) {
          setWorkspaceKey(name, relay.workspaceKey);
        }
        printJson(deps, { name, workspaceKey: relay.workspaceKey });
      });
    });

  group
    .command('list')
    .description('List stored workspaces')
    .action(async () => {
      await runSdk(deps, async () => {
        const store = readWorkspaceStore();
        printJson(deps, {
          active: store.active,
          workspaces: Object.keys(store.workspaces),
        });
      });
    });

  group
    .command('set_key')
    .description('Store a workspace key under a name')
    .argument('<name>', 'Workspace name')
    .argument('<key>', 'Workspace key')
    .action(async (name: string, key: string) => {
      await runSdk(deps, async () => {
        setWorkspaceKey(name, key);
        deps.log(`Stored key for workspace "${name}".`);
      });
    });

  group
    .command('join')
    .description('Join a workspace by key and make it active')
    .argument('<name>', 'Workspace name')
    .argument('<key>', 'Workspace key')
    .action(async (name: string, key: string) => {
      await runSdk(deps, async () => {
        setWorkspaceKey(name, key);
        switchWorkspace(name);
        deps.log(`Joined and switched to workspace "${name}".`);
      });
    });

  group
    .command('switch')
    .description('Switch the active workspace')
    .argument('<name>', 'Workspace name')
    .action(async (name: string) => {
      await runSdk(deps, async () => {
        switchWorkspace(name);
        deps.log(`Switched to workspace "${name}".`);
      });
    });
}
