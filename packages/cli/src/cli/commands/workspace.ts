import type { Command } from 'commander';
import { InvalidArgumentError } from 'commander';
import { resolveActiveWorkspace } from '@agent-relay/cloud';

import { shellWord } from '../lib/agent-registration.js';
import { maskSecret } from '../lib/redact.js';
import { printJson, runSdk, withSdkDefaults, type SdkCommandDeps } from '../lib/sdk-command.js';
import { readWorkspaceStore, setWorkspaceKey } from '../lib/workspace-store.js';
import {
  assertOriginBindingsWritable,
  configuredBaseUrl,
  boundOrigin,
  guardCredentialOrigin,
} from '../lib/relaycast-origin-binding.js';
import {
  describeClearedEnrollment,
  persistWorkspaceSession,
  pinProjectWorkspaceSession,
  validateWorkspaceSessionName,
  type PersistWorkspaceSessionResult,
} from '../lib/workspace-session.js';

export type WorkspaceCommandDependencies = SdkCommandDeps;

/**
 * Say so when moving workspaces drops this project's enrolled fleet node.
 * Leaving it silent is what produced the split rosters in #1432.
 */
function reportClearedEnrollment(
  result: PersistWorkspaceSessionResult,
  deps: WorkspaceCommandDependencies
): void {
  const message = describeClearedEnrollment(result);
  if (message) {
    deps.log(message);
  }
}

/**
 * Bind a key someone hands us to the server named by RELAY_BASE_URL, so later
 * shells without the variable keep sending it there. Without the variable we
 * do not know where the key belongs and leave it unbound.
 */
function bindKeyToConfiguredServer(key: string): void {
  if (process.env.RELAY_BASE_URL !== undefined) {
    guardCredentialOrigin(key, process.env.RELAY_BASE_URL);
  }
}

const HOSTED_ORIGIN = 'https://cast.agentrelay.com';

/**
 * The `--url` a joined key needs in `relay init`: the configured server,
 * else the server the key is already bound to; none for the hosted service,
 * which `--key` alone joins. A self-hosted key is never pointed at it.
 */
function joinServerFlag(key: string): string {
  const configured = process.env.RELAY_BASE_URL?.trim() || boundOrigin(key);
  if (!configured) return '';
  try {
    if (new URL(configured).origin === HOSTED_ORIGIN) return '';
  } catch {
    // Not a URL: shown as given, for the person to correct.
  }
  return `--url ${shellWord(configured)} `;
}

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
        const requestedBaseUrl = (o.baseUrl as string | undefined) ?? process.env.RELAY_BASE_URL;
        const baseUrl = configuredBaseUrl(
          requestedBaseUrl,
          'The Relaycast base URL (--base-url or RELAY_BASE_URL)'
        );
        // Check the binding file before the server mints a key: a key that
        // cannot be bound afterwards would be lost or fall back to hosted.
        if (baseUrl) assertOriginBindingsWritable(baseUrl);
        const relay = await deps.createWorkspace(workspaceName, requestedBaseUrl?.trim());
        if (relay.workspaceKey && baseUrl) {
          // The self-hosted server that minted this key is the only one it may be sent to.
          guardCredentialOrigin(relay.workspaceKey, baseUrl);
        }
        const previousActive = readWorkspaceStore().active;
        const persisted = relay.workspaceKey
          ? persistWorkspaceSession({ name: workspaceName, workspaceKey: relay.workspaceKey })
          : {};
        if (relay.workspaceKey && previousActive && previousActive !== workspaceName) {
          deps.error(`⚠  Active workspace changed: ${previousActive} → ${workspaceName}`);
          deps.error('   Restore with: agent-relay workspace restore');
        }
        // The key is persisted to the workspace store either way; the output
        // masks it unless the caller explicitly asks for the raw value. A
        // dropped enrollment rides in the JSON rather than a log line so the
        // output stays parseable.
        printJson(deps, {
          name: workspaceName,
          workspaceKey:
            relay.workspaceKey && !o.revealSecrets ? maskSecret(relay.workspaceKey) : relay.workspaceKey,
          ...(persisted.clearedEnrolledNodeId
            ? {
                clearedEnrolledNodeId: persisted.clearedEnrolledNodeId,
                warning: describeClearedEnrollment(persisted),
              }
            : {}),
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
        bindKeyToConfiguredServer(key);
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
        bindKeyToConfiguredServer(key);
        const result = persistWorkspaceSession({ name, workspaceKey: key });
        deps.log(`Joined and switched to workspace "${name}".`);
        deps.log(
          'This only saves the workspace. To connect agent tools and have messages injected into their ' +
            `sessions, run in the project: relay init ${joinServerFlag(key)}--key <key> --name ${shellWord(name)}`
        );
        reportClearedEnrollment(result, deps);
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
        const result = persistWorkspaceSession({ name, workspaceKey: workspace.key });
        deps.log(`Switched to workspace "${name}".`);
        reportClearedEnrollment(result, deps);
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
