import { createDefaultRelay, withDefaults, type CoreDependencies } from '../commands/core.js';
import {
  runDownCommand,
  runStatusCommand,
  runUpCommand,
  type DownOptions,
  type StatusOptions,
  type UpOptions,
} from './broker-lifecycle.js';

export type EmbeddedNodeOutputLevel = 'info' | 'warn' | 'error';

export interface EmbeddedNodeOutput {
  level: EmbeddedNodeOutputLevel;
  message: string;
}

export interface EmbeddedNodeRuntimeOptions {
  /**
   * Environment visible to the broker and node providers. It is cloned before
   * use, so lifecycle setup never mutates the host's process.env object.
   */
  env?: NodeJS.ProcessEnv;
  /** Receive lifecycle and provider output without global console writes. */
  onOutput?: (output: EmbeddedNodeOutput) => void;
}

/**
 * Embedded startup deliberately owns the foreground lifecycle in this host.
 * Detached `--background` mode belongs to the process-oriented CLI and is
 * rejected at runtime too, including for untyped JavaScript callers.
 */
export type EmbeddedNodeStartOptions = Omit<UpOptions, 'background'> & {
  background?: false;
};

export type EmbeddedNodeDownOptions = DownOptions;
export type EmbeddedNodeStatusOptions = StatusOptions;

export interface EmbeddedNodeCommandSuccess {
  ok: true;
  code: 0;
  output: EmbeddedNodeOutput[];
}

export interface EmbeddedNodeCommandFailure {
  ok: false;
  code: number;
  message: string;
  output: EmbeddedNodeOutput[];
}

export type EmbeddedNodeCommandResult = EmbeddedNodeCommandSuccess | EmbeddedNodeCommandFailure;

export interface EmbeddedNodeHandle {
  /** Resolves after the lifecycle has fully stopped and released its resources. */
  readonly completion: Promise<EmbeddedNodeCommandResult>;
  /**
   * Run the same shutdown path the CLI uses for SIGTERM/SIGINT, without
   * installing a handler on the host process. Repeated calls are idempotent.
   */
  stop(signal?: 'SIGINT' | 'SIGTERM'): Promise<EmbeddedNodeCommandResult>;
}

export type EmbeddedNodeStartResult =
  | (EmbeddedNodeCommandSuccess & { handle: EmbeddedNodeHandle })
  | EmbeddedNodeCommandFailure;

/** A distinguishable replacement for the CLI's process-terminating exit dependency. */
export class BrokerLifecycleExitError extends Error {
  constructor(readonly code: number) {
    super(`Broker lifecycle requested exit code ${code}`);
    this.name = 'BrokerLifecycleExitError';
  }
}

type SignalHandler = () => void | Promise<void>;

