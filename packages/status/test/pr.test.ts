import { describe, it, expect } from 'vitest';
import {
  initialSessionWorkStatus,
  transitionSessionWorkStatus,
  type SessionWorkStatus,
} from '../src/work.js';
import { nextPrWorkEvent, type PrWorkEvidence, type PrWorkEpisode } from '../src/pr.js';
const now = '2026-10-13T12:00:00Z';
const identity = { organizationId: 'org', workspaceId: 'workspace', source: 'codex', sessionId: 'session' };
const url = 'https://github.com/acme/repo/pull/1';
const episode: PrWorkEpisode = {
  identity,
  workEpisodeId: 'episode_1',
  required: [{ dependencyId: 'pr1', url }],
};
const snapshot: PrWorkEvidence = {
  url,
  headSha: 'a'.repeat(40),
  state: 'merged',
  mergedAt: now,
  observedAt: now,
  review: 'approved',
  checks: 'success',
};
const status = (): SessionWorkStatus => ({
  ...initialSessionWorkStatus(identity),
  workEpisodeId: 'episode_1',
  revision: 5,
  state: 'waiting_on_pr',
  reason: 'pr_ci',
  dependencies: [{ id: 'pr1', target: url, kind: 'pr', state: 'pending' }],
});
const next = (s = status(), evidence = [snapshot], e = episode) =>
  nextPrWorkEvent({
    episode: e,
    status: s,
    evidence,
    now,
    producerId: 'cloud-pr-v1',
    eventId: `pr-event-${s.revision}`,
  });

describe('episode-scoped PR work evidence', () => {
  it("resolves a required merge before finishing and replays Relay core's real reducer", () => {
    const resolve = next()!;
    expect(resolve.kind).toBe('resolve_dependency');
    const resolved = transitionSessionWorkStatus(status(), resolve);
    expect(resolved.outcome).toBe('applied');
    const complete = next(resolved.status)!;
    expect(complete.kind).toBe('complete');
    expect(transitionSessionWorkStatus(resolved.status, complete).status.state).toBe('done');
  });
  it.each(['working', 'needs_attention', 'waiting_on_agent', 'done', 'archived'] as const)(
    'never overwrites %s with a merge',
    (state) => {
      expect(next({ ...status(), state })).toBeNull();
    }
  );
  it('refuses a historical episode, contributor link, different tenant, stale evidence, or undeclared dependency', () => {
    expect(next({ ...status(), workEpisodeId: 'new-work' })).toBeNull();
    expect(
      next(status(), [snapshot], { ...episode, required: [{ dependencyId: 'contributor', url }] })
    ).toBeNull();
    expect(next({ ...status(), identity: { ...identity, workspaceId: 'other' } })).toBeNull();
    expect(next(status(), [{ ...snapshot, observedAt: '2026-10-13T11:00:00Z' }])).toBeNull();
    expect(next({ ...status(), dependencies: [] })).toBeNull();
  });
  it('does not finish until every required PR is merged and every dependency is resolved', () => {
    const second = { dependencyId: 'pr2', url: url.replace('/1', '/2') };
    const both = { ...episode, required: [...episode.required, second] };
    const s = {
      ...status(),
      dependencies: [
        ...status().dependencies,
        { id: 'pr2', target: second.url, kind: 'pr' as const, state: 'pending' as const },
      ],
    };
    expect(next(s, [snapshot], both)).toBeNull();
    const evidence = [snapshot, { ...snapshot, url: second.url, state: 'open' as const, mergedAt: null }];
    const resolved = transitionSessionWorkStatus(s, next(s, evidence, both)!).status;
    expect(next(resolved, evidence, both)?.kind).not.toBe('complete');
    expect(
      next({
        ...status(),
        dependencies: [
          ...status().dependencies,
          { id: 'human', kind: 'human', target: 'owner', state: 'pending' },
        ],
      })
    ).toBeNull();
  });
  it('rechecks review/CI reasons without declaring failures human blockers', () => {
    expect(
      next(status(), [{ ...snapshot, state: 'open', checks: 'success', review: 'pending' }])
    ).toMatchObject({ kind: 'wait', reason: 'pr_review' });
    expect(next(status(), [{ ...snapshot, state: 'open' }])).toMatchObject({
      kind: 'wait',
      reason: 'pr_merge',
    });
    expect(next(status(), [{ ...snapshot, state: 'closed', mergedAt: null }])).toBeNull();
  });
});
