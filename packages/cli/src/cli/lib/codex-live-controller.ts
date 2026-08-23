import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  LiveTeleportCloudClient,
  LiveTeleportEnvironment,
  LiveTeleportLifecycleStatus,
  LiveTeleportWorkspaceSource,
} from '@agent-relay/cloud';
import { LIVE_TELEPORT_MIN_TURN_LEASE_MS } from '@agent-relay/cloud';

import {
  CodexAppServerTurnTerminalError,
  type CodexAppServerSession,
  type CodexTurnOutcome,
  type CodexTurnResult,
} from './codex-app-server.js';

export type CodexControllerPhase =
  | 'local'
  | 'teleport_pending'
  | 'acquiring'
  | 'verifying'
  | 'remote'
  | 'rolling_back'
  | 'outcome_uncertain'
  | 'fenced'
  | 'recovery_failed';

export type CodexCloudLifecycleIntent =
  | 'none'
  | 'prewarm_requested'
  | 'prewarmed'
  | 'acquire_requested'
  | 'acquired'
  | 'cleanup_requested';

export type CodexTeleportRequest = {
  requestId: string;
  expectedGeneration: number;
};

type CodexRecoveredOutcome = {
  sessionId: string;
  threadId: string;
  generation: number;
  clientUserMessageId: string;
  turnId: string;
} & ({ status: 'completed'; result: CodexTurnResult } | { status: 'failed' | 'interrupted' });

export type CodexControllerState = {
  version: 1;
  sessionId: string;
  threadId: string;
  workspaceRoot: string;
  source?: { kind: LiveTeleportWorkspaceSource['kind'] };
  mountRestore?: CodexMountRestoreIdentity;
  generation: number;
  phase: CodexControllerPhase;
  controllerPid: number;
  socketPath: string;
  turnActive: boolean;
  pending?: CodexTeleportRequest;
  lastRequestId?: string;
  prewarmId?: string;
  prewarmStatus?: 'warming' | 'ready' | 'failed';
  /** Durable evidence that Cloud may own resources for this generation. */
  cloudLifecycle?: CodexCloudLifecycleIntent;
  remote?: Omit<LiveTeleportEnvironment, 'connectPath' | 'execServerUrl'> & {
    /** True only after the first remote turn/completed notification. */
    attached: boolean;
  };
  inFlightTurn?: {
    clientUserMessageId: string;
    execution: 'local' | 'remote';
  };
  /**
   * Durable, at-least-once output delivery retained until the CLI acknowledges
   * that its asynchronous writer completed. Model execution is never replayed.
   */
  recoveredOutcome?: CodexRecoveredOutcome;
  lastError?: string;
  updatedAt: string;
};

export type PublicCodexControllerStatus = Omit<
  CodexControllerState,
  'source' | 'remote' | 'mountRestore' | 'recoveredOutcome'
> & {
  execution: 'local' | 'verifying' | 'cloud' | 'fenced';
  controller: 'local';
  remote?: Pick<
    LiveTeleportEnvironment,
    'environmentId' | 'generation' | 'workspaceCwd' | 'connectExpiresAt' | 'leaseExpiresAt'
  > & {
    attached: true;
  };
  workspaceSource: LiveTeleportWorkspaceSource['kind'] | 'unavailable';
};

export interface CodexControllerStateStore {
  read(): CodexControllerState | null;
  write(state: CodexControllerState): void;
}

export class FileCodexControllerStateStore implements CodexControllerStateStore {
  constructor(readonly filePath: string) {}

  read(): CodexControllerState | null {
    try {
      return validatePersistedState(JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as unknown);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  write(state: CodexControllerState): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    const temporaryFd = fs.openSync(temporary, 'r');
    try {
      fs.fsyncSync(temporaryFd);
    } finally {
      fs.closeSync(temporaryFd);
    }
    fs.renameSync(temporary, this.filePath);
    fs.chmodSync(this.filePath, 0o600);
    try {
      const directoryFd = fs.openSync(path.dirname(this.filePath), 'r');
      try {
        fs.fsyncSync(directoryFd);
      } finally {
        fs.closeSync(directoryFd);
      }
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          'code' in error &&
          ['EBADF', 'EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM'].includes(String(error.code))
        )
      ) {
        throw error;
      }
    }
  }
}

export type CodexWorkspaceSealInput = {
  sessionId: string;
  generation: number;
  threadId: string;
  workspaceRoot: string;
  lifecycleId: string;
  signal?: AbortSignal;
};

export type CodexWorkspaceSealHandle = {
  source: LiveTeleportWorkspaceSource;
  restore: CodexMountRestoreIdentity;
  /** Restarts/thaws the exact sealed mount and resolves only after readiness. */
  resumeLocal(signal?: AbortSignal): Promise<void>;
  /** Releases resources when the controller is closing without local resume. */
  close(): Promise<void>;
};

export type CodexMountRestoreIdentity = {
  lifecycleId: string;
  resumeId?: string;
  workspaceId?: string;
  localRoot: string;
};

export type CodexWorkspaceSealProvider = (
  input: CodexWorkspaceSealInput
) => Promise<CodexWorkspaceSealHandle>;
// Contract: a rejection (including AbortSignal) must leave the local mount
// ready, or restore it before rejecting. A fulfilled handle transfers mount
// lifecycle ownership to the controller until resumeLocal()/close().

export type CodexPersistedMountResumeProvider = (
  input: CodexWorkspaceSealInput & {
    source?: { kind: LiveTeleportWorkspaceSource['kind'] };
    restore: CodexMountRestoreIdentity;
  }
) => Promise<void>;

export type CodexLiveControllerDependencies = {
  cloud: LiveTeleportCloudClient;
  store: CodexControllerStateStore;
  createAppServer: () => Promise<CodexAppServerSession>;
  probeCapability: () => Promise<void>;
  checkpointAndSeal: CodexWorkspaceSealProvider;
  resumePersistedLocalMount: CodexPersistedMountResumeProvider;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => Date;
  sessionId: () => string;
  operationId: () => string;
  pid: number;
};

export type CodexLiveControllerOptions = {
  workspaceRoot: string;
  socketPath: string;
  model?: string;
  lifecycleDeadlineMs?: number;
  lifecyclePollIntervalMs?: number;
};

