import { describe, expect, it, vi } from 'vitest';

import { formatRunSummaryTable } from '../run-summary-table.js';

vi.mock('@relaycast/sdk', () => ({
  RelayCast: vi.fn(),
  RelayError: class RelayError extends Error {},
}));

vi.mock('../../relay.js', () => ({
  AgentRelay: vi.fn(),
}));

const { WorkflowRunner } = await import('../runner.js');

describe('formatRunSummaryTable', () => {
  it('renders all-passing steps', () => {
    const output = formatRunSummaryTable(
      [
        { name: 'plan', agent: 'lead', status: 'completed', attempts: 1, durationMs: 1_000 },
        { name: 'implement', agent: 'worker', status: 'completed', attempts: 1, durationMs: 2_000 },
      ],
      new Map([
        [
          'plan',
          {
            cli: 'claude',
            sessionId: 's1',
            model: 'claude-sonnet-4',
            provider: 'anthropic',
            durationMs: 1_200,
            cost: 0.75,
            tokens: { input: 100, output: 50, cacheRead: 10 },
            turns: 2,
            toolCalls: [],
            errors: [],
            finalStatus: 'completed',
            summary: 'planned',
          },
        ],
        [
          'implement',
          {
            cli: 'codex',
            sessionId: 's2',
            model: 'gpt-5',
            provider: 'openai',
            durationMs: 3_400,
            cost: 1.25,
            tokens: { input: 300, output: 90, cacheRead: 20 },
            turns: 4,
            toolCalls: [],
            errors: [{ turn: 2, text: 'Error: recovered after retry' }],
            finalStatus: 'completed',
            summary: 'implemented',
          },
        ],
      ]),
    );

    expect(output).toMatchInlineSnapshot(`
      "  Step                  Status  Model                 Cost      Tokens    Duration      Errors
        plan                  pass    claude-sonnet-4      $0.75         160          1s          --
        implement             pass    gpt-5                $1.25         410          3s   1 (fixed)
        ────────────────────────────────────────────────────────────────────────────────────────────
        Total                                              $2.00         570          5s            "
    `);
  });

  it('renders a failed step with the first error line', () => {
    const output = formatRunSummaryTable(
      [{ name: 'broken-step', agent: 'worker', status: 'failed', attempts: 1, durationMs: 1_500, error: 'boom' }],
      new Map([
        [
          'broken-step',
          {
            cli: 'opencode',
            sessionId: 's3',
            model: 'gpt-5',
            provider: 'openai',
            durationMs: 1_500,
            cost: 0.01,
            tokens: { input: 10, output: 5, cacheRead: 0 },
            turns: 1,
            toolCalls: [],
            errors: [{ turn: 1, text: 'Error: database locked' }],
            finalStatus: 'failed',
            summary: null,
          },
        ],
      ]),
    );

    expect(output).toContain('broken-step           FAIL');
    expect(output).toContain('  └─ Error [turn 1] Error: database locked');
  });

  it('renders deterministic steps without reports using placeholder columns', () => {
    const output = formatRunSummaryTable(
      [{ name: 'lint', agent: 'shell', status: 'completed', attempts: 1, durationMs: 900 }],
      new Map(),
    );

    expect(output).toContain('lint                  pass    --');
    expect(output).toContain('--');
    // No reports means no cost column
    expect(output).not.toContain('Cost');
  });

  it('hides Cost column when no report has reliable cost data', () => {
    const output = formatRunSummaryTable(
      [
        { name: 'gen-code', agent: 'worker', status: 'completed', attempts: 1, durationMs: 5_000 },
      ],
      new Map([
        [
          'gen-code',
          {
            cli: 'claude',
            sessionId: 's1',
            model: 'claude-sonnet-4',
            provider: 'anthropic',
            durationMs: 5_000,
            cost: null,
            tokens: { input: 200, output: 80, cacheRead: 0 },
            turns: 3,
            toolCalls: [],
            errors: [],
            finalStatus: 'completed',
            summary: 'done',
          },
        ],
      ]),
    );

    expect(output).not.toContain('Cost');
    expect(output).toContain('Tokens');
    expect(output).toContain('280');
  });
});

describe('WorkflowRunner logRunSummary', () => {
  it('falls back to the legacy summary format when no reports exist', () => {
    const runner = new WorkflowRunner({ cwd: '/tmp/workflow-runner' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    (runner as any).logRunSummary(
      'sample-workflow',
      [{ name: 'lint', agent: 'shell', status: 'completed', attempts: 1, output: 'ok' }],
      'run-1',
    );

    const combined = logSpy.mock.calls.flat().join('\n');
    expect(combined).toContain('Workflow "sample-workflow"');
    expect(combined).toContain('✓ lint [shell]');
    expect(combined).not.toContain('Step                  Status');

    logSpy.mockRestore();
  });
});
