import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emitStimulus } from './emission.mjs';
import { validFixtureExpected } from './fixture-scope.mjs';
import { semanticMatches } from './proof.mjs';
function emission(failReadback) {
  const owned = {
    repo: 'AgentWorkforce/relay',
    pr: 123,
    file: 'owned.txt',
    headSha: 'b'.repeat(40),
    base: 'ghsub-demo/review-0911/base',
    head: 'ghsub-demo/review-0911/head',
    branches: ['ghsub-demo/review-0911/base', 'ghsub-demo/review-0911/head'],
    comments: [],
    reviews: [],
  };
  const manifest = { createdAt: '2026-09-11T12:00:00Z', fixtures: [owned], stimuli: [] };
  const saves = [],
    calls = [];
  let reads = 0;
  const context = {
    args: ['relay', 'merge', '--busy'],
    manifest,
    config: { runId: 'review-0911', receiver: 'chief' },
    fixtureName: (r) => r.split('/')[1],
    readLines: () => [],
    log() {},
    save: () => saves.push(structuredClone(manifest)),
    gh: (endpoint, method = 'GET') => {
      calls.push({ endpoint, method });
      if (method === 'GET') {
        if (++reads === 2 && failReadback) throw new Error('synthetic post-merge read failure');
        return {
          id: '456',
          base: { ref: owned.base },
          head: { ref: owned.head, sha: owned.headSha },
          user: { login: 'owner' },
          merge_commit_sha: 'c'.repeat(40),
        };
      }
      if (method === 'PUT') return { merged: true, sha: 'c'.repeat(40) };
      return {};
    },
  };
  let error;
  try {
    emitStimulus(context);
  } catch (e) {
    error = e.message;
  }
  return { error, calls, saved: saves.at(-1), inMemory: manifest };
}

for (const failReadback of [false, true])
  test(`merge acknowledgement survives readback failure=${failReadback}`, () => {
    const result = emission(failReadback);
    assert.equal(result.error, failReadback ? 'synthetic post-merge read failure' : undefined);
    assert.equal(result.saved.fixtures[0].merged, true);
    assert.equal(result.saved.fixtures[0].baseSha, 'c'.repeat(40));
    assert.equal(result.saved.stimuli[0].accepted, true);
    if (failReadback) assert.equal(result.saved.stimuli[0].expected, undefined);
  });

function threadEmission(association, reply) {
  const fixture = { repo: 'owner/relay', pr: 123, file: 'owned.txt', headSha: 'a'.repeat(40), comments: [] };
  const manifest = { fixtures: [fixture], stimuli: [], createdAt: '2026-09-16T00:00:00Z' };
  let saved,
    posted = false;
  const response = {
    id: '9007199254740993',
    user: { login: 'owner' },
    pull_request_review_id: association,
    in_reply_to_id: reply,
  };
  if (association === undefined) delete response.pull_request_review_id;
  let error;
  try {
    emitStimulus({
      args: ['relay', 'thread', '--busy'],
      manifest,
      config: { runId: 'review-0916' },
      readLines: () => [],
      now: () => '2026-09-16T00:00:01.000Z',
      log() {},
      save: () => {
        saved = structuredClone(manifest);
      },
      gh: (endpoint, method, body) => {
        assert.equal(method, 'POST');
        assert.equal(endpoint, 'repos/owner/relay/pulls/123/comments');
        assert.equal(saved.stimuli[0].createdAt, '2026-09-16T00:00:01.000Z');
        assert.equal(saved.stimuli[0].accepted, undefined);
        assert.equal(saved.stimuli[0].expected, undefined);
        assert.equal(body.in_reply_to_id, undefined);
        assert.deepEqual(
          { path: body.path, commit_id: body.commit_id, line: body.line, side: body.side },
          { path: fixture.file, commit_id: fixture.headSha, line: 2, side: 'RIGHT' }
        );
        posted = true;
        return response;
      },
    });
  } catch (e) {
    error = e;
  }
  return { manifest, saved, posted, error, response };
}

for (const association of [null, '9007199254740995'])
  test(`real emitter retains nullable/lossless review association ${association}`, () => {
    const r = threadEmission(association);
    assert.equal(r.error, undefined);
    assert.equal(r.posted, true);
    const s = r.saved.stimuli[0];
    assert.equal(s.accepted, true);
    assert.equal(s.expected.record.pull_request_review_id, association);
    assert.equal(validFixtureExpected(s), true);
    assert.equal(
      semanticMatches('thread', {
        metadata: { provider_event_type: 'pull_request_review_comment.created', record: r.response },
      }),
      true
    );
    assert.deepEqual(r.saved.fixtures[0].comments, [
      { id: '9007199254740993', endpoint: 'pulls/comments/9007199254740993' },
    ]);
  });

for (const association of [undefined, '', 'null', 'undefined', 9007199254740992])
  test(`thread rejects missing/malformed/lossy association ${association} but retains acknowledged ownership`, () => {
    const r = threadEmission(association);
    assert(r.error);
    assert.equal(r.saved.stimuli[0].accepted, true);
    assert.equal(r.saved.stimuli[0].expected, undefined);
    assert.equal(r.saved.fixtures[0].comments[0].id, '9007199254740993');
  });

test('thread reply cannot masquerade as root; acknowledged comment remains owned', () => {
  const r = threadEmission(null, '42');
  assert.match(r.error.message, /new review thread root/);
  assert.equal(r.saved.stimuli[0].accepted, true);
  assert.equal(r.saved.stimuli[0].expected, undefined);
  assert.equal(
    semanticMatches('thread', {
      metadata: { provider_event_type: 'pull_request_review_comment.created', record: r.response },
    }),
    false
  );
});

test('emitter persists intent timestamp before provider mutation and never replaces it with acknowledgement time', () => {
  const manifest = {
    createdAt: '2026-09-16T00:00:00Z',
    fixtures: [{ repo: 'owner/relay', pr: 1, comments: [] }],
    stimuli: [],
  };
  let now = '2026-09-16T00:00:01.000Z',
    saved,
    providerTimestamp;
  emitStimulus({
    args: ['relay', 'comment', '--busy'],
    manifest,
    config: { runId: 'review-0916' },
    readLines: () => [],
    now: () => now,
    log() {},
    save: () => {
      saved = structuredClone(manifest);
    },
    gh: () => {
      assert.equal(saved.stimuli[0].createdAt, now);
      assert.equal(saved.stimuli[0].accepted, undefined);
      // Delivery may happen during the provider request, before its acknowledgement.
      providerTimestamp = '2026-09-16T00:00:01.001Z';
      now = '2026-09-16T00:00:05.000Z';
      return {
        id: '42',
        user: { login: 'owner' },
        issue_url: 'https://api.github.com/repos/owner/relay/issues/1',
      };
    },
  });
  assert.equal(saved.stimuli[0].createdAt, '2026-09-16T00:00:01.000Z');
  assert(Date.parse(providerTimestamp) >= Date.parse(saved.stimuli[0].createdAt));
  assert(Date.parse(providerTimestamp) < Date.parse(now));
});
