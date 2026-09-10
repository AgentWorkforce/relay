import assert from 'node:assert/strict';
import test from 'node:test';
import { captureGitProvenance, verifyGitProvenance } from './git-provenance.mjs';

const candidates = { cloud: '/cloud', relayfile: '/relayfile', 'relayfile-cloud': '/relayfile-cloud' };

function fakeGit(states) {
  return async (_command, args) => {
    const repo = args[1];
    const state = states[repo];
    if (args[2] === 'status') return { stdout: state.status, stderr: '' };
    return { stdout: `${state.head}\n`, stderr: '' };
  };
}

test('recheck rejects a candidate that becomes dirty after archive creation', async () => {
  const states = Object.fromEntries(
    Object.values(candidates).map((repo, index) => [repo, { head: `${index + 1}`.repeat(40), status: '' }])
  );
  const execFileAsync = fakeGit(states);
  const captured = await captureGitProvenance(candidates, { execFileAsync });
  states['/relayfile-cloud'].status = ' M package.json';
  await assert.rejects(
    () => verifyGitProvenance(candidates, captured, { execFileAsync }),
    /relayfile-cloud candidate became dirty/
  );
});

test('recheck rejects a candidate whose HEAD drifts after archive creation', async () => {
  const states = Object.fromEntries(
    Object.values(candidates).map((repo, index) => [repo, { head: `${index + 1}`.repeat(40), status: '' }])
  );
  const execFileAsync = fakeGit(states);
  const captured = await captureGitProvenance(candidates, { execFileAsync });
  states['/relayfile'].head = 'f'.repeat(40);
  await assert.rejects(
    () => verifyGitProvenance(candidates, captured, { execFileAsync }),
    /relayfile candidate git HEAD changed/
  );
});
