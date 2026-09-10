import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { writeQualificationConfig } from './config.mjs';

test('stripped deterministic child reads exact pins and paths from mode-0600 config', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'relayfile-qualification-config-'));
  try {
    const file = path.join(dir, 'qualification-config.json');
    await writeQualificationConfig(file, { version: 1, runId: 'qualification-test-run', artifactDir: dir, bundleDir: `${dir}/bundle`, createSandboxes: false, candidates: { cloud: '/exact/cloud', relayfile: '/exact/relayfile', 'relayfile-cloud': '/exact/relayfile-cloud' }, npm: { version: '0.10.58-rc.1', tarballSha256: 'a'.repeat(64), sourceSha: 'b'.repeat(40), releaseAttestationSha256: 'c'.repeat(64), mountTarballSha256: 'd'.repeat(64) }, daytona: { image: 'image@sha256:' + 'e'.repeat(64), cpu: '2', memoryMb: '4096', diskGib: '10', ttlMinutes: '90' } });
    const child = spawnSync('bun', ['-e', "import './scripts/relayfile-cross-repo-qualification/config.mjs'; console.log(JSON.stringify({runId:process.env.RELAYFILE_QUALIFICATION_RUN_ID,repo:process.env.RELAYFILE_REPO,version:process.env.RELAYFILE_QUALIFICATION_NPM_VERSION}))", '--', '--config', file], { cwd: path.resolve(new URL('../..', import.meta.url).pathname), env: { PATH: process.env.PATH }, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { runId: 'qualification-test-run', repo: '/exact/relayfile', version: '0.10.58-rc.1' });
    assert.equal((await readFile(file)).length > 0, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
