import type { Command } from 'commander';
import { InvalidArgumentError } from 'commander';
import { resolveActiveWorkspace } from '@agent-relay/cloud';

import { maskSecret } from '../lib/redact.js';
import { printJson, runSdk, withSdkDefaults, type SdkCommandDeps } from '../lib/sdk-command.js';
import { readWorkspaceStore, setWorkspaceKey } from '../lib/workspace-store.js';
import {
  persistWorkspaceSession,
  pinProjectWorkspaceSession,
  validateWorkspaceSessionName,
} from '../lib/workspace-session.js';

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
    .option('--json', 'Output the active workspace as JSON (keys masked unless --reveal-secrets)')
    .option('--reveal-secrets', 'Include raw workspace keys in --json output')
    .option(
      '--refresh-timeout <milliseconds>',
      'Timeout for refreshing the cloud session',
      parsePositiveInteger
    )
    .action(
      async (options: {
        apiUrl?: string;
        json?: boolean;
        revealSecrets?: boolean;
        refreshTimeout?: number;
      }) => {
        await runSdk(deps, async () => {
          const workspace = await resolveActiveWorkspace({
            apiUrl: options.apiUrl,
            interactive: false,
            refreshTimeoutMs: options.refreshTimeout,
          });

          if (options.json) {
            printJson(
              deps,
              options.revealSecrets
                ? workspace
                : {
                    ...workspace,
                    key: maskSecret(workspace.key),
                    ...(workspace.relaycastApiKey
                      ? { relaycastApiKey: maskSecret(workspace.relaycastApiKey) }
                      : {}),
                  }
            );
            return;
          }

          deps.log(`Workspace: ${workspace.name ?? workspace.cloudWorkspaceId}`);
          deps.log(`Cloud workspace ID: ${workspace.cloudWorkspaceId}`);
          deps.log(`Relayfile workspace ID: ${workspace.relayfileWorkspaceId}`);
          deps.log(`Relayauth workspace ID: ${workspace.relayauthWorkspaceId}`);
        });
      }
    );

  group
    .command('create')
    .description('Create a new workspace and store its key')
    .argument('<name>', 'Workspace name')
    .option('--base-url <url>', 'Override the API base URL')
    .option('--reveal-secrets', 'Include the raw workspace key in the output')
    .action(async (name: string, o: Record<string, unknown>) => {
      await runSdk(deps, async () => {
        const workspaceName = validateWorkspaceSessionName(name);
        const relay = await deps.createWorkspace(workspaceName, o.baseUrl as string | undefined);
        if (relay.workspaceKey) {
          const previousActive = readWorkspaceStore().active;
          persistWorkspaceSession({ name: workspaceName, workspaceKey: relay.workspaceKey });
          if (previousActive && previousActive !== workspaceName) {
            deps.error(`⚠  Active workspace changed: ${previousActive} → ${workspaceName}`);
            deps.error('   Restore with: agent-relay workspace restore');
          }
        }
        // The key is persisted to the workspace store either way; the output
        // masks it unless the caller explicitly asks for the raw value.
        printJson(deps, {
          name: workspaceName,
          workspaceKey:
            relay.workspaceKey && !o.revealSecrets ? maskSecret(relay.workspaceKey) : relay.workspaceKey,
        });
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
          previous: store.previous,
          workspaces: Object.keys(store.workspaces),
        });
      });
    });

  group
    .command('key')
    .description('Print a stored workspace key from the local store (masked unless --reveal-secrets)')
    .argument('[name]', 'Workspace name (defaults to the active workspace)')
    .option('--reveal-secrets', 'Print the raw key')
    .action(async (name: string | undefined, o: Record<string, unknown>) => {
      await runSdk(deps, async () => {
        const store = readWorkspaceStore();
        const target = name?.trim() || store.active;
        if (!target) {
          throw new Error('No workspace named and no active workspace set.');
        }
        const record = Object.hasOwn(store.workspaces, target) ? store.workspaces[target] : undefined;
        if (!record?.key) {
          throw new Error(`No stored key for workspace "${target}".`);
        }
        deps.log(o.revealSecrets ? record.key : maskSecret(record.key));
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
        persistWorkspaceSession({ name, workspaceKey: key });
        deps.log(`Joined and switched to workspace "${name}".`);
      });
    });

  group
    .command('switch')
    .description('Switch the active workspace')
    .argument('<name>', 'Workspace name')
    .action(async (name: string) => {
      await runSdk(deps, async () => {
        const store = readWorkspaceStore();
        const workspace = store.workspaces[name];
        if (!workspace) {
          throw new Error(
            `Unknown workspace "${name}". Add it with \`relay workspace set_key ${name} <key>\`.`
          );
        }
        persistWorkspaceSession({ name, workspaceKey: workspace.key });
        deps.log(`Switched to workspace "${name}".`);
      });
    });

  group
    .command('restore')
    .description('Switch back to the previously active workspace')
    .action(async () => {
      await runSdk(deps, async () => {
        const store = readWorkspaceStore();
        const previous = store.previous;
        if (!previous) {
          throw new Error('No previous workspace is recorded.');
        }
        if (previous === store.active) {
          throw new Error(`The recorded previous workspace "${previous}" is already active.`);
        }
        const workspace = Object.hasOwn(store.workspaces, previous) ? store.workspaces[previous] : undefined;
        if (!workspace) {
          throw new Error(`The recorded previous workspace "${previous}" no longer exists.`);
        }
        const current = store.active;
        persistWorkspaceSession({ name: previous, workspaceKey: workspace.key });
        deps.log(`Switched to workspace "${previous}" (was ${current ?? 'none'}).`);
      });
    });

  group
    .command('rebind')
    .description("Pin this project's broker to a stored workspace")
    .argument('<name>', 'Stored workspace name')
    .action(async (name: string) => {
      await runSdk(deps, async () => {
        const workspaceName = validateWorkspaceSessionName(name);
        const store = readWorkspaceStore();
        const workspace = Object.hasOwn(store.workspaces, workspaceName)
          ? store.workspaces[workspaceName]
          : undefined;
        if (!workspace) {
          throw new Error(
            `Unknown workspace "${workspaceName}". Add it with \`relay workspace set_key ${workspaceName} <key>\`.`
          );
        }
        pinProjectWorkspaceSession({ workspaceKey: workspace.key });
        deps.log(
          `Rebound this project's broker to workspace "${workspaceName}". Restart the broker to apply it.`
        );
      });
    });
}
