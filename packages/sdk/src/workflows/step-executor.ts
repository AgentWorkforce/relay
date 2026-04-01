import { ChannelMessenger } from './channel-messenger.js';
import type { ProcessSpawner } from './process-spawner.js';
import { TemplateResolver } from './template-resolver.js';
import type { StepOutcome } from './trajectory.js';
import type {
  AgentDefinition,
  ErrorHandlingConfig,
  StepCompletionMode,
  VerificationCheck,
  WorkflowStep,
  WorkflowStepCompletionReason,
  WorkflowStepRow,
  WorkflowStepStatus,
} from './types.js';
import { runVerification, type VerificationOptions, type VerificationResult } from './verification.js';

type StateLike = {
  row: WorkflowStepRow;
};

export interface StepResult {
  status: WorkflowStepStatus;
  output: string;
  exitCode?: number;
  exitSignal?: string;
  duration: number;
  retries: number;
  completionReason?: WorkflowStepCompletionReason;
  error?: string;
}

export interface StepSchedule {
  step: WorkflowStep;
  readyAt: number;
  staggerDelay: number;
}

export interface StepExecutorDeps<TState extends StateLike = StateLike> {
  cwd: string;
  runId?: string;
  postToChannel?: (text: string) => void;
  persistStepRow?: (stepId: string, patch: Partial<WorkflowStepRow>) => Promise<void>;
  persistStepOutput?: (runId: string, stepName: string, output: string) => Promise<void>;
  resolveTemplate?: (template: string, context: Record<string, unknown>) => string;
  getStepOutput?: (stepName: string) => string | undefined;
  loadStepOutput?: (runId: string, stepName: string) => string | undefined;
  checkAborted?: () => void;
  waitIfPaused?: () => Promise<void>;
  log?: (message: string) => void;
  processSpawner?: ProcessSpawner;
  templateResolver?: TemplateResolver;
  channelMessenger?: ChannelMessenger;
  verificationRunner?: (
    check: VerificationCheck,
    output: string,
    stepName: string,
    injectedTaskText?: string,
    options?: VerificationOptions
  ) => VerificationResult;
  executeStep?: (
    step: WorkflowStep,
    state: TState,
    agentMap: Map<string, AgentDefinition>,
    errorHandling?: ErrorHandlingConfig
  ) => Promise<Partial<StepResult> | void>;
  onStepStarted?: (step: WorkflowStep, state: TState) => Promise<void> | void;
  onStepRetried?: (
    step: WorkflowStep,
    state: TState,
    attempt: number,
    maxRetries: number
  ) => Promise<void> | void;
  onStepCompleted?: (step: WorkflowStep, state: TState, result: StepResult) => Promise<void> | void;
  onStepFailed?: (step: WorkflowStep, state: TState, result: StepResult) => Promise<void> | void;
  onBeginTrack?: (steps: WorkflowStep[]) => Promise<void> | void;
  onConverge?: (steps: WorkflowStep[], outcomes: StepOutcome[]) => Promise<void> | void;
  markDownstreamSkipped?: (failedStepName: string) => Promise<void>;
  buildCompletionMode?: (
    stepName: string,
    completionReason?: WorkflowStepCompletionReason
  ) => StepCompletionMode | undefined;
}

export interface MonitorStepOptions<TState extends StateLike, TResult> {
  maxRetries?: number;
  retryDelayMs?: number;
  startMessage?: string;
  onStart?: (attempt: number, state: TState) => Promise<void> | void;
  onRetry?: (attempt: number, maxRetries: number, state: TState) => Promise<void> | void;
  execute: (attempt: number, state: TState) => Promise<TResult>;
  toCompletionResult: (result: TResult, attempt: number, state: TState) => Partial<StepResult>;
  onAttemptFailed?: (error: unknown, attempt: number, state: TState) => Promise<void> | void;
  getFailureResult?: (error: unknown, attempt: number, state: TState) => Partial<StepResult>;
}

