import { describe, expect, it } from 'vitest';

import { BudgetExceededError, BudgetTracker } from '../budget-tracker.js';

describe('BudgetTracker', () => {
  it('tracks usage across multiple steps', () => {
    const tracker = new BudgetTracker({ perAgent: 100, perWorkflow: 500 });

    tracker.recordUsage('plan', { input: 10, output: 5, cacheRead: 3 });
    tracker.recordUsage('plan', { input: 1, output: 2 });
    tracker.recordUsage('implement', { input: 20, output: 8, cacheRead: 4 });

    expect(tracker.getStepUsage('plan')).toEqual({
      input: 11,
      output: 7,
      cacheRead: 3,
      total: 18,
    });
    expect(tracker.getStepUsage('implement')).toEqual({
      input: 20,
      output: 8,
      cacheRead: 4,
      total: 28,
    });
    expect(tracker.getTotalUsage()).toEqual({
      input: 31,
      output: 15,
      cacheRead: 7,
      total: 46,
    });
    expect(tracker.getRemainingBudget()).toEqual({
      agent: 72,
      workflow: 454,
    });
  });

  it('detects per-agent budget overruns without counting cache reads', () => {
    const tracker = new BudgetTracker({ perAgent: 30 });

    tracker.recordUsage('worker-a', { input: 20, output: 15, cacheRead: 999 });

    expect(tracker.isOverBudget('worker-a')).toEqual({
      over: true,
      reason: 'Step "worker-a" exceeded per-agent budget (35/30 tokens used)',
    });
  });

  it('detects per-workflow budget overruns', () => {
    const tracker = new BudgetTracker({ perWorkflow: 50 });

    tracker.recordUsage('step-1', { input: 20, output: 10 });
    tracker.recordUsage('step-2', { input: 5, output: 20 });

    expect(tracker.isOverBudget('step-2')).toEqual({
      over: true,
      reason: 'Workflow budget exceeded after step "step-2" (55/50 tokens used)',
    });
    expect(tracker.getRemainingBudget()).toEqual({
      agent: null,
      workflow: -5,
    });
  });

  it('prevents spawning when workflow budget is nearly exhausted', () => {
    const tracker = new BudgetTracker({ perAgent: 100, perWorkflow: 500 });

    tracker.recordUsage('planner', { input: 250, output: 241 });

    expect(tracker.checkCanSpawn('implementer')).toEqual({
      allowed: false,
      reason: 'Cannot spawn "implementer": remaining workflow budget 9 is below 10% of per-agent budget 10',
    });
  });

  it('maintains correct totals when async callers record usage in parallel', async () => {
    const tracker = new BudgetTracker({ perAgent: 1_000, perWorkflow: 1_000 });

    await Promise.all(
      Array.from({ length: 100 }, async (_, index) => {
        await Promise.resolve();
        tracker.recordUsage(`step-${index % 4}`, {
          input: 2,
          output: 3,
          cacheRead: index % 2,
        });
      }),
    );

    expect(tracker.getTotalUsage()).toEqual({
      input: 200,
      output: 300,
      cacheRead: 50,
      total: 500,
    });
    expect(tracker.getStepUsage('step-0').total).toBe(125);
    expect(tracker.getStepUsage('step-1').total).toBe(125);
    expect(tracker.getStepUsage('step-2').total).toBe(125);
    expect(tracker.getStepUsage('step-3').total).toBe(125);
  });
});

describe('BudgetExceededError', () => {
  it('exposes structured budget overrun details', () => {
    const error = new BudgetExceededError('review', 'workflow', 500, 550);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('BudgetExceededError');
    expect(error.message).toBe('Workflow exceeded workflow budget: 550 tokens used of 500');
    expect(error.stepName).toBe('review');
    expect(error.budgetType).toBe('workflow');
    expect(error.limit).toBe(500);
    expect(error.actual).toBe(550);
  });
});
