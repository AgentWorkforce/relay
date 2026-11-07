#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const caseId = 'codex-hook-thread-affinity';
const arm = process.env.RELAY_PR_PROOF_ARM;
const target = process.env.RELAY_PR_PROOF_TARGET_DIR;
const resultPath = process.env.RELAY_PR_PROOF_RESULT_PATH;
const expected = process.env[arm === 'base' ? 'RELAY_PR_PROOF_BASE_SHA' : 'RELAY_PR_PROOF_HEAD_SHA'];
const harness =
  process.env.RELAY_PR_PROOF_HARNESS_DIR ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const sha = (cwd) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
if (
  !['base', 'head'].includes(arm) ||
  !target ||
  !resultPath ||
  !expected ||
  !process.env.RELAY_PR_PROOF_HEAD_SHA
) {
  throw new Error('RelayFlow proof environment is incomplete');
}
await rm(resultPath, { force: true });
if (sha(target) !== expected || sha(harness) !== process.env.RELAY_PR_PROOF_HEAD_SHA) {
  throw new Error('Target or harness is not the exact expected revision');
}
for (const [cwd, revision] of [
  [target, expected],
  [harness, process.env.RELAY_PR_PROOF_HEAD_SHA],
]) {
  const clean = spawnSync('git', ['diff', '--quiet', revision, '--'], { cwd });
  if (clean.error) throw clean.error;
  if (clean.status !== 0) throw new Error('Target or harness has modified tracked inputs');
}

// Apply only the same regression harness to each arm. Production authorization
// remains the target revision's implementation, including on the base arm.
const modulePath = 'crates/relay-node/src/relay/outbound/hooks/codex_stop.rs';
const fixturePath = 'crates/relay-node/src/relay/outbound/hooks/codex_stop/affinity.rs';
const declaration = '#[cfg(test)]\n#[path = "codex_stop/affinity.rs"]\nmod affinity;';
const moduleFile = path.join(target, modulePath);
const fixtureFile = path.join(target, fixturePath);
const originalModule = await readFile(moduleFile);
const originalFixture = await readFile(fixtureFile).catch((error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
const fixture = execFileSync('git', ['show', `${process.env.RELAY_PR_PROOF_HEAD_SHA}:${fixturePath}`], {
  cwd: harness,
});
let result;
try {
  await mkdir(path.dirname(fixtureFile), { recursive: true });
  await writeFile(fixtureFile, fixture);
  if (!originalModule.toString().includes(declaration)) {
    await writeFile(moduleFile, `${originalModule}\n${declaration}\n`);
  }
  result = spawnSync(
    'cargo',
    ['test', '--manifest-path', 'crates/relay-node/Cargo.toml', '--lib', 'consuming_hook_thread_affinity'],
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
const tests = [
  'consuming_hook_thread_affinity_preserves_parent_and_child_offers',
  'consuming_hook_thread_affinity_preserves_registration_guidance',
  'consuming_hook_thread_affinity_keeps_kernel_writer_checks',
];
const passed =
  result.status === 0 &&
  /test result:\s*ok\.\s+3 passed;\s+0 failed/.test(output) &&
  tests.every((name) => new RegExp(String.raw`\btest\s+(?:\w+::)*${name}\s*\.{3}\s*ok\b`).test(output));
const failed =
  result.status !== 0 &&
  /test result:\s*FAILED\.\s+0 passed;\s+3 failed/.test(output) &&
  tests.every((name) => new RegExp(String.raw`\btest\s+(?:\w+::)*${name}\s*\.{3}\s*FAILED\b`).test(output)) &&
  output.includes('assertion failed: outbound.codex_stop_hook');
if (!passed && !failed)
  throw new Error('Expected all three authorization regressions to run with a recognized result');
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
        ? 'codex_hook_consumption_matches_caller_thread'
        : 'subagent_hook_consumes_parent_offer',
      details:
        'Actual Outbound hook route with LocalSessions and a trusted shared app-server holding parent and child writer locks; tests offer ownership, registration guidance, and kernel/writer validation.',
    },
    null,
    2
  )}\n`
);
