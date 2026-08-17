import { InvalidArgumentError, type Command } from 'commander';
import { HarnessDriverClient } from '@agent-relay/harness-driver';
import { createWorkspaceClient, type RelayWorkspaceThinClient } from '@agent-relay/sdk';

import { withDefaults, type CoreDependencies } from './core.js';
import { readBrokerConnection } from '../lib/broker-lifecycle.js';
import { declaredWorkforceMetadata } from '../lib/registration-metadata.js';
import { redactSecrets } from '../lib/redact.js';
import { attributableReleaseReason } from '../lib/release-reason.js';
import {
  resolveAgentToken,
  resolveBaseUrl,
  resolveWorkspaceKey,
  resolveWorkspaceKeyWithSource,
  type SdkClientOptions,
} from '../lib/sdk-client.js';
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

const FLEET_CLIS = new Set(['claude', 'codex', 'gemini', 'aider', 'goose', 'grok', 'opencode']);

export interface FleetCommandDependencies {
  core: CoreDependencies;
  sdk: SdkCommandDeps;
  createFleetWorkspaceClient: (options: SdkClientOptions) => RelayWorkspaceThinClient;
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
    createFleetWorkspaceClient: (options) =>
      createWorkspaceClient({
        workspaceKey: resolveWorkspaceKey(options),
        baseUrl: resolveBaseUrl(options),
      }),
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
      const liveNodes = nodes.filter(isAvailableFleetNode);
      const historyNodes = nodes.filter((node) => !isAvailableFleetNode(node));
      const visibleNodes = options.all === true ? [...liveNodes, ...historyNodes] : liveNodes;
      const hiddenCount = historyNodes.length;
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

  addSdkOptions(
    group
      .command('spawn')
      .description('Spawn an agent on a fleet node')
      .argument('<cli>', 'AI CLI to launch', parseFleetCli)
      .requiredOption('--name <name>', 'Worker agent name')
      .requiredOption('--task <text>', 'Initial task instructions')
      .option('--node <name>', 'Target a specific fleet node')
      .option('--target-node <name>', 'Alias for --node')
      .option('--channel <name>', 'Channel for the worker to join')
      .option('--persona <persona>', 'Worker persona (automatic placement)')
      .option('--model <model>', 'Model powering the worker')
      .option('--cwd <path>', 'Absolute working directory for the spawned worker')
      .option('--organization <organization>', 'Declared organization for workforce reporting')
      .option('--project <project>', 'Declared project for workforce reporting')
      .option('--workstream <workstream>', 'Declared workstream for workforce reporting')
      .option('--role <role>', 'Declared role for workforce reporting')
      .option('--objective <objective>', 'Declared objective (defaults to --task when omitted)')
      .option('--session-ref <reference>', 'Session reference for a resumable targeted spawn')
      .option(
        '--no-confirm',
        'Report a targeted spawn as soon as the node accepts it, without waiting for the node to confirm the agent actually launched'
      )
      .option(
        '--confirm-timeout <ms>',
        'How long a targeted spawn waits for the node to confirm the launch',
        '120000'
      )
  ).action(async (cli: string, options: Record<string, unknown>) => {
    await runSdk(deps.sdk, async () => {
      warnIfInferredFromProjectSession(options, deps.warn);
      const clientOptions = sdkOptionsFromOpts(options);
      const name = requiredText(options.name, 'Worker name');
      const task = requiredText(options.task, 'Task');
      const targetNode =
        optionalText(options.targetNode, 'Target node') ?? optionalText(options.node, 'Node');
      const channel = optionalText(options.channel, 'Channel');
      const model = optionalText(options.model, 'Model');
      const workerCwd = optionalText(options.cwd, 'Worker cwd');
      const organization = optionalText(options.organization, 'Organization');
      const project = optionalText(options.project, 'Project');
      const workstream = optionalText(options.workstream, 'Workstream');
      const role = optionalText(options.role, 'Role');
      const objective = optionalText(options.objective, 'Objective');
      const sessionRef = optionalText(options.sessionRef, 'Session reference');
      const registrationMetadata = declaredWorkforceMetadata(
        { organization, project, workstream, role, objective },
        task
      );
      const confirmTimeoutText = optionalText(options.confirmTimeout, 'Confirm timeout') ?? '120000';
      const confirmTimeoutMs = Number(confirmTimeoutText);
      if (!Number.isFinite(confirmTimeoutMs) || confirmTimeoutMs <= 0) {
        throw new Error('--confirm-timeout must be a positive number of milliseconds.');
      }

      if (targetNode) {
        if (!resolveAgentToken(clientOptions)) {
          throw new Error(
            'Targeted Fleet spawn requires an agent token. Pass --token or set RELAY_AGENT_TOKEN.'
          );
        }
        const relay = deps.sdk.createAgentRelay(clientOptions);
        // Placement alone only proves the node accepted the dispatch. A node
        // running an obsolete broker advertises `spawn:<cli>` capacity, acks
        // the invocation and launches nothing, which is indistinguishable from
        // success here — so wait for the node to confirm unless asked not to.
        const confirm = options.confirm !== false;
        const invocation = await relay.messaging.placement.spawn({
          capability: `spawn:${cli}`,
          node: targetNode,
          failFast: true,
          confirm,
          ...(confirm ? { confirmTimeoutMs: confirmTimeoutMs } : {}),
          input: {
            name,
            cli,
            task,
            ...(channel ? { channels: [channel] } : {}),
            ...(model ? { model } : {}),
            ...(workerCwd ? { worker_cwd: workerCwd } : {}),
            ...registrationMetadata,
            ...(sessionRef ? { session_ref: sessionRef } : {}),
          },
        });
        printJson(deps.sdk, { invocation });
        return;
      }

      if (sessionRef) {
        throw new Error('--session-ref requires --node or --target-node.');
      }
      const persona = optionalText(options.persona, 'Persona');
      const workspace = deps.createFleetWorkspaceClient(clientOptions);
      const invocation = await workspace.agents.spawn({
        name,
        cli,
        task,
        ...(channel ? { channel } : {}),
        ...(persona ? { persona } : {}),
        ...(model || workerCwd || Object.keys(registrationMetadata).length > 0
          ? {
              metadata: {
                ...(model ? { model } : {}),
                ...(workerCwd ? { worker_cwd: workerCwd } : {}),
                ...registrationMetadata,
              },
            }
          : {}),
      });
      printJson(deps.sdk, { invocation });
    });
  });

