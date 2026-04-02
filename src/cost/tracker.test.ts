import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StepCostRecord } from './types.js';

const fsMock = vi.hoisted(() => ({
  appendFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  default: fsMock,
}));

import { MODEL_PRICING, estimateCost, estimateTokensFromDuration } from './pricing.js';
import { CostTracker } from './tracker.js';

describe('pricing', () => {
  it('estimateTokensFromDuration returns reasonable values', () => {
    expect(estimateTokensFromDuration(-1)).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(estimateTokensFromDuration(0)).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(estimateTokensFromDuration(1_500)).toEqual({ inputTokens: 300, outputTokens: 113 });
    expect(estimateTokensFromDuration(2_000)).toEqual({ inputTokens: 400, outputTokens: 150 });
  });

  it.each(Object.entries(MODEL_PRICING))('estimateCost calculates correctly for %s', (model, pricing) => {
    const inputTokens = 123_456;
    const outputTokens = 78_900;
    const expected =
      Math.round(
        ((inputTokens / 1_000_000) * pricing.inputPer1M + (outputTokens / 1_000_000) * pricing.outputPer1M) *
          1_000_000
      ) / 1_000_000;

    expect(estimateCost(model, inputTokens, outputTokens)).toBe(expected);
  });
});

describe('CostTracker', () => {
  const usageFilePath = '/tmp/agent-relay/usage.jsonl';
  let files: Map<string, string>;

  beforeEach(() => {
    files = new Map();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    fsMock.mkdirSync.mockImplementation(() => undefined);
    fsMock.appendFileSync.mockImplementation((filePath: string, data: string) => {
      const key = String(filePath);
      files.set(key, `${files.get(key) ?? ''}${String(data)}`);
    });
    fsMock.existsSync.mockImplementation((filePath: string) => files.has(String(filePath)));
    fsMock.readFileSync.mockImplementation((filePath: string) => files.get(String(filePath)) ?? '');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stepStarted + stepCompleted produces valid record', () => {
    const tracker = new CostTracker({ usageFilePath });

    tracker.stepStarted('run-1', 'compile', 'worker-a', 'codex exec');
    vi.setSystemTime(new Date('2026-01-01T00:00:02.000Z'));

    const record = tracker.stepCompleted('run-1', 'compile', 0);

    expect(record).toEqual({
      runId: 'run-1',
      stepName: 'compile',
      agent: 'worker-a',
      cli: 'codex exec',
      model: 'gpt-5.4',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:02.000Z',
      durationMs: 2_000,
      estimatedInputTokens: 400,
      estimatedOutputTokens: 150,
      estimatedCostUsd: 0.0025,
    });
    expect(fsMock.mkdirSync).toHaveBeenCalledWith(path.dirname(usageFilePath), {
      recursive: true,
      mode: 0o700,
    });
    expect(files.get(usageFilePath)).toBe(`${JSON.stringify(record)}\n`);
  });

  it('records are appended to usage file', () => {
    const tracker = new CostTracker({ usageFilePath });

    tracker.stepStarted('run-1', 'first-step', 'o3', 'codex');
    vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
    const firstRecord = tracker.stepCompleted('run-1', 'first-step', 0);

    tracker.stepStarted('run-1', 'second-step', 'o3', 'codex');
    vi.setSystemTime(new Date('2026-01-01T00:00:03.000Z'));
    const secondRecord = tracker.stepCompleted('run-1', 'second-step', 0);

    expect(fsMock.appendFileSync).toHaveBeenCalledTimes(2);
    expect(parseJsonLines(files.get(usageFilePath) ?? '')).toEqual([firstRecord, secondRecord]);
  });

  it('getRunSummary filters by runId', () => {
    const tracker = new CostTracker({ usageFilePath });
    const firstRecord = createRecord({
      runId: 'run-1',
      stepName: 'first-step',
      startedAt: '2026-01-01T00:00:01.000Z',
      endedAt: '2026-01-01T00:00:02.000Z',
      durationMs: 1_000,
      estimatedInputTokens: 200,
      estimatedOutputTokens: 75,
      estimatedCostUsd: 0.0005,
    });
    const secondRecord = createRecord({
      runId: 'run-2',
      stepName: 'other-run-step',
      startedAt: '2026-01-01T00:00:03.000Z',
      endedAt: '2026-01-01T00:00:05.000Z',
      durationMs: 2_000,
      estimatedInputTokens: 400,
      estimatedOutputTokens: 150,
      estimatedCostUsd: 0.0025,
    });
    const thirdRecord = createRecord({
      runId: 'run-1',
      stepName: 'second-step',
      startedAt: '2026-01-01T00:00:06.000Z',
      endedAt: '2026-01-01T00:00:08.000Z',
      durationMs: 2_000,
      estimatedInputTokens: 400,
      estimatedOutputTokens: 150,
      estimatedCostUsd: 0.0025,
    });

    files.set(
      usageFilePath,
      [
        JSON.stringify(thirdRecord),
        '{"broken":true}',
        JSON.stringify(secondRecord),
        JSON.stringify(firstRecord),
      ].join('\n')
    );

    expect(tracker.getRunSummary('run-1')).toEqual({
      runId: 'run-1',
      totalCostUsd: 0.003,
      totalDurationMs: 3_000,
      steps: [firstRecord, thirdRecord],
    });
  });
});

function createRecord(overrides: Partial<StepCostRecord> = {}): StepCostRecord {
  return {
    runId: 'run-1',
    stepName: 'step',
    agent: 'worker-a',
    cli: 'codex exec',
    model: 'gpt-5.4',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1_000,
    estimatedInputTokens: 200,
    estimatedOutputTokens: 75,
    estimatedCostUsd: 0.0005,
    ...overrides,
  };
}

function parseJsonLines(contents: string): StepCostRecord[] {
  return contents
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StepCostRecord);
}
