/**
 * `spawnFleetSandbox` — the typed SDK contract for `agent-relay fleet spawn
 * --sandbox`. It provisions a Cloud fleet sandbox, starts the agent harness on
 * it, confirms the node the agent landed on, and returns a handle to the live
 * agent that can be attached to immediately and torn down idempotently.
 *
 * The CLI command drives this same function, so the two cannot drift.
 */
import { randomUUID } from 'node:crypto';

import {
  CloudFleetSandboxProvisionError,
  DEV_CLOUD_API_URL,
  DEV_RELAYCAST_ORIGIN,
  deleteCloudFleetSandbox,
  ensureCloudFleetSandbox,
  resolveWorkspaceByKey,
  type CloudFleetRelaycastTarget,
  type EnsureCloudFleetSandboxInput,
  type EnsureCloudFleetSandboxResult,
} from '@agent-relay/cloud/fleet';
import {
  startFleetNodeAttachProxy,
  type FleetNodeAttachOptions,
  type FleetNodeAttachProxy,
} from '@agent-relay/cloud/attach';
import {
  persistWorkspaceRelaycastTarget,
  resolveBaseUrl,
  resolveWorkspaceSelection,
  resolveWorkspaceTransport,
  type WorkspaceTransportOptions,
} from '@agent-relay/cloud/workspace-transport';

import { AgentRelay, type AgentRelayAgent } from './agent-relay.js';
import { RelayPlacementError } from './messaging/relaycast-placement.js';
import type { RelaySpawnPlacementAck } from './messaging/types.js';

export type FleetSandboxProvider = 'daytona' | 'e2b' | 'agent37';

const CLOUD_SANDBOX_ID_PATTERN =
  /^sbx_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEFAULT_CONFIRM_TIMEOUT_MS = 120_000;

/** A sandbox that is ready to receive the agent (never a provisioning timeout). */
export type FleetSandboxReadyResult = Exclude<
  EnsureCloudFleetSandboxResult,
  { outcome: 'provisioning_timeout' }
>;

/** A Relaycast target without its credential. */
export type RedactedCloudFleetRelaycastTarget = Omit<CloudFleetRelaycastTarget, 'relaycastApiKey'>;

/** An ensured sandbox with the Relaycast credential removed. */
export type RedactedFleetSandboxResult = EnsureCloudFleetSandboxResult extends infer Result
  ? Result extends { relaycastTarget?: CloudFleetRelaycastTarget }
    ? Omit<Result, 'relaycastTarget'> & { relaycastTarget?: RedactedCloudFleetRelaycastTarget }
    : Result
  : never;

export interface SpawnFleetSandboxInput {
  /** Agent harness to start, e.g. `claude` or `codex`. */
  cli: string;
  /** Worker agent name. Defaults to `<cli>-sandbox-<random>`. */
  name?: string;
  /** Initial task. */
  task?: string;
  /** Relay workspace ID used for Cloud provisioning. Resolved from the workspace selection when omitted. */
  workspaceId?: string;
  /** Alias for `workspaceId`. */
  workspace?: string;
  /** Workspace credential/transport selection; ambient sources are used when omitted. */
  workspaceKey?: string;
  baseUrl?: string;
  projectRoot?: string;
  /** Advanced: full transport selection (overrides workspaceKey/baseUrl/projectRoot). */
  transport?: WorkspaceTransportOptions;
  /**
   * Harness environment. Fleet spawn cannot deliver per-agent environment yet,
   * so a non-empty map is rejected rather than silently dropped.
   */
  env?: Record<string, string>;
  provider?: FleetSandboxProvider;
  /**
   * Caller-declared `sbx_<UUID>` identity. A declared sandbox is retained: it
   * is never deleted by failure cleanup or by `destroy()`.
   */
  sandboxId?: string;
  sandboxName?: string;
  /** Mount Relayfile in the sandbox (default true). */
  mountRelayfile?: boolean;
  /** Relayfile subtrees (`/path/**`) to mount. */
  relayfilePaths?: string[];
  /** Relayfile subtrees (`/path/**`) Cloud must mount read-only. An empty list is ignored. */
  readonlyPaths?: string[];
  /** Static repository checkouts for the sandbox. */
  repos?: string[];
  repoRevisions?: Record<string, string>;
  /** Worker working directory. Defaults to the Relayfile mount root. */
  workerCwd?: string;
  channels?: string[];
  model?: string;
  /** Extra spawn input fields (for example declared workforce metadata or `session_ref`). */
  spawnMetadata?: Record<string, unknown>;
  /** Wait for the node to confirm the harness launched (default true). */
  confirm?: boolean;
  confirmTimeoutMs?: number;
  /** Validate the ensured sandbox before any agent is started; throwing aborts and cleans up. */
  verifySandbox?: (sandbox: EnsureCloudFleetSandboxResult) => void | Promise<void>;
  /** Compute the worker cwd once the sandbox mount is known. */
  resolveWorkerCwd?: (sandbox: FleetSandboxReadyResult) => string | undefined | Promise<string | undefined>;
  /** Compute the task once the sandbox and worker cwd are known. */
  resolveTask?: (sandbox: FleetSandboxReadyResult, workerCwd: string | undefined) => string | Promise<string>;
}

