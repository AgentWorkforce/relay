import type { Command } from 'commander';
import { fleetNodeEnrollmentStorePath, resolveActiveFleetNodeEnrollment } from '@agent-relay/cloud';

import {
  addUpCommandOptions,
  registerCoreCommands,
  withDefaults,
  type CoreDependencies,
  type UpCommandOptions,
} from './core.js';
import { runUpCommand } from '../lib/broker-lifecycle.js';
import {
  projectWorkspaceKeyPath,
  readProjectWorkspaceSession,
  type ProjectWorkspaceSession,
} from '../lib/project-workspace-key.js';
import { promoteWorkspaceKeyEnvAlias } from '../lib/workspace-env.js';
import { registerLocalAgentCommands } from './local-agent.js';
import { registerLocalWorkflowCommands } from './local-workflow.js';

type ExitFn = (code: number) => never;

export interface NodeCommandDependencies {
  core: CoreDependencies;
  resolveEnrollment: typeof resolveActiveFleetNodeEnrollment;
  resolveProjectWorkspaceSession: () => ProjectWorkspaceSession | undefined;
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}

function withNodeDefaults(overrides: Partial<NodeCommandDependencies> = {}): NodeCommandDependencies {
  const core = overrides.core ?? withDefaults();
  return {
    core,
    resolveEnrollment: resolveActiveFleetNodeEnrollment,
    resolveProjectWorkspaceSession: () => readProjectWorkspaceSession(core.getProjectPaths().dataDir),
    log: (...args: unknown[]) => console.log(...args),
    warn: (...args: unknown[]) => console.warn(...args),
    error: (...args: unknown[]) => console.error(...args),
    exit: core.exit,
    ...overrides,
  };
}

/**
 * Register the `node` command group: `node up|down|status|metrics`, the
 * `node agent …` subtree (+ `node tail`), and `node workflow run|logs|sync`.
 */
export function registerNodeCommands(
  program: Command,
  overrides: Partial<NodeCommandDependencies> = {}
): void {
  const deps = withNodeDefaults(overrides);
  const node = program.command('node').description("Run and manage this machine's relay node");

  // `up` is registered here (not via registerCoreCommands) because the node
  // variant adds `--config` and runs enrollment pickup before delegating.
  addUpCommandOptions(node.command('up').description("Start this node's local broker"))
    .option(
      '--config <file>',
      'Node definition file to serve (defaults to auto-discovered agent-relay.{ts,tsx,mts,cts,js,mjs,cjs})'
    )
    .action(async (options: UpCommandOptions) => {
      await runNodeUp(options, deps);
    });

  // down / status / metrics are the same as `local` — reuse the core
  // registrations without a second `up`.
  registerCoreCommands(node, deps.core, { includeUp: false });

  registerLocalAgentCommands(node);
  registerLocalWorkflowCommands(
    node.command('workflow').description('Run and inspect workflows on this node')
  );
}

/** Normalize workspace env aliases and report whether `node up` received an explicit workspace. */
function prepareExplicitWorkspaceForNodeUp(
  options: UpCommandOptions,
  deps: NodeCommandDependencies
): boolean {
  const envWorkspaceKey = promoteWorkspaceKeyEnvAlias(deps.core.env);
  return Boolean(options.workspaceKey?.trim() || envWorkspaceKey);
}

/**
 * Refuse to start when the stored enrollment addresses a different workspace
 * than the repository pin.
 *
 * The enrollment store is machine-global; the pin is per-repository. When they
 * disagree, silently preferring either one re-homes the node — so name both
 * sources and stop. Only possible once a previous start recorded the pin's
 * workspace id; before that the two are simply passed through together (the
 * pin wins for workspace selection, the enrollment for node identity) and a
 * mismatched node token fails loudly at registration instead.
 */
function reportWorkspaceSourceConflict(
  record: NonNullable<ReturnType<typeof resolveActiveFleetNodeEnrollment>>,
  session: ProjectWorkspaceSession | undefined,
  deps: NodeCommandDependencies
): boolean {
  const pinnedWorkspaceId = session?.workspaceId?.trim();
  const enrolledWorkspaceId = record.relayWorkspaceId?.trim();
  if (!pinnedWorkspaceId || !enrolledWorkspaceId || pinnedWorkspaceId === enrolledWorkspaceId) {
    return false;
  }

  const pinPath = projectWorkspaceKeyPath(deps.core.getProjectPaths().dataDir);
  deps.error(
    'Refusing to start: this repository and the stored Fleet enrollment select different workspaces.'
  );
  deps.error(`  repository pin      ${pinPath} -> workspace ${pinnedWorkspaceId}`);
  deps.error(
    `  fleet enrollment    ${fleetNodeEnrollmentStorePath(deps.core.env)} -> workspace ${enrolledWorkspaceId} (node ${record.nodeId})`
  );
  deps.error(
    'Pass --workspace-key to choose explicitly, re-enroll this node in the pinned workspace, ' +
      'or delete the repository pin to adopt the enrollment.'
  );
  return true;
}

