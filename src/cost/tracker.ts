import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CLI_DEFAULT_MODEL, MODEL_PRICING, estimateCost, estimateTokensFromDuration } from './pricing.js';
import type { CostTrackerOptions, RunCostSummary, StepCostRecord } from './types.js';

interface StartedStep {
  runId: string;
  stepName: string;
  agent: string;
  cli: string;
  model: string;
  startedAt: string;
  startedAtMs: number;
}

const DEFAULT_USAGE_FILE_PATH = path.join(os.homedir(), '.agent-relay', 'usage.jsonl');

export class CostTracker {
  private readonly usageFilePath: string;
  private readonly startedSteps = new Map<string, StartedStep>();

  constructor(options: CostTrackerOptions = {}) {
    this.usageFilePath = resolveUsageFilePath(options.usageFilePath);
  }

  stepStarted(runId: string, stepName: string, agent: string, cli: string): void {
    const startedAt = new Date();

    this.startedSteps.set(this.getStepKey(runId, stepName), {
      runId,
      stepName,
      agent,
      cli,
      model: resolveModel(agent, cli),
      startedAt: startedAt.toISOString(),
      startedAtMs: startedAt.getTime(),
    });
  }

  stepCompleted(runId: string, stepName: string, _exitCode: number): StepCostRecord {
    const stepKey = this.getStepKey(runId, stepName);
    const startedStep = this.startedSteps.get(stepKey);

    if (!startedStep) {
      throw new Error(`No started step found for run "${runId}" and step "${stepName}"`);
    }

    const endedAt = new Date();
    const durationMs = Math.max(0, endedAt.getTime() - startedStep.startedAtMs);
    const tokenEstimate = estimateTokensFromDuration(durationMs);
    const record: StepCostRecord = {
      runId: startedStep.runId,
      stepName: startedStep.stepName,
      agent: startedStep.agent,
      cli: startedStep.cli,
      model: startedStep.model,
      startedAt: startedStep.startedAt,
      endedAt: endedAt.toISOString(),
      durationMs,
      estimatedInputTokens: tokenEstimate.inputTokens,
      estimatedOutputTokens: tokenEstimate.outputTokens,
      estimatedCostUsd: estimateCost(startedStep.model, tokenEstimate.inputTokens, tokenEstimate.outputTokens),
    };

    this.appendRecord(record);
    this.startedSteps.delete(stepKey);

    return record;
  }

  getRunSummary(runId: string): RunCostSummary {
    const steps = this.readRecords()
      .filter((record) => record.runId === runId)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));

    const totalCostUsd = roundUsd(steps.reduce((sum, step) => sum + step.estimatedCostUsd, 0));
    const totalDurationMs = steps.reduce((sum, step) => sum + step.durationMs, 0);

    return {
      runId,
      totalCostUsd,
      totalDurationMs,
      steps,
    };
  }

  private appendRecord(record: StepCostRecord): void {
    fs.mkdirSync(path.dirname(this.usageFilePath), { recursive: true });
    fs.appendFileSync(this.usageFilePath, `${JSON.stringify(record)}\n`, 'utf8');
  }

  private getStepKey(runId: string, stepName: string): string {
    return `${runId}:${stepName}`;
  }

  private readRecords(): StepCostRecord[] {
    if (!fs.existsSync(this.usageFilePath)) {
      return [];
    }

    const raw = fs.readFileSync(this.usageFilePath, 'utf8').trim();
    if (!raw) {
      return [];
    }

    const records: StepCostRecord[] = [];

    for (const line of raw.split('\n')) {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isStepCostRecord(parsed)) {
          records.push(parsed);
        }
      } catch {
        // Ignore malformed lines so older or partial records do not block summaries.
      }
    }

    return records;
  }
}

function resolveUsageFilePath(usageFilePath?: string): string {
  if (!usageFilePath) {
    return DEFAULT_USAGE_FILE_PATH;
  }

  if (usageFilePath === '~') {
    return os.homedir();
  }

  if (/^~[\\/]/.test(usageFilePath)) {
    return path.join(os.homedir(), usageFilePath.slice(2));
  }

  return usageFilePath;
}

function resolveModel(agent: string, cli: string): string {
  const normalizedAgent = normalizeValue(agent);
  if (normalizedAgent && normalizedAgent in MODEL_PRICING) {
    return normalizedAgent;
  }

  const normalizedCli = normalizeCli(cli);
  if (normalizedCli && normalizedCli in CLI_DEFAULT_MODEL) {
    return CLI_DEFAULT_MODEL[normalizedCli as keyof typeof CLI_DEFAULT_MODEL];
  }

  return normalizedAgent || 'unknown';
}

function normalizeCli(cli: string): string {
  const normalized = normalizeValue(cli);
  if (!normalized) {
    return '';
  }

  const [command] = normalized.split(/\s+/, 1);
  const binary = path.basename(command);
  const [family] = binary.split(':', 1);

  return family;
}

function normalizeValue(value: string): string {
  return value.trim().toLowerCase();
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function isStepCostRecord(value: unknown): value is StepCostRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Partial<StepCostRecord>;

  return (
    typeof record.runId === 'string' &&
    typeof record.stepName === 'string' &&
    typeof record.agent === 'string' &&
    typeof record.cli === 'string' &&
    typeof record.model === 'string' &&
    typeof record.startedAt === 'string' &&
    typeof record.endedAt === 'string' &&
    typeof record.durationMs === 'number' &&
    typeof record.estimatedInputTokens === 'number' &&
    typeof record.estimatedOutputTokens === 'number' &&
    typeof record.estimatedCostUsd === 'number'
  );
}