export class StepExecutor<TState extends StateLike = StateLike> {
  private readonly templateResolver: TemplateResolver;
  private readonly channelMessenger: ChannelMessenger;
  private readonly verificationRunner: NonNullable<StepExecutorDeps<TState>['verificationRunner']>;

  constructor(private readonly deps: StepExecutorDeps<TState>) {
    this.templateResolver = deps.templateResolver ?? new TemplateResolver();
    this.channelMessenger =
      deps.channelMessenger ?? new ChannelMessenger({ postFn: deps.postToChannel });
    this.verificationRunner = deps.verificationRunner ?? runVerification;
  }

  findReady(
    steps: WorkflowStep[],
    statuses: Map<string, WorkflowStepStatus> | Map<string, TState>
  ): WorkflowStep[] {
    return steps.filter((step) => {
      const state = statuses.get(step.name);
      const status = this.getStatus(state);
      if (status !== 'pending') return false;

      return (step.dependsOn ?? []).every((dependency) => {
        const depState = statuses.get(dependency);
        const depStatus = this.getStatus(depState);
        return depStatus === 'completed' || depStatus === 'skipped';
      });
    });
  }

  findReadySteps(
    steps: WorkflowStep[],
    statuses: Map<string, WorkflowStepStatus> | Map<string, TState>
  ): WorkflowStep[] {
    return this.findReady(steps, statuses);
  }

  scheduleStep(
    step: WorkflowStep,
    options: { readyAt?: number; staggerDelay?: number } = {}
  ): StepSchedule {
    return {
      step,
      readyAt: options.readyAt ?? Date.now(),
      staggerDelay: options.staggerDelay ?? 0,
    };
  }

  async startStep(step: WorkflowStep, state: TState, startMessage?: string): Promise<void> {
    const startedAt = new Date().toISOString();
    state.row.status = 'running';
    state.row.error = undefined;
    state.row.completionReason = undefined;
    state.row.startedAt = startedAt;

    await this.deps.persistStepRow?.(state.row.id, {
      status: 'running',
      error: undefined,
      completionReason: undefined,
      startedAt,
      updatedAt: new Date().toISOString(),
    });

    if (startMessage) {
      this.deps.postToChannel?.(startMessage);
    }
    await this.deps.onStepStarted?.(step, state);
  }

  async retryStep(step: WorkflowStep, state: TState, attempt: number, maxRetries: number): Promise<void> {
    state.row.retryCount = attempt;
    await this.deps.persistStepRow?.(state.row.id, {
      retryCount: attempt,
      updatedAt: new Date().toISOString(),
    });
    await this.deps.onStepRetried?.(step, state, attempt, maxRetries);
  }

  async completeStep(
    step: WorkflowStep,
    state: TState,
    result: Partial<StepResult>
  ): Promise<StepResult> {
    const completedAt = new Date().toISOString();
    const finalResult: StepResult = {
      status: result.status ?? 'completed',
      output: result.output ?? '',
      exitCode: result.exitCode,
      exitSignal: result.exitSignal,
      duration: result.duration ?? 0,
      retries: result.retries ?? state.row.retryCount,
      completionReason: result.completionReason,
      error: result.error,
    };

    state.row.status = finalResult.status;
    state.row.output = finalResult.output;
    state.row.error = finalResult.error;
    state.row.completionReason = finalResult.completionReason;
    state.row.completedAt = completedAt;

    await this.deps.persistStepRow?.(state.row.id, {
      status: finalResult.status,
      output: finalResult.output,
      error: finalResult.error,
      completionReason: finalResult.completionReason,
      completedAt,
      updatedAt: new Date().toISOString(),
    });
    if (finalResult.status === 'completed' && this.deps.runId && finalResult.output) {
      await this.deps.persistStepOutput?.(this.deps.runId, step.name, finalResult.output);
    }

    if (finalResult.status === 'failed') {
      await this.deps.onStepFailed?.(step, state, finalResult);
    } else {
      await this.deps.onStepCompleted?.(step, state, finalResult);
    }
    return finalResult;
  }