const DEFAULT_LIFECYCLE_DEADLINE_MS = 60_000;
const DEFAULT_LIFECYCLE_POLL_INTERVAL_MS = 500;
const TURN_BLOCKED_PHASES = new Set<CodexControllerPhase>([
  'recovery_failed',
  'outcome_uncertain',
  'fenced',
  'rolling_back',
  'acquiring',
  'verifying',
]);
const CONTROLLER_PHASES = new Set<CodexControllerPhase>([
  'local',
  'teleport_pending',
  'acquiring',
  'verifying',
  'remote',
  'rolling_back',
  'outcome_uncertain',
  'fenced',
  'recovery_failed',
]);
const CLOUD_LIFECYCLE_INTENTS = new Set<CodexCloudLifecycleIntent>([
  'none',
  'prewarm_requested',
  'prewarmed',
  'acquire_requested',
  'acquired',
  'cleanup_requested',
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validOptionalString(value: unknown): boolean {
  return value === undefined || nonEmptyString(value);
}

function validTimestamp(value: unknown): value is string {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function invalidNestedState(state: Record<string, unknown>): boolean {
  const pending = state.pending === undefined ? undefined : record(state.pending);
  const source = state.source === undefined ? undefined : record(state.source);
  const restore = state.mountRestore === undefined ? undefined : record(state.mountRestore);
  const remote = state.remote === undefined ? undefined : record(state.remote);
  const inFlight = state.inFlightTurn === undefined ? undefined : record(state.inFlightTurn);
  const recovered = state.recoveredOutcome === undefined ? undefined : record(state.recoveredOutcome);
  const generation = Number(state.generation);
  const workspaceRoot = String(state.workspaceRoot);
  if (
    (pending !== undefined &&
      (!nonEmptyString(pending.requestId) || pending.expectedGeneration !== generation)) ||
    (state.pending !== undefined && !pending) ||
    (source !== undefined &&
      (!hasOnlyKeys(source, ['kind']) || source.kind !== 'relayfile-checkpoint-seal')) ||
    (state.source !== undefined && !source) ||
    (restore !== undefined &&
      (!nonEmptyString(restore.lifecycleId) ||
        !validOptionalString(restore.resumeId) ||
        !validOptionalString(restore.workspaceId) ||
        !nonEmptyString(restore.localRoot) ||
        !path.isAbsolute(restore.localRoot) ||
        path.resolve(restore.localRoot) !== path.resolve(workspaceRoot))) ||
    (state.mountRestore !== undefined && !restore) ||
    (source !== undefined && !restore) ||
    (inFlight !== undefined &&
      (!nonEmptyString(inFlight.clientUserMessageId) ||
        (inFlight.execution !== 'local' && inFlight.execution !== 'remote'))) ||
    (state.inFlightTurn !== undefined && !inFlight) ||
    (state.recoveredOutcome !== undefined && !recovered) ||
    (inFlight !== undefined && recovered !== undefined) ||
    (recovered !== undefined && !validRecoveredOutcome(state, recovered)) ||
    (recovered !== undefined && state.phase !== 'local' && state.phase !== 'recovery_failed') ||
    (recovered !== undefined &&
      (pending !== undefined ||
        source !== undefined ||
        restore !== undefined ||
        remote !== undefined ||
        state.cloudLifecycle !== 'none' ||
        state.prewarmId !== undefined ||
        state.prewarmStatus !== undefined)) ||
    !validOptionalString(state.prewarmId) ||
    (state.prewarmStatus !== undefined &&
      state.prewarmStatus !== 'warming' &&
      state.prewarmStatus !== 'ready' &&
      state.prewarmStatus !== 'failed')
  ) {
    return true;
  }
  if (!remote) return state.remote !== undefined || state.phase === 'remote' || state.phase === 'verifying';
  const verification = record(remote.verification);
  const observed = record(verification?.observed);
  const health = record(verification?.health);
  return (
    'connectPath' in remote ||
    'execServerUrl' in remote ||
    remote.sessionId !== state.sessionId ||
    remote.generation !== generation ||
    !nonEmptyString(remote.environmentId) ||
    !nonEmptyString(remote.workspaceCwd) ||
    !validTimestamp(remote.connectExpiresAt) ||
    !validTimestamp(remote.leaseExpiresAt) ||
    typeof remote.attached !== 'boolean' ||
    !verification ||
    verification.version !== 1 ||
    verification.kind !== 'relayfile-destination-verification' ||
    verification.status !== 'converged' ||
    verification.remoteRoot !== '/' ||
    verification.sessionId !== state.sessionId ||
    verification.generation !== generation ||
    !nonEmptyString(verification.verificationId) ||
    !nonEmptyString(verification.workspaceId) ||
    !nonEmptyString(verification.localRoot) ||
    verification.localRoot !== remote.workspaceCwd ||
    !validTimestamp(verification.verifiedAt) ||
    !observed ||
    typeof observed.digest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(observed.digest) ||
    typeof observed.workspaceRevision !== 'string' ||
    !/^(?:0|rev_[0-9]+)$/.test(observed.workspaceRevision) ||
    typeof observed.eventCursor !== 'string' ||
    !/^(?:0|evt_[0-9]+)$/.test(observed.eventCursor) ||
    !health ||
    health.pendingWriteback !== 0 ||
    health.conflicts !== 0 ||
    health.outboxPending !== 0 ||
    health.outboxNeedsAttention !== false
  );
}

function validRecoveredOutcome(state: Record<string, unknown>, recovered: Record<string, unknown>): boolean {
  const commonKeys = [
    'sessionId',
    'threadId',
    'generation',
    'clientUserMessageId',
    'turnId',
    'status',
  ] as const;
  const bindingMatches = [
    recovered.sessionId === state.sessionId,
    recovered.threadId === state.threadId,
    recovered.generation === state.generation,
    nonEmptyString(recovered.clientUserMessageId),
    nonEmptyString(recovered.turnId),
  ].every(Boolean);
  if (!bindingMatches) {
    return false;
  }
  if (recovered.status === 'failed' || recovered.status === 'interrupted') {
    return hasOnlyKeys(recovered, commonKeys);
  }
  if (recovered.status !== 'completed' || !hasOnlyKeys(recovered, [...commonKeys, 'result'])) {
    return false;
  }
  return validRecoveredCompletion(state, recovered);
}

function validRecoveredCompletion(
  state: Record<string, unknown>,
  recovered: Record<string, unknown>
): boolean {
  const result = record(recovered.result) ?? {};
  const response = record(result.response) ?? {};
  const responseTurn = record(response.turn) ?? {};
  const completed = record(result.completed) ?? {};
  const params = record(completed.params) ?? {};
  const turn = record(params.turn) ?? {};
  const items = Array.isArray(turn.items) ? turn.items : [];
  const hasBoundUserMessage = items.some((item) => {
    const entry = record(item);
    return entry?.type === 'userMessage' && entry.clientId === recovered.clientUserMessageId;
  });
  const hasAssistantAnswer = items.some((item) => {
    const entry = record(item);
    return entry?.type === 'agentMessage' && typeof entry.text === 'string';
  });
  return [
    result.reconciled === true,
    result.turnId === recovered.turnId,
    responseTurn.id === recovered.turnId,
    responseTurn.status === 'completed',
    completed.method === 'turn/completed',
    params.threadId === state.threadId,
    turn.id === recovered.turnId,
    turn.status === 'completed',
    [undefined, 'full'].includes(turn.itemsView as string | undefined),
    Array.isArray(turn.items),
    hasBoundUserMessage,
    hasAssistantAnswer,
  ].every(Boolean);
}

function inferredCloudLifecycle(value: Record<string, unknown>): CodexCloudLifecycleIntent {
  if (value.remote) return 'acquired';
  if (value.phase === 'acquiring' || value.phase === 'verifying') return 'acquire_requested';
  if (value.prewarmId || value.prewarmStatus === 'ready') return 'prewarmed';
  if (CLOUD_LIFECYCLE_INTENTS.has(value.cloudLifecycle as CodexCloudLifecycleIntent)) {
    return value.cloudLifecycle as CodexCloudLifecycleIntent;
  }
  return 'none';
}

function validatePersistedState(value: unknown): CodexControllerState {
  const state = record(value);
  if (
    !state ||
    state.version !== 1 ||
    !nonEmptyString(state.sessionId) ||
    !nonEmptyString(state.threadId) ||
    !nonEmptyString(state.workspaceRoot) ||
    !nonEmptyString(state.socketPath) ||
    !Number.isSafeInteger(state.generation) ||
    Number(state.generation) < 1 ||
    !Number.isSafeInteger(state.controllerPid) ||
    Number(state.controllerPid) < 1 ||
    typeof state.turnActive !== 'boolean' ||
    !CONTROLLER_PHASES.has(state.phase as CodexControllerPhase) ||
    !nonEmptyString(state.updatedAt) ||
    Number.isNaN(Date.parse(state.updatedAt)) ||
    (state.cloudLifecycle !== undefined &&
      !CLOUD_LIFECYCLE_INTENTS.has(state.cloudLifecycle as CodexCloudLifecycleIntent)) ||
    invalidNestedState(state)
  ) {
    throw new Error('Persisted managed Codex controller state is invalid or from an unsupported version.');
  }
  return { ...(state as CodexControllerState), cloudLifecycle: inferredCloudLifecycle(state) };
}

export class CodexTurnRecordedError extends Error {
  readonly recordedTerminal = true;

  constructor(
    readonly status: 'failed' | 'interrupted',
    message: string,
    readonly requiresRecoveryAcknowledgment = false
  ) {
    super(message);
    this.name = 'CodexTurnRecordedError';
  }
}

export class CodexTurnOutcomeUncertainError extends Error {
  readonly outcomeUncertain = true;

  constructor(
    message = 'Codex turn outcome is uncertain; execution is fenced pending reconciliation.',
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'CodexTurnOutcomeUncertainError';
  }
}

class CodexLifecycleEffectUnsettledError extends Error {
  constructor(operationName: string) {
    super(`${operationName} did not settle after abort; lifecycle outcome is unknown.`);
    this.name = 'CodexLifecycleEffectUnsettledError';
  }
}

function isReadyStatus(value: unknown): boolean {
  if (typeof value === 'string') return /^(?:ready|connected|active)$/i.test(value);
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if ((key === 'status' || key === 'state') && isReadyStatus(nested)) return true;
    }
  }
  return false;
}

function sameRecoveredIdentity(left: CodexRecoveredOutcome, right: CodexRecoveredOutcome): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.threadId === right.threadId &&
    left.generation === right.generation &&
    left.clientUserMessageId === right.clientUserMessageId &&
    left.turnId === right.turnId &&
    left.status === right.status
  );
}

