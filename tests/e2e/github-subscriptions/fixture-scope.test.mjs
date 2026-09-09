import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubIssueCommentPath } from '@relayfile/adapter-github/path-mapper';
import { fixturePathGlob, fixtureTitle, assertProducerWorkspace } from './fixture-scope.mjs';

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