type WorkspaceRelayLike = Pick<AgentRelayAgent, 'workspace'>;
type AgentRelayLike = { messaging: Pick<AgentRelayAgent['messaging'], 'placement'> };

export interface SpawnFleetSandboxDependencies {
  ensureCloudFleetSandbox: typeof ensureCloudFleetSandbox;
  deleteCloudFleetSandbox: typeof deleteCloudFleetSandbox;
  resolveWorkspaceByKey: (workspaceKey: string) => Promise<{ cloudWorkspaceId: string }>;
  createWorkspaceRelay: (options: WorkspaceTransportOptions) => WorkspaceRelayLike;
  createAgentRelay: (options: { token: string; baseUrl?: string }) => AgentRelayLike;
  /**
   * Persist Cloud's server-selected Relaycast target for follow-up commands.
   * Throwing aborts the spawn (and cleans up an owned sandbox). The default
   * persists to the project session when one exists and otherwise does nothing;
   * the handle's `attach()` carries the verified target either way.
   */
  persistRelaycastTarget: (
    target: CloudFleetRelaycastTarget,
    context: { sandbox: EnsureCloudFleetSandboxResult; transport: WorkspaceTransportOptions }
  ) => void | Promise<void>;
  startFleetNodeAttachProxy: (options: FleetNodeAttachOptions) => Promise<FleetNodeAttachProxy>;
  warn: (message: string) => void;
}

export interface FleetSandboxHandle {
  sandboxId: string;
  /** Cloud node ID the agent landed on. */
  nodeId: string;
  nodeName: string;
  agentName: string;
  cloudWorkspaceId: string;
  providerId?: string;
  workerCwd?: string;
  relayfileMountPath?: string;
  /** True when this call provisioned the sandbox and `destroy()` deletes it. */
  ownsSandbox: boolean;
  /** The ensured sandbox, with the Relaycast credential removed. */
  sandbox: RedactedFleetSandboxResult;
  invocation: RelaySpawnPlacementAck;
  /** Attach to the live agent's terminal through a private local socket. */
  attach(options?: { mode?: FleetNodeAttachOptions['mode'] }): Promise<FleetNodeAttachProxy>;
  /** Release the agent and delete the sandbox when owned. Idempotent. */
  destroy(): Promise<void>;
}

export type FleetSandboxSpawnErrorCode =
  | 'invalid_input'
  | 'unsupported_env'
  | 'workspace_unresolved'
  | 'provisioning_timeout'
  | 'relayfile_unmounted'
  | 'relaycast_target_unverified'
  | 'sandbox_identity_unknown'
  | 'placement_mismatch';

