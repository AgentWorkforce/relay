import { describe, expect, it } from 'vitest';

import { declaredWorkforceMetadata } from './registration-metadata.js';

describe('declaredWorkforceMetadata', () => {
  it('trims declared fields and omits blank ones', () => {
    expect(
      declaredWorkforceMetadata({
        organization: '  Agent Workforce  ',
        project: '',
        workstream: '   ',
        role: 'implementer',
        objective: 'Publish registration metadata',
      })
    ).toEqual({
      organization: 'Agent Workforce',
      role: 'implementer',
      objective: 'Publish registration metadata',
    });
  });

  it('falls back to the task for objective, and prefers an explicit one', () => {
    expect(declaredWorkforceMetadata({}, 'the initial brief')).toEqual({
      objective: 'the initial brief',
    });
    expect(declaredWorkforceMetadata({ objective: 'ship it' }, 'the initial brief')).toEqual({
      objective: 'ship it',
    });
  });

  // `??` alone would keep the blank, suppress the fallback, and then drop the
  // key at the trim step — leaving no objective at all. The broker filters
  // blanks before its own fallback, so these two surfaces must agree.
  it('treats a blank objective as absent so the task fallback still applies', () => {
    expect(declaredWorkforceMetadata({ objective: '   ' }, 'the initial brief')).toEqual({
      objective: 'the initial brief',
    });
    expect(declaredWorkforceMetadata({ objective: '   ' }, '   ')).toEqual({});
  });

  // The guard callers rely on is `Object.keys(...).length > 0`, so "nothing
  // declared" has to produce a genuinely empty object — an `objective:
  // undefined` key would make that guard always true.
  it('returns an empty object when nothing is declared', () => {
    const metadata = declaredWorkforceMetadata({ organization: '   ' }, '  ');
    expect(metadata).toEqual({});
    expect(Object.keys(metadata)).toHaveLength(0);
  });
});
