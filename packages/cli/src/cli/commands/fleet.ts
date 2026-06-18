import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Command } from 'commander';
import { createJiti } from 'jiti';
import { HarnessDriverClient } from '@agent-relay/harness-driver';
import { enrollFleetNode, type FleetNodeEnrollment } from '@agent-relay/cloud';
import type { FleetNodeDefinition } from '@agent-relay/fleet';
// Namespace import sidesteps bun --compile's named-import validation against the
// package .d.ts (see cli/lib/fleet-sidecar.ts).
import * as fleetSdk from '@agent-relay/fleet';
const { isFleetNodeDefinition } = fleetSdk;

import { withDefaults, type CoreDependencies, type CoreProjectPaths } from './core.js';
import { readBrokerConnection, startBrokerWithPortFallback } from '../lib/broker-lifecycle.js';
import {
  buildNodeSupervision,
  createImplicitLocalFleetNode,
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
  enrollFleetNode: typeof enrollFleetNode;
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
    enrollFleetNode,
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
    .argument('[file]', 'TS/JS node definition file (optional when --enrollment-token is provided)')
    .option('--name <name>', 'Override node name')
    .option('--workspace <key>', 'Workspace key for broker registration and trigger sync')
    .option('--max-agents <count>', 'Override maximum managed agents for this node')
    .option('--base-url <url>', 'Override Relaycast API base URL')
    .option(
      '--enrollment-token <token>',
      'One-time Cloud enrollment token (ocl_node_enr_...) to register this node'
    )
    .option(
      '--enrollment-url <url>',
      'Cloud enrollment endpoint that redeems the token (e.g. https://agentrelay.com/api/v1/fleet/register)'
    )
    .action(async (file: string | undefined, options: Record<string, unknown>) => {
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

  addSdkOptions(group.command('inherit').description('Use the deployment default for workspace fleet nodes')).action(
    async (options: Record<string, unknown>) => {
      await runSdk(deps.sdk, async () => {
        const relay = deps.sdk.createWorkspaceRelay(sdkOptionsFromOpts(options));
        printJson(deps.sdk, await relay.workspace.fleetNodes.inherit());
      });
    }
  );

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

/**
 * In enrollment mode the one-time token is exchanged for durable node
 * credentials BEFORE the broker boots. The returned credentials populate the env
 * the broker reads to bind itself to the Cloud workspace's fleet roster
 * (RELAY_NODE_TOKEN over the fleet WS, RELAY_BASE_URL as the Relaycast origin).
 * Returns the enrollment record, or undefined when not in enrollment mode.
 */
async function maybeEnrollFleetNode(
  options: Record<string, unknown>,
  nameOption: string | undefined,
  maxAgentsOverride: number | undefined,
  deps: FleetCommandDependencies
): Promise<FleetNodeEnrollment | undefined> {
  const enrollmentToken = typeof options.enrollmentToken === 'string' ? options.enrollmentToken.trim() : '';
  const enrollmentUrl = typeof options.enrollmentUrl === 'string' ? options.enrollmentUrl.trim() : '';
  if (enrollmentUrl && !enrollmentToken) {
    throw new Error('--enrollment-url requires --enrollment-token.');
  }
  if (!enrollmentToken) {
    return undefined;
  }

  const enrollment = await deps.enrollFleetNode({
    enrollmentToken,
    enrollmentUrl,
    ...(nameOption ? { name: nameOption } : {}),
    ...(maxAgentsOverride !== undefined ? { maxAgents: maxAgentsOverride } : {}),
  });
  deps.core.env.RELAY_NODE_TOKEN = enrollment.nodeToken;
  deps.core.env.RELAY_BASE_URL = enrollment.relaycastUrl;
  deps.log(
    `Enrolled fleet node "${enrollment.nodeName}"${
      enrollment.nodeId ? ` (${enrollment.nodeId})` : ''
    } in workspace ${enrollment.relayWorkspaceId}.`
  );
  return enrollment;
}

/**
 * Wires the explicit `--workspace`/`--base-url` overrides into the broker env so
 * `startBrokerWithPortFallback` binds the node to the right workspace and origin.
 * Returns the resolved values for downstream sidecar wiring.
 *
 * Precedence for the Relaycast origin: enrollment is the source of truth (it
 * already wrote RELAY_BASE_URL during the exchange) and an explicit `--base-url`
 * is the only thing that overrides it; the override must reach the broker via
 * RELAY_BASE_URL, not just `serveFleetSidecar`.
 */
function applyServeEnvOverrides(
  options: Record<string, unknown>,
  deps: FleetCommandDependencies
): { workspaceKey: string; baseUrlOverride: string } {
  const workspaceKey = typeof options.workspace === 'string' ? options.workspace.trim() : '';
  if (workspaceKey) {
    deps.core.env.RELAY_WORKSPACE_KEY = workspaceKey;
    deps.core.env.RELAY_API_KEY = workspaceKey;
  }

  const baseUrlOverride = typeof options.baseUrl === 'string' ? options.baseUrl.trim() : '';
  if (baseUrlOverride) {
    deps.core.env.RELAY_BASE_URL = baseUrlOverride;
  }

  return { workspaceKey, baseUrlOverride };
}

function createImplicitServeNodeDefinition(input: {
  paths: CoreProjectPaths;
  enrollment: FleetNodeEnrollment | undefined;
  nameOption: string | undefined;
  maxAgentsOverride: number | undefined;
  deps: FleetCommandDependencies;
}): FleetNodeDefinition {
  return createImplicitLocalFleetNode({
    paths: input.paths,
    teamsConfig: input.deps.core.loadTeamsConfig(input.paths.projectRoot),
    // Name precedence (kept identical to nameOverride in runFleetServe so the
    // implicit node definition and the sidecar registration always agree):
    // --name > enrollment record's nodeName > createImplicitLocalFleetNode's
    // projectRoot-basename default.
    name: input.nameOption ?? input.enrollment?.nodeName,
    ...(input.maxAgentsOverride !== undefined ? { maxAgents: input.maxAgentsOverride } : {}),
  });
}

async function runFleetServe(
  file: string | undefined,
  options: Record<string, unknown>,
  deps: FleetCommandDependencies
): Promise<void> {
  const maxAgentsOverride = parsePositiveIntegerOption(options.maxAgents, '--max-agents');
  const nameOption = typeof options.name === 'string' ? options.name : undefined;
  const paths = deps.core.getProjectPaths();
  deps.core.fs.mkdirSync(paths.dataDir, { recursive: true });

  // The `<file>` node-def is OPTIONAL in enrollment mode — identity/name/
  // capabilities come from the enrollment record; a `<file>`, when present,
  // overrides/augments it.
  //
  // Load + validate the `<file>` BEFORE redeeming the one-time enrollment token:
  // the token is single-use, so a missing/invalid file must fail fast rather than
  // burn the token on a run that can't succeed (the durable creds returned by the
  // exchange would never be persisted, forcing the operator to mint a fresh token
  // just to fix a local file error).
  const fileDefinition = file ? await deps.loadNodeDefinition(file) : undefined;

  const enrollment = await maybeEnrollFleetNode(options, nameOption, maxAgentsOverride, deps);
  if (!enrollment && !file) {
    throw new Error('A node definition <file> is required unless --enrollment-token is provided.');
  }

  const nodeDefinition =
    fileDefinition ??
    createImplicitServeNodeDefinition({
      paths,
      enrollment,
      nameOption,
      maxAgentsOverride,
      deps,
    });

  const { workspaceKey, baseUrlOverride } = applyServeEnvOverrides(options, deps);

  // An enrolled node prefers the name from the enrollment record; a --name flag
  // (already forwarded to the exchange) still wins through nameOption.
  const nameOverride = nameOption ?? enrollment?.nodeName ?? undefined;
  const baseUrl = baseUrlOverride || enrollment?.relaycastUrl || undefined;

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
    baseUrl,
    nameOverride,
    maxAgentsOverride,
    supervision: buildNodeSupervision({
      // Strip the one-time --enrollment-token/--enrollment-url flags from the
      // supervised argv. The broker restarts supervised sidecars by re-executing
      // this argv; replaying a consumed enrollment token would fail the exchange
      // and the node would never come back. The durable credentials minted by the
      // first exchange live in the supervision env (RELAY_NODE_TOKEN /
      // RELAY_BASE_URL), so restarts take the durable path with no flags to redeem.
      argv: stripEnrollmentFlags(deps.core.argv),
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

/**
 * Removes the one-time enrollment flags (and their values) from a captured argv
 * so the broker's supervised-restart replay never re-redeems a consumed token.
 * Handles both `--flag value` and `--flag=value` forms. The durable credentials
 * minted by the first exchange are carried in the supervision env instead.
 */
export function stripEnrollmentFlags(argv: readonly string[]): string[] {
  const oneTimeFlags = new Set(['--enrollment-token', '--enrollment-url']);
  const result: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const eqIndex = arg.indexOf('=');
    const flagName = eqIndex === -1 ? arg : arg.slice(0, eqIndex);
    if (oneTimeFlags.has(flagName)) {
      // `--flag=value` carries its value inline; `--flag value` consumes the next
      // token. Skip the following token only when this flag had no inline `=value`
      // and a value token actually follows.
      if (eqIndex === -1 && i + 1 < argv.length) {
        i += 1;
      }
      continue;
    }
    result.push(arg);
  }
  return result;
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