function publicStatus(state: CodexControllerState): PublicCodexControllerStatus {
  const { source, remote, mountRestore: _mountRestore, recoveredOutcome: _recoveredOutcome, ...rest } = state;
  const execution =
    state.phase === 'remote'
      ? 'cloud'
      : state.phase === 'verifying'
        ? 'verifying'
        : state.phase === 'fenced' ||
            state.phase === 'recovery_failed' ||
            state.phase === 'outcome_uncertain' ||
            state.phase === 'acquiring' ||
            state.phase === 'rolling_back'
          ? 'fenced'
          : 'local';
  return {
    ...rest,
    controller: 'local',
    execution,
    workspaceSource: source?.kind ?? 'unavailable',
    ...(remote && state.phase === 'remote' && remote.attached
      ? {
          remote: {
            environmentId: remote.environmentId,
            generation: remote.generation,
            workspaceCwd: remote.workspaceCwd,
            connectExpiresAt: remote.connectExpiresAt,
            leaseExpiresAt: remote.leaseExpiresAt,
            attached: true,
          },
        }
      : {}),
  };
}

/**
 * Owns one local Codex app-server/thread. The queued teleport is consumed only
 * immediately before turn/start. A remote lease is never followed by local
 * execution until Cloud has positively confirmed revoke or expiry.
 */
export class CodexLiveController {
  private appServer: CodexAppServerSession | null = null;
  private state: CodexControllerState | null = null;
  private sealedWorkspace: CodexWorkspaceSealHandle | null = null;
  private prewarmPromise: Promise<void> | null = null;
  private prewarmAbort: AbortController | null = null;
  private recoveredEvidenceTaken: CodexRecoveredOutcome | undefined;
  private closing = false;

  constructor(
    private readonly options: CodexLiveControllerOptions,
    private readonly deps: CodexLiveControllerDependencies
  ) {}

  async initialize(): Promise<PublicCodexControllerStatus> {
    this.recoveredEvidenceTaken = undefined;
    await this.deps.probeCapability();
    const persisted = this.deps.store.read();
    if (persisted && path.resolve(persisted.workspaceRoot) !== path.resolve(this.options.workspaceRoot)) {
      throw new Error(
        `The persisted managed Codex thread belongs to ${persisted.workspaceRoot}, not ${this.options.workspaceRoot}.`
      );
    }

    if (persisted) {
      const mustFenceCloud = this.cloudMayOwnResources(persisted);
      const mustRecoverMount = Boolean(persisted.source || persisted.mountRestore || persisted.remote);
      this.state = {
        ...persisted,
        controllerPid: this.deps.pid,
        socketPath: this.options.socketPath,
        workspaceRoot: this.options.workspaceRoot,
        turnActive: false,
        phase: mustFenceCloud || mustRecoverMount ? 'rolling_back' : 'local',
        pending: undefined,
        lastError: undefined,
        updatedAt: this.timestamp(),
      };
      this.persist();

      if (mustFenceCloud) {
        try {
          await this.confirmFence('restart-revoke');
        } catch (error) {
          this.markFenced('CLOUD_FENCE_UNCONFIRMED_ON_RESTART');
          throw new Error(this.requireState().lastError, { cause: error });
        }
      }

      if (mustRecoverMount) {
        try {
          await this.resumeLocalMount();
        } catch (error) {
          this.markRecoveryFailed('RELAYFILE_RESUME_FAILED_ON_RESTART');
          throw new Error(this.requireState().lastError, { cause: error });
        }
      }

      const replacement = await this.createInitializedAppServer();
      this.appServer = replacement;
      try {
        await replacement.resumeThread({
          threadId: persisted.threadId,
          cwd: this.options.workspaceRoot,
        });
      } catch (error) {
        this.markRecoveryFailed('CODEX_THREAD_RESUME_FAILED_ON_RESTART');
        await replacement.close().catch(() => undefined);
        this.appServer = null;
        throw new Error(this.requireState().lastError, { cause: error });
      }

      let recovered:
        | Extract<CodexTurnOutcome, { status: 'completed' }>
        | { status: 'failed' | 'interrupted'; turnId: string }
        | undefined;
      const inFlight = this.requireState().inFlightTurn;
      if (inFlight) {
        const outcome = await this.reconcileInFlightTurn().catch((error) => {
          this.markOutcomeUncertain('TURN_RECONCILIATION_UNAVAILABLE');
          throw new CodexTurnOutcomeUncertainError(undefined, { cause: error });
        });
        if (outcome.status === 'absent' || outcome.status === 'inProgress') {
          this.markOutcomeUncertain(`TURN_${outcome.status.toUpperCase()}`);
          throw new CodexTurnOutcomeUncertainError();
        }
        if (outcome.status === 'completed') {
          recovered = outcome;
        } else if (outcome.status === 'failed' || outcome.status === 'interrupted') {
          recovered = { status: outcome.status, turnId: outcome.turnId };
        }
      }

      const state = this.requireState();
      state.generation = persisted.generation + (mustFenceCloud || mustRecoverMount ? 1 : 0);
      state.phase = 'local';
      state.cloudLifecycle = 'none';
      state.remote = undefined;
      state.source = undefined;
      state.mountRestore = undefined;
      if (recovered) this.stageRecoveredOutcome(recovered);
      state.lastError = undefined;
      state.updatedAt = this.timestamp();
      this.persist();
    } else {
      const appServer = await this.createInitializedAppServer();
      this.appServer = appServer;
      const threadId = await appServer.startThread({
        cwd: this.options.workspaceRoot,
        ...(this.options.model ? { model: this.options.model } : {}),
      });
      this.state = {
        version: 1,
        sessionId: this.deps.sessionId(),
        threadId,
        workspaceRoot: this.options.workspaceRoot,
        generation: 1,
        phase: 'local',
        controllerPid: this.deps.pid,
        socketPath: this.options.socketPath,
        turnActive: false,
        cloudLifecycle: 'none',
        updatedAt: this.timestamp(),
      };
      this.persist();
    }

    if (!this.requireState().recoveredOutcome) this.schedulePrewarm();
    return this.status();
  }

