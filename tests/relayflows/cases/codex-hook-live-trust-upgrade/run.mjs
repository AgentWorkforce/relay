#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const caseId = 'codex-hook-live-trust-upgrade';
const arm = process.env.RELAY_PR_PROOF_ARM;
const target = process.env.RELAY_PR_PROOF_TARGET_DIR;
const resultPath = process.env.RELAY_PR_PROOF_RESULT_PATH;
const head = process.env.RELAY_PR_PROOF_HEAD_SHA;
const expected = process.env[arm === 'base' ? 'RELAY_PR_PROOF_BASE_SHA' : 'RELAY_PR_PROOF_HEAD_SHA'];
const harness =
  process.env.RELAY_PR_PROOF_HARNESS_DIR ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const sha = (cwd) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
if (!['base', 'head'].includes(arm) || !target || !resultPath || !expected || !head) {
  throw new Error('RelayFlow proof environment is incomplete');
}
await rm(resultPath, { force: true });
for (const [cwd, revision] of [
  [target, expected],
  [harness, head],
]) {
  if (sha(cwd) !== revision) throw new Error('Target or harness is not the exact expected revision');
  const clean = spawnSync('git', ['diff', '--quiet', revision, '--'], { cwd });
  if (clean.error) throw clean.error;
  if (clean.status !== 0) throw new Error('Target or harness has modified tracked inputs');
}
const modulePath = 'crates/relay-node/src/relay/codex/stop_hook.rs';
const fixturePath = 'crates/relay-node/src/relay/codex/stop_hook/live_refresh_regression.rs';
const moduleFile = path.join(target, modulePath);
const fixtureFile = path.join(target, fixturePath);
const declaration =
  '#[cfg(test)]\n#[path = "stop_hook/live_refresh_regression.rs"]\nmod live_refresh_regression;';
const originalModule = await readFile(moduleFile);
const originalFixture = await readFile(fixtureFile).catch((error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
let fixture = execFileSync('git', ['show', `${head}:${fixturePath}`], { cwd: harness, encoding: 'utf8' });
if (arm === 'base') {
  // Test-only compatibility: old Settings had no live-reconciliation field.
  // Omit only its injected fake runtime context; the base's real disk-only
  // install/ready path remains unchanged and must expose the stale host.
  const begin = '    // BEGIN_LIVE_RUNTIME_CONTEXT:';
  const end = '    // END_LIVE_RUNTIME_CONTEXT\n';
  if (fixture.split(begin).length !== 2 || fixture.split(end).length !== 2) {
    throw new Error('Unexpected live-runtime fixture shape');
  }
  const start = fixture.indexOf(begin);
  const finish = fixture.indexOf(end, start) + end.length;
  fixture = fixture.slice(0, start) + fixture.slice(finish);
  fixture = fixture.replace('let mut settings =', 'let settings =');
}
let result;
try {
  await mkdir(path.dirname(fixtureFile), { recursive: true });
  await writeFile(fixtureFile, fixture);
  if (!originalModule.toString().includes(declaration)) {
    await writeFile(moduleFile, `${originalModule}\n${declaration}\n`);
  }
  result = spawnSync(
    'cargo',
    [
      'test',
      '--manifest-path',
      'crates/relay-node/Cargo.toml',
      '--lib',
      'codex_hook_upgrade_reconciles_loaded_approved_snapshot',
    ],
    {
      cwd: target,
      env: { ...process.env, CARGO_TERM_COLOR: 'never' },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 12 * 60 * 1000,
    }
  );
  process.stdout.write(`${result.stdout ?? ''}${result.stderr ?? ''}`);
  if (result.error) throw result.error;
} finally {
  await writeFile(moduleFile, originalModule);
  if (originalFixture === null) await rm(fixtureFile, { force: true });
  else await writeFile(fixtureFile, originalFixture);
}
const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
const named = (status) =>
  new RegExp(
    String.raw`\btest\s+(?:\w+::)*codex_hook_upgrade_reconciles_loaded_approved_snapshot\s*\.{3}\s*${status}\b`
  ).test(output);
const passed =
  result.status === 0 && named('ok') && /test result:\s*ok\.\s+1 passed;\s+0 failed/.test(output);
const failed =
  result.status !== 0 &&
  named('FAILED') &&
  /test result:\s*FAILED\.\s+0 passed;\s+1 failed/.test(output) &&
  output.includes('approved disk hook left stale on the live daemon');
if (!passed && !failed) throw new Error('Live-trust regression did not run with a recognized result');
await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(
  resultPath,
  `${JSON.stringify(
    {
      version: 1,
      caseId,
      arm,
      outcome: passed ? 'fixed' : 'bug',
      signature: passed ? 'loaded_codex_hook_snapshot_verified' : 'loaded_codex_hook_snapshot_stays_stale',
      details:
        'Actual hook settings install/readiness with approved disk state and a stale loaded host; only the head has a live reconciliation stage. No daemon, thread or hook is started by the test.',
    },
    null,
    2
  )}\n`
);
