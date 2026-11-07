#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const caseId = 'codex-hook-canonical-read';
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

const fixturePath = 'crates/relay-node/src/relay/process/codex_hook/scaling.rs';
const fixtureFile = path.join(target, fixturePath);
const original = await readFile(fixtureFile);
let fixture = execFileSync('git', ['show', `${head}:${fixturePath}`], { cwd: harness, encoding: 'utf8' });
if (arm === 'base') {
  // Test-only ABI adaptation: the old FnOnce() reader captures its original
  // alias, exactly as LocalSessions did. The new FnOnce(&Path) reader receives
  // the verified canonical path. Neither arm changes production code.
  const callback = '|verified_path| {';
  const assertion = 'assert_eq!(verified_path, canonical);';
  const canonical = 'let canonical = rollout.canonicalize()?;';
  for (const text of [callback, assertion, canonical]) {
    if (fixture.split(text).length !== 2) throw new Error('Unexpected canonical-read fixture shape');
  }
  fixture = fixture
    .replace(callback, '|| { let verified_path = &alias;')
    .replace(assertion, '')
    .replace(canonical, '');
}
let result;
try {
  await writeFile(fixtureFile, fixture);
  result = spawnSync(
    'cargo',
    [
      'test',
      '--manifest-path',
      'crates/relay-node/Cargo.toml',
      '--lib',
      'hook_rollout_reader_uses_verified_canonical_path',
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
  await writeFile(fixtureFile, original);
}
const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
const named = (status) =>
  new RegExp(
    String.raw`\btest\s+(?:\w+::)*hook_rollout_reader_uses_verified_canonical_path\s*\.{3}\s*${status}\b`
  ).test(output);
const passed =
  result.status === 0 && named('ok') && /test result:\s*ok\.\s+1 passed;\s+0 failed/.test(output);
const failed =
  result.status !== 0 &&
  named('FAILED') &&
  /test result:\s*FAILED\.\s+0 passed;\s+1 failed/.test(output) &&
  output.includes('assertion failed: with_codex_hook_rollout');
if (!passed && !failed) throw new Error('Canonical-read regression did not run with a recognized result');
await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(
  resultPath,
  `${JSON.stringify(
    {
      version: 1,
      caseId,
      arm,
      outcome: passed ? 'fixed' : 'bug',
      signature: passed
        ? 'rollout_reader_uses_verified_canonical_path'
        : 'rollout_reader_follows_retargeted_alias',
      details:
        'Actual rollout binding and reader with a symlink retargeted after verification; only the base fixture adapts the callback ABI and captures the original alias.',
    },
    null,
    2
  )}\n`
);
