#!/usr/bin/env node

/**
 * Proof for PR #1792: this repository can produce runnable relayflows v2 flow
 * specs, and every shell command in them parses.
 *
 * Base (pre-migration) has no `flows/` tree at all: the generators do not
 * exist, so no v2 spec can be produced — `absent`.
 *
 * Head runs each generator from the target checkout and then parses every
 * emitted command with `sh -n` — `fixed`.
 *
 * The parse check is the part worth proving. The migration introduced a
 * generator that appended "\n|| true" to every `failOnError: false` command,
 * which is a shell syntax error rather than a fallback, so those steps could
 * never run. That is exactly the class of defect a red/green proof catches and
 * a passing typecheck does not, so the head signature asserts the commands
 * parse rather than merely that a file was written.
 *
 * Deliberately self-contained: it drives only the target checkout's own
 * generators plus `sh -n`. No broker, no Cloud, no model credentials, so the
 * observation is reproducible from the checkout alone.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1792-relayflows-v2-spec-generation';
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

const expectedSha = arm === 'base' ? process.env.RELAY_PR_PROOF_BASE_SHA : process.env.RELAY_PR_PROOF_HEAD_SHA;
if (!expectedSha) throw new Error(`Missing expected ${arm} SHA.`);
const targetSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
  timeout: COMMAND_TIMEOUT_MS,
}).trim();
if (targetSha !== expectedSha) {
  throw new Error(`Target checkout ${targetSha} does not match exact ${arm} SHA ${expectedSha}.`);
}

// The runner must execute from the exact-head harness, never from the target.
const runnerPath = fileURLToPath(import.meta.url);
if (!runnerPath.startsWith(`${harnessDir}${path.sep}`)) {
  throw new Error('The case runner must execute from the exact-head harness checkout.');
}

/** The generators under proof, as public entry points relative to the checkout. */
const GENERATORS = [
  ['flows/verify/fleet-daytona.spec.ts', {}],
  ['flows/verify/cleanroom.spec.ts', { VERIFY_CLEANROOM_PROFILE: 'smoke' }],
  ['flows/diagnose/orchestration.spec.ts', {}],
  ['flows/audit/feature-manifest.spec.ts', {}],
  ['flows/verify/features.spec.ts', {}],
];

function generate(relativePath, extraEnv, outPath) {
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', relativePath, '--out', outPath],
    {
      cwd: targetDir,
      encoding: 'utf8',
      timeout: COMMAND_TIMEOUT_MS,
      env: { ...process.env, ...extraEnv },
    }
  );
}

/** `sh -n` parses without executing, so an unrunnable command is caught safely. */
function parses(command) {
  const result = spawnSync('sh', ['-n'], {
    input: command,
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
  });
  return { ok: result.status === 0, stderr: (result.stderr ?? '').trim().split('\n')[0] ?? '' };
}

let outcome;
let signature;
let details;

const scratch = await mkdtemp(path.join(os.tmpdir(), 'relay-pr1792-'));
try {
  const present = GENERATORS.filter(([relativePath]) => existsSync(path.join(targetDir, relativePath)));

  if (arm === 'base') {
    // Absence is the observation. Assert it rather than inferring it from a
    // failed run, so a generator that exists but merely crashes cannot be
    // mistaken for the capability being absent.
    if (present.length > 0) {
      throw new Error(
        `Base unexpectedly provides relayflows v2 generators: ${present.map(([p]) => p).join(', ')}`
      );
    }
    if (existsSync(path.join(targetDir, 'flows'))) {
      throw new Error('Base unexpectedly provides a flows/ tree.');
    }
    // Confirm the capability is genuinely unavailable, not just relocated.
    const attempt = generate(GENERATORS[0][0], {}, path.join(scratch, 'base.json'));
    if (attempt.status === 0) {
      throw new Error('Base generated a flow spec despite having no generator on disk.');
    }
    outcome = 'absent';
    signature = 'relayflows_v2_specs_not_generatable';
    details =
      `The exact base checkout has no flows/ tree and none of the ${GENERATORS.length} v2 generators. ` +
      `Invoking ${GENERATORS[0][0]} exits ${attempt.status ?? 'null'}, so no relayflows v2 spec can be produced.`;
  } else {
    if (present.length !== GENERATORS.length) {
      const missing = GENERATORS.filter(([p]) => !present.some(([q]) => q === p)).map(([p]) => p);
      throw new Error(`Head is missing relayflows v2 generators: ${missing.join(', ')}`);
    }

    let commandCount = 0;
    let stepCount = 0;
    const failures = [];
    for (const [relativePath, extraEnv] of GENERATORS) {
      const outPath = path.join(scratch, `${path.basename(relativePath, '.spec.ts')}.json`);
      const generated = generate(relativePath, extraEnv, outPath);
      if (generated.status !== 0) {
        throw new Error(
          `Head generator ${relativePath} exited ${generated.status ?? 'null'}: ${(generated.stderr ?? '').slice(0, 300)}`
        );
      }
      const spec = JSON.parse(await readFile(outPath, 'utf8'));
      if (!Array.isArray(spec.steps) || spec.steps.length === 0) {
        throw new Error(`Head generator ${relativePath} emitted no steps.`);
      }
      stepCount += spec.steps.length;
      for (const step of spec.steps) {
        if (typeof step.command !== 'string' || !step.command) continue;
        commandCount += 1;
        const verdict = parses(step.command);
        if (!verdict.ok) failures.push(`${spec.name}:${step.id} — ${verdict.stderr}`);
      }
    }

    if (failures.length > 0) {
      throw new Error(`Head emitted commands that do not parse: ${failures.slice(0, 5).join(' | ')}`);
    }
    if (commandCount === 0) {
      throw new Error('Head emitted no shell commands to parse; the proof would be vacuous.');
    }

    outcome = 'fixed';
    signature = 'relayflows_v2_specs_generate_and_parse';
    details =
      `All ${GENERATORS.length} relayflows v2 generators in the exact head checkout emit a spec: ` +
      `${stepCount} steps total, of which ${commandCount} carry a shell command. Every one of those ` +
      `${commandCount} commands parses under \`sh -n\`, so no step is unrunnable through a shell syntax error.`;
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(
  resultPath,
  `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details }, null, 2)}\n`
);
console.log(`PR1792_CASE_COMPLETE arm=${arm} outcome=${outcome} signature=${signature}`);
