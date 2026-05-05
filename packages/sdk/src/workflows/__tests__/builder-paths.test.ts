import { describe, it, expect } from 'vitest';

import { WorkflowBuilder } from '../builder.js';

describe('WorkflowBuilder.paths()', () => {
  it('records the declared paths on toConfig() output', () => {
    const config = new WorkflowBuilder('multi-repo')
      .paths([
        { name: 'alpha', path: 'alpha', description: 'Demo repo A' },
        { name: 'beta', path: 'beta', description: 'Demo repo B' },
      ])
      .agent('worker', { cli: 'codex' })
      .step('noop', { type: 'deterministic', command: 'true' })
      .toConfig();

    expect(config.paths).toEqual([
      { name: 'alpha', path: 'alpha', description: 'Demo repo A' },
      { name: 'beta', path: 'beta', description: 'Demo repo B' },
    ]);
  });

  it('omits the paths field entirely when none are declared', () => {
    const config = new WorkflowBuilder('single-repo')
      .agent('worker', { cli: 'codex' })
      .step('noop', { type: 'deterministic', command: 'true' })
      .toConfig();

    expect(config.paths).toBeUndefined();
  });

  it('does not allow downstream callers to mutate the recorded paths via the input array', () => {
    const original = [{ name: 'alpha', path: 'alpha' }];
    const builder = new WorkflowBuilder('mutation-guard')
      .paths(original)
      .agent('w', { cli: 'codex' })
      .step('s', { type: 'deterministic', command: 'true' });

    // Mutating the original array AFTER passing it in should not change
    // the config the builder emits.
    original.push({ name: 'beta', path: 'beta' });
    original[0].name = 'mutated';

    const config = builder.toConfig();
    expect(config.paths).toEqual([{ name: 'alpha', path: 'alpha' }]);
  });

  it('rejects non-array inputs', () => {
    const builder = new WorkflowBuilder('bad-input');
    // @ts-expect-error — runtime guard, not a type-level test
    expect(() => builder.paths('not-an-array')).toThrow(/expects an array/);
  });

  it('rejects entries missing name or path', () => {
    const builder = new WorkflowBuilder('bad-entry');
    // @ts-expect-error — runtime guard
    expect(() => builder.paths([{ name: 'alpha' }])).toThrow(/string `name` and `path`/);
    // @ts-expect-error — runtime guard
    expect(() => builder.paths([{ path: 'beta' }])).toThrow(/string `name` and `path`/);
  });

  it('rejects duplicate path names', () => {
    const builder = new WorkflowBuilder('dup');
    expect(() =>
      builder.paths([
        { name: 'alpha', path: 'alpha' },
        { name: 'alpha', path: 'alpha-also' },
      ])
    ).toThrow(/duplicate entry name "alpha"/);
  });

  it('returns the builder so the call chains', () => {
    const builder = new WorkflowBuilder('chain');
    const returned = builder.paths([{ name: 'alpha', path: 'alpha' }]);
    expect(returned).toBe(builder);
  });
});
