import { describe, expect, it } from 'vitest';

import { BudgetExceededError, BudgetTracker, type TokenUsage } from '../budget-tracker.js';

function expectUsage(actual: TokenUsage, expected: TokenUsage): void {
  expect(actual).toEqual(expected);
}

describe('BudgetTracker', () => {
  it('tracks usage across multiple steps', () => {
    const tracker = new BudgetTracker({ perAgent: 100, perWorkflow: 500 });

    tracker.recordUsage('planner', { input: 10, output: 5, cacheRead: 3 });
    tracker.recordUsage('writer', { input: 20, output: 4 });
    tracker.recordUsage('planner', { input: 1, output: 1, cacheRead: 2 });

    expectUsage(tracker.getStepUsage('planner'), {
      input: 11,
      output: 6,
      cacheRead: 5,
      total: 17,
    });
    expectUsage(tracker.getStepUsage('writer'), {
      input: 20,
      output: 4,
      cacheRead: 0,
      total: 24,
    });
    expectUsage(tracker.getTotalUsage(), {
      input: 31,
      output: 10,
      cacheRead: 5,
      total: 41,
    });
    // total = input + output (cacheRead excluded from budget)
    expect(tracker.getRemainingBudget()).toEqual({
      agent: 59,
      workflow: 459,
    });
  });

  it('detects when a step exceeds the per-agent budget', () => {
    const tracker = new BudgetTracker({ perAgent: 25, perWorkflow: 100 });

    tracker.recordUsage('specialist', { input: 18, output: 9 });

    expect(tracker.isOverBudget('specialist')).toEqual({
      over: true,
      reason: 'Step "specialist" exceeded per-agent budget (27/25)',
    });
  });

  it('detects when total usage exceeds the per-workflow budget', () => {
    const tracker = new BudgetTracker({ perAgent: 100, perWorkflow: 40 });

    tracker.recordUsage('step-a', { input: 10, output: 10 });
    tracker.recordUsage('step-b', { input: 15, output: 10 });

    expect(tracker.isOverBudget('step-b')).toEqual({
      over: true,
      reason: 'Workflow exceeded total budget (45/40)',
    });
    expect(tracker.checkCanSpawn('step-c')).toEqual({
      allowed: false,
      reason: 'Cannot spawn step-c: workflow budget exceeded (45/40)',
    });
  });

  it('refuses to spawn when the remaining workflow budget is nearly exhausted', () => {
    const tracker = new BudgetTracker({ perAgent: 100, perWorkflow: 250 });

    tracker.recordUsage('lead', { input: 120, output: 121 });

    expect(tracker.checkCanSpawn('reviewer')).toEqual({
      allowed: false,
      reason: 'Cannot spawn reviewer: remaining workflow budget 9 is below step budget 100',
    });
  });

  it('maintains correct totals when parallel steps record usage concurrently', async () => {
    const tracker = new BudgetTracker({ perAgent: 1_000, perWorkflow: 10_000 });

    await Promise.all(
      Array.from({ length: 40 }, async (_, index) => {
        await new Promise((resolve) => setTimeout(resolve, index % 5));
        tracker.recordUsage(`step-${index % 4}`, {
          input: 2,
          output: 3,
          cacheRead: 1,
        });
      })
    );

    expectUsage(tracker.getTotalUsage(), {
      input: 80,
      output: 120,
      cacheRead: 40,
      total: 200,
    });

    for (const stepName of ['step-0', 'step-1', 'step-2', 'step-3']) {
      expectUsage(tracker.getStepUsage(stepName), {
        input: 20,
        output: 30,
        cacheRead: 10,
        total: 50,
      });
    }
  });

  it('exposes budget metadata on BudgetExceededError', () => {
    const error = new BudgetExceededError('planner', 'workflow', 100, 125);

    expect(error.name).toBe('BudgetExceededError');
    expect(error.stepName).toBe('planner');
    expect(error.budgetType).toBe('workflow');
    expect(error.limit).toBe(100);
    expect(error.actual).toBe(125);
  });
});