  async monitorStep<TResult>(
    step: WorkflowStep,
    state: TState,
    options: MonitorStepOptions<TState, TResult>
  ): Promise<StepResult> {
    const maxRetries = options.maxRetries ?? 0;
    const retryDelayMs = options.retryDelayMs ?? 1000;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      this.deps.checkAborted?.();
      await this.deps.waitIfPaused?.();

      if (attempt > 0) {
        await this.retryStep(step, state, attempt, maxRetries);
        await options.onRetry?.(attempt, maxRetries, state);
        if (retryDelayMs > 0) {
          await delay(retryDelayMs);
        }
      }

      const attemptStartedAt = Date.now();
      await this.startStep(step, state, options.startMessage);
      await options.onStart?.(attempt, state);

      try {
        const rawResult = await options.execute(attempt, state);
        const completion = options.toCompletionResult(rawResult, attempt, state);
        return await this.completeStep(step, state, {
          ...completion,
          duration: completion.duration ?? Date.now() - attemptStartedAt,
          retries: completion.retries ?? attempt,
        });
      } catch (error) {
        lastError = error;
        await options.onAttemptFailed?.(error, attempt, state);
      }
    }

    const failure = options.getFailureResult?.(lastError, maxRetries, state) ?? {
      status: 'failed' as const,
      output: '',
      error: lastError instanceof Error ? lastError.message : String(lastError ?? 'Unknown error'),
      retries: maxRetries,
    };
    return this.completeStep(step, state, {
      ...failure,
      status: 'failed',
    });
  }

  async executeAll(
    steps: WorkflowStep[],
    agentMap: Map<string, AgentDefinition>,
    errorHandling?: ErrorHandlingConfig,
    providedStates?: Map<string, TState>
  ): Promise<Map<string, StepResult>> {
    const states = providedStates ?? this.createEphemeralStates(steps);
    const strategy = normalizeStrategy(errorHandling?.strategy ?? 'fail-fast');
    const results = new Map<string, StepResult>();

    while (true) {
      this.deps.checkAborted?.();
      await this.deps.waitIfPaused?.();

      const readySteps = this.findReady(steps, states);
      if (readySteps.length === 0) break;

      const schedules = readySteps.map((step, index) =>
        this.scheduleStep(step, {
          readyAt: Date.now(),
          staggerDelay: readySteps.length > 3 ? index * 2_000 : 0,
        })
      );

      if (schedules.length > 1) {
        await this.deps.onBeginTrack?.(readySteps);
      }

      const settled = await Promise.allSettled(
        schedules.map(async (schedule) => {
          if (schedule.staggerDelay > 0) {
            await delay(schedule.staggerDelay);
          }
          return this.executeScheduledStep(schedule.step, states, agentMap, errorHandling);
        })
      );

      const batchOutcomes: StepOutcome[] = [];

      for (let index = 0; index < settled.length; index += 1) {
        const settledResult = settled[index];
        const step = readySteps[index];
        const state = states.get(step.name);

        if (settledResult.status === 'fulfilled') {
          const result = settledResult.value;
          const outcomeStatus =
            result.status === 'completed' || result.status === 'skipped' ? result.status : 'failed';
          results.set(step.name, result);
          batchOutcomes.push({
            name: step.name,
            agent: step.agent ?? 'deterministic',
            status: outcomeStatus,
            attempts: result.retries + 1,
            output: result.output,
            error: result.error,
            verificationPassed: outcomeStatus === 'completed' && step.verification !== undefined,
            completionMode:
              result.completionReason !== undefined
                ? this.deps.buildCompletionMode?.(step.name, result.completionReason)
                : undefined,
          });

          if (result.status === 'failed') {
            await this.deps.markDownstreamSkipped?.(step.name);
            if (strategy === 'fail-fast') {
              throw new Error(`Step "${step.name}" failed: ${result.error ?? 'unknown error'}`);
            }
          }
          continue;
        }

        const error = settledResult.reason instanceof Error
          ? settledResult.reason.message
          : String(settledResult.reason);
        if (state) {
          const failed =
            state.row.status === 'failed'
              ? {
                  status: 'failed' as const,
                  output: state.row.output ?? '',
                  duration: 0,
                  retries: state.row.retryCount,
                  completionReason: state.row.completionReason,
                  error: state.row.error ?? error,
                }
              : await this.completeStep(step, state, {
                  status: 'failed',
                  output: '',
                  error,
                  retries: state.row.retryCount,
                });
          results.set(step.name, failed);
        }
        batchOutcomes.push({
          name: step.name,
          agent: step.agent ?? 'deterministic',
          status: 'failed',
          attempts: (state?.row.retryCount ?? 0) + 1,
          error,
        });
        await this.deps.markDownstreamSkipped?.(step.name);
        if (strategy === 'fail-fast') {
          throw new Error(`Step "${step.name}" failed: ${error}`);
        }
      }

      if (readySteps.length > 1 && batchOutcomes.length > 0) {
        await this.deps.onConverge?.(readySteps, batchOutcomes);
      }
    }

    return results;
  }

  async executeOne(
    step: WorkflowStep,
    agentMap: Map<string, AgentDefinition>,
    errorHandling?: ErrorHandlingConfig,
    providedState?: TState
  ): Promise<StepResult> {
    const state = providedState ?? this.createEphemeralState(step);
    if (this.deps.executeStep) {
      const result = await this.deps.executeStep(step, state, agentMap, errorHandling);
      if (state.row.status !== 'pending' && state.row.status !== 'running') {
        return {
          status: state.row.status,
          output: state.row.output ?? '',
          duration: result?.duration ?? 0,
          retries: result?.retries ?? state.row.retryCount,
          exitCode: result?.exitCode,
          exitSignal: result?.exitSignal,
          completionReason: state.row.completionReason ?? result?.completionReason,
          error: state.row.error ?? result?.error,
        };
      }
      return this.completeStep(step, state, {
        status: result?.status ?? 'completed',
        output: result?.output ?? '',
        exitCode: result?.exitCode,
        exitSignal: result?.exitSignal,
        completionReason: result?.completionReason,
        retries: result?.retries ?? state.row.retryCount,
        duration: result?.duration ?? 0,
        error: result?.error,
      });
    }

    return this.executeWithProcessSpawner(step, state, agentMap, errorHandling);
  }

  async markFailed(stepName: string, error: string): Promise<void> {
    this.deps.postToChannel?.(`**[${stepName}]** Failed: ${error}`);
  }

  buildStepOutputContext(stepStates: Map<string, TState>): Record<string, { output: string }> {
    const steps: Record<string, { output: string }> = {};
    for (const [name, state] of stepStates) {
      if (state.row.status === 'completed' && state.row.output !== undefined) {
        steps[name] = { output: state.row.output };
        continue;
      }
      if (state.row.status === 'completed' && this.deps.runId) {
        const persisted = this.deps.loadStepOutput?.(this.deps.runId, name);
        if (persisted !== undefined) {
          state.row.output = persisted;
          steps[name] = { output: persisted };
        }
      }
    }
    return steps;
  }

  resolveStepTemplate(template: string, context: Record<string, unknown>): string {
    if (this.deps.resolveTemplate) {
      return this.deps.resolveTemplate(template, context);
    }
    return this.templateResolver.interpolateStepTask(template, context);
  }

  getChannelMessenger(): ChannelMessenger {
    return this.channelMessenger;
  }

  runVerification(
    check: VerificationCheck,
    output: string,
    stepName: string,
    injectedTaskText?: string,
    options?: VerificationOptions
  ): VerificationResult {
    return this.verificationRunner(check, output, stepName, injectedTaskText, {
      ...options,
      cwd: options?.cwd ?? this.deps.cwd,
    });
  }

  private async executeScheduledStep(
    step: WorkflowStep,
    states: Map<string, TState>,
    agentMap: Map<string, AgentDefinition>,
    errorHandling?: ErrorHandlingConfig
  ): Promise<StepResult> {
    const state = states.get(step.name) ?? this.createEphemeralState(step);
    if (!states.has(step.name)) {
      states.set(step.name, state);
    }
    return this.executeOne(step, agentMap, errorHandling, state);
  }

  private async executeWithProcessSpawner(
    step: WorkflowStep,
    state: TState,
    agentMap: Map<string, AgentDefinition>,
    errorHandling?: ErrorHandlingConfig
  ): Promise<StepResult> {
    const spawner = this.deps.processSpawner;
    if (!spawner) {
      throw new Error(`No step execution callback or process spawner configured for step "${step.name}"`);
    }

    const maxRetries = step.retries ?? errorHandling?.maxRetries ?? 0;
    return this.monitorStep(step, state, {
      maxRetries,
      retryDelayMs: errorHandling?.retryDelayMs ?? 1000,
      startMessage: `**[${step.name}]** Started`,
      onRetry: (attempt, total) => {
        this.deps.postToChannel?.(`**[${step.name}]** Retrying (attempt ${attempt + 1}/${total + 1})`);
      },
      execute: async () => {
        if (step.type === 'deterministic') {
          const command = step.command ?? '';
          return spawner.spawnShell(command, { cwd: this.deps.cwd, timeoutMs: step.timeoutMs });
        }

        const agent = step.agent ? agentMap.get(step.agent) : undefined;
        if (!agent) {
          throw new Error(`Agent "${step.agent ?? '(missing)'}" not found in config`);
        }

        const task = step.task ?? '';
        if (agent.interactive === false) {
          return spawner.spawnAgent(agent, task, { cwd: this.deps.cwd, timeoutMs: step.timeoutMs });
        }
        return spawner.spawnInteractive(agent, task, { cwd: this.deps.cwd, timeoutMs: step.timeoutMs });
      },
      toCompletionResult: (spawnResult, attempt) => {
        const failOnError = step.failOnError !== false;
        const failed = failOnError && (spawnResult.exitCode ?? 0) !== 0;
        const output =
          step.captureOutput === false
            ? `Command completed (exit code ${spawnResult.exitCode ?? 0})`
            : spawnResult.output;

        if (failed) {
          return {
            status: 'failed' as const,
            output,
            exitCode: spawnResult.exitCode,
            exitSignal: spawnResult.exitSignal,
            retries: attempt,
            error: spawnResult.output || `Command failed with exit code ${spawnResult.exitCode ?? 'unknown'}`,
          };
        }

        return {
          status: 'completed' as const,
          output,
          exitCode: spawnResult.exitCode,
          exitSignal: spawnResult.exitSignal,
          retries: attempt,
        };
      },
    });
  }

  private createEphemeralStates(steps: WorkflowStep[]): Map<string, TState> {
    return new Map(steps.map((step) => [step.name, this.createEphemeralState(step)]));
  }

  private createEphemeralState(step: WorkflowStep): TState {
    return {
      row: {
        id: `step-${step.name}`,
        runId: this.deps.runId ?? 'run',
        stepName: step.name,
        agentName: step.agent ?? null,
        stepType: step.type ?? 'agent',
        status: 'pending',
        task: step.task ?? step.command ?? step.branch ?? '',
        dependsOn: step.dependsOn ?? [],
        retryCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    } as TState;
  }

  private getStatus(state: WorkflowStepStatus | TState | undefined): WorkflowStepStatus | undefined {
    if (typeof state === 'string') return state;
    return state?.row.status;
  }
}

function normalizeStrategy(strategy: ErrorHandlingConfig['strategy']): 'fail-fast' | 'continue' {
  if (strategy === 'continue') return 'continue';
  return 'fail-fast';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
