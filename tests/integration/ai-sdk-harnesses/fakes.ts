import type {
  HarnessV1,
  HarnessV1ContinueTurnState,
  HarnessV1NetworkSandboxSession,
  HarnessV1PromptControl,
  HarnessV1ResumeSessionState,
  HarnessV1SandboxProvider,
  HarnessV1Session,
  HarnessV1StartOptions,
  HarnessV1StreamPart,
} from '@ai-sdk/harness';
import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils';
import type { MessageContext, RelayMessage } from '@agent-relay/sdk';

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(error: unknown): void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export async function settleEvents(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

const USAGE = {
  inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 2, reasoning: 1 },
};

export function referenceStream(): HarnessV1StreamPart[] {
  return [
    { type: 'stream-start', modelId: 'fake-model', warnings: [{ type: 'other', message: 'fake warning' }] },
    { type: 'reasoning-start', id: 'reasoning-1' },
    { type: 'reasoning-delta', id: 'reasoning-1', delta: 'considering' },
    { type: 'reasoning-end', id: 'reasoning-1' },
    { type: 'text-start', id: 'text-1' },
    { type: 'text-delta', id: 'text-1', delta: 'working' },
    { type: 'tool-call', toolCallId: 'tool-1', toolName: 'read', input: '{"path":"a.ts"}' },
    { type: 'tool-call', toolCallId: 'tool-2', toolName: 'read', input: '{"path":"b.ts"}' },
    { type: 'tool-approval-request', approvalId: 'approval-1', toolCallId: 'tool-2' },
    { type: 'tool-result', toolCallId: 'tool-1', toolName: 'read', result: 'a' },
    { type: 'tool-result', toolCallId: 'tool-2', toolName: 'read', result: 'b' },
    { type: 'text-end', id: 'text-1' },
    { type: 'file-change', event: 'modify', path: 'a.ts' },
    { type: 'compaction', trigger: 'auto', summary: 'summary', tokensBefore: 10, tokensAfter: 5 },
    { type: 'finish-step', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage: USAGE },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, totalUsage: USAGE },
  ];
}

export class FakeSandboxProvider implements HarnessV1SandboxProvider {
  readonly specificationVersion = 'harness-sandbox-v1' as const;
  readonly providerId = 'fake-sandbox';
  readonly bridgePorts = [43111];
  createCount = 0;
  resumeCount = 0;
  bootstrapCount = 0;
  stopCount = 0;
  destroyCount = 0;
  readonly live = new Map<string, HarnessV1NetworkSandboxSession>();
  readonly #bootstrapped = new Set<string>();

  async createSession(options: Parameters<HarnessV1SandboxProvider['createSession']>[0] = {}) {
    this.createCount += 1;
    const id = options?.sessionId ?? `sandbox-${this.createCount}`;
    const provider = this;
    let stopped = false;
    const base = {
      description: `fake sandbox ${id}`,
      async readFile() {
        return null;
      },
      async readBinaryFile() {
        return null;
      },
      async readTextFile() {
        return null;
      },
      async writeFile() {},
      async writeBinaryFile() {},
      async writeTextFile() {},
      async spawn() {
        throw new Error('Fake sandbox spawn was not expected');
      },
      async run() {
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    } satisfies Partial<SandboxSession>;
    const session = {
      ...base,
      id,
      defaultWorkingDirectory: '/tmp/relay-ai-sdk-contract',
      ports: [43111],
      async getPortUrl({ port, protocol = 'https' }: { port: number; protocol?: 'http' | 'https' | 'ws' }) {
        return `${protocol}://127.0.0.1:${port}`;
      },
      restricted: () => base as SandboxSession,
      async stop() {
        if (stopped) return;
        stopped = true;
        provider.stopCount += 1;
        provider.live.delete(id);
      },
      async destroy() {
        if (!stopped) provider.stopCount += 1;
        stopped = true;
        provider.destroyCount += 1;
        provider.live.delete(id);
      },
    } as HarnessV1NetworkSandboxSession;
    this.live.set(id, session);
    if (options?.identity && options.onFirstCreate && !this.#bootstrapped.has(options.identity)) {
      this.#bootstrapped.add(options.identity);
      this.bootstrapCount += 1;
      await options.onFirstCreate(base as SandboxSession, { abortSignal: options.abortSignal });
    }
    return session;
  }

  async resumeSession(options: { sessionId: string }) {
    this.resumeCount += 1;
    const session = this.live.get(options.sessionId);
    if (!session) throw new Error(`Fake sandbox ${options.sessionId} is unavailable`);
    return session;
  }
}

export interface FakeHarnessOptions {
  harnessId?: string;
  autoComplete?: boolean;
  activeInput?: boolean;
  toolApprovals?: boolean;
  compact?: boolean;
  failStart?: Error;
  stream?: () => HarnessV1StreamPart[];
}

export class FakeHarnessController {
  readonly prompts: string[] = [];
  readonly activeMessages: string[] = [];
  readonly approvals: Array<{ approvalId: string; approved: boolean; reason?: string }> = [];
  readonly toolResults: Array<{ toolCallId: string; output: unknown; isError?: boolean }> = [];
  readonly starts: HarnessV1StartOptions[] = [];
  readonly controls: Deferred<void>[] = [];
  compactCount = 0;
  suspendCount = 0;
  detachCount = 0;
  stopCount = 0;
  destroyCount = 0;
  continueCount = 0;
  readonly options: Required<
    Pick<FakeHarnessOptions, 'autoComplete' | 'activeInput' | 'toolApprovals' | 'compact'>
  > &
    FakeHarnessOptions;
  readonly harness: HarnessV1;

