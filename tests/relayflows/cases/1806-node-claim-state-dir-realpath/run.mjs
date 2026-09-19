#!/usr/bin/env node

/**
 * Proof for #1806: `releaseNodeClaimsForBroker` (what `node down` calls)
 * matches a claim by state dir even when the claim was recorded under a
 * non-canonical spelling of that directory.
 *
 * Base canonicalises the caller's state dir and compares it with the raw
 * recorded `state_dir`, so a claim written through a symlink never matches
 * and `node down` leaves it behind — `bug`. On macOS every temp dir is such a
 * symlink (`/var/...` -> `/private/var/...`), which is how CI surfaced it; on
 * Linux the proof builds the symlink itself so the observation is portable.
 *
 * Head canonicalises both sides and releases the claim — `fixed`.
 *
 * Self-contained: it imports the target checkout's `node-claim.ts` directly
 * (Node built-ins only) under `--experimental-strip-types`. That file has one
 * class using a constructor parameter property, which strip-only mode rejects,
 * so the runner rewrites exactly that constructor to erasable syntax in a
 * scratch copy. The rewrite touches `NodeClaimConflictError` only — a class
 * this proof never exercises — and the runner refuses to continue if the copy
 * differs from the original anywhere else.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1806-node-claim-state-dir-realpath';
const MODULE = 'packages/cli/src/cli/lib/node-claim.ts';
const COMMAND_TIMEOUT_MS = 60_000;

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
 * The only non-erasable construct in the module: error classes whose
 * constructors declare `public readonly` parameter properties. Each is
 * rewritten to explicit fields plus assignments after `super(...)`, which is
 * what TypeScript emits for the same source. The shape is matched exactly —
 * parameter properties first, an optional plain `cause?` parameter, then the
 * body — and the runner refuses if any parameter property survives.
 */
const PARAMETER_PROPERTY_CONSTRUCTOR =
  /  constructor\(\n((?:    public readonly \w+: \w+,?\n)+)((?:    cause\?: unknown\n)?)  \) \{\n([\s\S]*?)\n  \}\n\}/g;

function erasable(_match, properties, cause, body) {
  const params = [...properties.matchAll(/public readonly (\w+): (\w+)/g)].map(([, name, type]) => ({
    name,
    type,
  }));
  const fields = params.map(({ name, type }) => `  readonly ${name}: ${type};`).join('\n');
  const signature = [
    ...params.map(({ name, type }) => `${name}: ${type}`),
    ...(cause ? ['cause?: unknown'] : []),
  ];
  const assignments = params.map(({ name }) => `    this.${name} = ${name};`).join('\n');
  return `${fields}\n  constructor(${signature.join(', ')}) {\n${body}\n${assignments}\n  }\n}`;
}

/** Copy the module into scratch with only those constructors rewritten. */
async function loadableCopy(scratch) {
  const original = await readFile(path.join(targetDir, MODULE), 'utf8');
  const rewritten = original.replace(PARAMETER_PROPERTY_CONSTRUCTOR, erasable);
  if (/\b(public|private|protected) readonly\b/.test(rewritten)) {
    throw new Error(`${MODULE} has a parameter property outside the shape this proof knows how to rewrite.`);
  }
  // Outside the rewritten constructors the copy must be identical: the same
  // number of lines changed as the rewrite accounts for, and nothing else.
  const changedOutside = original
    .split('\n')
    .filter(
      (line) =>
        !rewritten.includes(line) &&
        !/^\s+(public readonly \w+: \w+,?|cause\?: unknown|constructor\(|\) \{)$/.test(line)
    );
  if (changedOutside.length > 0) {
    throw new Error(
      `The scratch copy lost lines outside the constructors: ${changedOutside.slice(0, 3).join(' | ')}`
    );
  }
  const copy = path.join(scratch, 'node-claim.ts');
  await writeFile(copy, rewritten);
  return copy;
}

/** Runs in a child so the module is loaded under strip-types from the copy. */
const PROBE = `
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [modulePath, root] = process.argv.slice(2);
const mod = await import(pathToFileURL(modulePath).href);
const real = path.join(root, 'state');
fs.mkdirSync(real);
const link = path.join(root, 'link');
fs.symlinkSync(real, link);
const home = path.join(root, 'home');
const env = { AGENT_RELAY_HOME: path.join(home, 'relay'), HOME: home, XDG_DATA_HOME: path.join(home, 'data') };
// A claim recorded through the symlinked spelling, as an older CLI or a
// hand-written record would leave it.
const file = mod.nodeClaimPath('node_1', env, 1);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify({
  version: 1, node_id: 'node_1', pid: 555, state_dir: link,
  claimed_at: new Date().toISOString(), generation: 1,
}));
const released = await mod.releaseNodeClaimsForBroker({
  pid: 555, stateDir: real, env,
  killProcess: () => undefined,
  execCommand: async () => ({ stdout: '', stderr: '' }),
});
const remaining = mod.listNodeClaims(env).map((claim) => claim.node_id);
console.log(JSON.stringify({ released: released.map((claim) => claim.node_id), remaining, real, link }));
`;

let outcome;
let signature;
let details;

const scratch = await mkdtemp(path.join(os.tmpdir(), 'relay-pr1806-'));
try {
  if (!existsSync(path.join(targetDir, MODULE))) throw new Error(`Target is missing ${MODULE}.`);
  const copy = await loadableCopy(scratch);
  const probePath = path.join(scratch, 'probe.mjs');
  await writeFile(probePath, PROBE);
  const root = path.join(scratch, 'run');
  await mkdir(root);

  const result = spawnSync(process.execPath, ['--experimental-strip-types', probePath, copy, root], {
    cwd: targetDir,
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    throw new Error(`Probe exited ${result.status ?? 'null'}: ${(result.stderr ?? '').slice(-400)}`);
  }
  const observed = JSON.parse(result.stdout.trim().split('\n').at(-1));
  const releasedNode1 = observed.released.length === 1 && observed.released[0] === 'node_1';
  const leftBehind = observed.remaining.includes('node_1');

  if (arm === 'base') {
    if (releasedNode1 || !leftBehind) {
      throw new Error(`Base unexpectedly released the symlinked claim: ${JSON.stringify(observed)}`);
    }
    outcome = 'bug';
    signature = 'node_claim_symlinked_state_dir_not_released';
    details =
      `In the exact base checkout, releaseNodeClaimsForBroker({ pid: 555, stateDir: <real> }) released ` +
      `${observed.released.length} claim(s) although node_1 records the same directory through a symlink; ` +
      'node_1 is left behind, so `node down` cannot clear a claim written under a non-canonical spelling ' +
      '(every macOS temp dir is one).';
  } else {
    if (!releasedNode1 || leftBehind) {
      throw new Error(`Head did not release the symlinked claim: ${JSON.stringify(observed)}`);
    }
    outcome = 'fixed';
    signature = 'node_claim_symlinked_state_dir_released';
    details =
      'In the exact head checkout, releaseNodeClaimsForBroker({ pid: 555, stateDir: <real> }) released ' +
      'exactly node_1, whose record names the same directory through a symlink, and no claim is left behind: ' +
      'both spellings are canonicalised before comparison.';
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(
  resultPath,
  `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details }, null, 2)}\n`
);
console.log(`PR1806_CASE_COMPLETE arm=${arm} outcome=${outcome} signature=${signature}`);
