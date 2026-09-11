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

test('review, thread, and check scopes use exact adapter record paths outside PR directories', async () => {
  const { fixtureExpected } = await import('./fixture-scope.mjs');
  const stimulus = {
    repo: 'AgentWorkforce/relay',
    pr: 1714,
    headSha: 'a'.repeat(40),
    file: 'owned.txt',
    line: 2,
    side: 'RIGHT',
  };
  const review = {
    id: '9007199254740993',
    user: { login: 'owner' },
    pull_request_review_id: '123',
    submitted_at: '2026-09-11T12:00:00Z',
  };
  for (const [kind, directory] of [
    ['review', 'reviews'],
    ['thread', 'comments'],
    ['ci', 'checks'],
  ]) {
    const expected = fixtureExpected({ ...stimulus, kind }, { ...review, name: 'owned-check' }, 'test-123');
    assert.equal(expected.path, `/github/repos/AgentWorkforce/relay/${directory}/${review.id}.json`);
    assert.equal(expected.record.id, review.id);
    assert(!expected.path.startsWith(fixturePathGlob(stimulus, 'pr', 'test-123').slice(0, -2)));
  }
  assert.throws(
    () => fixtureExpected({ ...stimulus, kind: 'review' }, { ...review, id: Number(review.id) }, 'test-123'),
    /lossless/
  );
  assert.throws(
    () =>
      fixtureExpected(
        { ...stimulus, kind: 'thread' },
        { ...review, pull_request_review_id: undefined },
        'test-123'
      ),
    /Incomplete/
  );
});

test('semantic fixture identity pins thread location, submitted review time and owned merge base', async () => {
  const { fixtureExpected } = await import('./fixture-scope.mjs');
  const stimulus = {
    repo: 'AgentWorkforce/relay',
    pr: 1714,
    headSha: 'a'.repeat(40),
    base: 'ghsub-demo/test-123/base',
    file: 'owned.txt',
    line: 2,
    side: 'RIGHT',
  };
  const record = {
    id: '123',
    user: { login: 'owner' },
    pull_request_review_id: '456',
    submitted_at: '2026-09-11T12:00:00Z',
    merge_commit_sha: 'b'.repeat(40),
  };
  const thread = fixtureExpected({ ...stimulus, kind: 'thread' }, record, 'test-123');
  assert.equal(thread.record.line, 2);
  assert.equal(thread.record.side, 'RIGHT');
  const review = fixtureExpected({ ...stimulus, kind: 'review' }, record, 'test-123');
  assert.equal(review.record.submitted_at, record.submitted_at);
  const merge = fixtureExpected({ ...stimulus, kind: 'merge' }, record, 'test-123');
  assert.equal(merge.record.base.ref, stimulus.base);
});

test('rejects malformed captured review dates and lossy review associations', async () => {
  const { fixtureExpected } = await import('./fixture-scope.mjs');
  const stimulus = {
    repo: 'AgentWorkforce/relay',
    pr: 123,
    headSha: 'a'.repeat(40),
    file: 'owned.txt',
    line: 2,
    side: 'RIGHT',
  };
  const record = {
    id: '456',
    user: { login: 'owner' },
    submitted_at: '2026-09-11T12:00:00Z',
    pull_request_review_id: '9007199254740993',
  };
  assert.doesNotThrow(() => fixtureExpected({ ...stimulus, kind: 'thread' }, record, 'test'));
  for (const id of [null, undefined, 'null', 'undefined', 9007199254740992, 0, -1])
    assert.throws(() =>
      fixtureExpected({ ...stimulus, kind: 'thread' }, { ...record, pull_request_review_id: id }, 'test')
    );
  for (const submitted_at of ['not-a-date', '', null])
    assert.throws(() =>
      fixtureExpected({ ...stimulus, kind: 'review' }, { ...record, submitted_at }, 'test')
    );
});
