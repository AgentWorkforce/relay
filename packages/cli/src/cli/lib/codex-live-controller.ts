import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  LiveTeleportCloudClient,
  LiveTeleportEnvironment,
  LiveTeleportWorkspaceSource,
} from '@agent-relay/cloud';

import type { CodexAppServerSession, CodexTurnResult } from './codex-app-server.js';

export type CodexControllerPhase =
  | 'local'
  | 'teleport_pending'
  | 'remote'
  | 'rolling_back'
  | 'failed'
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
  source: LiveTeleportWorkspaceSource;
  generation: number;
  phase: CodexControllerPhase;
  controllerPid: number;
  socketPath: string;
  turnActive: boolean;
  pending?: CodexTeleportRequest;
  lastRequestId?: string;
  prewarmId?: string;
  prewarmStatus?: 'warming' | 'ready' | 'failed';
  remote?: Omit<LiveTeleportEnvironment, 'execServerUrl'> & {
    /** Stored privately for controller recovery; never returned from public status. */
    execServerUrl: string;
    attached: boolean;
  };
  lastError?: string;
  updatedAt: string;
};

export type PublicCodexControllerStatus = Omit<CodexControllerState, 'source' | 'remote'> & {
  execution: 'local' | 'cloud';
  controller: 'local';
  remote?: Pick<LiveTeleportEnvironment, 'environmentId' | 'generation' | 'workspaceCwd' | 'expiresAt'> & {
    attached: boolean;
  };
  workspaceSource: LiveTeleportWorkspaceSource['kind'];
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

export type CodexLiveControllerDependencies = {
  cloud: LiveTeleportCloudClient;
  store: CodexControllerStateStore;
  createAppServer: () => Promise<CodexAppServerSession>;
  probeCapability: () => Promise<void>;
  now: () => Date;
  sessionId: () => string;
  pid: number;
};

export type CodexLiveControllerOptions = {
  workspaceRoot: string;
  source: LiveTeleportWorkspaceSource;
  socketPath: string;
  model?: string;
};

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
  const { source, remote, ...rest } = state;
  return {
    ...rest,
    controller: 'local',
    execution: remote && state.phase === 'remote' ? 'cloud' : 'local',
    workspaceSource: source.kind,
    ...(remote
      ? {
          remote: {
            environmentId: remote.environmentId,
            generation: remote.generation,
            workspaceCwd: remote.workspaceCwd,
            expiresAt: remote.expiresAt,
            attached: remote.attached,
          },
        }
      : {}),
  };
}

/**
 * Owns one local Codex app-server/thread. There is exactly one mutation seam:
 * a queued teleport is consumed immediately before a turn/start request.
 */
export class CodexLiveController {
  private appServer: CodexAppServerSession | null = null;
  private state: CodexControllerState | null = null;

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
    this.appServer = await this.deps.createAppServer();
    await this.appServer.initialize();

