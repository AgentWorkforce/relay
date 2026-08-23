import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  LiveTeleportCloudClient,
  LiveTeleportEnvironment,
  LiveTeleportLifecycleStatus,
  LiveTeleportWorkspaceSource,
} from '@agent-relay/cloud';

import type { CodexAppServerSession, CodexTurnResult } from './codex-app-server.js';

export type CodexControllerPhase =
  | 'local'
  | 'teleport_pending'
  | 'acquiring'
  | 'verifying'
  | 'remote'
  | 'rolling_back'
  | 'fenced'
  | 'recovery_failed';

export type CodexTeleportRequest = {
  requestId: string;
  expectedGeneration: number;
};

export type CodexControllerState = {
  version: 1;
  sessionId: string;
  threadId: string;
  workspaceRoot: string;
  source?: LiveTeleportWorkspaceSource;
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
  remote?: LiveTeleportEnvironment & {
    /** True only after the first remote turn/completed notification. */
    attached: boolean;
  };
  lastError?: string;
  updatedAt: string;
};

export type PublicCodexControllerStatus = Omit<CodexControllerState, 'source' | 'remote' | 'mountRestore'> & {
  execution: 'local' | 'verifying' | 'cloud' | 'fenced';
  controller: 'local';
  remote?: Pick<LiveTeleportEnvironment, 'environmentId' | 'generation' | 'workspaceCwd' | 'expiresAt'> & {
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
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as CodexControllerState;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  write(state: CodexControllerState): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
    fs.chmodSync(this.filePath, 0o600);
  }
}

export type CodexWorkspaceSealInput = {
  sessionId: string;
  generation: number;
  threadId: string;
  workspaceRoot: string;
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
  resumeId: string;
  workspaceId: string;
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
    source: LiveTeleportWorkspaceSource;
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
  'fenced',
  'rolling_back',
  'acquiring',
  'verifying',
]);

export class CodexTurnRecoveredError extends Error {
  readonly recoveredLocally = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CodexTurnRecoveredError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function publicStatus(state: CodexControllerState): PublicCodexControllerStatus {
  const { source, remote, mountRestore: _mountRestore, ...rest } = state;
  const execution =
    state.phase === 'remote'
      ? 'cloud'
      : state.phase === 'verifying'
        ? 'verifying'
        : state.phase === 'fenced' || state.phase === 'recovery_failed'
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
            expiresAt: remote.expiresAt,
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

  constructor(
    private readonly options: CodexLiveControllerOptions,
    private readonly deps: CodexLiveControllerDependencies
  ) {}

  async initialize(): Promise<PublicCodexControllerStatus> {
    await this.deps.probeCapability();
    const persisted = this.deps.store.read();
    if (persisted && path.resolve(persisted.workspaceRoot) !== path.resolve(this.options.workspaceRoot)) {
      throw new Error(
        `The persisted managed Codex thread belongs to ${persisted.workspaceRoot}, not ${this.options.workspaceRoot}.`
      );
    }

    if (persisted) {
      this.state = {
        ...persisted,
        controllerPid: this.deps.pid,
        socketPath: this.options.socketPath,
        workspaceRoot: this.options.workspaceRoot,
        turnActive: false,
        phase: 'rolling_back',
        pending: undefined,
        lastError: undefined,
        updatedAt: this.timestamp(),
      };
      this.persist();

      try {
        await this.confirmFence('restart-revoke');
      } catch (error) {
        this.markFenced(`Controller restart could not confirm Cloud fencing: ${errorMessage(error)}`);
        throw new Error(this.requireState().lastError, { cause: error });
      }

      try {
        await this.resumeLocalMount();
      } catch (error) {
        this.markRecoveryFailed(
          `Cloud was fenced but the persisted Relayfile mount could not resume: ${errorMessage(error)}`
        );
        throw new Error(this.requireState().lastError, { cause: error });
      }

      const replacement = await this.createInitializedAppServer();
      this.appServer = replacement;
      try {
        await replacement.resumeThread({
          threadId: persisted.threadId,
          cwd: this.options.workspaceRoot,
        });
      } catch (error) {
        this.markRecoveryFailed(
          `Could not resume Codex thread ${persisted.threadId}: ${errorMessage(error)}`
        );
        await replacement.close().catch(() => undefined);
        this.appServer = null;
        throw new Error(this.requireState().lastError, { cause: error });
      }

      const state = this.requireState();
      state.generation = persisted.generation + 1;
      state.phase = 'local';
      state.remote = undefined;
      state.source = undefined;
      state.mountRestore = undefined;
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
        updatedAt: this.timestamp(),
      };
      this.persist();
    }

    await this.startPrewarm();
    return this.status();
  }

