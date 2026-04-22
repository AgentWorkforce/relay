export interface BudgetTrackerStepConfig {
  stepName: string;
  agentName: string;
  maxTokens?: number;
}

export interface BudgetTrackerOptions {
  perAgent?: number;
  perWorkflow?: number;
  workflowBudget?: number;
  steps?: BudgetTrackerStepConfig[];
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  total: number;
}

export interface BudgetAvailability {
  allowed: boolean;
  reason?: string;
}

export interface OverBudgetResult {
  over: boolean;
  reason?: string;
}

export interface BudgetStatus {
  agentLimitExceeded: boolean;
  workflowBudgetExceeded: boolean;
  workflowBudgetExhausted: boolean;
}

export interface StepBudgetStatus {
  used?: number;
  limit?: number;
  over: boolean;
}

export interface WorkflowBudgetStatus {
  used: number;
  limit?: number;
  exhausted: boolean;
}

export interface RunSummaryBudgetData {
  steps: Map<string, StepBudgetStatus>;
  workflow?: WorkflowBudgetStatus;
}

function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, total: 0 };
}

function toUsage(value: number | Partial<Omit<TokenUsage, 'total'>>): TokenUsage {
  if (typeof value === 'number') {
    const input = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
    return { input, output: 0, cacheRead: 0, total: input };
  }

  const input = Number.isFinite(value.input) ? Math.max(0, Math.round(value.input ?? 0)) : 0;
  const output = Number.isFinite(value.output) ? Math.max(0, Math.round(value.output ?? 0)) : 0;
  const cacheRead = Number.isFinite(value.cacheRead) ? Math.max(0, Math.round(value.cacheRead ?? 0)) : 0;
  return {
    input,
    output,
    cacheRead,
    total: input + output,
  };
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  const input = left.input + right.input;
  const output = left.output + right.output;
  const cacheRead = left.cacheRead + right.cacheRead;
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
  readonly used: number;

  constructor(stepName: string, budgetType: 'agent' | 'workflow', limit: number, actual: number) {
    const qualifier = budgetType === 'workflow' ? 'workflow budget exhausted' : 'agent budget exceeded';
    super(`Step "${stepName}" cannot continue: ${qualifier} (${actual}/${limit})`);
    this.name = 'BudgetExceededError';
    this.stepName = stepName;
    this.budgetType = budgetType;
    this.limit = limit;
    this.actual = actual;
    this.used = actual;
  }
}

export class BudgetTracker {
  private readonly defaultAgentBudget?: number;
  private readonly workflowBudget?: number;
  private readonly stepLimits = new Map<string, number | undefined>();
  private readonly stepUsage = new Map<string, TokenUsage>();
  private totalUsage: TokenUsage = emptyUsage();
  private workflowBudgetExhausted = false;

  constructor(options: BudgetTrackerOptions) {
    this.defaultAgentBudget = options.perAgent;
    this.workflowBudget = options.workflowBudget ?? options.perWorkflow;

    for (const step of options.steps ?? []) {
      this.stepLimits.set(step.stepName, step.maxTokens);
    }
  }

  recordUsage(stepName: string, usage: number | Partial<Omit<TokenUsage, 'total'>>): void {
    const normalized = toUsage(usage);
    const current = this.stepUsage.get(stepName) ?? emptyUsage();
    const next = addUsage(current, normalized);
    this.stepUsage.set(stepName, next);
    this.totalUsage = addUsage(this.totalUsage, normalized);

    if (this.workflowBudget !== undefined && this.totalUsage.total >= this.workflowBudget) {
      this.workflowBudgetExhausted = true;
    }
  }

  getStepUsage(stepName: string): TokenUsage {
    return this.stepUsage.get(stepName) ?? emptyUsage();
  }

  getTotalUsage(): TokenUsage {
    return this.totalUsage;
  }

  getRemainingBudget(): { agent?: number; workflow?: number } {
    return {
      agent:
        this.defaultAgentBudget !== undefined
          ? Math.max(0, this.defaultAgentBudget - this.totalUsage.total)
          : undefined,
      workflow:
        this.workflowBudget !== undefined ? Math.max(0, this.workflowBudget - this.totalUsage.total) : undefined,
    };
  }