    if (persisted) {
      this.state = {
        ...persisted,
        controllerPid: this.deps.pid,
        socketPath: this.options.socketPath,
        workspaceRoot: this.options.workspaceRoot,
        source: this.options.source,
        turnActive: false,
        phase: 'rolling_back',
        pending: undefined,
        lastError: undefined,
        updatedAt: this.timestamp(),
      };
      this.persist();

      if (persisted.remote) {
        await this.deps.cloud
          .revoke({
            sessionId: persisted.sessionId,
            generation: persisted.generation,
            idempotencyKey: `${persisted.sessionId}:${persisted.generation}:restart-revoke`,
          })
          .catch(() => undefined);
      }

      try {
        await this.appServer.resumeThread({
          threadId: persisted.threadId,
          cwd: this.options.workspaceRoot,
        });
      } catch (error) {
        this.state.phase = 'recovery_failed';
        this.state.lastError = `Could not resume Codex thread ${persisted.threadId}: ${errorMessage(error)}`;
        this.state.remote = undefined;
        this.state.updatedAt = this.timestamp();
        this.persist();
        throw new Error(this.state.lastError, { cause: error });
      }

      this.state.generation = persisted.generation + 1;
      this.state.phase = 'local';
      this.state.remote = undefined;
      this.state.updatedAt = this.timestamp();
      this.persist();
    } else {
      const threadId = await this.appServer.startThread({
        cwd: this.options.workspaceRoot,
        ...(this.options.model ? { model: this.options.model } : {}),
      });
      this.state = {
        version: 1,
        sessionId: this.deps.sessionId(),
        threadId,
        workspaceRoot: this.options.workspaceRoot,
        source: this.options.source,
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
    if (state.phase !== 'local')
      throw new Error(`Cannot queue a teleport while the controller is ${state.phase}.`);

    state.pending = request;
    state.phase = 'teleport_pending';
    state.lastRequestId = request.requestId;
    state.updatedAt = this.timestamp();
    this.persist();
    return this.status();
  }

  async runTurn(text: string): Promise<CodexTurnResult> {
    const state = this.requireState();
    const appServer = this.requireAppServer();
    if (state.turnActive) throw new Error('A Codex turn is already active.');
    if (state.phase === 'recovery_failed' || state.phase === 'failed' || state.phase === 'rolling_back') {
      throw new Error(`Cannot start a turn while the controller is ${state.phase}.`);
    }

    // This is the concrete turn boundary: snapshot the pending request before
    // marking the turn active. A request arriving after this snapshot is
    // persisted for the following invocation, never spliced into this turn.
    const pendingAtBoundary = state.pending;
    state.turnActive = true;
    state.updatedAt = this.timestamp();
    this.persist();
    try {
      if (pendingAtBoundary) await this.applyPendingTeleport(pendingAtBoundary);
      const remote = state.phase === 'remote' ? state.remote : undefined;
      const result = await appServer.runTurn({
        threadId: state.threadId,
        text,
        ...(remote && !remote.attached
          ? { environment: { environmentId: remote.environmentId, cwd: remote.workspaceCwd } }
          : {}),
      });
      if (remote && !remote.attached) remote.attached = true;
      return result;
    } finally {
      state.turnActive = false;
      state.updatedAt = this.timestamp();
      this.persist();
    }
  }

  async rollback(): Promise<PublicCodexControllerStatus> {
    const state = this.requireState();
    if (state.turnActive) throw new Error('Rollback is only allowed at a Codex turn boundary.');
    const old = this.requireAppServer();
    state.phase = 'rolling_back';
    state.pending = undefined;
    state.updatedAt = this.timestamp();
    this.persist();

    if (state.remote) {
      await this.deps.cloud.revoke({
        sessionId: state.sessionId,
        generation: state.generation,
        idempotencyKey: `${state.sessionId}:${state.generation}:rollback-revoke`,
      });
    }

    await old.close();
    const replacement = await this.deps.createAppServer();
    this.appServer = replacement;
    await replacement.initialize();
    try {
      await replacement.resumeThread({ threadId: state.threadId, cwd: state.workspaceRoot });
    } catch (error) {
      state.phase = 'recovery_failed';
      state.remote = undefined;
      state.lastError = `Could not resume Codex thread ${state.threadId}: ${errorMessage(error)}`;
      state.updatedAt = this.timestamp();
      this.persist();
      throw new Error(state.lastError, { cause: error });
    }

    state.generation += 1;
    state.phase = 'local';
    state.remote = undefined;
    state.lastError = undefined;
    state.updatedAt = this.timestamp();
    this.persist();
    await this.startPrewarm();
    return this.status();
  }

  async close(): Promise<void> {
    const state = this.state;
    if (state) {
      await this.deps.cloud
        .revoke({
          sessionId: state.sessionId,
          generation: state.generation,
          idempotencyKey: `${state.sessionId}:${state.generation}:shutdown-revoke`,
        })
        .catch((error) => {
          state.lastError = `Cloud shutdown revoke failed; the generation must expire server-side: ${errorMessage(
            error
          )}`;
          state.updatedAt = this.timestamp();
          this.persist();
        });
    }
    await this.appServer?.close();
    this.appServer = null;
  }

  private async applyPendingTeleport(pendingAtBoundary: CodexTeleportRequest): Promise<void> {
    const state = this.requireState();
    const pending = state.pending;
    if (!pending || pending.requestId !== pendingAtBoundary.requestId) return;
    if (pending.expectedGeneration !== state.generation) {
      throw new Error('Pending teleport generation became stale before the turn boundary.');
    }

    try {
      const environment = await this.deps.cloud.acquire({
        sessionId: state.sessionId,
        threadId: state.threadId,
        generation: state.generation,
        workspaceRoot: state.workspaceRoot,
        source: state.source,
        ...(state.prewarmId ? { prewarmId: state.prewarmId } : {}),
        idempotencyKey: `${state.sessionId}:${state.generation}:acquire`,
      });
      if (environment.sessionId !== state.sessionId || environment.generation !== state.generation) {
        throw new Error('Cloud returned a stale or cross-session live-teleport generation.');
      }

      await this.requireAppServer().addEnvironment({
        environmentId: environment.environmentId,
        execServerUrl: environment.execServerUrl,
        connectTimeoutMs: 10_000,
      });
      const environmentStatus = await this.requireAppServer().environmentStatus(environment.environmentId);
      if (!isReadyStatus(environmentStatus)) {
        throw new Error('Codex did not report the Cloud execution environment ready.');
      }

      state.remote = { ...environment, attached: false };
      state.pending = undefined;
      state.phase = 'remote';
      state.lastError = undefined;
      state.updatedAt = this.timestamp();
      this.persist();
    } catch (error) {
      await this.deps.cloud
        .revoke({
          sessionId: state.sessionId,
          generation: state.generation,
          idempotencyKey: `${state.sessionId}:${state.generation}:failed-acquire-revoke`,
        })
        .catch(() => undefined);
      state.pending = undefined;
      state.phase = 'local';
      state.remote = undefined;
      state.lastError = `Teleport failed before turn/start; execution remains local: ${errorMessage(error)}`;
      state.updatedAt = this.timestamp();
      this.persist();
      throw new Error(state.lastError, { cause: error });
    }
  }

  private async startPrewarm(): Promise<void> {
    const state = this.requireState();
    try {
      const prewarm = await this.deps.cloud.prewarm({
        sessionId: state.sessionId,
        generation: state.generation,
        workspaceRoot: state.workspaceRoot,
        source: state.source,
        idempotencyKey: `${state.sessionId}:${state.generation}:prewarm`,
      });
      if (prewarm.generation !== state.generation) {
        throw new Error('Cloud returned a stale prewarm generation.');
      }
      state.prewarmId = prewarm.prewarmId;
      state.prewarmStatus = prewarm.status;
    } catch (error) {
      state.prewarmId = undefined;
      state.prewarmStatus = 'failed';
      state.lastError = `Cloud prewarm unavailable; local Codex remains usable: ${errorMessage(error)}`;
    }
    state.updatedAt = this.timestamp();
    this.persist();
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
