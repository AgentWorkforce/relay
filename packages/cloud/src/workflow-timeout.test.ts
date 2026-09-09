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

  it('ignores timeout-shaped text in TypeScript regular expressions', () => {
    expect(
      inferWorkflowLaunchTimeoutMs(
        'const pattern = /foo.timeout(600_000)/; if (ready) /workflow("fake").timeout(500_000)/;',
        'ts'
      )
    ).toBeUndefined();
  });

  it('ignores a regular-expression timeout while inferring the real builder timeout', () => {
    const source = 'const pattern = /foo.timeout(600_000)/; workflow("real").timeout(900_000).run();';
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBe(900_000);
  });

  it('ignores timeout methods on unrelated objects', () => {
    expect(inferWorkflowLaunchTimeoutMs('httpClient.timeout(600_000);', 'ts')).toBeUndefined();
  });

  it('does not treat a bare workflow object identifier as a builder', () => {
    expect(
      inferWorkflowLaunchTimeoutMs('const workflow = {}; workflow.timeout(600_000);', 'ts')
    ).toBeUndefined();
  });

  it('masks a regular expression after a block statement', () => {
    expect(
      inferWorkflowLaunchTimeoutMs('if (ready) {} /workflow("fake").timeout(500_000)/;', 'ts')
    ).toBeUndefined();
  });

  it('supports the fluent and assigned RelayFlow builder shapes used by workflows', () => {
    expect(
      inferWorkflowLaunchTimeoutMs("const wf = workflow('real').description('demo').timeout(900_000);", 'ts')
    ).toBe(900_000);
    expect(inferWorkflowLaunchTimeoutMs("const wf = workflow('real'); wf.timeout(600_000);", 'ts')).toBe(
      600_000
    );
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

  it('does not infer a literal when another builder timeout is dynamic', () => {
    const source = "workflow('dynamic').timeout(timeoutMs); workflow('literal').timeout(900_000);";
    expect(inferWorkflowLaunchTimeoutMs(source, 'ts')).toBeUndefined();
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