  status(): PublicCodexControllerStatus {
    return publicStatus(this.requireState());
  }

  /**
   * Claims crash-reconciled completion evidence without clearing its durable
   * copy. Rendering the full recovered answer is intentionally at-least-once:
   * a process can have emitted notification deltas before it lost the terminal
   * notification, so a recovered answer may duplicate an already-observed
   * prefix. The model turn itself is not replayed.
   */
  takeRecoveredTurn(): CodexTurnResult | undefined {
    const recovered = this.requireState().recoveredOutcome;
    if (!recovered || recovered.status !== 'completed' || this.recoveredEvidenceTaken) return undefined;
    this.recoveredEvidenceTaken = recovered;
    return recovered.result;
  }

  /** Claims terminal recovery evidence in memory without clearing its durable copy. */
  takeRecoveredTerminal(): CodexTurnRecordedError | undefined {
    const recovered = this.requireState().recoveredOutcome;
    if (!recovered || recovered.status === 'completed' || this.recoveredEvidenceTaken) return undefined;
    this.recoveredEvidenceTaken = recovered;
    return new CodexTurnRecordedError(
      recovered.status,
      `Codex recorded the crash-reconciled turn as ${recovered.status}; it was not replayed.`,
      true
    );
  }

  /** Durably acknowledges successful CLI rendering of the currently claimed recovery evidence. */
  acknowledgeRecoveredOutcome(): void {
    const state = this.requireState();
    const durable = state.recoveredOutcome;
    const claimed = this.recoveredEvidenceTaken;
    if (!durable || !claimed || !sameRecoveredIdentity(durable, claimed)) {
      throw new Error('Recovered Codex turn acknowledgment does not match durable recovery evidence.');
    }
    state.recoveredOutcome = undefined;
    state.updatedAt = this.timestamp();
    try {
      this.persist();
    } catch (error) {
      state.recoveredOutcome = durable;
      throw error;
    }
    this.recoveredEvidenceTaken = undefined;
    if (state.phase === 'local') this.schedulePrewarm();
  }

  requestTeleport(request: CodexTeleportRequest): PublicCodexControllerStatus {
    const state = this.requireState();
    this.assertNoUnacknowledgedOutcome('queue a teleport');
    if (request.expectedGeneration !== state.generation) {
      throw new Error(
        `Stale teleport generation ${request.expectedGeneration}; active generation is ${state.generation}.`
      );
    }
    if (state.lastRequestId === request.requestId || state.pending?.requestId === request.requestId) {
      return this.status();
    }
    if (state.phase === 'remote') throw new Error('This managed Codex session already executes in Cloud.');
    if (state.pending) throw new Error(`Teleport request ${state.pending.requestId} is already pending.`);
    if (state.phase !== 'local') {
      throw new Error(`Cannot queue a teleport while the controller is ${state.phase}.`);
    }

    state.pending = request;
    state.phase = 'teleport_pending';
    state.lastRequestId = request.requestId;
    state.updatedAt = this.timestamp();
    this.persist();
    return this.status();
  }

  async runTurn(text: string): Promise<CodexTurnResult> {
    const state = this.requireState();
    this.assertNoUnacknowledgedOutcome('start a turn');
    if (state.turnActive) throw new Error('A Codex turn is already active.');
    if (TURN_BLOCKED_PHASES.has(state.phase)) {
      throw new Error(`Cannot start a turn while the controller is ${state.phase}.`);
    }

    // Concrete turn boundary: snapshot before turnActive. A later request is
    // persisted for the following invocation and cannot splice this turn.
    const pendingAtBoundary = state.pending;
    state.turnActive = true;
    state.updatedAt = this.timestamp();
    this.persist();
    try {
      if (pendingAtBoundary) await this.applyPendingTeleport(pendingAtBoundary);
      if (this.requireState().phase === 'remote') await this.ensureRemoteActiveOrRecover();
      const execution =
        this.requireState().phase === 'remote' || this.requireState().phase === 'verifying'
          ? 'remote'
          : 'local';
      state.inFlightTurn = {
        clientUserMessageId: this.deps.operationId(),
        execution,
      };
      state.updatedAt = this.timestamp();
      this.persist();
      const result = await this.executeTurn(text, state.inFlightTurn.clientUserMessageId);
      state.inFlightTurn = undefined;
      state.updatedAt = this.timestamp();
      this.persist();
      return result;
    } finally {
      state.turnActive = false;
      state.updatedAt = this.timestamp();
      this.persist();
    }
  }

