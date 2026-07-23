import type { Command } from 'commander';
import { HarnessDriverClient } from '@agent-relay/harness-driver';

import { withDefaults, type CoreDependencies } from './core.js';
import { readBrokerConnection } from '../lib/broker-lifecycle.js';
import { redactSecrets } from '../lib/redact.js';
import { resolveWorkspaceKeyWithSource } from '../lib/sdk-client.js';
import {
  addSdkOptions,
  printJson,
  runSdk,
  sdkOptionsFromOpts,
  withSdkDefaults,
  type SdkCommandDeps,
} from '../lib/sdk-command.js';

const SERVE_REPLACEMENT_MESSAGE =
  "'fleet serve' has been replaced. Run 'relay node up' (with an optional --config <file>); " +
  "for Cloud-managed nodes run 'relay cloud enroll --token <token>' first.";

export interface FleetCommandDependencies {
  core: CoreDependencies;
  sdk: SdkCommandDeps;
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => never;
}

function withFleetDefaults(overrides: Partial<FleetCommandDependencies> = {}): FleetCommandDependencies {
  const core = overrides.core ?? withDefaults();
  const sdk = overrides.sdk ?? withSdkDefaults();
  return {
    core,
    sdk,
    log: (...args: unknown[]) => console.log(...args),
    warn: (...args: unknown[]) => console.warn(...args),
    error: (...args: unknown[]) => console.error(...args),
    exit: core.exit,
    ...overrides,
  };
}

export function registerFleetCommands(
  program: Command,
  overrides: Partial<FleetCommandDependencies> = {}
): void {
  const deps = withFleetDefaults(overrides);
  const group = program.command('fleet').description('Inspect and manage Agent Relay fleet nodes');

  // `fleet serve` has moved to `relay node up`. Keep a hidden stub so existing
  // invocations fail loudly with migration guidance instead of an "unknown
  // command" error. `allowUnknownOption` lets it swallow the old serve flags.
  group
    .command('serve', { hidden: true })
    .argument('[file]')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(() => {
      deps.error(SERVE_REPLACEMENT_MESSAGE);
      deps.exit(1);
    });

  addSdkOptions(
    group
      .command('nodes')
      .description('List fleet nodes in the workspace')
      .option('--capability <name>', 'Filter by capability name')
      .option('--name <name>', 'Filter by node name')
      .option('--all', 'Include offline and direct history records')
  ).action(async (options: Record<string, unknown>) => {
    await runSdk(deps.sdk, async () => {
      warnIfInferredFromProjectSession(options, deps.warn);
      const relay = deps.sdk.createWorkspaceRelay(sdkOptionsFromOpts(options));
      const nodes = await relay.nodes.list({
        capability: options.capability as string | undefined,
        name: options.name as string | undefined,
      });
      const visibleNodes = options.all === true ? nodes : nodes.filter(isAvailableFleetNode);
      const hiddenCount = nodes.length - visibleNodes.length;
      if (hiddenCount > 0 && options.all !== true) {
        deps.warn(
          `${hiddenCount} offline or non-fleet records hidden. ` +
            'Run `agent-relay fleet nodes --all` to include history.'
        );
      }
      printJson(deps.sdk, {
        nodes: visibleNodes,
      });
    });
  });

  addSdkOptions(group.command('config').description('Show workspace fleet node configuration')).action(
    async (options: Record<string, unknown>) => {
      await runSdk(deps.sdk, async () => {
        const relay = deps.sdk.createWorkspaceRelay(sdkOptionsFromOpts(options));
        printJson(deps.sdk, await relay.workspace.fleetNodes.get());
      });
    }
  );

  addSdkOptions(group.command('enable').description('Enable fleet nodes for the workspace')).action(
    async (options: Record<string, unknown>) => {
      await runSdk(deps.sdk, async () => {
        const relay = deps.sdk.createWorkspaceRelay(sdkOptionsFromOpts(options));
        printJson(deps.sdk, await relay.workspace.fleetNodes.set(true));
      });
    }
  );

  addSdkOptions(group.command('disable').description('Disable fleet nodes for the workspace')).action(
    async (options: Record<string, unknown>) => {
      await runSdk(deps.sdk, async () => {
        const relay = deps.sdk.createWorkspaceRelay(sdkOptionsFromOpts(options));
        printJson(deps.sdk, await relay.workspace.fleetNodes.set(false));
      });
    }
  );

  addSdkOptions(
    group.command('inherit').description('Use the deployment default for workspace fleet nodes')
  ).action(async (options: Record<string, unknown>) => {
    await runSdk(deps.sdk, async () => {
      const relay = deps.sdk.createWorkspaceRelay(sdkOptionsFromOpts(options));
      printJson(deps.sdk, await relay.workspace.fleetNodes.inherit());
    });
  });

  addSdkOptions(
    group.command('status').description('Show local broker status and this node’s provider attachment')
  ).action(async (options: Record<string, unknown>) => {
    try {
      await runFleetStatus(deps, options);
    } catch (error) {
      deps.error(error instanceof Error ? error.message : String(error));
      deps.exit(1);
    }
  });
}

