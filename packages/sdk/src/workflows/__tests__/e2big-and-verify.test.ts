import { describe, expect, it, vi } from 'vitest';

vi.mock('@relaycast/sdk', () => ({
  RelayCast: vi.fn(),
  RelayError: class RelayError extends Error {},
}));

vi.mock('../../relay.js', () => ({
  AgentRelay: vi.fn(),
}));

const { WorkflowRunner } = await import('../runner.js');

describe('runVerification output_contains (token double-count fix)', () => {
  function createRunner(): InstanceType<typeof WorkflowRunner> {
    return new WorkflowRunner({ cwd: '/tmp/test' });
  }

  function runVerification(
    runner: InstanceType<typeof WorkflowRunner>,
    check: { type: 'output_contains'; value: string },
    output: string,
    stepName: string,
    injectedTaskText?: string
  ) {
    return (runner as any).runVerification(check, output, stepName, injectedTaskText, {
      allowFailure: true,
    });
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
    const result = runVerification(
      runner,
      { type: 'output_contains', value: 'REFLECTION_COMPLETE' },
      'Your task: output REFLECTION_COMPLETE when done\n\nI worked on it but forgot the marker.',
      'step1',
      'Your task: output REFLECTION_COMPLETE when done'
    );
    expect(result.passed).toBe(false);
    expect(result.error).toContain('does not contain "REFLECTION_COMPLETE"');
  });

  it('handles token appearing multiple times in task injection', () => {
    const runner = createRunner();
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

  it('handles empty token gracefully', () => {
    const runner = createRunner();
    const result = runVerification(
      runner,
      { type: 'output_contains', value: '' },
      'some output',
      'step1'
    );
    expect(result.passed).toBe(false);
  });
});
