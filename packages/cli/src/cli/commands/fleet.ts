import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Command } from 'commander';
import { createJiti } from 'jiti';
import { HarnessDriverClient } from '@agent-relay/harness-driver';
import type { FleetNodeDefinition } from '@agent-relay/fleet';
// Namespace import sidesteps bun --compile's named-import validation against the
// package .d.ts (see cli/lib/fleet-sidecar.ts).
import * as fleetSdk from '@agent-relay/fleet';
const { isFleetNodeDefinition } = fleetSdk;

import { withDefaults, type CoreDependencies } from './core.js';
import { readBrokerConnection, startBrokerWithPortFallback } from '../lib/broker-lifecycle.js';
import {
  buildNodeSupervision,
  fleetStatusPath,
  readFleetSidecarStatus,
  serveFleetSidecar,
  type FleetBrokerConnection,
} from '../lib/fleet-sidecar.js';
import {
  addSdkOptions,
  printJson,
  runSdk,
  sdkOptionsFromOpts,
  withSdkDefaults,
  type SdkCommandDeps,
} from '../lib/sdk-command.js';

export interface FleetCommandDependencies {
  core: CoreDependencies;
  sdk: SdkCommandDeps;
  loadNodeDefinition: (file: string) => Promise<FleetNodeDefinition>;
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
    loadNodeDefinition,
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
  const group = program.command('fleet').description('Serve and inspect Agent Relay fleet nodes');

  group
    .command('serve')
    .description('Serve a fleet node definition')
    .argument('<file>', 'TS/JS node definition file')
    .option('--name <name>', 'Override node name')
    .option('--workspace <key>', 'Workspace key for broker registration and trigger sync')
    .option('--max-agents <count>', 'Override maximum managed agents for this node')
    .option('--base-url <url>', 'Override Relaycast API base URL')
    .action(async (file: string, options: Record<string, unknown>) => {
      try {
        await runFleetServe(file, options, deps);
      } catch (error) {
        deps.error(error instanceof Error ? error.message : String(error));
        deps.exit(1);
      }
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

  group
    .command('status')
    .description('Show local fleet broker and sidecar status')
    .action(async () => {
      try {
        await runFleetStatus(deps);
      } catch (error) {
        deps.error(error instanceof Error ? error.message : String(error));
        deps.exit(1);
      }
    });
}

export async function loadNodeDefinition(file: string): Promise<FleetNodeDefinition> {
  const absolutePath = path.resolve(file);
  const jiti = createJiti(pathToFileURL(process.cwd()).href, {
    interopDefault: true,
  });
  const loaded = (await jiti.import(absolutePath, { default: true })) as unknown;
  const definition =
    loaded && typeof loaded === 'object' && 'default' in loaded
      ? (loaded as { default?: unknown }).default
      : loaded;
  if (!isFleetNodeDefinition(definition)) {
    throw new Error(`Fleet node file ${absolutePath} must default-export defineNode(...)`);
  }
  return definition;
}

async function runFleetServe(
  file: string,
  options: Record<string, unknown>,
  deps: FleetCommandDependencies
): Promise<void> {
  const nodeDefinition = await deps.loadNodeDefinition(file);
  const maxAgentsOverride = parsePositiveIntegerOption(options.maxAgents, '--max-agents');
  const paths = deps.core.getProjectPaths();
  deps.core.fs.mkdirSync(paths.dataDir, { recursive: true });

  const workspaceKey = typeof options.workspace === 'string' ? options.workspace.trim() : '';
  if (workspaceKey) {
    deps.core.env.RELAY_WORKSPACE_KEY = workspaceKey;
    deps.core.env.RELAY_API_KEY = workspaceKey;
  }

  const dashboardPort = Number.parseInt(deps.core.env.AGENT_RELAY_DASHBOARD_PORT ?? '3888', 10) || 3888;
  const started = await startBrokerWithPortFallback(paths, dashboardPort, deps.core);
  const connection = connectionFromFile(paths.dataDir);
  const controller = new AbortController();
  const stop = () => controller.abort();
  deps.core.onSignal('SIGINT', stop);
  deps.core.onSignal('SIGTERM', stop);

  await serveFleetSidecar({
    definition: nodeDefinition,
    connection,
    workspaceKey: workspaceKey || started.relay.workspaceKey,
    baseUrl: typeof options.baseUrl === 'string' ? options.baseUrl : undefined,
    nameOverride: typeof options.name === 'string' ? options.name : undefined,
    maxAgentsOverride,
    supervision: buildNodeSupervision({
      argv: deps.core.argv,
      cwd: process.cwd(),
      env: deps.core.env,
    }),
    statusPath: fleetStatusPath(paths),
    signal: controller.signal,
    log: (message) => deps.log(message),
    warn: (message) => deps.warn(message),
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

function connectionFromFile(dataDir: string): FleetBrokerConnection {
  const conn = readBrokerConnection(dataDir);
  if (!conn) {
    throw new Error(`Broker connection file was not written in ${dataDir}`);
  }
  return { url: conn.url, apiKey: conn.api_key };
}

function parsePositiveIntegerOption(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