  addSdkOptions(
    group
      .command('release')
      .description('Release a spawned fleet agent')
      .argument('<name>', 'Worker agent name')
      .option('--reason <reason>', 'Release reason')
      .option('--delete-agent', 'Permanently delete the agent after release')
  ).action(async (name: string, options: Record<string, unknown>) => {
    await runSdk(deps.sdk, async () => {
      warnIfInferredFromProjectSession(options, deps.warn);
      const workspace = deps.createFleetWorkspaceClient(sdkOptionsFromOpts(options));
      const reason = attributableReleaseReason(
        optionalText(options.reason, 'Reason'),
        process.env.RELAY_AGENT_NAME ?? 'agent-relay fleet CLI',
        'fleet agent released'
      );
      const released = await workspace.agents.release({
        name: requiredText(name, 'Worker name'),
        reason,
        deleteAgent: options.deleteAgent === true,
      });
      printJson(deps.sdk, released);
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

/** Return whether a roster entry can currently accept Fleet work. */
function isAvailableFleetNode(node: {
  live?: boolean;
  status?: string;
  handlersLive?: boolean;
  tags?: unknown;
}): boolean {
  const tags = Array.isArray(node.tags) ? node.tags : [];
  const isDirectPseudoNode = tags.includes('direct');
  const isLive = node.live === undefined ? node.status === 'online' : node.live === true;
  return isLive && node.handlersLive !== false && !isDirectPseudoNode;
}

function parseFleetCli(value: string): string {
  const cli = value.trim().toLowerCase();
  if (!FLEET_CLIS.has(cli)) {
    throw new InvalidArgumentError(
      `unsupported CLI "${value}"; expected one of: ${[...FLEET_CLIS].join(', ')}`
    );
  }
  return cli;
}

function requiredText(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    throw new Error(`${label} is required.`);
  }
  return text;
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, label);
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