  private async executeTurn(text: string, clientUserMessageId: string): Promise<CodexTurnResult> {
    const state = this.requireState();
    const phase = state.phase as CodexControllerPhase;
    const remote = phase === 'verifying' || phase === 'remote' ? state.remote : undefined;
    try {
      const result = await this.requireAppServer().runTurn({
        threadId: state.threadId,
        text,
        clientUserMessageId,
        execution: remote
          ? {
              kind: 'remote',
              ...(!remote.attached
                ? { environment: { environmentId: remote.environmentId, cwd: remote.workspaceCwd } }
                : {}),
            }
          : { kind: 'local', workspaceRoot: state.workspaceRoot },
      });
      if (this.requireState().phase === 'verifying' && remote && !remote.attached) {
        remote.attached = true;
        state.phase = 'remote';
        state.lastError = undefined;
        state.updatedAt = this.timestamp();
        this.persist();
      }
      return result;
    } catch (error) {
      if (error instanceof CodexAppServerTurnTerminalError) {
        if (remote && this.requireState().phase === 'verifying' && !remote.attached) {
          remote.attached = true;
          state.phase = 'remote';
        }
        this.clearInFlightTurn(`TURN_${error.status.toUpperCase()}`);
        throw new CodexTurnRecordedError(error.status, `Codex turn ended ${error.status}.`);
      }
      if (remote) {
        const outcome = await this.recoverLocal('remote-turn-error-revoke', 'REMOTE_TURN_RECONCILED');
        if (outcome?.status === 'completed') return this.resultFromOutcome(outcome);
        if (outcome?.status === 'failed' || outcome?.status === 'interrupted') {
          throw new CodexTurnRecordedError(
            outcome.status,
            `Cloud turn ended ${outcome.status}; the recorded terminal turn was not replayed.`,
            true
          );
        }
        throw new CodexTurnOutcomeUncertainError(undefined, { cause: error });
      }
      let outcome: CodexTurnOutcome;
      try {
        outcome = await this.reconcileInFlightTurn();
      } catch (reconcileError) {
        this.markOutcomeUncertain('TURN_RECONCILIATION_UNAVAILABLE');
        throw new CodexTurnOutcomeUncertainError(undefined, { cause: reconcileError });
      }
      if (outcome.status === 'completed') {
        this.persistRecoveredOutcome(outcome, 'LOCAL_TURN_RECONCILED');
        return this.resultFromOutcome(outcome);
      }
      if (outcome.status === 'failed' || outcome.status === 'interrupted') {
        this.persistRecoveredOutcome(
          { status: outcome.status, turnId: outcome.turnId },
          'LOCAL_TURN_RECONCILED'
        );
        throw new CodexTurnRecordedError(
          outcome.status,
          `Codex turn ended ${outcome.status}; the recorded terminal turn was not replayed.`,
          true
        );
      }
      this.markOutcomeUncertain(`TURN_${outcome.status.toUpperCase()}`);
      throw new CodexTurnOutcomeUncertainError(undefined, { cause: error });
    }
  }

  async rollback(): Promise<PublicCodexControllerStatus> {
    const state = this.requireState();
    this.assertNoUnacknowledgedOutcome('roll back');
    if (state.turnActive) throw new Error('Rollback is only allowed at a Codex turn boundary.');
    await this.recoverLocal('rollback-revoke', 'Operator requested local rollback.');
    return this.status();
  }

  async close(): Promise<void> {
    const state = this.state;
    const lifecycleIdentityConsumed = Boolean(
      state &&
      (this.cloudMayOwnResources(state) || this.sealedWorkspace || state.source || state.mountRestore)
    );
    this.closing = true;
    this.prewarmAbort?.abort();
    await this.prewarmPromise?.catch(() => undefined);
    let fenceConfirmed = false;
    if (state && this.cloudMayOwnResources(state)) {
      try {
        await this.confirmFence('shutdown-revoke');
        fenceConfirmed = true;
      } catch {
        this.markFenced('CLOUD_FENCE_UNCONFIRMED_ON_SHUTDOWN');
      }
    }
    try {
      await this.appServer?.close();
    } catch (error) {
      if (state && (fenceConfirmed || !this.cloudMayOwnResources(state))) {
        this.markRecoveryFailed('CONTROLLER_CLOSE_FAILED_ON_SHUTDOWN');
      }
      throw error;
    }
    this.appServer = null;
    if (state && (fenceConfirmed || !this.cloudMayOwnResources(state))) {
      if (this.sealedWorkspace || state.source || state.mountRestore) {
        try {
          await this.resumeLocalMount();
        } catch (error) {
          this.markRecoveryFailed('RELAYFILE_RESUME_FAILED_ON_SHUTDOWN');
          throw new Error(state.lastError, { cause: error });
        }
      }
      if (state.inFlightTurn) {
        state.phase = 'outcome_uncertain';
        state.remote = undefined;
        state.lastError = 'TURN_RECONCILIATION_REQUIRED_ON_RESTART';
        state.updatedAt = this.timestamp();
        this.persist();
        return;
      }
      if (!lifecycleIdentityConsumed) return;
      // A confirmed prewarm-only fence consumes this generation's idempotency
      // identity just as surely as acquire/revoke. Never reinitialize and
      // replay a revoked resource under the same generation.
      // Finalize any queued request in the same durable write so it cannot
      // retain an expectedGeneration from the consumed identity.
      state.pending = undefined;
      state.generation += 1;
      state.phase = 'local';
      state.cloudLifecycle = 'none';
      state.remote = undefined;
      state.source = undefined;
      state.mountRestore = undefined;
      state.prewarmId = undefined;
      state.prewarmStatus = undefined;
      state.lastError = undefined;
      state.updatedAt = this.timestamp();
      this.persist();
    }
  }

  private async applyPendingTeleport(pendingAtBoundary: CodexTeleportRequest): Promise<void> {
    const state = this.requireState();
    const pending = state.pending;
    if (!pending || pending.requestId !== pendingAtBoundary.requestId) return;
    if (pending.expectedGeneration !== state.generation) {
      throw new Error('Pending teleport generation became stale before the turn boundary.');
    }

    state.phase = 'acquiring';
    state.updatedAt = this.timestamp();
    this.persist();
    try {
      // Keep the poll mount alive while Cloud warms. Admission is already
      // stopped at this turn boundary, but the short-lived seal is minted only
      // when Cloud is ready to consume it.
      await this.prewarmPromise;
      if (state.prewarmId && state.prewarmStatus !== 'ready') {
        await this.waitForCloudReady(state.prewarmId);
      }

      const lifecycleId = `${state.sessionId}:${state.generation}:${this.deps.operationId()}`;
      state.mountRestore = { lifecycleId, localRoot: state.workspaceRoot };
      state.updatedAt = this.timestamp();
      this.persist();
      const sealedWorkspace = await this.withAbortableLifecycleDeadline(
        (signal) =>
          this.deps.checkpointAndSeal({
            sessionId: state.sessionId,
            generation: state.generation,
            threadId: state.threadId,
            workspaceRoot: state.workspaceRoot,
            lifecycleId,
            signal,
          }),
        'Relayfile checkpoint-and-seal'
      );
      const source = sealedWorkspace.source;
      this.sealedWorkspace = sealedWorkspace;
      this.assertSeal(source, sealedWorkspace.restore);
      state.source = { kind: source.kind };
      state.mountRestore = sealedWorkspace.restore;
      state.updatedAt = this.timestamp();
      this.persist();

      state.cloudLifecycle = 'acquire_requested';
      state.updatedAt = this.timestamp();
      this.persist();
      const environment = await this.withAbortableLifecycleDeadline(
        (signal) =>
          this.deps.cloud.acquire({
            sessionId: state.sessionId,
            threadId: state.threadId,
            generation: state.generation,
            workspaceRoot: '/',
            source,
            ...(state.prewarmId ? { prewarmId: state.prewarmId } : {}),
            idempotencyKey: `${state.sessionId}:${state.generation}:acquire`,
            signal,
          }),
        'Cloud acquire/convergence'
      );
      if (environment.sessionId !== state.sessionId || environment.generation !== state.generation) {
        throw new Error('Cloud returned a stale or cross-session live-teleport generation.');
      }
      this.requireTurnLeaseHorizon(environment.leaseExpiresAt);

      const {
        connectPath: _connectPath,
        execServerUrl: _execServerUrl,
        ...persistedEnvironment
      } = environment;
      state.remote = { ...persistedEnvironment, attached: false };
      state.cloudLifecycle = 'acquired';
      state.pending = undefined;
      state.phase = 'acquiring';
      state.updatedAt = this.timestamp();
      this.persist();

      await this.requireAppServer().addEnvironment({
        environmentId: environment.environmentId,
        execServerUrl: environment.execServerUrl,
        connectTimeoutMs: Math.min(10_000, this.lifecycleDeadlineMs()),
      });
      await this.waitForEnvironmentReady(environment.environmentId);

      state.phase = 'verifying';
      state.lastError = undefined;
      state.updatedAt = this.timestamp();
      this.persist();
    } catch (error) {
      if (error instanceof CodexLifecycleEffectUnsettledError) {
        this.markFenced('LIFECYCLE_EFFECT_OUTCOME_UNKNOWN');
        throw error;
      }
      await this.recoverLocal('failed-acquire-revoke', 'TELEPORT_ACQUIRE_FAILED_RECOVERED');
      // No clientUserMessageId exists until applyPendingTeleport returns, so a
      // settled failure here is proven pre-submission. Continue this same
      // prompt locally on the recovered app-server with a fresh message id.
      return;
    }
  }

