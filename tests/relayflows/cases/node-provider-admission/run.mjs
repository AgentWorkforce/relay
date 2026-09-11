import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const required = (key) => {
  assert(process.env[key], `Missing ${key}`);
  return process.env[key];
};
const arm = required('RELAY_PR_PROOF_ARM');
assert(['base', 'head'].includes(arm));
const target = required('RELAY_PR_PROOF_TARGET_DIR');
const harness = required('RELAY_PR_PROOF_HARNESS_DIR');
const resultPath = required('RELAY_PR_PROOF_RESULT_PATH');
assert.equal(
  execFileSync('git', ['-C', target, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  required(arm === 'base' ? 'RELAY_PR_PROOF_BASE_SHA' : 'RELAY_PR_PROOF_HEAD_SHA')
);
const relative = path.relative(path.resolve(harness), fileURLToPath(import.meta.url));
assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
const temporary = await mkdtemp(path.join(tmpdir(), 'relayflow-provider-'));
try {
  // One exact engine release on both arms; do not resolve latest or use hosted services.
  execFileSync(
    'npm',
    ['install', '--prefix', temporary, '--no-audit', '--no-fund', '@relaycast/engine@8.9.0'],
    { timeout: 120000, stdio: 'pipe' }
  );
  const engine = path.join(temporary, 'node_modules/@relaycast/engine/dist/bin/serve.js');
  const evidence = path.join(temporary, 'evidence');
  execFileSync(
    process.execPath,
    [
      path.join(harness, 'tests/relayflows/tools/prove-node-provider-admission.mjs'),
      required('RELAY_PR_PROOF_BROKER_BINARY'),
      engine,
      evidence,
      arm,
    ],
    { timeout: 90000, stdio: 'pipe' }
  );
  const observed = JSON.parse(await readFile(path.join(evidence, 'result.json'), 'utf8'));
  assert.equal(observed.passed, true);
  if (arm === 'base') assert.equal(observed.defaultProviderBug, true);
  else
    for (const key of [
      'providerAndOriginCorrect',
      'fleetSpawn',
      'brokerReceivedRealDm',
      'isolatedChannels',
      'duplicateRejected',
      'guardedReleaseRejectedWrongHash',
      'failedLaunchCleanedOwnedIdentity',
    ])
      assert.equal(observed[key], true, key);
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    JSON.stringify({
      version: 1,
      caseId: 'node-provider-admission',
      arm,
      outcome: arm === 'base' ? 'bug' : 'fixed',
      signature:
        arm === 'base'
          ? 'http_identity_admitted_on_default_provider'
          : 'node_identity_provider_origin_and_delivery_proven',
      details:
        arm === 'base'
          ? 'Compiled broker admits a default-provider identity with no authenticated node origin.'
          : 'Compiled broker and local real engine prove API/fleet provider, origin, isolated scope, DM delivery, duplicate refusal, guarded release, and failed-launch cleanup.',
    }) + '\n'
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