  constructor(options: FakeHarnessOptions = {}) {
    this.options = {
      autoComplete: options.autoComplete ?? true,
      activeInput: options.activeInput ?? true,
      toolApprovals: options.toolApprovals ?? true,
      compact: options.compact ?? true,
      ...options,
    };
    const controller = this;
    this.harness = {
      specificationVersion: 'harness-v1',
      harnessId: options.harnessId ?? 'fake',
      builtinTools: {},
      supportsBuiltinToolApprovals: this.options.toolApprovals,
      async getBootstrap() {
        return {
          harnessId: controller.harness.harnessId,
          bootstrapDir: '/tmp/relay-ai-sdk-contract',
          files: [{ path: '/tmp/relay-ai-sdk-contract/bootstrap.txt', content: 'ready' }],
          commands: [{ command: 'true' }],
        };
      },
      async doStart(startOptions) {
        controller.starts.push(startOptions);
        if (controller.options.failStart) throw controller.options.failStart;
        return controller.#session(startOptions);
      },
    };
  }

  complete(index = this.controls.length - 1): void {
    this.controls[index]?.resolve();
  }

  fail(error: Error, index = this.controls.length - 1): void {
    this.controls[index]?.reject(error);
  }

  #state(type: 'resume-session' | 'continue-turn'): HarnessV1ResumeSessionState | HarnessV1ContinueTurnState {
    return {
      type,
      harnessId: this.harness.harnessId,
      specificationVersion: 'harness-v1',
      data: { cursor: this.prompts.length },
    };
  }

  #control(): HarnessV1PromptControl {
    const completion = deferred<void>();
    this.controls.push(completion);
    if (this.options.autoComplete) queueMicrotask(() => completion.resolve());
    return {
      done: completion.promise,
      submitToolResult: async (input) => {
        this.toolResults.push(input);
      },
      ...(this.options.activeInput
        ? {
            submitUserMessage: async (text: string) => {
              this.activeMessages.push(text);
            },
          }
        : {}),
      ...(this.options.toolApprovals
        ? {
            submitToolApproval: async (input: { approvalId: string; approved: boolean; reason?: string }) => {
              this.approvals.push(input);
            },
          }
        : {}),
    };
  }

  #session(startOptions: HarnessV1StartOptions): HarnessV1Session {
    return {
      sessionId: startOptions.sessionId,
      isResume: Boolean(startOptions.resumeFrom || startOptions.continueFrom),
      modelId: 'fake-model',
      doPromptTurn: async (options) => {
        this.prompts.push(String(options.prompt));
        for (const part of (this.options.stream ?? referenceStream)()) options.emit(part);
        return this.#control();
      },
      doCompact: async () => {
        if (!this.options.compact) throw new Error('Manual compaction unsupported');
        this.compactCount += 1;
      },
      doContinueTurn: async (options) => {
        this.continueCount += 1;
        for (const part of (this.options.stream ?? referenceStream)()) options.emit(part);
        return this.#control();
      },
      doSuspendTurn: async () => {
        this.suspendCount += 1;
        this.complete();
        return this.#state('continue-turn') as HarnessV1ContinueTurnState;
      },
      doDetach: async () => {
        this.detachCount += 1;
        return this.#state('resume-session') as HarnessV1ResumeSessionState;
      },
      doStop: async () => {
        this.stopCount += 1;
        return this.#state('resume-session') as HarnessV1ResumeSessionState;
      },
      doDestroy: async () => {
        this.destroyCount += 1;
      },
    };
  }
}

export const TEST_IDENTITY = {
  id: 'agent-contract',
  name: 'contract',
  handle: 'contract',
};

export function message(index: number): { message: RelayMessage; context: MessageContext } {
  return {
    message: {
      id: `message-${index}`,
      messageId: `message-${index}`,
      from: { name: 'human' },
      target: { kind: 'agent', agentName: 'contract' },
      text: `prompt-${index}`,
      createdAt: new Date(0).toISOString(),
    },
    context: {
      id: `delivery-${index}`,
      mode: 'immediate',
      reason: 'message',
      idempotencyKey: `key-${index}`,
    },
  };
}
