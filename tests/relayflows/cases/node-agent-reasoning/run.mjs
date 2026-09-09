import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

function required(name) {
  if (!process.env[name]) throw new Error(`Missing ${name}`);
  return process.env[name];
}
const target = path.resolve(required('RELAY_PR_PROOF_TARGET_DIR'));
const harness = path.resolve(required('RELAY_PR_PROOF_HARNESS_DIR'));
const arm = required('RELAY_PR_PROOF_ARM');
if (!['base', 'head'].includes(arm)) throw new Error('Invalid proof arm');
const resultPath = required('RELAY_PR_PROOF_RESULT_PATH');
const id = 'node-agent-reasoning';
const suffix = randomUUID();
const probe = path.join(target, `packages/cli/src/cli/commands/reasoning-proof-${suffix}.test.ts`);
const observation = path.join(target, `.reasoning-observation-${suffix}.json`);
function run(command, args, timeout) {
  const result = spawnSync(command, args, {
    cwd: target,
    stdio: 'inherit',
    timeout,
    env: { ...process.env, RELAY_REASONING_OBSERVATION: observation },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.status ?? result.signal}`);
}
try {
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], 480_000);
  await copyFile(path.join(harness, `tests/relayflows/cases/${id}/probe.ts`), probe);
  run('npm', ['exec', '--', 'vitest', 'run', path.relative(target, probe)], 120_000);
  const outcome = JSON.parse(await readFile(observation, 'utf8'));
  if (!['absent', 'fixed'].includes(outcome)) throw new Error('Unexpected observation');
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    JSON.stringify({
      version: 1,
      caseId: id,
      arm,
      outcome,
      signature: outcome === 'absent' ? 'reasoning_option_absent' : 'reasoning_translated_or_rejected',
      details:
        outcome === 'absent'
          ? 'Both commands reject --reasoning as an unknown option for all six cases.'
          : 'Both commands serialize exact Codex, Claude, and Grok reasoning argv with --model; unsupported harness and invalid levels fail before connecting or attaching.',
    }) + '\n'
  );
} finally {
  await rm(probe, { force: true });
  await rm(observation, { force: true });
}
