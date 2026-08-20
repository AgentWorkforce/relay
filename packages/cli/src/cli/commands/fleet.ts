import { InvalidArgumentError, type Command } from 'commander';
import { HarnessDriverClient } from '@agent-relay/harness-driver';
import { createWorkspaceClient, type RelayWorkspaceThinClient, type RelayNode } from '@agent-relay/sdk';

import { withDefaults, type CoreDependencies } from './core.js';
import {
  buildRows,
  collectWithRetry,
  formatPretty,
  readRemoteLiveAgents,
  readLocalBrokerMaps,
  type FleetNodeContribution,
  type RosterAgent,
} from './fleet-agent.js';
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

  // `fleet agent list` — the fleet-wide answer to `node agent list --pretty`.
  // See relay#1553 for the gap this fills and packages/cli/src/cli/commands/
  // fleet-agent.ts for the join logic (three name spaces, per-node contributions).
  const agent = group.command('agent').description('Inspect agents across the fleet');
  addSdkOptions(
    agent
      .command('list')
      .description('List agents on every reachable fleet node, joined against the workspace roster')
      .option('--pretty', 'Render as a human-readable table')
      .option('--json', 'Render JSON output (default; explicit so the flag advertised in --help works)')
      .option('--node <name>', 'Return only this node and its live broker agents')
      .option('--all', 'Include offline/history nodes the way `fleet nodes --all` does')
  ).action(async (options: Record<string, unknown>) => {
    await runFleetAgentList(deps, options);
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

/**
 * Assemble the local broker's contribution from the raw per-half results.
 * `sessionError` is a hard failure (broker session lookup blew up) — it
 * degrades to a full ERROR row so the operator can see the local machine
 * itself is unreachable. `liveError` / `inventoryError` are partial and are
 * preserved into the contribution so `buildRows` can render one map with a
 * `(?)` marker on the missing half instead of dropping both.
 */
function buildLocalContribution(
  node: RelayNode,
  input: {
    liveAgents?: Awaited<ReturnType<HarnessDriverClient['listAgents']>>;
    liveError?: string;
    inventoryAgents?: Awaited<ReturnType<HarnessDriverClient['listFleetInventory']>>['agents'];
    inventoryError?: string;
    sessionError?: string;
    retried?: boolean;
    note?: string;
  }
): FleetNodeContribution {
  if (input.sessionError) {
    return {
      node,
      isLocal: true,
      error: input.note ? `${input.note}: ${input.sessionError}` : input.sessionError,
      ...(input.retried ? { retried: true } : {}),
    };
  }
  return {
    node,
    isLocal: true,
    ...(input.liveAgents !== undefined ? { liveAgents: input.liveAgents } : {}),
    ...(input.liveError ? { liveError: input.liveError } : {}),
    ...(input.inventoryAgents !== undefined ? { inventoryAgents: input.inventoryAgents } : {}),
    ...(input.inventoryError ? { inventoryError: input.inventoryError } : {}),
    ...(input.retried ? { retried: true } : {}),
  };
}

/**
 * Fan-out for `fleet agent list`. Reads `nodes.list()` for the roster of
 * reachable fleet nodes, `agents.list()` for the workspace agent registry,
 * and — when this machine has a running local broker — both the live worker
 * map and the fleet_inventory snapshot from it. Remote live names arrive in
 * the node heartbeat capabilities returned by the same `nodes.list()` call.
 * A node is never dropped from the output.
 *
 * The pure join lives in {@link ./fleet-agent.ts} so it can be tested against
 * fixtures without wiring up the SDK.
 */
async function runFleetAgentList(
  deps: FleetCommandDependencies,
  options: Record<string, unknown>
): Promise<void> {
  await runSdk(deps.sdk, async () => {
    warnIfInferredFromProjectSession(options, deps.warn);
    const clientOptions = sdkOptionsFromOpts(options);
    const relay = deps.sdk.createWorkspaceRelay(clientOptions);
    const requestedNodeName = typeof options.node === 'string' && options.node ? options.node : undefined;

    // Enumerate fleet nodes exactly the way `fleet nodes` does. `nodes.list()`
    // failure is fatal — nothing to reconcile against.
    const nodes = await relay.nodes.list({
      ...(requestedNodeName ? { name: requestedNodeName } : {}),
    });
    const includeAll = options.all === true;
    const visibleNodes = (includeAll ? nodes : nodes.filter(isAvailableFleetNode)).filter(
      (node) => !requestedNodeName || node.name === requestedNodeName
    );

    // The workspace roster is separately fetched; a failure here is degraded
    // rather than fatal — the presence column just marks fewer rows as
    // roster-matched and warns.
    let roster: RosterAgent[] = [];
    // A targeted query must be a real filter, not a node row followed by
    // unrelated workspace sediment. It also avoids an unnecessary D1 roster
    // read on the path operators use to inspect one remote node.
    if (!requestedNodeName) {
      try {
        // Default to online-only. `--all` opens it up to the workspace's
        // full record set (>1600 today, most stale/offline) so a scripted diff
        // has the option, without making the default output unreadable. This
        // mirrors what `fleet nodes` does with node history.
        const relayAgents = await relay.agents.list(includeAll ? {} : { status: 'online' });
        roster = relayAgents.map((entry) => ({
          name: entry.name,
          ...(entry.status ? { status: entry.status } : {}),
          ...(entry.lastSeenAt ? { lastSeenAt: entry.lastSeenAt } : {}),
          ...(entry.metadata ? { metadata: entry.metadata } : {}),
        }));
      } catch (error) {
        deps.warn(
          `roster unavailable (${error instanceof Error ? error.message : String(error)}); ` +
            'PRESENCE column will not report roster membership.'
        );
      }
    }

    // Local broker (this machine): read /api/spawned and /api/fleet-inventory.
    // The broker's node_name identifies which entry in `visibleNodes` is us.
    const paths = deps.core.getProjectPaths();
    const conn = readBrokerConnection(paths.dataDir);
    let localNodeName: string | undefined;
    let localLive: Awaited<ReturnType<HarnessDriverClient['listAgents']>> | undefined;
    let localInventory: Awaited<ReturnType<HarnessDriverClient['listFleetInventory']>>['agents'] | undefined;
    let localLiveError: string | undefined;
    let localInventoryError: string | undefined;
    /** Whole-session failure (session lookup blew up before either map ran). */
    let localSessionError: string | undefined;
    let localRetried = false;

    if (conn) {
      const client = new HarnessDriverClient({ baseUrl: conn.url, apiKey: conn.api_key });
      try {
        const session = await client.getSession();
        localNodeName = session.node_name ?? undefined;
        // `readLocalBrokerMaps` uses Promise.allSettled so a failure in one
        // half never discards the other. `collectWithRetry` retries the pair
        // once as a unit; a per-half retry policy is more code for no
        // observable win when both halves hit the same broker.
        const result = await collectWithRetry('local broker', () => readLocalBrokerMaps(client));
        if (result.ok) {
          localLive = result.value.liveAgents;
          localLiveError = result.value.liveError;
          localInventory = result.value.inventoryAgents;
          localInventoryError = result.value.inventoryError;
          localRetried = result.retried;
        } else {
          // Both halves failed as a unit — record it as a session error so
          // the contribution below renders an explicit ERROR row rather than
          // silently pretending both maps were empty.
          localSessionError = result.error;
          localRetried = result.retried;
        }
      } catch (error) {
        localSessionError = `local broker: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        client.disconnect();
      }
    }

    // Assemble per-node contributions. Brokers encode the live WorkerName set
    // in reserved heartbeat capabilities. This path is independent of agent
    // registration and adds no API call beyond nodes.list(): no workspace
    // roster and no node-binding read.
    const contributions: FleetNodeContribution[] = [];
    for (const node of visibleNodes) {
      if (localNodeName && node.name === localNodeName) {
        contributions.push(
          buildLocalContribution(node, {
            liveAgents: localLive,
            liveError: localLiveError,
            inventoryAgents: localInventory,
            inventoryError: localInventoryError,
            sessionError: localSessionError,
            retried: localRetried,
          })
        );
        continue;
      }

      const remote = readRemoteLiveAgents(node);
      if (remote.supported) {
        contributions.push({
          node,
          isLocal: false,
          remoteAgents: remote.agents,
          ...(remote.warning ? { remoteWarning: remote.warning } : {}),
        });
      } else {
        contributions.push({
          node,
          isLocal: false,
          remoteError: 'broker heartbeat does not publish live agent names',
        });
      }
    }

    // Guarantee the local machine appears somewhere in the output even if
    // `nodes.list()` filtered its record out or the workspace never saw it.
    // Dropping the local machine's contribution silently was one of the
    // review findings on the first pass — this is the third-state discipline
    // applied to the local node itself, not just to per-agent rows.
    const localNodeIsInScope =
      requestedNodeName === undefined || (localNodeName !== undefined && requestedNodeName === localNodeName);
    if (
      localNodeIsInScope &&
      (localNodeName || localSessionError || conn) &&
      !contributions.some((c) => c.isLocal)
    ) {
      const syntheticNodeName =
        localNodeName ?? (process.env.AGENT_RELAY_BROKER_NAME?.trim() || undefined) ?? '(local broker)';
      const syntheticNode: RelayNode = {
        name: syntheticNodeName,
        status: 'unknown',
        capabilities: [],
      };
      contributions.unshift(
        buildLocalContribution(syntheticNode, {
          liveAgents: localLive,
          liveError: localLiveError,
          inventoryAgents: localInventory,
          inventoryError: localInventoryError,
          sessionError: localSessionError,
          retried: localRetried,
          note: 'local broker not in visible node list',
        })
      );
    }

    const now = new Date();
    const output = buildRows({ contributions, roster }, now);

    if (options.pretty === true) {
      deps.log(formatPretty(output));
      return;
    }
    printJson(deps.sdk, {
      generatedAt: now.toISOString(),
      localNode: localNodeName ?? null,
      perNode: output.perNode,
      unplacedRoster: output.unplacedRoster,
      errors: output.errors,
    });
  });
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
