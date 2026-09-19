#!/usr/bin/env node

/**
 * Proof for PR #1805: the repository can reconcile its `relay.ci.pr-proof`
 * hosted listener by name, converging to exactly one and leaving unrelated
 * listeners untouched.
 *
 * Base has no `scripts/flows/deploy-listeners.mjs` — the reconcile does not
 * exist, so the listener can only be redeployed by hand and goes stale after
 * a merge — `absent`.
 *
 * Head runs the real reconcile script from the target checkout against a
 * stubbed `flows` CLI whose state starts with two stale listeners under the
 * managed name plus one unrelated listener. The script must undeploy both
 * stale ones, deploy once, verify convergence, and never touch the unrelated
 * one — `fixed`.
 *
 * Stubbing `flows` is what makes this a proof of the RECONCILE and not of
 * Cloud: it needs no credential in the proof sandbox, and the properties under
 * test — name-scoped matching, undeploy-before-deploy ordering, convergence to
 * exactly the new listener — are all decided by the script, not the service.
 * The stub records every call so the order can be asserted, not inferred.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1805-relayflows-deploy-reconcile';
const SCRIPT = 'scripts/flows/deploy-listeners.mjs';
const MANAGED_NAME = 'relay.ci.pr-proof';
const COMMAND_TIMEOUT_MS = 120_000;

function requiredValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function requiredDirectory(name) {
  const value = requiredValue(name);
  if (!existsSync(value)) throw new Error(`${name} does not exist: ${value}`);
  return path.resolve(value);
}

const targetDir = requiredDirectory('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = requiredDirectory('RELAY_PR_PROOF_HARNESS_DIR');
const resultPath = path.resolve(requiredValue('RELAY_PR_PROOF_RESULT_PATH'));
const arm = requiredValue('RELAY_PR_PROOF_ARM');
if (arm !== 'base' && arm !== 'head') {
  throw new Error(`RELAY_PR_PROOF_ARM must be base or head, received ${JSON.stringify(arm)}.`);
}

const expectedSha =
  arm === 'base' ? process.env.RELAY_PR_PROOF_BASE_SHA : process.env.RELAY_PR_PROOF_HEAD_SHA;
if (!expectedSha) throw new Error(`Missing expected ${arm} SHA.`);
const targetSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
  timeout: COMMAND_TIMEOUT_MS,
}).trim();
if (targetSha !== expectedSha) {
  throw new Error(`Target checkout ${targetSha} does not match exact ${arm} SHA ${expectedSha}.`);
}

const runnerPath = fileURLToPath(import.meta.url);
if (!runnerPath.startsWith(`${harnessDir}${path.sep}`)) {
  throw new Error('The case runner must execute from the exact-head harness checkout.');
}

/**
 * A `flows` stand-in that keeps its deployment list in a JSON file and logs
 * every invocation, so the runner can assert what the reconcile did and in
 * what order. Installed as `npx` because the script invokes `npx flows …`.
 */
