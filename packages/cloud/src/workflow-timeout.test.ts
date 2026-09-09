import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WORKFLOW_LAUNCH_TIMEOUT_MS,
  MAX_WORKFLOW_LAUNCH_TIMEOUT_MS,
  MIN_EXPLICIT_WORKFLOW_LAUNCH_TIMEOUT_MS,
  inferWorkflowLaunchTimeoutMs,
  resolveWorkflowLaunchTimeoutMs,
} from './workflow-timeout.js';

describe('workflow launch timeout inference', () => {
  it('reads an underscored TypeScript builder timeout without executing the workflow', () => {
    const source = "const result = await workflow('proof').timeout(3_300_000).run();";
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(3_300_000);
  });

  it('ignores timeout-shaped text in TypeScript comments, strings, and templates', () => {
    const source = [
      "// workflow('comment').timeout(3_300_000)",
      "/* workflow('block').timeout(3_200_000) */",
      'const quoted = ".timeout(3_100_000)";',
      'const template = `.timeout(3_000_000)`;',
      "workflow('real').timeout(900_000).run();",
    ].join('\n');
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(900_000);
  });

  it('reads Python literals while ignoring comments and string bodies', () => {
    const source = [
      '# workflow("comment").timeout(3_300_000)',
      'description = """.timeout(3_200_000)"""',
      'workflow("real").timeout(600_000).run()',
    ].join('\n');
    expect(inferWorkflowLaunchTimeoutMs(source, 'py')).toBe(600_000);
  });

  it('uses the legacy five-minute floor for shorter workflow deadlines', () => {
    expect(inferWorkflowLaunchTimeoutMs("workflow('fast').timeout(1_000).run()", 'ts')).toBe(
      DEFAULT_WORKFLOW_LAUNCH_TIMEOUT_MS
    );
  });

  it('does not guess dynamic timeout expressions', () => {
    expect(
      inferWorkflowLaunchTimeoutMs("workflow('dynamic').timeout(timeoutMs).run()", 'ts')
    ).toBeUndefined();
  });

  it('requires an explicit override when distinct builder timeouts are present', () => {
    const source = "workflow('a').timeout(600_000); workflow('b').timeout(900_000);";
    expect(() => inferWorkflowLaunchTimeoutMs(source, 'ts')).toThrow(/multiple distinct/);
    expect(resolveWorkflowLaunchTimeoutMs(source, 'ts', 1_200_000)).toBe(1_200_000);
  });

  it('rejects non-integer and oversized explicit budgets', () => {
    expect(() => resolveWorkflowLaunchTimeoutMs('', 'ts', Number.NaN)).toThrow(/safe integer/);
    expect(() =>
      resolveWorkflowLaunchTimeoutMs('', 'ts', MIN_EXPLICIT_WORKFLOW_LAUNCH_TIMEOUT_MS - 1)
    ).toThrow(/must be at least/);
    expect(() => resolveWorkflowLaunchTimeoutMs('', 'ts', MAX_WORKFLOW_LAUNCH_TIMEOUT_MS + 1)).toThrow(
      /must not exceed/
    );
  });
});
