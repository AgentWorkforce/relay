import type { Command } from 'commander';
import { HarnessDriverClient } from '@agent-relay/harness-driver';
import { readFleetSidecarStatus } from '@agent-relay/fleet';

import { withDefaults, type CoreDependencies } from './core.js';
import { readBrokerConnection } from '../lib/broker-lifecycle.js';
import { fleetStatusPath } from '../lib/fleet-sidecar.js';
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
  ).action(async (options: Record<string, unknown>) => {
    await runSdk(deps.sdk, async () => {
      const relay = deps.sdk.createWorkspaceRelay(sdkOptionsFromOpts(options));
      printJson(deps.sdk, {
        nodes: await relay.nodes.list({
          capability: options.capability as string | undefined,
          name: options.name as string | undefined,
        }),
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

  group
    .command('status')
    .description('Show local fleet broker and node status')
    .action(async () => {
      try {
        await runFleetStatus(deps);
      } catch (error) {
        deps.error(error instanceof Error ? error.message : String(error));
        deps.exit(1);
      }
    });
}

async function runFleetStatus(deps: FleetCommandDependencies): Promise<void> {
  const paths = deps.core.getProjectPaths();
  const conn = readBrokerConnection(paths.dataDir);
  const statusPath = fleetStatusPath(paths);
  const sidecar = readFleetSidecarStatus(statusPath);

  if (!conn) {
    deps.log(
      JSON.stringify(
        {
          broker: { running: false },
          sidecar: sidecar ? { ...sidecar, alive: isPidAlive(sidecar.pid) } : null,
        },
        null,
        2
      )
    );
    return;
  }

  const client = new HarnessDriverClient({ baseUrl: conn.url, apiKey: conn.api_key });
  let broker: Record<string, unknown>;
  try {
    const session = await client.getSession();
    broker = {
      running: true,
      url: conn.url,
      pid: conn.pid,
      workspaceKey: session.workspace_key,
      brokerVersion: session.broker_version,
      protocolVersion: session.protocol_version,
    };
  } catch (error) {
    broker = {
      running: false,
      url: conn.url,
      pid: conn.pid,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  deps.log(
    JSON.stringify(
      {
        broker,
        sidecar: sidecar ? { ...sidecar, alive: isPidAlive(sidecar.pid) } : null,
      },
      null,
      2
    )
  );
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