function stubSource(stateFile, logFile) {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + '\\n');
if (args[0] !== 'flows') process.exit(127);
const a = args.slice(1);
const read = () => JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
const write = (s) => fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(s));
if (a[0] === 'deployments') { console.log(JSON.stringify({ ok: true, deployments: read().deployments })); process.exit(0); }
if (a[0] === 'undeploy') {
  const id = a[a.length - 1]; const s = read();
  s.deployments = s.deployments.filter((d) => d.agentId !== id); write(s);
  console.log(JSON.stringify({ ok: true, status: 'deleted' })); process.exit(0);
}
if (a[0] === 'deploy') {
  const s = read(); const id = 'new-' + (s.seq = (s.seq || 0) + 1);
  s.deployments.push({ agentId: id, name: ${JSON.stringify(MANAGED_NAME)}, status: 'listening',
    repository: { owner: 'AgentWorkforce', name: 'relay' }, sources: [] }); write(s);
  console.log(JSON.stringify({ ok: true, agentId: id, name: ${JSON.stringify(MANAGED_NAME)}, status: 'listening', sourceSha256: 'a'.repeat(64) }));
  process.exit(0);
}
process.exit(2);
`;
}

const listener = (agentId, name) => ({
  agentId,
  name,
  status: 'listening',
  repository: { owner: 'AgentWorkforce', name: 'relay' },
  sources: [],
});

let outcome;
let signature;
let details;

const scratch = await mkdtemp(path.join(os.tmpdir(), 'relay-pr1805-'));
try {
  const scriptPath = path.join(targetDir, SCRIPT);

  if (arm === 'base') {
    if (existsSync(scriptPath)) {
      throw new Error(`Base unexpectedly provides ${SCRIPT}.`);
    }
    if (existsSync(path.join(targetDir, '.github/workflows/deploy-relayflows.yml'))) {
      throw new Error('Base unexpectedly provides the deploy workflow.');
    }
    outcome = 'absent';
    signature = 'listener_reconcile_not_available';
    details =
      `The exact base checkout has neither ${SCRIPT} nor .github/workflows/deploy-relayflows.yml, ` +
      'so the hosted listener can only be redeployed by hand and keeps running a stale snapshot after a merge.';
  } else {
    if (!existsSync(scriptPath)) throw new Error(`Head is missing ${SCRIPT}.`);

    const bin = path.join(scratch, 'bin');
    const stateFile = path.join(scratch, 'state.json');
    const logFile = path.join(scratch, 'calls.log');
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, 'npx'), stubSource(stateFile, logFile));
    await chmod(path.join(bin, 'npx'), 0o755);
    await writeFile(
      stateFile,
      JSON.stringify({
        deployments: [
          listener('stale-1', MANAGED_NAME),
          listener('stale-2', MANAGED_NAME),
          listener('unrelated', 'someone.else.flow'),
        ],
      })
    );
    await writeFile(logFile, '');

    const run = spawnSync(process.execPath, [SCRIPT], {
      cwd: targetDir,
      encoding: 'utf8',
      timeout: COMMAND_TIMEOUT_MS,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
        FLOWS_CLOUD_TOKEN: 'cld_at_stub',
        RELAY_PR_PROOF_APPROVER: 'proof-approver',
      },
    });
    if (run.status !== 0) {
      throw new Error(`Head reconcile exited ${run.status ?? 'null'}: ${(run.stderr ?? '').slice(0, 300)}`);
    }

    const final = JSON.parse(await readFile(stateFile, 'utf8')).deployments;
    const managed = final.filter((d) => d.name === MANAGED_NAME);
    const unrelated = final.find((d) => d.agentId === 'unrelated');
    if (managed.length !== 1 || !managed[0].agentId.startsWith('new-')) {
      throw new Error(
        `Head did not converge to one new listener: ${JSON.stringify(managed.map((d) => d.agentId))}`
      );
    }
    if (!unrelated) throw new Error('Head removed an unrelated listener.');

    // Order is the safety property: both stale listeners must be gone before
    // the new one exists, or a pull request in the window could start two
    // proofs racing on the same status context.
    const calls = (await readFile(logFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .map((args) => args.slice(1)); // drop the leading 'flows'
    const firstDeploy = calls.findIndex((a) => a[0] === 'deploy');
    const undeploys = calls.map((a, i) => (a[0] === 'undeploy' ? i : -1)).filter((i) => i >= 0);
    if (undeploys.length !== 2 || undeploys.some((i) => i > firstDeploy)) {
      throw new Error(
        `Head did not undeploy both stale listeners before deploying: ${JSON.stringify(calls)}`
      );
    }
    if (calls.filter((a) => a[0] === 'deploy').length !== 1) {
      throw new Error('Head deployed more than once.');
    }

    outcome = 'fixed';
    signature = 'listener_reconcile_converges_by_name';
    details =
      `From two stale ${MANAGED_NAME} listeners plus one unrelated listener, the reconcile issued ` +
      `${undeploys.length} undeploys, then exactly one deploy, and re-listed to confirm convergence. ` +
      `Final state: one ${MANAGED_NAME} listener (${managed[0].agentId}); the unrelated listener is untouched.`;
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(
  resultPath,
  `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details }, null, 2)}\n`
);
console.log(`PR1805_CASE_COMPLETE arm=${arm} outcome=${outcome} signature=${signature}`);
