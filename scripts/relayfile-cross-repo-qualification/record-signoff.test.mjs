import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const script = new URL('./record-signoff.mjs', import.meta.url);
const runId = 'qualification-signoff';

async function seed(dir, review, fix, finalReview) {
  const common = { runId };
  await writeFile(path.join(dir, 'preflight.json'), JSON.stringify({ ...common, status: 'READY' }));
  await writeFile(path.join(dir, 'aggregate-evidence.json'), JSON.stringify({ ...common, verdict: 'PASS' }));
  await writeFile(path.join(dir, 'integrity.json'), JSON.stringify({ ...common, verdict: 'PASS', ok: true }));
  for (const arm of ['arm-A', 'arm-B'])
    await writeFile(path.join(dir, `${arm}-verification.json`), JSON.stringify({ ...common, ok: true }));
  for (const [phase, value] of [
    ['review', review],
    ['fix', fix],
    ['final-review', finalReview],
  ])
    await writeFile(
      path.join(dir, `claude-${phase}.json`),
      JSON.stringify({ version: 1, provider: 'claude', phase, ...common, ...value })
    );
}

async function run(dir) {
  try {
    await execFileAsync(process.execPath, [script.pathname, 'claude'], {
      env: {
        ...process.env,
        RELAYFILE_QUALIFICATION_ARTIFACT_DIR: dir,
        RELAYFILE_QUALIFICATION_RUN_ID: runId,
      },
    });
    return 0;
  } catch (error) {
    return error.code ?? 1;
  }
}

test('record-signoff hashes all three phases and accepts a complete chain', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relayfile-signoff-'));
  try {
    await seed(
      dir,
      { verdict: 'COMPREHENSIVELY_SATISFIED', findings: [] },
      { verdict: 'COMPREHENSIVELY_SATISFIED', findings: [] },
      { verdict: 'COMPREHENSIVELY_SATISFIED', findings: [] }
    );
    assert.equal(await run(dir), 0);
    const signoff = JSON.parse(await readFile(path.join(dir, 'claude-signoff.json')));
    assert.equal(signoff.verdict, 'COMPREHENSIVELY_SATISFIED');
    assert.deepEqual(Object.keys(signoff.evidenceHashes).sort(), [
      'claude-final-review.json',
      'claude-fix.json',
      'claude-review.json',
    ]);
    assert.ok(Object.values(signoff.evidenceHashes).every((hash) => /^[0-9a-f]{64}$/.test(hash)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('record-signoff blocks an initial finding forgotten by fix and final-review', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relayfile-signoff-'));
  try {
    await seed(
      dir,
      { verdict: 'BLOCKED', findings: ['immutable evidence is missing'] },
      { verdict: 'COMPREHENSIVELY_SATISFIED', findings: [] },
      { verdict: 'COMPREHENSIVELY_SATISFIED', findings: [] }
    );
    assert.notEqual(await run(dir), 0);
    const signoff = JSON.parse(await readFile(path.join(dir, 'claude-signoff.json')));
    assert.equal(signoff.verdict, 'BLOCKED');
    assert.match(signoff.failures.join('\n'), /initial blocked finding was forgotten/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
