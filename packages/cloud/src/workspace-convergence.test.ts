import { describe, expect, it } from 'vitest';

import { describeDataPlaneConvergence, formatDataPlaneDivergence } from './workspace-convergence.js';

describe('describeDataPlaneConvergence', () => {
  it('reports one shared data-plane ID when all three planes agree', () => {
    expect(
      describeDataPlaneConvergence({
        relaycastWorkspaceId: 'rw_7ccfea89',
        relayfileWorkspaceId: 'rw_7ccfea89',
        relayauthWorkspaceId: 'rw_7ccfea89',
      })
    ).toEqual({
      unified: true,
      workspaceId: 'rw_7ccfea89',
      planes: { relaycast: 'rw_7ccfea89', relayfile: 'rw_7ccfea89', relayauth: 'rw_7ccfea89' },
      divergent: [],
    });
  });

  it('names the planes that disagree and withholds a shared ID', () => {
    const convergence = describeDataPlaneConvergence({
      relaycastWorkspaceId: 'rw_a',
      relayfileWorkspaceId: 'rw_b',
      relayauthWorkspaceId: 'rw_a',
    });

    expect(convergence.unified).toBe(false);
    expect(convergence.workspaceId).toBeUndefined();
    expect(convergence.divergent).toEqual(['relayfile']);
  });

  it('treats a cloud control-plane ID as irrelevant to data-plane convergence', () => {
    // The cloud workspace is a UUID in a different id space; including it would
    // make every healthy workspace look divergent.
    expect(
      describeDataPlaneConvergence({
        relaycastWorkspaceId: 'rw_same',
        relayfileWorkspaceId: 'rw_same',
        relayauthWorkspaceId: 'rw_same',
      }).unified
    ).toBe(true);
  });

  it('describes a divergence with every plane ID so the report is actionable', () => {
    const message = formatDataPlaneDivergence(
      describeDataPlaneConvergence({
        relaycastWorkspaceId: 'rw_a',
        relayfileWorkspaceId: 'rw_b',
        relayauthWorkspaceId: 'rw_c',
      })
    );

    expect(message).toContain('relaycast=rw_a');
    expect(message).toContain('relayfile=rw_b');
    expect(message).toContain('relayauth=rw_c');
  });
});
