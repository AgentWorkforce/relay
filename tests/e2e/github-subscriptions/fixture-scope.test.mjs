import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubIssueCommentPath } from '@relayfile/adapter-github/path-mapper';
import {
  fixturePathGlob,
  fixtureTitle,
  assertProducerWorkspace,
  findFixtureCommentMessage,
} from './fixture-scope.mjs';

test('PR comment scope contains the adapter-written record and excludes adjacent PR numbers', () => {
  const fixture = { repo: 'AgentWorkforce/relay', pr: 1714 };
  const runId = 'ghsub-proof-123';
  const prefix = fixturePathGlob(fixture, 'issue', runId).slice(0, -2);
  assert(
    githubIssueCommentPath('AgentWorkforce', 'relay', 1714, 5602331117, fixtureTitle(runId)).startsWith(
      prefix
    )
  );
  assert(
    !githubIssueCommentPath('AgentWorkforce', 'relay', 17140, 5602331117, fixtureTitle(runId)).startsWith(
      prefix
    )
  );
  assert(!prefix.includes('/issues/1714/'));
});
test('requires a pinned runtime workspace and rejects the app UUID', () => {
  assert.doesNotThrow(() => assertProducerWorkspace('rw_bound', 'rw_bound'));
  assert.throws(
    () => assertProducerWorkspace('rw_bound', '50587328-441d-4acb-b8f3-dbe1b3c5de99'),
    /workspace mismatch/
  );
  assert.throws(() => assertProducerWorkspace(undefined, 'rw_bound'), /workspace mismatch/);
});

test('selects the canonical comment even when a newer legacy copy has the same nonce', () => {
  const stimulus = { repo: 'AgentWorkforce/relay', pr: 1714, commentId: 5602331117, nonce: 'event-only' };
  const runId = 'ghsub-proof-123';
  const canonicalPath = githubIssueCommentPath(
    'AgentWorkforce',
    'relay',
    1714,
    stimulus.commentId,
    fixtureTitle(runId)
  );
  const canonical = {
    id: 'canonical',
    text: 'GHSUB_EVENT_NONCE=event-only',
    metadata: { path: canonicalPath, provider_event_type: 'issue_comment.created' },
  };
  const legacy = {
    ...canonical,
    id: 'legacy',
    metadata: { path: canonicalPath.replace('/meta.json', '.json') },
  };
  assert.equal(findFixtureCommentMessage([legacy, canonical], stimulus, runId), canonical);
  assert.equal(findFixtureCommentMessage([legacy], stimulus, runId), undefined);
  assert.equal(
    findFixtureCommentMessage([canonical], { ...stimulus, commentId: 5602331118 }, runId),
    undefined
  );
  assert.equal(findFixtureCommentMessage([canonical], { ...stimulus, nonce: 'different' }, runId), undefined);
  // Selection must not invent or filter away missing authentication metadata:
  // the caller's semantic assertion still fails if the canonical record is untrusted.
  const untrusted = { ...canonical, metadata: { path: canonicalPath } };
  assert.equal(findFixtureCommentMessage([untrusted], stimulus, runId), untrusted);
  assert.equal(
    findFixtureCommentMessage([untrusted], stimulus, runId).metadata.provider_event_type,
    undefined
  );
});