  private async recoverLocal(reason: string, context: string): Promise<CodexTurnOutcome | undefined> {
    const state = this.requireState();
    const old = this.requireAppServer();
    state.phase = 'rolling_back';
    state.pending = undefined;
    state.updatedAt = this.timestamp();
    this.persist();

    if (this.cloudMayOwnResources(state)) {
      try {
        await this.confirmFence(reason);
      } catch (error) {
        this.markFenced('CLOUD_FENCE_UNCONFIRMED');
        await old.close().catch(() => {
          state.lastError = 'CLOUD_FENCE_UNCONFIRMED_AND_CONTROLLER_CLOSE_FAILED';
          state.updatedAt = this.timestamp();
          this.persist();
        });
        this.appServer = null;
        throw new Error(state.lastError, { cause: error });
      }
    }

    try {
      await old.close();
    } catch (error) {
      this.markRecoveryFailed('CONTROLLER_CLOSE_FAILED_AFTER_FENCE');
      throw new Error(state.lastError, { cause: error });
    }
    this.appServer = null;
    try {
      await this.resumeLocalMount();
    } catch (error) {
      this.markRecoveryFailed('RELAYFILE_RESUME_FAILED_AFTER_FENCE');
      throw new Error(state.lastError, { cause: error });
    }
    let replacement: CodexAppServerSession;
    try {
      replacement = await this.createInitializedAppServer();
    } catch (error) {
      this.markRecoveryFailed('LOCAL_APP_SERVER_START_FAILED_AFTER_FENCE');
      throw new Error(state.lastError, { cause: error });
    }
    this.appServer = replacement;
    try {
      await replacement.resumeThread({ threadId: state.threadId, cwd: state.workspaceRoot });
    } catch (error) {
      this.markRecoveryFailed('CODEX_THREAD_RESUME_FAILED_AFTER_FENCE');
      await replacement.close().catch(() => undefined);
      this.appServer = null;
      throw new Error(state.lastError, { cause: error });
    }

    let outcome: CodexTurnOutcome | undefined;
    if (state.inFlightTurn) {
      try {
        outcome = await this.reconcileInFlightTurn();
      } catch (error) {
        this.markOutcomeUncertain('TURN_RECONCILIATION_UNAVAILABLE');
        throw new CodexTurnOutcomeUncertainError(undefined, { cause: error });
      }
      if (outcome.status === 'absent' || outcome.status === 'inProgress') {
        this.markOutcomeUncertain(`TURN_${outcome.status.toUpperCase()}`);
        throw new CodexTurnOutcomeUncertainError();
      }
    }

    state.generation += 1;
    state.phase = 'local';
    state.cloudLifecycle = 'none';
    state.remote = undefined;
    state.source = undefined;
    state.mountRestore = undefined;
    state.prewarmId = undefined;
    state.prewarmStatus = undefined;
    if (outcome?.status === 'completed') {
      this.stageRecoveredOutcome(outcome);
    } else if (outcome?.status === 'failed' || outcome?.status === 'interrupted') {
      this.stageRecoveredOutcome({ status: outcome.status, turnId: outcome.turnId });
    }
    state.lastError = context;
    state.updatedAt = this.timestamp();
    this.persist();
    if (outcome) {
      this.recoveredEvidenceTaken = state.recoveredOutcome;
    } else {
      this.schedulePrewarm();
    }
    return outcome;
  }

  private async confirmFence(_reason: string): Promise<void> {
    const state = this.requireState();
    state.cloudLifecycle = 'cleanup_requested';
    state.updatedAt = this.timestamp();
    this.persist();
    await this.withAbortableLifecycleDeadline(async (signal) => {
      let lastError: unknown;
      try {
        const revoked = await this.deps.cloud.revoke({
          sessionId: state.sessionId,
          generation: state.generation,
          idempotencyKey: `${state.sessionId}:${state.generation}:revoke`,
          signal,
        });
        this.assertLifecycleIdentity(revoked);
        // The Cloud contract may publish revoked/expired only after the
        // destination is stopped, flushed, and its consumer-bound Relayfile
        // ownership has been handed back. cleanup_pending is not a fence and
        // must never allow the source mount to resume.
        if (revoked.status === 'revoked' || revoked.status === 'expired') {
          this.markCloudFenced();
          return;
        }
      } catch (error) {
        lastError = error;
      }
      for (let attempt = 0; attempt < this.lifecycleAttempts(); attempt += 1) {
        try {
          const status = await this.deps.cloud.status({
            sessionId: state.sessionId,
            generation: state.generation,
            signal,
          });
          this.assertLifecycleIdentity(status);
          if (status.status === 'revoked' || status.status === 'expired') {
            this.markCloudFenced();
            return;
          }
          lastError = new Error(`Cloud fence remains ${status.status}.`);
        } catch (error) {
          lastError = error;
        }
        await this.deps.sleep(this.lifecyclePollIntervalMs());
      }
      throw new Error('Cloud fencing did not reach a terminal state.', { cause: lastError });
    }, 'Cloud revoke confirmation');
  }

