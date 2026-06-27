import type { Command } from 'commander';
import { InvalidArgumentError } from 'commander';
import { resolveActiveWorkspace } from '@agent-relay/cloud';

import { printJson, runSdk, withSdkDefaults, type SdkCommandDeps } from '../lib/sdk-command.js';
import { readWorkspaceStore, setWorkspaceKey, switchWorkspace } from '../lib/workspace-store.js';

export type WorkspaceCommandDependencies = SdkCommandDeps;

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('Expected a positive integer.');
  }
  return parsed;
}

export function registerWorkspaceCommands(
  program: Command,
  overrides: Partial<WorkspaceCommandDependencies> = {}
): void {
  const deps = withSdkDefaults(overrides);
  const group = program.command('workspace').description('Create and switch between workspaces');

  group
    .command('active')
    .description('Show the active canonical cloud workspace')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--json', 'Output the active workspace as JSON')
    .option(
      '--refresh-timeout <milliseconds>',
      'Timeout for refreshing the cloud session',
      parsePositiveInteger
    )
    .action(async (options: { apiUrl?: string; json?: boolean; refreshTimeout?: number }) => {
      await runSdk(deps, async () => {
        const workspace = await resolveActiveWorkspace({
          apiUrl: options.apiUrl,
          interactive: false,
          refreshTimeoutMs: options.refreshTimeout,
        });

        if (options.json) {
          printJson(deps, workspace);
          return;
        }

        deps.log(`Workspace: ${workspace.name ?? workspace.cloudWorkspaceId}`);
        deps.log(`Cloud workspace ID: ${workspace.cloudWorkspaceId}`);
        deps.log(`Relayfile workspace ID: ${workspace.relayfileWorkspaceId}`);
        deps.log(`Relayauth workspace ID: ${workspace.relayauthWorkspaceId}`);
      });
    });

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
