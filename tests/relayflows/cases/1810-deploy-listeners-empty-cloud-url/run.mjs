#!/usr/bin/env node

/**
 * Proof for PR #1810: the listener reconcile does not hand the `flows` CLI an
 * empty `FLOWS_CLOUD_URL`, and when the CLI refuses, the refusal is in the
 * error rather than a bare exit code.
 *
 * The deploy workflow exported `${{ vars.FLOWS_CLOUD_URL }}` with no such
 * variable, which yields "" — and the CLI refuses an empty URL instead of
 * falling back to production. Base forwards the variable as-is, so with
 * `FLOWS_CLOUD_URL=""` the very first `flows deployments` fails and the log
 * says only `exited 2` — `bug`. Head drops the empty variable before spawning
 * the CLI, so the reconcile proceeds; and when the CLI does refuse, the
 * script's error carries the CLI's own `{"ok":false,…}` line — `fixed`.
 *
 * `flows` is stubbed exactly as the CLI behaves: with an empty FLOWS_CLOUD_URL
 * in its environment it prints the configuration refusal to stdout and exits
 * 2; otherwise it serves an in-memory deployment list. The stub is the
 * observed CLI contract, checked against the real binary when this case was
 * written, so the proof needs no Cloud credential.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1810-deploy-listeners-empty-cloud-url';
const SCRIPT = 'scripts/flows/deploy-listeners.mjs';
const REFUSAL =
  '{"ok":false,"code":"configuration","message":"FLOWS_CLOUD_URL must be an absolute Cloud application base URL."}';
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
 * A `flows` stand-in with the real CLI's environment contract: an empty
 * FLOWS_CLOUD_URL is a configuration refusal on stdout with exit 2. With the
 * variable absent it keeps a deployment list in a JSON file so a reconcile can
 * run to completion. `FLOWS_STUB_REFUSE_ALL=1` makes every call refuse, to
 * observe how the script reports a refusal it did not cause.
 */
function stubSource(stateFile) {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== 'flows') process.exit(127);
if (('FLOWS_CLOUD_URL' in process.env && !process.env.FLOWS_CLOUD_URL.trim()) || process.env.FLOWS_STUB_REFUSE_ALL) {
  console.log(${JSON.stringify(REFUSAL)});
  process.exit(2);
}
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
  s.deployments.push({ agentId: id, name: 'relay.ci.pr-proof', status: 'listening',
    repository: { owner: 'AgentWorkforce', name: 'relay' }, sources: [] }); write(s);
  console.log(JSON.stringify({ ok: true, agentId: id, status: 'listening', sourceSha256: 'a'.repeat(64) }));
  process.exit(0);
}
process.exit(2);
`;
}

function reconcile(bin, extraEnv) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: targetDir,
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      FLOWS_CLOUD_TOKEN: 'cld_at_stub',
      RELAY_PR_PROOF_APPROVER: 'proof-approver',
      ...extraEnv,
    },
  });
  return {
    status: result.status,
    stderr: (result.stderr ?? '').trim(),
    stdout: (result.stdout ?? '').trim(),
  };
}

let outcome;
let signature;
let details;

const scratch = await mkdtemp(path.join(os.tmpdir(), 'relay-pr1810-'));
try {
  if (!existsSync(path.join(targetDir, SCRIPT))) throw new Error(`Target is missing ${SCRIPT}.`);
  const bin = path.join(scratch, 'bin');
  const stateFile = path.join(scratch, 'state.json');
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, 'npx'), stubSource(stateFile));
  await chmod(path.join(bin, 'npx'), 0o755);
  const resetState = () => writeFile(stateFile, JSON.stringify({ deployments: [] }));

  // Exactly the workflow's environment: the variable present and empty.
  await resetState();
  const emptyUrl = reconcile(bin, { FLOWS_CLOUD_URL: '' });

  if (arm === 'base') {
    if (emptyUrl.status === 0) {
      throw new Error(`Base unexpectedly reconciled with an empty FLOWS_CLOUD_URL: ${emptyUrl.stdout}`);
    }
    if (!/flows deployments --json exited 2/.test(emptyUrl.stderr)) {
      throw new Error(`Base failed for another reason: ${emptyUrl.stderr.slice(0, 300)}`);
    }
    if (emptyUrl.stderr.includes('absolute Cloud application base URL')) {
      throw new Error('Base already surfaces the CLI refusal; the observation would not be the bug.');
    }
    outcome = 'bug';
    signature = 'reconcile_refused_on_empty_cloud_url';
    details =
      `In the exact base checkout, ${SCRIPT} run with FLOWS_CLOUD_URL="" exits ${emptyUrl.status} at its first ` +
      'CLI call — the CLI refuses the empty URL rather than defaulting — and the log says only ' +
      `"${emptyUrl.stderr.split('\n').at(-1)}", without the CLI's reason. No listener is reconciled.`;
  } else {
    if (emptyUrl.status !== 0) {
      throw new Error(`Head still fails with an empty FLOWS_CLOUD_URL: ${emptyUrl.stderr.slice(0, 300)}`);
    }
    if (!/DEPLOYED new-1 listening/.test(emptyUrl.stdout)) {
      throw new Error(`Head did not complete the reconcile: ${emptyUrl.stdout.slice(0, 300)}`);
    }

    // When the CLI does refuse, the operator must see why.
    await resetState();
    const refused = reconcile(bin, { FLOWS_STUB_REFUSE_ALL: '1' });
    if (refused.status === 0) throw new Error('Head ignored a CLI refusal.');
    if (!refused.stderr.includes('absolute Cloud application base URL')) {
      throw new Error(`Head hid the CLI refusal: ${refused.stderr.slice(0, 300)}`);
    }

    outcome = 'fixed';
    signature = 'reconcile_ignores_empty_cloud_url_and_echoes_refusals';
    details =
      `In the exact head checkout, ${SCRIPT} run with FLOWS_CLOUD_URL="" drops the empty variable and completes ` +
      "the reconcile (DEPLOYED new-1 listening); and when the CLI refuses, the error carries the CLI's own " +
      `reason ("...absolute Cloud application base URL.") instead of a bare exit code.`;
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(
  resultPath,
  `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details }, null, 2)}\n`
);
console.log(`PR1810_CASE_COMPLETE arm=${arm} outcome=${outcome} signature=${signature}`);
