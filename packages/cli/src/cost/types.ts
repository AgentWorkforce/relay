export interface StepCostRecord {
  runId: string;
  stepName: string;
  agent: string;
  cli: string;
  model: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
}

export interface RunCostSummary {
  runId: string;
  totalCostUsd: number;
  totalDurationMs: number;
  steps: StepCostRecord[];
}

export interface CostTrackerOptions {
  usageFilePath?: string;
}
