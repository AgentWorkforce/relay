import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const script = new URL('./final-acceptance.mjs', import.meta.url);

async function runAcceptance(artifactDir, runId) {
  try {
    const result = await execFileAsync(process.execPath, [script.pathname], {
      env: {
        ...process.env,
        RELAYFILE_QUALIFICATION_ARTIFACT_DIR: artifactDir,
        RELAYFILE_QUALIFICATION_RUN_ID: runId,
      },
    });
    return { code: 0, stdout: result.stdout };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '' };
  }
}

async function seed(artifactDir, runId, verdict = 'PASS', verified = true) {
  await writeFile(path.join(artifactDir, 'aggregate.json'), JSON.stringify({ runId, verdict }));
  await writeFile(
    path.join(artifactDir, 'integrity.json'),
    JSON.stringify({ runId, verdict: 'PASS', ok: true })
  );
  for (const provider of ['claude', 'codex'])
    await writeFile(
      path.join(artifactDir, `${provider}-signoff.json`),
      JSON.stringify({
        runId,
        verifiedByScript: verified,
        verdict: verified ? 'COMPREHENSIVELY_SATISFIED' : 'BLOCKED',
      })
    );
}

test('final acceptance passes only with PASS aggregate and verified signoffs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relayfile-final-acceptance-'));
  try {
    const runId = 'qualification-final-acceptance';
    await seed(dir, runId);
    const result = await runAcceptance(dir, runId);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /QUALIFICATION_FINAL_ACCEPTANCE PASS/);
    assert.equal(JSON.parse(await readFile(path.join(dir, 'final-acceptance.json'))).ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('final acceptance rejects a blocked aggregate or unverified signoff', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relayfile-final-acceptance-'));
  try {
    const runId = 'qualification-final-acceptance';
    await seed(dir, runId, 'BLOCKED', false);
    await writeFile(
      path.join(dir, 'integrity.json'),
      JSON.stringify({ runId, verdict: 'BLOCKED', ok: false })
    );
    const result = await runAcceptance(dir, runId);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /QUALIFICATION_FINAL_ACCEPTANCE BLOCKED/);
    const report = JSON.parse(await readFile(path.join(dir, 'final-acceptance.json')));
    assert.equal(report.ok, false);
    assert.equal(report.failures.length, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
