import { createHash, randomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';
import type {
  HarnessV1,
  HarnessV1Bootstrap,
  HarnessV1ContinueTurnState,
  HarnessV1Diagnostic,
  HarnessV1NetworkSandboxSession,
  HarnessV1Observability,
  HarnessV1PermissionMode,
  HarnessV1PromptControl,
  HarnessV1ResumeSessionState,
  HarnessV1SandboxProvider,
  HarnessV1Session,
  HarnessV1Skill,
  HarnessV1StreamPart,
} from '@ai-sdk/harness';
import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils';

export type HarnessHostState =
  | 'new'
  | 'starting'
  | 'ready'
  | 'running'
  | 'suspended'
  | 'detached'
  | 'stopped'
  | 'destroyed'
  | 'failed';

export interface HarnessEventObservability {
  source: 'ai-sdk';
  fidelity: 'exact';
  sequence: number;
  timestamp: string;
  turnId?: string;
}

export interface NormalizedHarnessEvent {
  type: string;
  observability: HarnessEventObservability;
  [key: string]: unknown;
}

type NormalizedHarnessEventInput = { type: string; [key: string]: unknown };

export interface HarnessHostOptions {
  harness: HarnessV1;
  sandboxProvider: HarnessV1SandboxProvider;
  workspace: string;
  sessionId?: string;
  permissionMode?: HarnessV1PermissionMode;
  skills?: readonly HarnessV1Skill[];
  instructions?: string;
  observability?: HarnessV1Observability;
  abortSignal?: AbortSignal;
  resumeFrom?: HarnessV1ResumeSessionState;
  continueFrom?: HarnessV1ContinueTurnState;
  onEvent?: (event: NormalizedHarnessEvent) => void | Promise<void>;
  onDiagnostic?: (diagnostic: HarnessV1Diagnostic) => void | Promise<void>;
  /** Bounded retries with a fresh local port when an adapter bridge loses a bind race. */
  portBindRetries?: number;
}

export interface HarnessTurnHandle {
  turnId: string;
  done: Promise<void>;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function workDirectorySegment(value: string): string {
  if (/^[a-zA-Z0-9._-]+$/.test(value)) return value;
  const readable = value.replaceAll(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48);
  const suffix = createHash('sha256').update(value).digest('hex').slice(0, 12);
  return `${readable || 'session'}-${suffix}`;
}

function stableBootstrapIdentity(recipe: HarnessV1Bootstrap): string {
  return `${recipe.harnessId}:${createHash('sha256').update(JSON.stringify(recipe)).digest('hex')}`;
}

async function applyBootstrap(
  recipe: HarnessV1Bootstrap,
  session: SandboxSession,
  abortSignal?: AbortSignal
): Promise<void> {
  for (const file of recipe.files) {
    await session.writeTextFile({ path: file.path, content: file.content, abortSignal });
  }
  for (const command of recipe.commands) {
    const result = await session.run({
      command: command.command,
      workingDirectory: command.workingDirectory,
      abortSignal,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Bootstrap command failed with exit code ${result.exitCode}: ${command.command}\n${result.stderr}`
      );
    }
  }
}

function parseToolInput(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPortBindCollision(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const message = errorMessage(current);
    if (/EADDRINUSE|address already in use/i.test(message)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

function streamEvents(part: HarnessV1StreamPart): NormalizedHarnessEventInput[] {
  switch (part.type) {
    case 'stream-start':
      return [
        ...(part.modelId ? [{ type: 'model.resolved', modelId: part.modelId }] : []),
        ...(part.warnings ?? []).map((warning) => ({ type: 'warning', warning })),
      ];
    case 'text-start':
      return [{ type: 'text.started', blockId: part.id, metadata: part.harnessMetadata }];
    case 'text-delta':
      return [{ type: 'text.delta', blockId: part.id, delta: part.delta, metadata: part.harnessMetadata }];
    case 'text-end':
      return [{ type: 'text.finished', blockId: part.id, metadata: part.harnessMetadata }];
    case 'reasoning-start':
      return [{ type: 'reasoning.started', blockId: part.id, metadata: part.harnessMetadata }];
    case 'reasoning-delta':
      return [
        {
          type: 'reasoning.delta',
          blockId: part.id,
          delta: part.delta,
          metadata: part.harnessMetadata,
        },
      ];
    case 'reasoning-end':
      return [{ type: 'reasoning.finished', blockId: part.id, metadata: part.harnessMetadata }];
    case 'tool-call':
      return [
        {
          type: 'tool.called',
          callId: part.toolCallId,
          tool: part.toolName,
          input: parseToolInput(part.input),
          providerExecuted: part.providerExecuted,
          nativeName: part.nativeName,
        },
      ];
    case 'tool-approval-request':
      return [
        {
          type: 'tool.approval.requested',
          approvalId: part.approvalId,
          callId: part.toolCallId,
          metadata: part.providerMetadata,
        },
      ];
    case 'tool-result':
      return [
        part.isError
          ? {
              type: 'tool.failed',
              callId: part.toolCallId,
              tool: part.toolName,
              error: typeof part.result === 'string' ? part.result : JSON.stringify(part.result),
            }
          : {
              type: 'tool.completed',
              callId: part.toolCallId,
              tool: part.toolName,
              output: part.result,
            },
      ];
    case 'finish-step':
      return [
        {
          type: 'step.finished',
          finishReason: part.finishReason,
          usage: part.usage,
          metadata: part.harnessMetadata,
        },
      ];
    case 'finish':
      return [
        {
          type: 'turn.finished',
          finishReason: part.finishReason,
          usage: part.totalUsage,
          metadata: part.harnessMetadata,
        },
        { type: 'usage.updated', usage: part.totalUsage },
      ];
    case 'file-change':
      return [
        {
          type: 'file.changed',
          path: part.path,
          operation: part.event,
          metadata: part.harnessMetadata,
        },
      ];
    case 'compaction':
      return [
        {
          type: 'context.compacted',
          trigger: part.trigger,
          summary: part.summary,
          tokensBefore: part.tokensBefore,
          tokensAfter: part.tokensAfter,
          metadata: part.harnessMetadata,
        },
      ];
    case 'error':
      return [{ type: 'error', error: errorMessage(part.error) }];
    case 'raw':
      return [{ type: 'raw', rawValue: part.rawValue }];
  }
}

export class HarnessHost {
  readonly harness: HarnessV1;
  readonly sandboxProvider: HarnessV1SandboxProvider;
  readonly workspace: string;
  readonly sessionId: string;
  readonly #permissionMode?: HarnessV1PermissionMode;
  readonly #skills?: readonly HarnessV1Skill[];
  readonly #instructions?: string;
  readonly #observability?: HarnessV1Observability;
  readonly #abortSignal?: AbortSignal;
  readonly #initialResume?: HarnessV1ResumeSessionState;
  readonly #initialContinue?: HarnessV1ContinueTurnState;
  readonly #portBindRetries: number;
  readonly #listeners = new Set<(event: NormalizedHarnessEvent) => void | Promise<void>>();
  #state: HarnessHostState = 'new';
  #sandbox?: HarnessV1NetworkSandboxSession;
  #session?: HarnessV1Session;
  #control?: HarnessV1PromptControl;
  #turnId?: string;
  #turnGeneration = 0;
  #turnAbort?: AbortController;
  #sequence = 0;
  #operation = Promise.resolve();

  constructor(options: HarnessHostOptions) {
    this.harness = options.harness;
    this.sandboxProvider = options.sandboxProvider;
    this.workspace = resolve(options.workspace);
    this.sessionId = options.sessionId ?? randomUUID();
    this.#permissionMode = options.permissionMode;
    this.#skills = options.skills;
    this.#instructions = options.instructions;
    this.#abortSignal = options.abortSignal;
    this.#initialResume = options.resumeFrom;
    this.#initialContinue = options.continueFrom;
    this.#portBindRetries = Math.max(0, options.portBindRetries ?? 2);
    this.#observability = {
      ...options.observability,
      report: (diagnostic) => {
        options.observability?.report?.(diagnostic);
        void options.onDiagnostic?.(diagnostic);
        void this.#emit({ type: 'diagnostic', diagnostic });
      },
    };
    if (options.onEvent) this.#listeners.add(options.onEvent);
  }

  get state(): HarnessHostState {
    return this.#state;
  }

  get activeTurnId(): string | undefined {
    return this.#turnId;
  }

  get hasActiveTurn(): boolean {
    return this.#control !== undefined;
  }

  onEvent(listener: (event: NormalizedHarnessEvent) => void | Promise<void>): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async #emit(event: NormalizedHarnessEventInput, turnId = this.#turnId) {
    const normalized: NormalizedHarnessEvent = {
      ...event,
      observability: {
        source: 'ai-sdk',
        fidelity: 'exact',
        sequence: ++this.#sequence,
        timestamp: new Date().toISOString(),
        ...(turnId ? { turnId } : {}),
      },
    };
    await Promise.allSettled([...this.#listeners].map((listener) => listener(normalized)));
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async #sandboxForStart(resuming: boolean, bootstrap?: HarnessV1Bootstrap) {
    if (resuming && this.sandboxProvider.resumeSession) {
      try {
        return await this.sandboxProvider.resumeSession({
          sessionId: this.sessionId,
          abortSignal: this.#abortSignal,
        });
      } catch {
        // A stopped local runtime needs a fresh process wrapper with the same stable id.
      }
    }
    return this.sandboxProvider.createSession({
      sessionId: this.sessionId,
      abortSignal: this.#abortSignal,
      identity: bootstrap ? stableBootstrapIdentity(bootstrap) : undefined,
      onFirstCreate: bootstrap
        ? (session, options) => applyBootstrap(bootstrap, session, options.abortSignal)
        : undefined,
    });
  }

  async start(): Promise<void> {
    return this.#serialized(async () => {
      if (this.#state !== 'new') throw new Error(`Cannot start harness host from ${this.#state}`);
      this.#state = 'starting';
      await this.#emit({ type: 'session.starting' });
      try {
        const bootstrap = await this.harness.getBootstrap?.({ abortSignal: this.#abortSignal });
        const resuming = Boolean(this.#initialResume || this.#initialContinue);
        const sessionWorkDir = resolve(
          this.workspace,
          `${workDirectorySegment(basename(this.harness.harnessId))}-${workDirectorySegment(this.sessionId)}`
        );
        for (let attempt = 0; ; attempt += 1) {
          this.#sandbox = await this.#sandboxForStart(resuming, bootstrap);
          await this.#sandbox.run({
            command: `mkdir -p ${quote(sessionWorkDir)}`,
            workingDirectory: this.workspace,
            abortSignal: this.#abortSignal,
          });
          try {
            this.#session = await this.harness.doStart({
              sessionId: this.sessionId,
              skills: this.#skills,
              resumeFrom: this.#initialResume,
              continueFrom: this.#initialContinue,
              permissionMode: this.#permissionMode,
              abortSignal: this.#abortSignal,
              observability: this.#observability,
              sandboxSession: this.#sandbox,
              sessionWorkDir,
            });
            break;
          } catch (error) {
            const canRetry = !resuming && attempt < this.#portBindRetries && isPortBindCollision(error);
            if (!canRetry) throw error;
            await this.#sandbox.destroy?.();
            this.#sandbox = undefined;
          }
        }
        this.#state = 'ready';
        await this.#emit({
          type: resuming ? 'session.resumed' : 'session.started',
          sessionId: this.sessionId,
          modelId: this.#session.modelId,
        });
      } catch (error) {
        this.#state = 'failed';
        await this.#sandbox?.destroy?.();
        await this.#emit({ type: 'session.failed', error: errorMessage(error) });
        throw error;
      }
    });
  }

  async startTurn(prompt: string, turnId: string = randomUUID()): Promise<HarnessTurnHandle> {
    return this.#serialized(async () => {
      if (this.#state !== 'ready') throw new Error(`Cannot start prompt turn from ${this.#state}`);
      if (!this.#session) throw new Error('Harness session has not started');
      const generation = ++this.#turnGeneration;
      this.#turnAbort = new AbortController();
      const turnSignal = this.#abortSignal
        ? AbortSignal.any([this.#abortSignal, this.#turnAbort.signal])
        : this.#turnAbort.signal;
      this.#turnId = turnId;
      this.#state = 'running';
      await this.#emit({ type: 'turn.started', turnId }, turnId);
      let control: HarnessV1PromptControl;
      try {
        control = await this.#session.doPromptTurn({
          prompt,
          instructions: this.#instructions,
          abortSignal: turnSignal,
          emit: (part) => {
            for (const event of streamEvents(part)) void this.#emit({ ...event, turnId }, turnId);
          },
        });
      } catch (error) {
        this.#state = 'ready';
        this.#turnId = undefined;
        await this.#emit({ type: 'error', error: errorMessage(error), turnId }, turnId);
        throw error;
      }
      this.#control = control;
      const done = Promise.resolve(control.done).then(
        async () => {
          if (generation !== this.#turnGeneration) return;
          this.#control = undefined;
          this.#turnAbort = undefined;
          this.#turnId = undefined;
          if (this.#state === 'running') this.#state = 'ready';
          await this.#emit({ type: 'turn.settled', turnId }, turnId);
        },
        async (error) => {
          if (generation === this.#turnGeneration) {
            this.#control = undefined;
            this.#turnAbort = undefined;
            this.#turnId = undefined;
            this.#state = 'ready';
            await this.#emit({ type: 'error', error: errorMessage(error), turnId }, turnId);
          }
          throw error;
        }
      );
      void done.catch(() => undefined);
      return { turnId, done };
    });
  }

  async submitUserMessage(text: string): Promise<void> {
    return this.#serialized(async () => {
      if (!this.#control) throw new Error('There is no active prompt turn');
      if (!this.#control.submitUserMessage) {
        throw new Error(`Harness ${this.harness.harnessId} does not support active user messages`);
      }
      await this.#control.submitUserMessage(text);
    });
  }

  async submitToolResult(input: { toolCallId: string; output: unknown; isError?: boolean }) {
    return this.#serialized(async () => {
      if (!this.#control) throw new Error('There is no active prompt turn');
      await this.#control.submitToolResult(input);
    });
  }

  async submitToolApproval(input: { approvalId: string; approved: boolean; reason?: string }) {
    return this.#serialized(async () => {
      if (!this.#control) throw new Error('There is no active prompt turn');
      if (!this.#control.submitToolApproval) {
        throw new Error(`Harness ${this.harness.harnessId} does not support tool approvals`);
      }
      await this.#control.submitToolApproval(input);
      await this.#emit({ type: 'tool.approval.resolved', ...input });
    });
  }

  async interrupt(reason = 'Interrupted by Relay'): Promise<void> {
    return this.#serialized(async () => {
      if (!this.#control || !this.#turnAbort) throw new Error('There is no active prompt turn');
      this.#turnAbort.abort(new Error(reason));
    });
  }

  async compact(customInstructions?: string): Promise<void> {
    return this.#serialized(async () => {
      if (!this.#session || this.#state !== 'ready') throw new Error(`Cannot compact from ${this.#state}`);
      await this.#session.doCompact(customInstructions);
    });
  }

  async suspend(): Promise<HarnessV1ContinueTurnState> {
    return this.#serialized(async () => {
      if (!this.#session || !this.#control || this.#state !== 'running') {
        throw new Error(`Cannot suspend turn from ${this.#state}`);
      }
      const state = await this.#session.doSuspendTurn();
      ++this.#turnGeneration;
      this.#control = undefined;
      this.#turnAbort = undefined;
      this.#turnId = undefined;
      this.#state = 'suspended';
      await this.#emit({ type: 'session.suspended' });
      return state;
    });
  }

  async continue(
    state: HarnessV1ContinueTurnState,
    turnId: string = randomUUID()
  ): Promise<HarnessTurnHandle> {
    return this.#serialized(async () => {
      if (this.#state !== 'suspended') throw new Error(`Cannot continue turn from ${this.#state}`);
      if (!this.#sandbox) throw new Error('Harness sandbox is unavailable');
      this.#session = await this.harness.doStart({
        sessionId: this.sessionId,
        continueFrom: state,
        permissionMode: this.#permissionMode,
        skills: this.#skills,
        observability: this.#observability,
        sandboxSession: this.#sandbox,
        sessionWorkDir: resolve(
          this.workspace,
          `${workDirectorySegment(basename(this.harness.harnessId))}-${workDirectorySegment(this.sessionId)}`
        ),
      });
      const generation = ++this.#turnGeneration;
      this.#turnAbort = new AbortController();
      this.#turnId = turnId;
      this.#state = 'running';
      await this.#emit({ type: 'session.resumed' }, turnId);
      const control = await this.#session.doContinueTurn({
        abortSignal: this.#turnAbort.signal,
        emit: (part) => {
          for (const event of streamEvents(part)) void this.#emit({ ...event, turnId }, turnId);
        },
      });
      this.#control = control;
      const done = Promise.resolve(control.done).then(
        async () => {
          if (generation !== this.#turnGeneration) return;
          this.#control = undefined;
          this.#turnAbort = undefined;
          this.#turnId = undefined;
          this.#state = 'ready';
          await this.#emit({ type: 'turn.settled', turnId }, turnId);
        },
        async (error) => {
          if (generation === this.#turnGeneration) {
            this.#control = undefined;
            this.#turnAbort = undefined;
            this.#turnId = undefined;
            this.#state = 'ready';
            await this.#emit({ type: 'error', error: errorMessage(error), turnId }, turnId);
          }
          throw error;
        }
      );
      void done.catch(() => undefined);
      return { turnId, done };
    });
  }

  async detach(): Promise<HarnessV1ResumeSessionState> {
    return this.#serialized(async () => {
      if (!this.#session || this.#state !== 'ready') throw new Error(`Cannot detach from ${this.#state}`);
      const state = await this.#session.doDetach();
      this.#session = undefined;
      this.#state = 'detached';
      await this.#emit({ type: 'session.detached' });
      return state;
    });
  }

  async stop(): Promise<HarnessV1ResumeSessionState> {
    return this.#serialized(async () => {
      if (!this.#session || this.#state !== 'ready') throw new Error(`Cannot stop from ${this.#state}`);
      const state = await this.#session.doStop();
      this.#session = undefined;
      await this.#sandbox?.stop();
      this.#sandbox = undefined;
      this.#state = 'stopped';
      await this.#emit({ type: 'session.stopped' });
      return state;
    });
  }

  async destroy(): Promise<void> {
    return this.#serialized(async () => {
      if (this.#state === 'destroyed') return;
      ++this.#turnGeneration;
      this.#turnAbort?.abort(new Error('Harness session destroyed'));
      try {
        await this.#session?.doDestroy();
      } finally {
        await (this.#sandbox?.destroy?.() ?? this.#sandbox?.stop());
        this.#session = undefined;
        this.#sandbox = undefined;
        this.#control = undefined;
        this.#turnAbort = undefined;
        this.#turnId = undefined;
        this.#state = 'destroyed';
        await this.#emit({ type: 'session.destroyed' });
      }
    });
  }
}

export { applyBootstrap, streamEvents as normalizeHarnessStreamPart };
