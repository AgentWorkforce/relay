import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomBytes } from 'node:crypto';
import { fixtureExpected } from './fixture-scope.mjs';
const source = readFileSync(new URL('./run.mjs', import.meta.url), 'utf8');
const emitSource = source.slice(
  source.indexOf('function emit() {'),
  source.indexOf('function resolveStimuli() {')
);
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
    randomBytes,
    fixtureExpected,
    console: { log() {} },
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
    runInNewContext(emitSource + '\nemit();', context);
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