  checkCanSpawn(stepName: string): BudgetAvailability {
    if (this.workflowBudget !== undefined && this.totalUsage.total >= this.workflowBudget) {
      return {
        allowed: false,
        reason: `Cannot spawn ${stepName}: workflow budget exceeded (${this.totalUsage.total}/${this.workflowBudget})`,
      };
    }

    if (this.workflowBudget !== undefined) {
      const remainingWorkflowBudget = this.workflowBudget - this.totalUsage.total;
      const stepLimit = this.getStepLimit(stepName);
      const minimumHeadroom =
        stepLimit !== undefined
          ? Math.min(stepLimit, this.workflowBudget)
          : this.defaultAgentBudget !== undefined
            ? Math.ceil(this.defaultAgentBudget * 0.1)
            : Math.ceil(this.workflowBudget * 0.1);

      if (remainingWorkflowBudget <= minimumHeadroom) {
        return {
          allowed: false,
          reason: stepLimit !== undefined
            ? `Cannot spawn ${stepName}: remaining workflow budget ${remainingWorkflowBudget} is below step budget ${stepLimit}`
            : this.defaultAgentBudget !== undefined
              ? `Cannot spawn ${stepName}: remaining workflow budget ${remainingWorkflowBudget} ` +
                `is below 10% of per-agent budget ${this.defaultAgentBudget}`
              : `Cannot spawn ${stepName}: remaining workflow budget ${remainingWorkflowBudget} ` +
                `is below 10% headroom threshold for workflow budget ${this.workflowBudget}`,
        };
      }
    }

    return { allowed: true };
  }

  isOverBudget(stepName: string): OverBudgetResult {
    const stepUsage = this.getStepUsage(stepName);
    const stepLimit = this.getStepLimit(stepName);
    if (stepLimit !== undefined && stepUsage.total > stepLimit) {
      return {
        over: true,
        reason: `Step "${stepName}" exceeded per-agent budget (${stepUsage.total}/${stepLimit})`,
      };
    }

    if (this.workflowBudget !== undefined && this.totalUsage.total > this.workflowBudget) {
      return {
        over: true,
        reason: `Workflow exceeded total budget (${this.totalUsage.total}/${this.workflowBudget})`,
      };
    }

    return { over: false };
  }

  getBudgetStatus(stepName: string): BudgetStatus {
    const stepUsage = this.getStepUsage(stepName);
    const stepLimit = this.getStepLimit(stepName);
    return {
      agentLimitExceeded: stepLimit !== undefined && stepUsage.total > stepLimit,
      workflowBudgetExceeded: this.workflowBudget !== undefined && this.totalUsage.total > this.workflowBudget,
      workflowBudgetExhausted:
        this.workflowBudget !== undefined && (this.workflowBudgetExhausted || this.totalUsage.total >= this.workflowBudget),
    };
  }

  getStepBudgetStatus(stepName: string): StepBudgetStatus | undefined {
    const usage = this.stepUsage.get(stepName);
    const hasExplicitLimit = this.stepLimits.has(stepName);
    const limit = this.getStepLimit(stepName);

    if (!usage && !hasExplicitLimit && limit === undefined) {
      return undefined;
    }

    return {
      used: usage?.total,
      limit,
      over: limit !== undefined && (usage?.total ?? 0) > limit,
    };
  }

  getRunSummaryBudgetData(): RunSummaryBudgetData | undefined {
    const steps = new Map<string, StepBudgetStatus>();
    const stepNames = new Set<string>([...this.stepLimits.keys(), ...this.stepUsage.keys()]);

    for (const stepName of stepNames) {
      const status = this.getStepBudgetStatus(stepName);
      if (status) {
        steps.set(stepName, status);
      }
    }

    const workflow =
      this.workflowBudget !== undefined || this.totalUsage.total > 0
        ? {
            used: this.totalUsage.total,
            limit: this.workflowBudget,
            exhausted:
              this.workflowBudget !== undefined && (this.workflowBudgetExhausted || this.totalUsage.total >= this.workflowBudget),
          }
        : undefined;

    if (steps.size === 0 && !workflow) {
      return undefined;
    }

    return { steps, workflow };
  }

  private getStepLimit(stepName: string): number | undefined {
    const limit = this.stepLimits.get(stepName);
    return limit ?? this.defaultAgentBudget;
  }
}
