export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  total: number;
}

export interface BudgetTrackerConfig {
  perAgent?: number;
  perWorkflow?: number;
}

interface UsageDelta {
  input: number;
  output: number;
  cacheRead?: number;
}

function emptyUsage(): TokenUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    total: 0,
  };
}

function cloneUsage(usage: TokenUsage): TokenUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    total: usage.total,
  };
}

function validateBudget(name: string, value: number | undefined): void {
  if (value === undefined) {
    return;
  }

  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite number greater than or equal to 0`);
  }
}

function normalizeCount(name: string, value: number | undefined): number {
  const normalized = value ?? 0;

  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new RangeError(`${name} must be a finite number greater than or equal to 0`);
  }

  return normalized;
}

function normalizeUsage(tokens: UsageDelta): TokenUsage {
  const input = normalizeCount('input tokens', tokens.input);
  const output = normalizeCount('output tokens', tokens.output);
  const cacheRead = normalizeCount('cache read tokens', tokens.cacheRead);

  return {
    input,
    output,
    cacheRead,
    total: input + output,
  };
}

function addUsage(current: TokenUsage, delta: TokenUsage): TokenUsage {
  const input = current.input + delta.input;
  const output = current.output + delta.output;
  const cacheRead = current.cacheRead + delta.cacheRead;

  return {
    input,
    output,
    cacheRead,
    total: input + output,
  };
}

export class BudgetExceededError extends Error {
  readonly stepName: string;
  readonly budgetType: 'agent' | 'workflow';
  readonly limit: number;
  readonly actual: number;

  constructor(stepName: string, budgetType: 'agent' | 'workflow', limit: number, actual: number) {
    const scope = budgetType === 'agent' ? `Step "${stepName}"` : `Workflow`;
    super(`${scope} exceeded ${budgetType} budget: ${actual} tokens used of ${limit}`);
    this.name = 'BudgetExceededError';
    this.stepName = stepName;
    this.budgetType = budgetType;
    this.limit = limit;
    this.actual = actual;
  }
}

export class BudgetTracker {
  private readonly perAgent?: number;
  private readonly perWorkflow?: number;
  private readonly stepBudgets = new Map<string, number>();
  private readonly usageByStep = new Map<string, TokenUsage>();
  private totalUsage: TokenUsage = emptyUsage();

  constructor(config: BudgetTrackerConfig) {
    validateBudget('perAgent', config.perAgent);
    validateBudget('perWorkflow', config.perWorkflow);

    this.perAgent = config.perAgent;
    this.perWorkflow = config.perWorkflow;
  }

  recordUsage(stepName: string, tokens: { input: number; output: number; cacheRead?: number }): void {
    const delta = normalizeUsage(tokens);
    const currentStepUsage = this.usageByStep.get(stepName) ?? emptyUsage();

    // Keep the full mutation synchronous so async callers only interleave at
    // event-loop boundaries, not inside a partial update.
    this.usageByStep.set(stepName, addUsage(currentStepUsage, delta));
    this.totalUsage = addUsage(this.totalUsage, delta);
  }

  getStepUsage(stepName: string): TokenUsage {
    return cloneUsage(this.usageByStep.get(stepName) ?? emptyUsage());
  }

  getTotalUsage(): TokenUsage {
    return cloneUsage(this.totalUsage);
  }

  setStepBudget(stepName: string, limit: number | undefined): void {
    validateBudget(`budget for step "${stepName}"`, limit);

    if (limit === undefined) {
      this.stepBudgets.delete(stepName);
      return;
    }

    this.stepBudgets.set(stepName, limit);
  }

  getStepBudget(stepName: string): number | null {
    return this.stepBudgets.get(stepName) ?? null;
  }

  getRemainingBudget(): { agent: number | null; workflow: number | null } {
    const largestStepTotal = Array.from(this.usageByStep.values()).reduce(
      (largest, usage) => Math.max(largest, usage.total),
      0,
    );

    return {
      agent: this.perAgent === undefined ? null : this.perAgent - largestStepTotal,
      workflow: this.perWorkflow === undefined ? null : this.perWorkflow - this.totalUsage.total,
    };
  }

  checkCanSpawn(agentName: string): { allowed: boolean; reason?: string } {
    if (this.perWorkflow === undefined) {
      return { allowed: true };
    }

    if (this.totalUsage.total >= this.perWorkflow) {
      return {
        allowed: false,
        reason: `Cannot spawn "${agentName}": workflow budget exhausted (${this.totalUsage.total}/${this.perWorkflow} tokens used)`,
      };
    }

    if (this.perAgent !== undefined) {
      const remainingWorkflow = this.perWorkflow - this.totalUsage.total;
      const minimumHeadroom = this.perAgent * 0.1;

      if (remainingWorkflow < minimumHeadroom) {
        return {
          allowed: false,
          reason: `Cannot spawn "${agentName}": remaining workflow budget ${remainingWorkflow} is below 10% of per-agent budget ${minimumHeadroom}`,
        };
      }
    }

    return { allowed: true };
  }

  isOverBudget(stepName: string): { over: boolean; reason?: string } {
    const stepUsage = this.getStepUsage(stepName);
    const stepBudget = this.stepBudgets.get(stepName) ?? this.perAgent;

    if (stepBudget !== undefined && stepUsage.total > stepBudget) {
      return {
        over: true,
        reason: `Step "${stepName}" exceeded per-agent budget (${stepUsage.total}/${stepBudget} tokens used)`,
      };
    }

    if (this.perWorkflow !== undefined && this.totalUsage.total > this.perWorkflow) {
      return {
        over: true,
        reason: `Workflow budget exceeded after step "${stepName}" (${this.totalUsage.total}/${this.perWorkflow} tokens used)`,
      };
    }

    return { over: false };
  }
}