  status(): PublicCodexControllerStatus {
    return publicStatus(this.requireState());
  }

  requestTeleport(request: CodexTeleportRequest): PublicCodexControllerStatus {
    const state = this.requireState();
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
      return await this.executeTurn(text);
    } finally {
      state.turnActive = false;
      state.updatedAt = this.timestamp();
      this.persist();
    }
  }

  private async executeTurn(text: string): Promise<CodexTurnResult> {
    const state = this.requireState();
    const phase = state.phase as CodexControllerPhase;
    const remote = phase === 'verifying' || phase === 'remote' ? state.remote : undefined;
    try {
      const result = await this.requireAppServer().runTurn({
        threadId: state.threadId,
        text,
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
      if (this.requireState().phase !== 'verifying') throw error;
      await this.recoverLocal('first-turn-failed-revoke', `First Cloud turn failed: ${errorMessage(error)}`);
      throw new CodexTurnRecoveredError(
        `First Cloud turn failed; Cloud fencing was confirmed and thread ${state.threadId} resumed locally: ${errorMessage(error)}`,
        { cause: error }
      );
    }
  }

  async rollback(): Promise<PublicCodexControllerStatus> {
    const state = this.requireState();
    if (state.turnActive) throw new Error('Rollback is only allowed at a Codex turn boundary.');
    await this.recoverLocal('rollback-revoke', 'Operator requested local rollback.');
    return this.status();
  }

  async close(): Promise<void> {
    const state = this.state;
    let fenceConfirmed = false;
    if (state) {
      try {
        await this.confirmFence('shutdown-revoke');
        fenceConfirmed = true;
      } catch (error) {
        this.markFenced(`Cloud shutdown revoke was not confirmed: ${errorMessage(error)}`);
      }
    }
    try {
      await this.appServer?.close();
    } catch (error) {
      if (state && fenceConfirmed) {
        this.markRecoveryFailed(
          `Cloud was fenced during shutdown but the Codex app-server did not exit: ${errorMessage(error)}`
        );
      }
      throw error;
    }
    this.appServer = null;
    if (state && fenceConfirmed && (this.sealedWorkspace || state.source || state.mountRestore)) {
      try {
        await this.resumeLocalMount();
      } catch (error) {
        this.markRecoveryFailed(
          `Cloud was fenced during shutdown but the Relayfile mount did not resume: ${errorMessage(error)}`
        );
        throw new Error(state.lastError, { cause: error });
      }
      state.generation += 1;
      state.phase = 'local';
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
      if (state.prewarmId && state.prewarmStatus !== 'ready') {
        await this.waitForCloudReady(state.prewarmId);
      }

      const sealedWorkspace = await this.withAbortableLifecycleDeadline(
        (signal) =>
          this.deps.checkpointAndSeal({
            sessionId: state.sessionId,
            generation: state.generation,
            threadId: state.threadId,
            workspaceRoot: state.workspaceRoot,
            signal,
          }),
        'Relayfile checkpoint-and-seal'
      );
      const source = sealedWorkspace.source;
      this.sealedWorkspace = sealedWorkspace;
      this.assertSeal(source, sealedWorkspace.restore);
      state.source = source;
      state.mountRestore = sealedWorkspace.restore;
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

      state.remote = { ...environment, attached: false };
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
      await this.recoverLocal(
        'failed-acquire-revoke',
        `Teleport failed before the first Cloud turn completed: ${errorMessage(error)}`
      );
      throw new CodexTurnRecoveredError(
        `Teleport failed; Cloud fencing was confirmed and execution resumed locally: ${errorMessage(error)}`,
        { cause: error }
      );
    }
  }

  private async recoverLocal(reason: string, context: string): Promise<void> {
    const state = this.requireState();
    const old = this.requireAppServer();
    state.phase = 'rolling_back';
    state.pending = undefined;
    state.updatedAt = this.timestamp();
    this.persist();

    try {
      await this.confirmFence(reason);
    } catch (error) {
      this.markFenced(`${context} Cloud fencing could not be confirmed: ${errorMessage(error)}`);
      await old.close().catch((closeError) => {
        state.lastError = `${state.lastError} Old controller shutdown also failed: ${errorMessage(closeError)}`;
        state.updatedAt = this.timestamp();
        this.persist();
      });
      this.appServer = null;
      throw new Error(state.lastError, { cause: error });
    }

    try {
      await old.close();
    } catch (error) {
      this.markRecoveryFailed(
        `Cloud was fenced but the previous Codex app-server did not exit: ${errorMessage(error)}`
      );
      throw new Error(state.lastError, { cause: error });
    }
    this.appServer = null;
    try {
      await this.resumeLocalMount();
    } catch (error) {
      this.markRecoveryFailed(
        `Cloud was fenced but the sealed Relayfile mount could not resume: ${errorMessage(error)}`
      );
      throw new Error(state.lastError, { cause: error });
    }
    let replacement: CodexAppServerSession;
    try {
      replacement = await this.createInitializedAppServer();
    } catch (error) {
      this.markRecoveryFailed(
        `Cloud was fenced and the mount resumed, but a local Codex app-server could not start: ${errorMessage(error)}`
      );
      throw new Error(state.lastError, { cause: error });
    }
    this.appServer = replacement;
    try {
      await replacement.resumeThread({ threadId: state.threadId, cwd: state.workspaceRoot });
    } catch (error) {
      this.markRecoveryFailed(`Could not resume Codex thread ${state.threadId}: ${errorMessage(error)}`);
      await replacement.close().catch(() => undefined);
      this.appServer = null;
      throw new Error(state.lastError, { cause: error });
    }

    state.generation += 1;
    state.phase = 'local';
    state.remote = undefined;
    state.source = undefined;
    state.mountRestore = undefined;
    state.prewarmId = undefined;
    state.prewarmStatus = undefined;
    state.lastError = context;
    state.updatedAt = this.timestamp();
    this.persist();
    await this.startPrewarm();
  }

  private async confirmFence(reason: string): Promise<void> {
    const state = this.requireState();

    try {
      const revoked = await this.withAbortableLifecycleDeadline(
        (signal) =>
          this.deps.cloud.revoke({
            sessionId: state.sessionId,
            generation: state.generation,
            idempotencyKey: `${state.sessionId}:${state.generation}:${reason}`,
            signal,
          }),
        'Cloud revoke confirmation'
      );
      this.assertLifecycleIdentity(revoked);
      if (revoked.status === 'revoked' || revoked.status === 'expired') return;
    } catch (revokeError) {
      try {
        const status = await this.withAbortableLifecycleDeadline(
          (signal) =>
            this.deps.cloud.status({
              sessionId: state.sessionId,
              generation: state.generation,
              signal,
            }),
          'Cloud fence status confirmation'
        );
        this.assertLifecycleIdentity(status);
        if (status.status === 'revoked' || status.status === 'expired') return;
      } catch (statusError) {
        throw new Error(
          `revoke failed (${errorMessage(revokeError)}); status was unconfirmed (${errorMessage(statusError)})`,
          { cause: statusError }
        );
      }
      throw revokeError;
    }
    throw new Error('Cloud revoke returned without a terminal fence state.');
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

  private async startPrewarm(): Promise<void> {
    const state = this.requireState();
    try {
      const prewarm = await this.withAbortableLifecycleDeadline(
        (signal) =>
          this.deps.cloud.prewarm({
            sessionId: state.sessionId,
            generation: state.generation,
            workspaceRoot: '/',
            idempotencyKey: `${state.sessionId}:${state.generation}:prewarm`,
            signal,
          }),
        'Cloud prewarm'
      );
      if (prewarm.generation !== state.generation) {
        throw new Error('Cloud returned a stale prewarm generation.');
      }
      state.source = undefined;
      state.prewarmId = prewarm.prewarmId;
      state.prewarmStatus = prewarm.status;
    } catch (error) {
      state.source = undefined;
      state.prewarmId = undefined;
      state.prewarmStatus = 'failed';
      state.lastError = `Cloud prewarm unavailable; local Codex remains usable: ${errorMessage(error)}`;
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
      path.resolve(restore.localRoot) !== path.resolve(this.options.workspaceRoot)
    ) {
      throw new Error('Relayfile checkpoint-and-seal provider returned an invalid restore identity.');
    }
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
    if (!state.source || !state.mountRestore) {
      if (state.remote) {
        throw new Error('Persisted remote execution has no Relayfile seal identity to restore.');
      }
      return;
    }
    const source = state.source;
    const restore = state.mountRestore;
    await this.withAbortableLifecycleDeadline(
      (signal) =>
        this.deps.resumePersistedLocalMount({
          sessionId: state.sessionId,
          generation: state.generation,
          threadId: state.threadId,
          workspaceRoot: state.workspaceRoot,
          source,
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

  private withAbortableLifecycleDeadline<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    operationName: string
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutMs = this.lifecycleDeadlineMs();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`${operationName} exceeded the ${timeoutMs}ms lifecycle deadline.`));
      }, timeoutMs);
      let promise: Promise<T>;
      try {
        promise = operation(controller.signal);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
        return;
      }
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