/** Apply stored enrollment credentials and return the enrolled node name, when present. */
function applyEnrollment(
  record: NonNullable<ReturnType<typeof resolveActiveFleetNodeEnrollment>>,
  deps: NodeCommandDependencies
): string | undefined {
  const env = deps.core.env;
  env.RELAY_NODE_TOKEN = record.nodeToken;
  env.RELAY_NODE_ID = record.nodeId;
  // Internal, non-secret association inherited by a detached child. The broker
  // records it beside the project workspace so later starts can resolve the
  // same durable enrollment instead of minting a replacement node identity.
  env.AGENT_RELAY_ENROLLED_NODE_ID = record.nodeId;
  if (!env.RELAY_BASE_URL) {
    env.RELAY_BASE_URL = record.relaycastUrl;
  }
  deps.log(
    `Using persisted Cloud enrollment for node "${record.nodeName}" (workspace ${record.relayWorkspaceId}).`
  );
  return record.nodeName?.trim() || undefined;
}

/** Resolve the enrollment associated with a project session, avoiding ambiguous global fallback. */
function resolveEnrollmentForProject(
  session: ProjectWorkspaceSession | undefined,
  deps: NodeCommandDependencies
): ReturnType<typeof resolveActiveFleetNodeEnrollment> | undefined {
  const env = deps.core.env;
  if (session?.enrolledNodeId) {
    return deps.resolveEnrollment({
      ...(env.RELAY_BASE_URL ? { baseUrl: env.RELAY_BASE_URL } : {}),
      nodeId: session.enrolledNodeId,
      env,
    });
  }
  if (session) {
    return undefined;
  }
  return deps.resolveEnrollment({
    ...(env.RELAY_BASE_URL ? { baseUrl: env.RELAY_BASE_URL } : {}),
    env,
  });
}

/**
 * Apply the node identity for this start.
 *
 * Workspace selection is NOT decided here — `runUpCommand` walks the shared
 * precedence ladder (flag → env → repository pin → machine-global active) after
 * this returns. This function only settles which node identity the broker runs
 * as, so an enrollment can no longer suppress the repository's workspace.
 */
function applyResolvedNodeSession(
  record: ReturnType<typeof resolveActiveFleetNodeEnrollment> | undefined,
  projectSession: ProjectWorkspaceSession | undefined,
  deps: NodeCommandDependencies
): string | undefined {
  if (record) {
    return applyEnrollment(record, deps);
  }
  if (projectSession?.enrolledNodeId) {
    deps.core.env.AGENT_RELAY_ENROLLED_NODE_ID = projectSession.enrolledNodeId;
    deps.warn(
      `Persisted enrollment for node "${projectSession.enrolledNodeId}" was not found; resuming the pinned workspace without that node identity.`
    );
  }
  return undefined;
}

/**
 * `node up` with Cloud enrollment pickup: when no `RELAY_NODE_TOKEN` is set,
 * resolve a persisted enrollment and wire its credentials into the env before
 * delegating to the shared broker `up` flow.
 */
async function runNodeUp(options: UpCommandOptions, deps: NodeCommandDependencies): Promise<void> {
  const env = deps.core.env;
  // Fleet nodes may be started concurrently on one machine. Let the broker
  // bind an ephemeral API port atomically unless the operator explicitly
  // selected a stable broker base port.
  env.AGENT_RELAY_BROKER_PORT ??= '0';
  // An explicit workspace key (flag or env) is a direct workspace choice; the
  // enrollment store records workspace ids, not keys, so a stored enrollment
  // cannot be matched against it — skip pickup entirely rather than risk
  // starting the broker with a token from a different workspace.
  const explicitWorkspaceKey = prepareExplicitWorkspaceForNodeUp(options, deps);
  let enrolledNodeName: string | undefined;
  if (env.RELAY_NODE_TOKEN?.trim() && env.RELAY_NODE_ID?.trim()) {
    env.AGENT_RELAY_ENROLLED_NODE_ID ??= env.RELAY_NODE_ID.trim();
  }
  if (!env.RELAY_NODE_TOKEN && !explicitWorkspaceKey) {
    const projectSession = deps.resolveProjectWorkspaceSession();
    let record: ReturnType<typeof resolveActiveFleetNodeEnrollment> | undefined;
    try {
      record = resolveEnrollmentForProject(projectSession, deps);
    } catch (err) {
      // A missing store resolves to undefined (fine); only an ambiguous
      // multi-match throws, which must surface as a clear CLI error.
      deps.error(err instanceof Error ? err.message : String(err));
      deps.exit(1);
      return;
    }
    if (record && reportWorkspaceSourceConflict(record, projectSession, deps)) {
      deps.exit(1);
      return;
    }
    // Serve under the enrolled name (mirrors the old `fleet serve
    // --enrollment-token` behavior where --name beat the enrollment name).
    enrolledNodeName = applyResolvedNodeSession(record, projectSession, deps);
  }

  const nodeName = options.brokerName ?? enrolledNodeName;
  await runUpCommand(
    {
      ...options,
      discoverConfig: true,
      // The broker name is also its registered fleet-node name. Keeping both
      // fields aligned makes foreground startup use the enrolled identity and
      // lets detached startup preserve it via the existing --broker-name arg.
      ...(nodeName ? { brokerName: nodeName, nodeName } : {}),
    },
    deps.core
  );
}
