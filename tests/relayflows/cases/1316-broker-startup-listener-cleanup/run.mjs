#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1316-broker-startup-listener-cleanup';
const target = path.resolve(required('RELAY_PR_PROOF_TARGET_DIR'));
const harness = path.resolve(required('RELAY_PR_PROOF_HARNESS_DIR'));
const arm = required('RELAY_PR_PROOF_ARM');
if (arm !== 'base' && arm !== 'head') throw new Error(`Invalid arm ${arm}`);
const sha = execFileSync('git', ['-C', target, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (sha !== required(arm === 'base' ? 'RELAY_PR_PROOF_BASE_SHA' : 'RELAY_PR_PROOF_HEAD_SHA')) {
  throw new Error('Target SHA differs from expected SHA');
}
if (!fileURLToPath(import.meta.url).startsWith(`${harness}${path.sep}`)) {
  throw new Error('Runner must come from the exact-head harness');
}
const script = String.raw`import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { writeFile } from 'node:fs/promises';
import { waitForApiUrl } from './packages/harness-driver/dist/broker-process.js';

const debug = { binaryPath: 'broker', args: [], cwd: '/tmp', stdoutLines: [], stderrLines: [] };
function child() {
  const process = new EventEmitter();
  process.stdout = new PassThrough();
  process.pid = 101;
  process.kill = () => true;
  return process;
}
const success = child();
const url = waitForApiUrl(success, 1000, debug);
success.stdout.write('API listening on http://127.0.0.1:4282\\n');
const value = await url;
const successListeners = [success.listenerCount('exit'), success.listenerCount('error')];
success.stdout.destroy();
const failed = child();
const pending = waitForApiUrl(failed, 1000, debug);
failed.emit('exit', 3, null);
let failure = '';
try { await pending; } catch (error) { failure = error.message; }
const failureListeners = [failed.listenerCount('exit'), failed.listenerCount('error')];
failed.stdout.destroy();
await writeFile(process.env.RELAY_PR1316_OBSERVATION_PATH, JSON.stringify({ value, failure, successListeners, failureListeners }));
`;
const scriptPath = path.join(target, '.relayflow-1316-probe.mjs');
const observationPath = path.join(target, '.relayflow-1316-observation.json');
try {
  // Build the target's own production module. No head-only test is imported.
  run(
    'npm',
    ['ci', '--ignore-scripts', '--workspace', 'packages/harness-driver', '--include-workspace-root=false'],
    target
  );
  run(
    'node',
    [
      path.join(harness, 'node_modules/typescript/bin/tsc'),
      '-p',
      path.join(target, 'packages/harness-driver/tsconfig.json'),
    ],
    target
  );
  await writeFile(scriptPath, script);
  run('node', [scriptPath], target, { RELAY_PR1316_OBSERVATION_PATH: observationPath });
  const { value, failure, successListeners, failureListeners } = JSON.parse(
    await readFile(observationPath, 'utf8')
  );
  if (value !== 'http://127.0.0.1:4282' || !failure.includes('exited with code 3')) {
    throw new Error('Probe did not exercise both startup outcomes');
  }
  const is = (v, expected) => JSON.stringify(v) === JSON.stringify(expected);
  const baseObserved = is(successListeners, [1, 1]) && is(failureListeners, [1, 1]);
  const headObserved = is(successListeners, [0, 0]) && is(failureListeners, [0, 0]);
  if (!baseObserved && !headObserved)
    throw new Error(
      `Unexpected listener observation: ${JSON.stringify({ successListeners, failureListeners })}`
    );
  const outcome = baseObserved ? 'bug' : 'fixed';
  const signature = baseObserved
    ? 'broker_startup_listeners_remain_attached'
    : 'broker_startup_listeners_removed';
  await mkdir(path.dirname(required('RELAY_PR_PROOF_RESULT_PATH')), { recursive: true });
  await writeFile(
    required('RELAY_PR_PROOF_RESULT_PATH'),
    JSON.stringify({
      version: 1,
      caseId: CASE_ID,
      arm,
      outcome,
      signature,
      details: baseObserved
        ? 'After both successful and failed startup, the broker child retained its startup exit and error listeners.'
        : 'After both successful and failed startup, the broker child released its startup exit and error listeners.',
    }) + '\n'
  );
} finally {
  await Promise.all([scriptPath, observationPath].map((file) => rm(file, { force: true })));
}
function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
function run(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    timeout: 360000,
  });
  if (result.error || result.status !== 0)
    throw new Error(`${command} failed: ${result.error?.message ?? result.status}`);
}
