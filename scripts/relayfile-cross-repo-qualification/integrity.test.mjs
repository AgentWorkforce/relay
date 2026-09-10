import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { computeIntegrity } from './integrity.mjs';

const execFileAsync = promisify(execFile);
const verifyScript = new URL('./verify-integrity.mjs', import.meta.url);

async function seed(dir) {
  await mkdir(path.join(dir, 'bundle'), { recursive: true });
  await writeFile(path.join(dir, 'preflight.json'), JSON.stringify({ runId: 'qualification-integrity' }));
  for (const name of [
    'arm-A.json',
    'arm-B.json',
    'arm-A-verification.json',
    'arm-B-verification.json',
    'aggregate-evidence.json',
  ])
    await writeFile(path.join(dir, name), JSON.stringify({ runId: 'qualification-integrity', ok: true }));
  await writeFile(path.join(dir, 'bundle/cloud.tgz'), Buffer.from('cloud archive'));
  await writeFile(path.join(dir, 'bundle/relayfile.tgz'), Buffer.from('relayfile archive'));
  await writeFile(path.join(dir, 'bundle/relayfile-cloud.tgz'), Buffer.from('relayfile-cloud archive'));
  await writeFile(path.join(dir, 'bundle/relayfile-mount-linux-amd64'), Buffer.from('mount binary'));
  await writeFile(
    path.join(dir, 'bundle/bundle-manifest.json'),
    JSON.stringify({
      runId: 'qualification-integrity',
      artifacts: {
        cloud: { archive: 'cloud.tgz', sha256: 'a'.repeat(64) },
        relayfile: { archive: 'relayfile.tgz', sha256: 'b'.repeat(64) },
        'relayfile-cloud': { archive: 'relayfile-cloud.tgz', sha256: 'c'.repeat(64) },
      },
      candidateProvenance: {
        cloud: {
          name: 'cloud',
          repo: '../cloud',
          head: '1'.repeat(40),
          clean: true,
          archive: 'cloud.tgz',
          sha256: 'a'.repeat(64),
        },
        relayfile: {
          name: 'relayfile',
          repo: '../relayfile',
          head: '2'.repeat(40),
          clean: true,
          archive: 'relayfile.tgz',
          sha256: 'b'.repeat(64),
        },
        'relayfile-cloud': {
          name: 'relayfile-cloud',
          repo: '../relayfile-cloud',
          head: '3'.repeat(40),
          clean: true,
          archive: 'relayfile-cloud.tgz',
          sha256: 'c'.repeat(64),
        },
      },
      relayfileMount: { file: 'relayfile-mount-linux-amd64' },
    })
  );
}

async function verify(dir, expected) {
  try {
    const args = expected === undefined ? [verifyScript.pathname] : [verifyScript.pathname, expected];
    await execFileAsync(process.execPath, args, {
      env: {
        ...process.env,
        RELAYFILE_QUALIFICATION_ARTIFACT_DIR: dir,
        RELAYFILE_QUALIFICATION_RUN_ID: 'qualification-integrity',
      },
    });
    return 0;
  } catch (error) {
    return error.code ?? 1;
  }
}

test('manual verification without the runner digest cannot create or replace the integrity report', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relayfile-final-integrity-'));
  try {
    await seed(dir);
    assert.notEqual(await verify(dir, undefined), 0);
    await assert.rejects(readFile(path.join(dir, 'integrity.json')), { code: 'ENOENT' });

    const digest = (await computeIntegrity(dir)).digest;
    assert.equal(await verify(dir, digest), 0);
    const accepted = await readFile(path.join(dir, 'integrity.json'), 'utf8');
    assert.notEqual(await verify(dir, 'not-a-runner-digest'), 0);
    assert.equal(await readFile(path.join(dir, 'integrity.json'), 'utf8'), accepted);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('integrity digest passes unchanged evidence and blocks one-byte mutation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relayfile-integrity-'));
  try {
    await seed(dir);
    const first = await computeIntegrity(dir);
    assert.match(first.digest, /^[0-9a-f]{64}$/);
    assert.equal(await verify(dir, first.digest), 0);
    assert.equal(JSON.parse(await readFile(path.join(dir, 'integrity.json'))).verdict, 'PASS');
    await writeFile(
      path.join(dir, 'arm-A.json'),
      JSON.stringify({ runId: 'qualification-integrity', ok: false })
    );
    assert.notEqual(await verify(dir, first.digest), 0);
    const report = JSON.parse(await readFile(path.join(dir, 'integrity.json')));
    assert.equal(report.verdict, 'BLOCKED');
    assert.match(report.failures.join('\n'), /bytes changed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