  private async waitForCloudReady(prewarmId: string): Promise<void> {
    const state = this.requireState();
    const attempts = this.lifecycleAttempts();
    await this.withAbortableLifecycleDeadline(async (signal) => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const status = await this.deps.cloud.status({
          sessionId: state.sessionId,
          generation: state.generation,
          prewarmId,
          signal,
        });
        this.assertLifecycleIdentity(status);
        if (status.prewarmId && status.prewarmId !== prewarmId) {
          throw new Error('Cloud returned a stale or cross-prewarm lifecycle status.');
        }
        if (status.status === 'ready') {
          state.prewarmStatus = 'ready';
          state.updatedAt = this.timestamp();
          this.persist();
          return;
        }
        if (status.status !== 'warming') {
          throw new Error(`Cloud prewarm entered terminal state ${status.status}.`);
        }
        await this.deps.sleep(
          Math.min(status.retryAfterMs ?? this.lifecyclePollIntervalMs(), this.lifecyclePollIntervalMs())
        );
      }
      throw new Error('Cloud prewarm did not converge before the lifecycle deadline.');
    }, 'Cloud prewarm convergence');
  }

  private async waitForEnvironmentReady(environmentId: string): Promise<void> {
    const attempts = this.lifecycleAttempts();
    await this.withLifecycleDeadline(
      (async () => {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          const environmentStatus = await this.requireAppServer().environmentStatus(environmentId);
          if (isReadyStatus(environmentStatus)) return;
          await this.deps.sleep(this.lifecyclePollIntervalMs());
        }
        throw new Error('Codex did not report the Cloud execution environment ready before the deadline.');
      })(),
      'Codex environment readiness'
    );
  }

  private schedulePrewarm(): void {
    if (this.prewarmPromise || this.closing) return;
    const state = this.requireState();
    const generation = state.generation;
    state.cloudLifecycle = 'prewarm_requested';
    state.updatedAt = this.timestamp();
    this.persist();
    const abort = new AbortController();
    this.prewarmAbort = abort;
    const pending = this.startPrewarm(generation, abort.signal).finally(() => {
      if (this.prewarmPromise === pending) this.prewarmPromise = null;
      if (this.prewarmAbort === abort) this.prewarmAbort = null;
    });
    this.prewarmPromise = pending;
  }

  private async startPrewarm(generation: number, outerSignal: AbortSignal): Promise<void> {
    const state = this.requireState();
    try {
      const prewarm = await this.withAbortableLifecycleDeadline(
        (signal) =>
          this.deps.cloud.prewarm({
            sessionId: state.sessionId,
            generation,
            workspaceRoot: '/',
            idempotencyKey: `${state.sessionId}:${generation}:prewarm`,
            signal,
          }),
        'Cloud prewarm',
        outerSignal
      );
      if (prewarm.generation !== generation) {
        throw new Error('Cloud returned a stale prewarm generation.');
      }
      if (this.closing || this.requireState().generation !== generation) return;
      state.source = undefined;
      state.prewarmId = prewarm.prewarmId;
      state.prewarmStatus = prewarm.status;
      state.cloudLifecycle = 'prewarmed';
    } catch {
      if (this.closing || this.requireState().generation !== generation) return;
      state.source = undefined;
      state.prewarmId = undefined;
      state.prewarmStatus = 'failed';
      // Response loss is ambiguous. Retain prewarm_requested so restart or
      // shutdown fences any Cloud resource that may have been created.
      state.cloudLifecycle = 'prewarm_requested';
      state.lastError = 'CLOUD_PREWARM_UNAVAILABLE';
    }
    state.updatedAt = this.timestamp();
    this.persist();
  }

  private assertSeal(source: LiveTeleportWorkspaceSource, restore: CodexMountRestoreIdentity): void {
    if (
      source.kind !== 'relayfile-checkpoint-seal' ||
      !source.receipt ||
      typeof source.receipt !== 'object' ||
      Array.isArray(source.receipt)
    ) {
      throw new Error('Relayfile checkpoint-and-seal provider returned an invalid proof.');
    }
    if (
      typeof restore.resumeId !== 'string' ||
      restore.resumeId.length === 0 ||
      typeof restore.workspaceId !== 'string' ||
      restore.workspaceId.length === 0 ||
      typeof restore.lifecycleId !== 'string' ||
      restore.lifecycleId.length === 0 ||
      restore.lifecycleId !== this.requireState().mountRestore?.lifecycleId ||
      path.resolve(restore.localRoot) !== path.resolve(this.options.workspaceRoot)
    ) {
      throw new Error('Relayfile checkpoint-and-seal provider returned an invalid restore identity.');
    }
  }

  private async ensureRemoteActiveOrRecover(): Promise<void> {
    const state = this.requireState();
    const remote = state.remote;
    let active: boolean;
    if (!remote || Date.parse(remote.leaseExpiresAt) <= this.deps.now().getTime()) {
      await this.recoverLocal('remote-preflight-revoke', 'REMOTE_LEASE_RECOVERED');
      return;
    }
    try {
      const status = await this.withAbortableLifecycleDeadline(
        (signal) =>
          this.deps.cloud.status({
            sessionId: state.sessionId,
            generation: state.generation,
            signal,
          }),
        'Cloud active lease preflight'
      );
      this.assertLifecycleIdentity(status);
      active = status.status === 'active' && status.leaseExpiresAt !== undefined;
      if (active) {
        this.requireTurnLeaseHorizon(status.leaseExpiresAt!);
        if (Date.parse(status.leaseExpiresAt!) > Date.parse(remote.leaseExpiresAt)) {
          remote.leaseExpiresAt = status.leaseExpiresAt!;
          state.updatedAt = this.timestamp();
          this.persist();
        }
      }
    } catch {
      active = false;
    }
    if (!active) await this.recoverLocal('remote-preflight-revoke', 'REMOTE_LEASE_RECOVERED');
  }

  private reconcileInFlightTurn(): Promise<CodexTurnOutcome> {
    const state = this.requireState();
    const inFlight = state.inFlightTurn;
    if (!inFlight) return Promise.resolve({ status: 'absent' });
    return this.requireAppServer().turnOutcome({
      threadId: state.threadId,
      clientUserMessageId: inFlight.clientUserMessageId,
    });
  }

  private resultFromOutcome(outcome: Extract<CodexTurnOutcome, { status: 'completed' }>): CodexTurnResult {
    return outcome.result;
  }

  private persistRecoveredOutcome(
    outcome:
      | Extract<CodexTurnOutcome, { status: 'completed' }>
      | { status: 'failed' | 'interrupted'; turnId: string },
    context: string
  ): void {
    const state = this.requireState();
    this.stageRecoveredOutcome(outcome);
    state.lastError = context;
    state.updatedAt = this.timestamp();
    this.persist();
    this.recoveredEvidenceTaken = state.recoveredOutcome;
  }

  /** Move one reconciled in-flight turn into durable evidence in the caller's atomic state write. */
  private stageRecoveredOutcome(
    outcome:
      | Extract<CodexTurnOutcome, { status: 'completed' }>
      | { status: 'failed' | 'interrupted'; turnId: string }
  ): void {
    const state = this.requireState();
    const inFlight = state.inFlightTurn;
    if (!inFlight || state.recoveredOutcome) {
      throw new Error('Codex reconciliation evidence does not match one unique in-flight turn.');
    }
    const common = {
      sessionId: state.sessionId,
      threadId: state.threadId,
      generation: state.generation,
      clientUserMessageId: inFlight.clientUserMessageId,
      turnId: outcome.turnId,
    };
    state.recoveredOutcome =
      outcome.status === 'completed'
        ? { ...common, status: 'completed', result: outcome.result }
        : { ...common, status: outcome.status };
    state.inFlightTurn = undefined;
  }

  private requireTurnLeaseHorizon(leaseExpiresAt: string): void {
    const leaseDeadline = Date.parse(leaseExpiresAt);
    const minimumDeadline = this.deps.now().getTime() + LIVE_TELEPORT_MIN_TURN_LEASE_MS;
    if (Number.isNaN(leaseDeadline) || leaseDeadline < minimumDeadline) {
      throw new Error(
        `Cloud active lease does not cover the ${LIVE_TELEPORT_MIN_TURN_LEASE_MS / 60_000}-minute turn horizon.`
      );
    }
  }

  private clearInFlightTurn(code?: string): void {
    const state = this.requireState();
    state.inFlightTurn = undefined;
    state.lastError = code;
    state.updatedAt = this.timestamp();
    this.persist();
  }

  private async resumeLocalMount(): Promise<void> {
    const state = this.requireState();
    if (this.sealedWorkspace) {
      await this.withAbortableLifecycleDeadline(
        (signal) => this.sealedWorkspace!.resumeLocal(signal),
        'Relayfile local mount resume/readiness'
      );
      this.sealedWorkspace = null;
      return;
    }
    if (!state.mountRestore) {
      if (state.remote) {
        throw new Error('Persisted remote execution has no Relayfile seal identity to restore.');
      }
      return;
    }
    const restore = state.mountRestore;
    await this.withAbortableLifecycleDeadline(
      (signal) =>
        this.deps.resumePersistedLocalMount({
          sessionId: state.sessionId,
          generation: state.generation,
          threadId: state.threadId,
          workspaceRoot: state.workspaceRoot,
          lifecycleId: restore.lifecycleId,
          ...(state.source ? { source: state.source } : {}),
          restore,
          signal,
        }),
      'Persisted Relayfile local mount resume/readiness'
    );
  }

  private assertLifecycleIdentity(status: LiveTeleportLifecycleStatus): void {
    const state = this.requireState();
    if (status.sessionId !== state.sessionId || status.generation !== state.generation) {
      throw new Error('Cloud returned a stale or cross-session lifecycle status.');
    }
  }

  private cloudMayOwnResources(state = this.requireState()): boolean {
    return inferredCloudLifecycle(state as unknown as Record<string, unknown>) !== 'none';
  }

  private assertNoUnacknowledgedOutcome(operation: string): void {
    if (this.requireState().recoveredOutcome) {
      throw new Error(
        `Cannot ${operation} while a recovered Codex turn is awaiting durable output acknowledgment.`
      );
    }
  }

  private markCloudFenced(): void {
    const state = this.requireState();
    state.cloudLifecycle = 'none';
    state.prewarmId = undefined;
    state.prewarmStatus = undefined;
    state.updatedAt = this.timestamp();
    this.persist();
  }

  private async createInitializedAppServer(): Promise<CodexAppServerSession> {
    const appServer = await this.deps.createAppServer();
    await appServer.initialize();
    return appServer;
  }

  private markFenced(message: string): void {
    const state = this.requireState();
    state.phase = 'fenced';
    state.pending = undefined;
    state.lastError = message;
    state.updatedAt = this.timestamp();
    this.persist();
  }

  private markRecoveryFailed(message: string): void {
    const state = this.requireState();
    state.phase = 'recovery_failed';
    state.remote = undefined;
    state.lastError = message;
    state.updatedAt = this.timestamp();
    this.persist();
  }

  private markOutcomeUncertain(code: string): void {
    const state = this.requireState();
    state.phase = 'outcome_uncertain';
    state.lastError = code;
    state.updatedAt = this.timestamp();
    this.persist();
  }

  private withAbortableLifecycleDeadline<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    operationName: string,
    outerSignal?: AbortSignal
  ): Promise<T> {
    const controller = new AbortController();
    const abortFromOuter = () => controller.abort();
    outerSignal?.addEventListener('abort', abortFromOuter, { once: true });
    if (outerSignal?.aborted) controller.abort();
    const timeoutMs = this.lifecycleDeadlineMs();
    return new Promise<T>((resolve, reject) => {
      let timedOut = false;
      let settled = false;
      let settlementTimer: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        settlementTimer = setTimeout(
          () => {
            if (!settled) {
              outerSignal?.removeEventListener('abort', abortFromOuter);
              reject(new CodexLifecycleEffectUnsettledError(operationName));
            }
          },
          Math.min(5_000, timeoutMs)
        );
      }, timeoutMs);
      let promise: Promise<T>;
      try {
        promise = operation(controller.signal);
      } catch (error) {
        clearTimeout(timer);
        outerSignal?.removeEventListener('abort', abortFromOuter);
        reject(error);
        return;
      }
      promise.then(
        (value) => {
          settled = true;
          clearTimeout(timer);
          if (settlementTimer) clearTimeout(settlementTimer);
          outerSignal?.removeEventListener('abort', abortFromOuter);
          if (timedOut) reject(new Error(`${operationName} exceeded the ${timeoutMs}ms lifecycle deadline.`));
          else resolve(value);
        },
        (error) => {
          settled = true;
          clearTimeout(timer);
          if (settlementTimer) clearTimeout(settlementTimer);
          outerSignal?.removeEventListener('abort', abortFromOuter);
          if (timedOut)
            reject(
              new Error(`${operationName} exceeded the ${timeoutMs}ms lifecycle deadline.`, { cause: error })
            );
          else reject(error);
        }
      );
    });
  }

  private withLifecycleDeadline<T>(promise: Promise<T>, operation: string): Promise<T> {
    const timeoutMs = this.lifecycleDeadlineMs();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${operation} exceeded the ${timeoutMs}ms lifecycle deadline.`)),
        timeoutMs
      );
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  private lifecycleDeadlineMs(): number {
    return this.options.lifecycleDeadlineMs ?? DEFAULT_LIFECYCLE_DEADLINE_MS;
  }

  private lifecyclePollIntervalMs(): number {
    return this.options.lifecyclePollIntervalMs ?? DEFAULT_LIFECYCLE_POLL_INTERVAL_MS;
  }

  private lifecycleAttempts(): number {
    return Math.max(1, Math.ceil(this.lifecycleDeadlineMs() / this.lifecyclePollIntervalMs()));
  }

  private persist(): void {
    this.deps.store.write(this.requireState());
  }

  private timestamp(): string {
    return this.deps.now().toISOString();
  }

  private requireState(): CodexControllerState {
    if (!this.state) throw new Error('Codex controller is not initialized.');
    return this.state;
  }

  private requireAppServer(): CodexAppServerSession {
    if (!this.appServer) throw new Error('Codex app-server is not initialized.');
    return this.appServer;
  }
}