/** Return whether a roster entry is a live Fleet node rather than direct-history metadata. */
function isAvailableFleetNode(node: { live?: boolean; status?: string; tags?: unknown }): boolean {
  const tags = Array.isArray(node.tags) ? node.tags : [];
  const isDirectPseudoNode = tags.includes('direct');
  const isLive = node.live === undefined ? node.status === 'online' : node.live === true;
  return isLive && !isDirectPseudoNode;
}

/**
 * Warn (on stderr, so it never pollutes the JSON on stdout) when the workspace
 * key was inferred from the project's persisted session rather than named
 * explicitly. Surfacing the source lets the operator override with
 * `--workspace-key`/`--wk` or `RELAY_WORKSPACE_KEY` for a one-off query.
 * Resolution errors are swallowed: the SDK call below reports the real failure.
 */
function warnIfInferredFromProjectSession(
  options: Record<string, unknown>,
  warn: (...args: unknown[]) => void
): void {
  let source: string;
  try {
    source = resolveWorkspaceKeyWithSource(sdkOptionsFromOpts(options)).source;
  } catch {
    return;
  }
  if (source === 'project') {
    warn(
      'Note: using the workspace session pinned to this project. ' +
        'Pass --workspace-key/--wk or set RELAY_WORKSPACE_KEY to override for this command.'
    );
  }
}

async function runFleetStatus(
  deps: FleetCommandDependencies,
  options: Record<string, unknown>
): Promise<void> {
  const paths = deps.core.getProjectPaths();
  const conn = readBrokerConnection(paths.dataDir);

  let broker: Record<string, unknown> = { running: false };
  let nodeName: string | undefined;
  if (conn) {
    const client = new HarnessDriverClient({ baseUrl: conn.url, apiKey: conn.api_key });
    try {
      const session = await client.getSession();
      nodeName = session.node_name;
      broker = {
        running: true,
        url: conn.url,
        pid: conn.pid,
        workspaceKey: session.workspace_key,
        brokerVersion: session.broker_version,
        protocolVersion: session.protocol_version,
        nodeId: session.node_id,
        nodeName: session.node_name,
      };
    } catch (error) {
      broker = {
        running: false,
        url: conn.url,
        pid: conn.pid,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      client.disconnect();
    }
  }

  // Provider attachment (per-provider liveness) is owned by the engine now, not a
  // local status file; read this node's record from the nodes API.
  let node: unknown;
  if (nodeName) {
    try {
      const relay = deps.sdk.createWorkspaceRelay(sdkOptionsFromOpts(options));
      const nodes = await relay.nodes.list({ name: nodeName });
      node = nodes[0] ?? { available: false, reason: `no node named "${nodeName}" in the workspace` };
    } catch (error) {
      node = { error: error instanceof Error ? error.message : String(error) };
    }
  } else {
    // A running broker that never reported a node name means the engine lookup
    // was skipped — say so rather than looking fully checked.
    node = { available: false, reason: 'broker did not report a node name' };
  }

  // Redact the node token / workspace key structurally so status output (which a
  // user may paste into a bug report) never carries a live credential.
  deps.log(JSON.stringify(redactSecrets({ broker, node }), null, 2));
}
