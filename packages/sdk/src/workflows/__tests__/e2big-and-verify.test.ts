import { describe, it, expect, vi } from 'vitest';

vi.mock('@relaycast/sdk', () => ({
  RelayCast: vi.fn(),
  RelayError: class RelayError extends Error {},
}));

vi.mock('../../relay.js', () => ({
  AgentRelay: vi.fn(),
}));

const { WorkflowRunner } = await import('../runner.js');

// ── Bug 1: E2BIG — buildNonInteractiveCommand stdin mode ────────────────────

describe('buildNonInteractiveCommand stdin mode (E2BIG fix)', () => {
  it('returns useStdin: false when stdin option is not set', () => {
    const result = WorkflowRunner.buildNonInteractiveCommand('claude', 'do stuff', []);
    expect(result.useStdin).toBe(false);
    expect(result.args).toContain('do stuff');
  });

  it('returns useStdin: true and omits task from args when stdin is requested', () => {
    const result = WorkflowRunner.buildNonInteractiveCommand('claude', 'big task', [], {
      stdin: true,
    });
    expect(result.useStdin).toBe(true);
    expect(result.args).not.toContain('big task');
    // Should contain the stdin placeholder '-'
    expect(result.args).toContain('-');
    // Should still contain the bypass flag
    expect(result.args).toContain('--dangerously-skip-permissions');
  });

  it('passes extra args through in stdin mode', () => {
    const result = WorkflowRunner.buildNonInteractiveCommand(
      'claude',
      'task',
      ['--model', 'opus'],
      { stdin: true }
    );
    expect(result.useStdin).toBe(true);
    expect(result.args).toContain('--model');
    expect(result.args).toContain('opus');
  });

  it('supports stdin mode for codex', () => {
    const result = WorkflowRunner.buildNonInteractiveCommand('codex', 'task', [], {
      stdin: true,
    });
    expect(result.useStdin).toBe(true);
    expect(result.args).toContain('exec');
    expect(result.args).not.toContain('task');
  });

  it('supports stdin mode for gemini', () => {
    const result = WorkflowRunner.buildNonInteractiveCommand('gemini', 'task', [], {
      stdin: true,
    });
    expect(result.useStdin).toBe(true);
    expect(result.args).not.toContain('task');
  });

  it('falls back to regular args when CLI has no stdin support and stdin is requested', () => {
    const result = WorkflowRunner.buildNonInteractiveCommand('claude', 'task', [], {
      stdin: true,
    });
    // claude does have stdin support, so useStdin should be true
    expect(result.useStdin).toBe(true);
  });

  it('exposes TASK_ARG_SIZE_LIMIT as a static property', () => {
    expect(WorkflowRunner.TASK_ARG_SIZE_LIMIT).toBe(100 * 1024);
  });

  it('returns useStdin: false when stdin is requested but explicitly false', () => {
    const result = WorkflowRunner.buildNonInteractiveCommand('claude', 'task', [], {
      stdin: false,
    });
    expect(result.useStdin).toBe(false);
    expect(result.args).toContain('task');
  });
});

// ── Bug 2: Verification token double-count ──────────────────────────────────

describe('runVerification output_contains (token double-count fix)', () => {
  function createRunner(): InstanceType<typeof WorkflowRunner> {
    return new WorkflowRunner({ cwd: '/tmp/test' });
  }

  function runVerification(
    runner: InstanceType<typeof WorkflowRunner>,
    check: { type: string; value: string },
    output: string,
    stepName: string,
    injectedTaskText?: string
  ) {
    return (runner as any).runVerification(
      check,
      output,
      stepName,
      injectedTaskText,
      { allowFailure: true }
    );
  }

  it('passes when token is in output and not in task injection', () => {
    const runner = createRunner();
    const result = runVerification(
      runner,
      { type: 'output_contains', value: 'DONE' },
      'Task completed. DONE',
      'step1'
    );
    expect(result.passed).toBe(true);
  });

  it('fails when token is missing from output entirely', () => {
    const runner = createRunner();
    const result = runVerification(
      runner,
      { type: 'output_contains', value: 'DONE' },
      'Task completed without the marker',
      'step1'
    );
    expect(result.passed).toBe(false);
    expect(result.error).toContain('does not contain "DONE"');
  });

  it('passes when token is in both task injection and agent output', () => {
    const runner = createRunner();
    // Output has the token twice: once from task echo, once from agent
    const result = runVerification(
      runner,
      { type: 'output_contains', value: 'REFLECTION_COMPLETE' },
      'Your task: output REFLECTION_COMPLETE when done\n\nI have finished. REFLECTION_COMPLETE',
      'step1',
      'Your task: output REFLECTION_COMPLETE when done'
    );
    expect(result.passed).toBe(true);
  });

  it('fails when token appears only in task injection (not produced by agent)', () => {
    const runner = createRunner();
    // Output only has the token from the task echo — agent didn't produce it
    const result = runVerification(
      runner,
      { type: 'output_contains', value: 'REFLECTION_COMPLETE' },
      'Your task: output REFLECTION_COMPLETE when done\n\nI worked on it but forgot the marker.',
      'step1',
      'Your task: output REFLECTION_COMPLETE when done'
    );
    expect(result.passed).toBe(false);
    expect(result.error).toContain('token found only in task injection');
  });

  it('handles token appearing multiple times in task injection', () => {
    const runner = createRunner();
    // Task injection has the token twice, output has it three times total
    // (two from task echo + one from agent) — should pass
    const taskText = 'Output DONE when done. Remember: DONE is required.';
    const output = taskText + '\n\nAll work complete. DONE';
    const result = runVerification(
      runner,
      { type: 'output_contains', value: 'DONE' },
      output,
      'step1',
      taskText
    );
    expect(result.passed).toBe(true);
  });

  it('fails when token appears same number of times as in task injection', () => {
    const runner = createRunner();
    // Task has token twice, output also has it exactly twice (all from task echo)
    const taskText = 'Output DONE when done. Remember: DONE is required.';
    const output = taskText + '\n\nAll work complete but no marker here.';
    const result = runVerification(
      runner,
      { type: 'output_contains', value: 'DONE' },
      output,
      'step1',
      taskText
    );
    expect(result.passed).toBe(false);
  });

  it('passes when no task injection and token is in output', () => {
    const runner = createRunner();
    const result = runVerification(
      runner,
      { type: 'output_contains', value: 'SUCCESS' },
      'Operation: SUCCESS',
      'step1',
      undefined
    );
    expect(result.passed).toBe(true);
  });

  it('handles empty token gracefully', () => {
    const runner = createRunner();
    // Empty token should fail (countOccurrences returns 0 for empty needle)
    const result = runVerification(
      runner,
      { type: 'output_contains', value: '' },
      'some output',
      'step1'
    );
    expect(result.passed).toBe(false);
  });
});