export class FleetSandboxSpawnError extends Error {
  readonly code: FleetSandboxSpawnErrorCode;
  constructor(code: FleetSandboxSpawnErrorCode, message: string) {
    super(message);
    this.name = 'FleetSandboxSpawnError';
    this.code = code;
  }
}

function defaultDependencies(): SpawnFleetSandboxDependencies {
  return {
    ensureCloudFleetSandbox,
    deleteCloudFleetSandbox,
    resolveWorkspaceByKey: (workspaceKey) => resolveWorkspaceByKey(workspaceKey),
    createWorkspaceRelay: (options) => {
      const { workspaceKey, baseUrl } = resolveWorkspaceTransport(options);
      return new AgentRelay({ workspaceKey, baseUrl });
    },
    createAgentRelay: ({ token, baseUrl }) =>
      new AgentRelay({
        agentToken: token,
        // A launcher token is scoped to one deployment; never let a persisted
        // project route pick a different gateway for it.
        baseUrl: baseUrl ?? resolveBaseUrl({ ignorePersistedRelaycastTarget: true }),
      }),
    persistRelaycastTarget: (target, { sandbox, transport }) => {
      persistWorkspaceRelaycastTarget(
        resolveWorkspaceSelection(transport),
        target,
        sandbox.relaycastCloudApiUrl
      );
    },
    startFleetNodeAttachProxy,
    warn: (message) => process.stderr.write(`${message}\n`),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Remove the Relaycast credential so the result can be logged or returned. */
export function redactFleetSandbox(sandbox: EnsureCloudFleetSandboxResult): RedactedFleetSandboxResult {
  if (!sandbox.relaycastTarget) return sandbox as RedactedFleetSandboxResult;
  const { relaycastApiKey: _secret, ...target } = sandbox.relaycastTarget;
  return { ...sandbox, relaycastTarget: target } as RedactedFleetSandboxResult;
}

export async function spawnFleetSandbox(
  input: SpawnFleetSandboxInput,
  dependencies: Partial<SpawnFleetSandboxDependencies> = {}
): Promise<FleetSandboxHandle> {
  const deps: SpawnFleetSandboxDependencies = { ...defaultDependencies(), ...dependencies };
  const cli = nonEmpty(input.cli);
  if (!cli) throw new FleetSandboxSpawnError('invalid_input', 'A harness cli is required.');
  if (input.env && Object.keys(input.env).length > 0) {
    throw new FleetSandboxSpawnError(
      'unsupported_env',
      'Fleet sandbox spawn cannot deliver a per-agent environment yet; remove env or provide it through the workspace.'
    );
  }
  const mountRelayfile = input.mountRelayfile !== false;
  const readonlyPaths = input.readonlyPaths?.length ? [...input.readonlyPaths] : undefined;
  if (readonlyPaths && !mountRelayfile) {
    throw new FleetSandboxSpawnError('invalid_input', 'readonlyPaths requires mounting Relayfile.');
  }
  if (input.sandboxId !== undefined && !CLOUD_SANDBOX_ID_PATTERN.test(input.sandboxId)) {
    throw new FleetSandboxSpawnError(
      'invalid_input',
      'sandboxId must match lowercase sbx_<UUID> using an RFC 4122 UUID.'
    );
  }
  const name = nonEmpty(input.name) ?? `${cli}-sandbox-${randomUUID().slice(0, 8)}`;
  const provider = input.provider;
  // An explicit sandbox identity is a retained/replayable resource. Never
  // delete it as collateral when a later verification or dispatch step fails;
  // only clean up sandboxes whose identity this invocation minted.
  const shouldCleanupSandbox = input.sandboxId === undefined;
  const transport: WorkspaceTransportOptions = input.transport ?? {
    ...(input.workspaceKey === undefined ? {} : { workspaceKey: input.workspaceKey }),
    ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
    ...(input.projectRoot === undefined ? {} : { projectRoot: input.projectRoot }),
  };
  const legacyTransport: WorkspaceTransportOptions = {
    ...transport,
    ...(provider === 'agent37' ? {} : { ignorePersistedRelaycastTarget: true }),
  };
  let workspaceRelay: WorkspaceRelayLike | undefined;

  let relayWorkspaceId = nonEmpty(input.workspaceId) ?? nonEmpty(input.workspace);
  if (!relayWorkspaceId) {
    const selection = resolveWorkspaceSelection(transport);
    relayWorkspaceId = nonEmpty(selection?.workspaceId);
    if (!relayWorkspaceId && selection?.key && (provider === undefined || provider === 'agent37')) {
      relayWorkspaceId = (await deps.resolveWorkspaceByKey(selection.key)).cloudWorkspaceId;
    }
    if (!relayWorkspaceId && provider !== undefined && provider !== 'agent37') {
      workspaceRelay = deps.createWorkspaceRelay(legacyTransport);
      relayWorkspaceId = nonEmpty((await workspaceRelay.workspace.info()).id);
    }
  }
  if (!relayWorkspaceId) {
    throw new FleetSandboxSpawnError(
      'workspace_unresolved',
      'Sandbox provisioning requires a Relay workspace identity; pass workspaceId or bind the workspace.'
    );
  }

  const sandboxId = input.sandboxId ?? (input.sandboxName === undefined ? `sbx_${randomUUID()}` : undefined);
  const deterministicSandboxName =
    sandboxId === undefined ? undefined : `fleet-sandbox-${sandboxId.slice('sbx_'.length)}`;
  if (
    input.sandboxId !== undefined &&
    input.sandboxName !== undefined &&
    input.sandboxName !== deterministicSandboxName
  ) {
    throw new FleetSandboxSpawnError(
      'invalid_input',
      `--sandbox-name must be '${deterministicSandboxName}' when --sandbox-id is supplied; custom names cannot preserve the one-to-one sandbox identity.`
    );
  }
  const effectiveSandboxName = deterministicSandboxName ?? input.sandboxName;
  // The unpinned/Agent37 path deliberately carries the measured heavy
  // 8 CPU / 16 GiB / 20 GiB profile. Daytona and E2B cannot satisfy that
  // shape, so an explicit legacy-provider selection must request the
  // provider-neutral durable profile instead of becoming unroutable by
  // construction.
  const workloadProfile =
    provider === undefined || provider === 'agent37' ? 'long-running-agent' : 'standard-long-running-agent';
  const useAsyncPreparation = sandboxId !== undefined && (provider === undefined || provider === 'agent37');
  if (useAsyncPreparation && input.sandboxId === undefined) {
    // The generated identity is not persisted. Print it before Cloud work
    // starts so an interrupted run can be resumed instead of duplicated.
    deps.warn(
      `Cloud sandbox identity: ${sandboxId}. If this command is interrupted, re-run it with --sandbox-id ${sandboxId} to resume the same sandbox instead of creating another.`
    );
  }

  const deleteSandbox = (sandbox: { cloudWorkspaceId: string; sandboxId: string; providerId?: string }) =>
    deps.deleteCloudFleetSandbox({
      cloudWorkspaceId: sandbox.cloudWorkspaceId,
      sandboxId: sandbox.sandboxId,
      ...(sandbox.providerId === undefined
        ? {}
        : { providerId: sandbox.providerId as EnsureCloudFleetSandboxInput['providerId'] & string }),
    });

  let sandbox: EnsureCloudFleetSandboxResult | undefined;
  try {
    const ensureInput: EnsureCloudFleetSandboxInput = {
      workspaceId: relayWorkspaceId,
      requiredCapability: `spawn:${cli}`,
      ...(useAsyncPreparation ? { preparationMode: 'async-v1' as const } : {}),
      maxAgents: 1,
      mountRelayfile,
      ...(readonlyPaths === undefined ? {} : { readonlyPaths }),
      ...(input.relayfilePaths === undefined ? {} : { relayfilePaths: input.relayfilePaths }),
      ...(sandboxId === undefined ? {} : { sandboxId }),
      forceProvision: true,
      ...(provider === undefined ? {} : { providerId: provider }),
      workloadProfile,
      waitTimeoutMs: 90_000,
      ...(effectiveSandboxName === undefined ? {} : { name: effectiveSandboxName }),
      ...(input.repos === undefined ? {} : { repos: input.repos }),
      ...(input.repoRevisions === undefined ? {} : { repoRevisions: input.repoRevisions }),
    };
    sandbox = useAsyncPreparation
      ? await deps.ensureCloudFleetSandbox(ensureInput, {
          onPreparationProgress: (progress) => {
            deps.warn(
              `Cloud sandbox preparation: ${progress.phase} (${progress.state}, generation ${progress.generation}).`
            );
          },
        })
      : await deps.ensureCloudFleetSandbox(ensureInput);
    await input.verifySandbox?.(sandbox);
  } catch (error) {
    if (error instanceof CloudFleetSandboxProvisionError && error.sandboxAbsent) {
      // Cloud's terminal record for this exact identity already proves the
      // provider sandbox is gone; a delete here would only race its reaper.
      deps.warn(
        `${error.message} Cloud confirmed sandbox '${
          error.sandboxId ?? sandboxId ?? 'the requested sandbox'
        }' is not running; no sandbox was left running.`
      );
    } else if (
      shouldCleanupSandbox &&
      error instanceof CloudFleetSandboxProvisionError &&
      error.confirmedProvisioned &&
      error.cloudWorkspaceId &&
      error.sandboxId
    ) {
      const failedSandboxId = error.sandboxId;
      await deleteSandbox({
        cloudWorkspaceId: error.cloudWorkspaceId,
        sandboxId: failedSandboxId,
        ...(error.providerId === undefined ? {} : { providerId: error.providerId }),
      }).catch((cleanupError) => {
        deps.warn(
          `Provisioning failed after Cloud confirmed sandbox '${failedSandboxId}', and automatic cleanup failed: ${errorMessage(
            cleanupError
          )}`
        );
      });
    } else if (error instanceof CloudFleetSandboxProvisionError && error.noSandboxCreated) {
      deps.warn(error.message);
    } else if (error instanceof CloudFleetSandboxProvisionError && error.outcomeUnknown) {
      deps.warn(
        `Cloud did not return a complete provisioning response. The outcome is unknown; check Cloud Fleet for node '${
          error.nodeName ?? effectiveSandboxName ?? 'the requested sandbox'
        }'${
          sandboxId === undefined ? '' : ` before retrying with --sandbox-id '${sandboxId}'`
        } so a sandbox is not left running.`
      );
    } else if (
      shouldCleanupSandbox &&
      error instanceof CloudFleetSandboxProvisionError &&
      error.cloudWorkspaceId &&
      error.sandboxId
    ) {
      const failedSandboxId = error.sandboxId;
      await deleteSandbox({
        cloudWorkspaceId: error.cloudWorkspaceId,
        sandboxId: failedSandboxId,
        ...(error.providerId === undefined ? {} : { providerId: error.providerId }),
      }).catch((cleanupError) => {
        deps.warn(
          `Provisioning failed after Cloud created sandbox '${failedSandboxId}', and automatic cleanup failed: ${errorMessage(
            cleanupError
          )}`
        );
      });
    }
    if (shouldCleanupSandbox && sandbox && sandbox.outcome !== 'reused') {
      await deleteSandbox(sandbox).catch((cleanupError) => {
        deps.warn(
          `Sandbox repository verification failed and cleanup also failed: ${errorMessage(cleanupError)}`
        );
      });
    }
    throw error;
  }

  let relaycastTransport: WorkspaceTransportOptions = transport;
  let verifiedTarget: CloudFleetRelaycastTarget | undefined;
  if (sandbox.outcome !== 'provisioning_timeout' && sandbox.relaycastTarget) {
    // When Cloud returns a closed, server-owned target, apply it for any
    // provider and outcome before registration, spawn, or launcher release,
    // then prove the authenticated client sees the exact workspace Cloud
    // returned.
    try {
      const target = sandbox.relaycastTarget;
      const returnedRelayWorkspaceId =
        'relayWorkspaceId' in sandbox ? sandbox.relayWorkspaceId?.trim() : undefined;
      if (
        (returnedRelayWorkspaceId !== undefined && target.workspaceId.trim() !== returnedRelayWorkspaceId) ||
        (sandbox.outcome === 'provisioned' && !returnedRelayWorkspaceId)
      ) {
        throw new FleetSandboxSpawnError(
          'relaycast_target_unverified',
          'Cloud returned a Relaycast target for a different workspace.'
        );
      }
      relaycastTransport = {
        ...relaycastTransport,
        workspaceKey: target.relaycastApiKey,
        baseUrl: target.baseUrl,
      };
      workspaceRelay = deps.createWorkspaceRelay(relaycastTransport);
      const postEnsureWorkspace = await workspaceRelay.workspace.info();
      const postEnsureWorkspaceId = postEnsureWorkspace.id?.trim();
      if (
        !postEnsureWorkspaceId ||
        (sandbox.outcome === 'provisioned' && postEnsureWorkspaceId !== returnedRelayWorkspaceId) ||
        postEnsureWorkspaceId !== target.workspaceId.trim()
      ) {
        throw new FleetSandboxSpawnError(
          'relaycast_target_unverified',
          'Cloud returned a Relaycast workspace that could not be verified on the selected gateway.'
        );
      }
      if (
        target.route === 'canonical' &&
        target.baseUrl === DEV_RELAYCAST_ORIGIN &&
        sandbox.relaycastCloudApiUrl !== DEV_CLOUD_API_URL
      ) {
        throw new FleetSandboxSpawnError(
          'relaycast_target_unverified',
          `Cloud returned the DEV canonical Relaycast target, but relaycastCloudApiUrl was not exactly ${DEV_CLOUD_API_URL}; refusing to persist an untrusted route.`
        );
      }
      await deps.persistRelaycastTarget(target, { sandbox, transport });
      verifiedTarget = target;
    } catch (error) {
      if (shouldCleanupSandbox && sandbox.outcome === 'provisioned') {
        await deleteSandbox(sandbox).catch((cleanupError) => {
          deps.warn(
            `Relaycast workspace verification failed and sandbox cleanup also failed: ${errorMessage(
              cleanupError
            )}`
          );
        });
      }
      throw error;
    }
  } else if (sandbox.outcome !== 'provisioning_timeout') {
    // Older non-Agent37 Cloud responses can omit a target. In that
    // compatibility case, keep every subsequent client on the canonical
    // workspace selection; a stale persisted Agent37 target must not leak
    // into registration, dispatch, or launcher release.
    relaycastTransport = legacyTransport;
  }
  if (sandbox.outcome === 'provisioning_timeout') {
    if (shouldCleanupSandbox) {
      await deleteSandbox(sandbox).catch((error) => {
        deps.warn(`The timed-out sandbox could not be cleaned up automatically: ${errorMessage(error)}`);
      });
    }
    throw new FleetSandboxSpawnError(
      'provisioning_timeout',
      `Sandbox node '${sandbox.nodeName}' did not become ready within ${sandbox.waitedMs}ms.`
    );
  }
  const ready: FleetSandboxReadyResult = sandbox;
  if (mountRelayfile && (ready.outcome !== 'provisioned' || ready.relayfileMounted !== true)) {
    if (shouldCleanupSandbox && ready.outcome === 'provisioned') {
      await deleteSandbox(ready).catch((error) => {
        deps.warn(
          `The unmounted sandbox could not be cleaned up automatically and may still be running: ${errorMessage(
            error
          )}`
        );
      });
    }
    throw new FleetSandboxSpawnError(
      'relayfile_unmounted',
      'Cloud returned a sandbox node without the required Relayfile mount.'
    );
  }

  const mountPath =
    ready.outcome === 'provisioned' && ready.relayfileMounted
      ? (ready.relayfileMountPath ?? '/workspace')
      : undefined;
  const sandboxIdentity = 'sandboxId' in ready ? ready.sandboxId : sandboxId;
  if (sandboxIdentity === undefined) {
    // A reused node is not owned by this call, so there is nothing to clean up.
    throw new FleetSandboxSpawnError(
      'sandbox_identity_unknown',
      `Cloud reused node '${ready.nodeName}' without a sandbox identity; pass sandboxId to resume a known sandbox.`
    );
  }
  const ownsSandbox = shouldCleanupSandbox && ready.outcome === 'provisioned';
  const confirm = input.confirm !== false;
  const workspaceRelayFor = () =>
    (workspaceRelay ??= deps.createWorkspaceRelay(verifiedTarget ? relaycastTransport : legacyTransport));
  const releaseAgent = (reason: string) =>
    workspaceRelayFor().workspace.release({ name, reason, deleteAgent: true });

  let launcherName: string | undefined;
  let invocation: RelaySpawnPlacementAck;
  let workerCwd: string | undefined;
  try {
    // Caller hooks run inside the cleanup boundary: a throwing hook must not
    // strand the sandbox this call just provisioned.
    workerCwd = (await input.resolveWorkerCwd?.(ready)) ?? input.workerCwd ?? mountPath;
    const task = (await input.resolveTask?.(ready, workerCwd)) ?? input.task ?? '';
    // Agent tokens are scoped to a Relaycast deployment. Mint a temporary
    // launcher on the transport Cloud selected (or the canonical
    // compatibility transport when an older non-Agent37 response omitted the
    // target); ambient agent tokens cannot prove they belong to it.
    const pendingLauncherName = `fleet-spawn-launcher-${randomUUID().slice(0, 8)}`;
    const launcher = await workspaceRelayFor().workspace.register(
      { name: pendingLauncherName, metadata: { purpose: 'fleet-spawn-launcher' } },
      { strict: true }
    );
    launcherName = pendingLauncherName;
    const agentToken = launcher.token;
    if (!agentToken) {
      throw new Error('The temporary fleet spawn launcher did not receive an agent token.');
    }
    // The launcher token is already scoped to the exact workspace and
    // deployment Cloud selected; keep the workspace key only on
    // `workspaceRelay`, where it mints and releases that token.
    const relay = deps.createAgentRelay({
      token: agentToken,
      ...(relaycastTransport.baseUrl === undefined ? {} : { baseUrl: relaycastTransport.baseUrl }),
    });
    // Placement alone only proves the node accepted the dispatch. A node
    // running an obsolete broker advertises `spawn:<cli>` capacity, acks the
    // invocation and launches nothing — so wait for confirmation unless asked
    // not to.
    invocation = await relay.messaging.placement.spawn({
      capability: `spawn:${cli}`,
      node: ready.nodeName,
      failFast: true,
      confirm,
      ...(confirm ? { confirmTimeoutMs: input.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS } : {}),
      input: {
        // Metadata first: it must never replace the lifecycle fields the
        // handle attaches to and releases.
        ...(input.spawnMetadata ?? {}),
        name,
        cli,
        task,
        ...(input.channels?.length ? { channels: input.channels } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(workerCwd ? { worker_cwd: workerCwd } : {}),
      },
    });
    // Confirm the agent landed on the sandbox this call ensured. For a
    // targeted spawn, `invocation.node` and `placement.node` echo the
    // requested roster node, so only the engine's dispatch receipt is
    // evidence of where the action actually ran.
    const sandboxNodeIds = new Set(
      [
        ready.nodeId,
        ...(invocation.node?.name === ready.nodeName ? [invocation.node.id, invocation.node.nodeId] : []),
      ].filter((id): id is string => typeof id === 'string' && id.length > 0)
    );
    const receiptNodeIds = [invocation.dispatchedNodeId, invocation.handlerNodeId].filter(
      (id): id is string => typeof id === 'string' && id.length > 0
    );
    const landedNodeId = receiptNodeIds.find((id) => !sandboxNodeIds.has(id));
    if (receiptNodeIds.length === 0 || landedNodeId !== undefined) {
      // No receipt proves the sandbox node, or one names another node: fail
      // closed so an agent routed elsewhere never escapes the sandbox.
      await releaseAgent('Fleet sandbox spawn landed on an unverified node').catch((error) => {
        deps.warn(`Releasing the unverified agent '${name}' failed: ${errorMessage(error)}`);
      });
      throw new FleetSandboxSpawnError(
        'placement_mismatch',
        landedNodeId === undefined
          ? `Agent '${name}' was dispatched without a node receipt proving sandbox node '${ready.nodeName}' (${ready.nodeId}).`
          : `Agent '${name}' landed on node '${landedNodeId}', not sandbox node '${ready.nodeName}' (${ready.nodeId}).`
      );
    }
  } catch (error) {
    if (
      shouldCleanupSandbox &&
      ready.outcome === 'provisioned' &&
      !(error instanceof RelayPlacementError && error.state === 'unconfirmed_may_be_running')
    ) {
      await deleteSandbox(ready).catch((cleanupError) => {
        deps.warn(
          `Spawn failed and the sandbox could not be cleaned up automatically: ${errorMessage(cleanupError)}`
        );
      });
    }
    throw error;
  } finally {
    if (launcherName && workspaceRelay) {
      await workspaceRelay.workspace
        .release({
          name: launcherName,
          reason: 'Temporary fleet spawn launcher completed',
          deleteAgent: true,
        })
        .catch((error) => {
          deps.warn(`Temporary launcher cleanup failed: ${errorMessage(error)}`);
        });
    }
  }

  let destroyed: Promise<void> | undefined;
  let agentReleased = false;
  let sandboxDeleted = false;
  return {
    sandboxId: sandboxIdentity,
    nodeId: ready.nodeId,
    nodeName: ready.nodeName,
    agentName: name,
    cloudWorkspaceId: ready.cloudWorkspaceId,
    ...(ready.providerId === undefined ? {} : { providerId: ready.providerId }),
    ...(workerCwd === undefined ? {} : { workerCwd }),
    ...(mountPath === undefined ? {} : { relayfileMountPath: mountPath }),
    ownsSandbox,
    sandbox: redactFleetSandbox(ready),
    invocation,
    attach: async (options = {}) => {
      const attachTransport = verifiedTarget
        ? { workspaceKey: verifiedTarget.relaycastApiKey, baseUrl: verifiedTarget.baseUrl }
        : resolveWorkspaceTransport(legacyTransport);
      return deps.startFleetNodeAttachProxy({
        node: ready.nodeName,
        agent: name,
        mode: options.mode ?? 'drive',
        workspaceKey: attachTransport.workspaceKey,
        ...(attachTransport.baseUrl === undefined ? {} : { baseUrl: attachTransport.baseUrl }),
      });
    },
    destroy: () =>
      (destroyed ??= (async () => {
        // Each step is recorded once it succeeds, so a retry only replays
        // the step that failed (a deleted sandbox would otherwise 404).
        const failures: string[] = [];
        if (!agentReleased) {
          await releaseAgent('Fleet sandbox handle destroyed').then(
            () => {
              agentReleased = true;
            },
            (error) => {
              failures.push(`agent release failed: ${errorMessage(error)}`);
            }
          );
        }
        if (ownsSandbox && !sandboxDeleted) {
          await deleteSandbox(ready).then(
            () => {
              sandboxDeleted = true;
            },
            (error) => {
              failures.push(`sandbox deletion failed: ${errorMessage(error)}`);
            }
          );
        }
        if (failures.length > 0) {
          destroyed = undefined;
          throw new Error(`Fleet sandbox teardown incomplete: ${failures.join('; ')}`);
        }
      })()),
  };
}