interface OutputRecorder {
  emit(level: EmbeddedNodeOutputLevel, args: unknown[]): void;
  snapshot(): EmbeddedNodeOutput[];
  resultFrom(error?: unknown): EmbeddedNodeCommandResult;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function formatOutputArg(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

function createOutputRecorder(runtime: EmbeddedNodeRuntimeOptions): OutputRecorder {
  const output: EmbeddedNodeOutput[] = [];
  const emit = (level: EmbeddedNodeOutputLevel, args: unknown[]): void => {
    const entry = { level, message: args.map(formatOutputArg).join(' ') } satisfies EmbeddedNodeOutput;
    output.push(entry);
    runtime.onOutput?.(entry);
  };
  return {
    emit,
    snapshot: () => output.map((entry) => ({ ...entry })),
    resultFrom: (error?: unknown): EmbeddedNodeCommandResult => {
      const snapshot = output.map((entry) => ({ ...entry }));
      if (error === undefined) {
        // Some lifecycle commands report operational failures through
        // deps.error and return normally (notably down). Broker stderr is
        // recorded as neutral info below, so only lifecycle error output
        // participates in this fallback result inference.
        const reportedError = snapshot.find((entry) => entry.level === 'error');
        if (!reportedError) return { ok: true, code: 0, output: snapshot };
        return { ok: false, code: 1, message: reportedError.message, output: snapshot };
      }
      const code = error instanceof BrokerLifecycleExitError ? error.code : 1;
      if (code === 0) return { ok: true, code: 0, output: snapshot };
      const reportedError = snapshot.find((entry) => entry.level === 'error');
      const message =
        reportedError?.message ??
        (error instanceof Error ? error.message : `Broker lifecycle exited with code ${code}`);
      return { ok: false, code, message, output: snapshot };
    },
  };
}

function createEmbeddedDependencies(
  runtime: EmbeddedNodeRuntimeOptions,
  recorder: OutputRecorder,
  signalHandlers: Map<NodeJS.Signals, SignalHandler>,
  ready: Deferred<void>,
  releaseHold: Deferred<void>,
  dependencyOverrides: Partial<CoreDependencies>
): CoreDependencies {
  const env = { ...(runtime.env ?? dependencyOverrides.env ?? process.env) };
  const createRelay: CoreDependencies['createRelay'] =
    dependencyOverrides.createRelay ??
    ((cwd, apiPort, brokerName, verbose) =>
      createDefaultRelay(cwd, apiPort, brokerName, verbose, {
        env,
        onStep: (message) => recorder.emit('info', [`[agent-relay][verbose] ${message}`]),
        onStderr: (line) => recorder.emit('info', [`[broker] ${line}`]),
      }));

  return withDefaults({
    ...dependencyOverrides,
    env,
    createRelay,
    log: (...args) => recorder.emit('info', args),
    warn: (...args) => recorder.emit('warn', args),
    error: (...args) => recorder.emit('error', args),
    pythonProviderStdio: 'ignore',
    createNodeLogger: () => ({
      debug: (message, extra) => recorder.emit('info', [message, ...(extra ? [extra] : [])]),
      info: (message, extra) => recorder.emit('info', [message, ...(extra ? [extra] : [])]),
      warn: (message, extra) => recorder.emit('warn', [message, ...(extra ? [extra] : [])]),
      error: (message, extra) => recorder.emit('error', [message, ...(extra ? [extra] : [])]),
    }),
    onSignal: (signal, handler) => {
      signalHandlers.set(signal, handler);
    },
    holdOpen: () => {
      ready.resolve();
      return releaseHold.promise;
    },
    exit: (code): never => {
      throw new BrokerLifecycleExitError(code);
    },
  });
}

function unsupportedBackgroundResult(runtime: EmbeddedNodeRuntimeOptions): EmbeddedNodeCommandFailure {
  const message =
    'Embedded node startup does not support background mode; omit `background` and own the returned lifecycle handle.';
  const output = [{ level: 'error', message }] satisfies EmbeddedNodeOutput[];
  runtime.onOutput?.(output[0]!);
  return { ok: false, code: 2, message, output };
}

export async function startEmbeddedNode(
  options: EmbeddedNodeStartOptions = {},
  runtime: EmbeddedNodeRuntimeOptions = {}
): Promise<EmbeddedNodeStartResult> {
  return startEmbeddedNodeWithDependencies(options, runtime);
}

/** Internal dependency seam used by the embeddability tests. */
export async function startEmbeddedNodeWithDependencies(
  options: EmbeddedNodeStartOptions,
  runtime: EmbeddedNodeRuntimeOptions = {},
  dependencyOverrides: Partial<CoreDependencies> = {}
): Promise<EmbeddedNodeStartResult> {
  // Match runUpCommand's truthiness check exactly so untyped JavaScript
  // callers cannot bypass embedded ownership with values such as "true" or 1.
  if ((options as { background?: unknown }).background) {
    return unsupportedBackgroundResult(runtime);
  }

  const recorder = createOutputRecorder(runtime);
  const signalHandlers = new Map<NodeJS.Signals, SignalHandler>();
  const ready = deferred<void>();
  const releaseHold = deferred<void>();
  const deps = createEmbeddedDependencies(
    runtime,
    recorder,
    signalHandlers,
    ready,
    releaseHold,
    dependencyOverrides
  );

  const commandCompletion = runUpCommand({ ...options, discoverConfig: true }, deps).then(
    () => recorder.resultFrom(),
    (error) => recorder.resultFrom(error)
  );
  const startup = await Promise.race([
    ready.promise.then(() => ({ ready: true as const })),
    commandCompletion.then((result) => ({ ready: false as const, result })),
  ]);
  if (!startup.ready) {
    return startup.result.ok
      ? {
          ok: false,
          code: 1,
          message: 'Broker lifecycle ended before reaching the ready state.',
          output: startup.result.output,
        }
      : startup.result;
  }

  let stopPromise: Promise<EmbeddedNodeCommandResult> | undefined;
  const handle: EmbeddedNodeHandle = {
    completion: commandCompletion,
    stop: (signal = 'SIGTERM') => {
      if (!stopPromise) {
        stopPromise = (async () => {
          let signalResult: EmbeddedNodeCommandResult | undefined;
          const handler = signalHandlers.get(signal);
          if (!handler) {
            signalResult = recorder.resultFrom(
              new Error(`Broker lifecycle did not register a ${signal} shutdown handler.`)
            );
          } else {
            try {
              await handler();
            } catch (error) {
              signalResult = recorder.resultFrom(error);
            }
          }
          releaseHold.resolve();
          const completion = await commandCompletion;
          return signalResult && !signalResult.ok ? signalResult : completion;
        })();
      }
      return stopPromise;
    },
  };

  return { ok: true, code: 0, output: recorder.snapshot(), handle };
}

async function runEmbeddedCommand(
  command: (deps: CoreDependencies) => Promise<void>,
  runtime: EmbeddedNodeRuntimeOptions,
  dependencyOverrides: Partial<CoreDependencies> = {}
): Promise<EmbeddedNodeCommandResult> {
  const recorder = createOutputRecorder(runtime);
  const ready = deferred<void>();
  const releaseHold = deferred<void>();
  const deps = createEmbeddedDependencies(
    runtime,
    recorder,
    new Map(),
    ready,
    releaseHold,
    dependencyOverrides
  );
  try {
    await command(deps);
    return recorder.resultFrom();
  } catch (error) {
    return recorder.resultFrom(error);
  }
}

export function downEmbeddedNode(
  options: EmbeddedNodeDownOptions = {},
  runtime: EmbeddedNodeRuntimeOptions = {}
): Promise<EmbeddedNodeCommandResult> {
  return runEmbeddedCommand((deps) => runDownCommand(options, deps), runtime);
}

export function statusEmbeddedNode(
  options: EmbeddedNodeStatusOptions = {},
  runtime: EmbeddedNodeRuntimeOptions = {}
): Promise<EmbeddedNodeCommandResult> {
  return runEmbeddedCommand((deps) => runStatusCommand(deps, options), runtime);
}
