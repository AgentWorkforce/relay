/**
 * Input resolution and command construction for the Fleet qualification Relayflow.
 *
 * Relayflow deterministic steps take a shell string (`sh -c`), so there is no
 * argv form to pass operator input through. Rather than hand-escape untrusted
 * values into that string, no operator-supplied value is ever interpolated into
 * a command at all: paths and digests are validated here and handed to the
 * verifier through a params file whose own path is derived solely from a
 * charset-restricted run id. The only values that reach the shell are literals
 * this module generates and asserts to be shell-inert.
 */
import { accessSync, constants, lstatSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GIT_SHA = /^[0-9a-fA-F]{40}$/;
/** No shell metacharacter, quote, whitespace or backslash can match. */
const SHELL_INERT = /^[A-Za-z0-9._/-]+$/;

export const QUALIFICATION_PARAMS_SCHEMA = 'relay-fleet-qualification-params/1';
export const BLOCKED_EXIT_CODE = 2;

export class QualificationBlockedError extends Error {
  constructor(message) {
    super(`BLOCKED: ${message}`);
    this.name = 'QualificationBlockedError';
    this.exitCode = BLOCKED_EXIT_CODE;
  }
}

function blocked(message) {
  throw new QualificationBlockedError(message);
}

/**
 * Assert that a self-generated value is safe to place in a shell command
 * unquoted. This deliberately rejects rather than escapes: any value that needs
 * escaping is one that should have travelled through the params file instead.
 */
export function shellInertLiteral(value, field) {
  if (typeof value !== 'string' || !SHELL_INERT.test(value)) {
    blocked(`${field} is not a shell-inert literal`);
  }
  return value;
}

/**
 * `test -f` semantics, which the shell preflight this replaced relied on:
 * follow symlinks, accept only a regular file. `existsSync` alone would let a
 * directory, FIFO, socket or device through — a directory then surfaces as a
 * terminal NOT_PASS deep in the verifier, and reading a FIFO blocks until the
 * workflow times out, instead of failing fast as a BLOCKED setup error.
 */
function regularFile(candidate) {
  try {
    if (!statSync(candidate).isFile()) return false;
    // Type alone is not enough: an unreadable file would otherwise pass
    // preflight and surface as a late NOT_PASS from the verifier's read.
    // This is a setup check, not a race-free guarantee — the operator is not
    // the adversary here; a hostile local user could still swap the file
    // between this check and the read.
    accessSync(candidate, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Absolute, symlink-free form of a path, so two names for one file compare
 * equal. `path.resolve` only normalises `..` and `.`; it would happily treat a
 * symlink pointing at the verdict file as a different path. Falls back to the
 * deepest existing ancestor for a path that does not exist yet.
 */
function canonical(target) {
  let current = path.resolve(target);
  const trailing = [];
  for (;;) {
    try {
      return path.join(realpathSync(current), ...trailing);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      trailing.unshift(path.basename(current));
      current = parent;
    }
  }
}

function requiredPath(env, key, description) {
  const value = env[key] ?? '';
  if (!value) blocked(`${key} is required`);
  if (!regularFile(value)) blocked(`${description} is not a readable regular file`);
  return value;
}

/**
 * Validate every operator-supplied input up front, outside the shell.
 * @param {Record<string, string | undefined>} env
 * @param {{ now?: () => number, cwd?: string }} [deps]
 */
export function resolveQualificationInputs(env = process.env, deps = {}) {
  const now = deps.now ?? Date.now;
  const cwd = deps.cwd ?? process.cwd();

  const runId = env.FLEET_QUALIFICATION_RUN_ID ?? `fleet-${now()}`;
  if (!RUN_ID.test(runId)) {
    blocked('FLEET_QUALIFICATION_RUN_ID must be a safe 1-128 character artifact name');
  }

  const rawEvidence = requiredPath(env, 'FLEET_QUALIFICATION_RAW_EVIDENCE', 'raw evidence file');
  const candidateArtifact = requiredPath(
    env,
    'FLEET_QUALIFICATION_CANDIDATE_ARTIFACT',
    'packed candidate artifact'
  );
  const candidateManifest = requiredPath(env, 'FLEET_QUALIFICATION_CANDIDATE_MANIFEST', 'candidate manifest');

  const expectedHead = env.FLEET_QUALIFICATION_EXPECTED_HEAD ?? '';
  if (!GIT_SHA.test(expectedHead)) {
    blocked('FLEET_QUALIFICATION_EXPECTED_HEAD must be a full Git SHA');
  }

  const artifacts = `.workflow-artifacts/fleet-qualification/${runId}`;
  const inputs = {
    runId,
    artifacts,
    paramsPath: `${artifacts}/params.json`,
    verdictPath: `${artifacts}/verdict.json`,
    rawEvidence,
    candidateArtifact,
    candidateManifest,
    expectedHead: expectedHead.toLowerCase(),
  };
  assertNoOutputAliases(inputs, cwd);
  return inputs;
}

/**
 * An input path that names a file this run is about to write is a
 * destructive setup error: the params write would truncate the operator's own
 * evidence before the verifier reads it, and an input aliasing the verdict
 * would only surface halfway through the run. Both are BLOCKED here instead.
 *
 * Paths are compared canonically, so a symlink aimed at either output is
 * caught by its target rather than accepted under a different name.
 */
export function assertNoOutputAliases(inputs, cwd = process.cwd()) {
  const reserved = new Map([
    [canonical(path.resolve(cwd, inputs.paramsPath)), 'the qualification params file'],
    [canonical(path.resolve(cwd, inputs.verdictPath)), 'the qualification verdict file'],
  ]);
  for (const key of ['rawEvidence', 'candidateArtifact', 'candidateManifest']) {
    const clash = reserved.get(canonical(path.resolve(cwd, inputs[key])));
    if (clash) blocked(`${key} must not be ${clash}`);
  }
}

/** Serialize the resolved inputs for the verifier steps. */
export function qualificationParams(inputs) {
  return {
    schemaVersion: QUALIFICATION_PARAMS_SCHEMA,
    runId: inputs.runId,
    artifacts: inputs.artifacts,
    rawEvidence: inputs.rawEvidence,
    candidateArtifact: inputs.candidateArtifact,
    candidateManifest: inputs.candidateManifest,
    expectedHead: inputs.expectedHead,
    verdictPath: inputs.verdictPath,
  };
}

/**
 * Reject a symlink or non-directory anywhere in the artifact root this module
 * is about to create. `mkdirSync(..., { recursive: true })` happily accepts a
 * pre-planted symlink-to-directory and would then write the params file into
 * the link target. Only the segments this module owns are walked; the
 * workspace root above them belongs to the operator.
 */
function assertRealArtifactRoot(cwd, relative) {
  let current = path.resolve(cwd);
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = lstatSync(current);
    } catch {
      return; // Absent, so every deeper segment is too: mkdirSync creates real dirs.
    }
    if (stats.isSymbolicLink()) {
      blocked(`${relative} must be a real directory, but ${segment} is a symlink`);
    }
    if (!stats.isDirectory()) {
      blocked(`${relative} must be a real directory, but ${segment} is not a directory`);
    }
  }
}

/**
 * Write the params file the deterministic steps read instead of argv.
 *
 * Created exclusively (`wx`, i.e. O_EXCL), matching how verify-evidence.mjs
 * writes the verdict. A pre-existing params.json — a reused run id, or a
 * symlink planted at that path — is BLOCKED rather than followed and
 * overwritten.
 */
export function writeQualificationParams(inputs, { cwd = process.cwd() } = {}) {
  assertNoOutputAliases(inputs, cwd);
  assertRealArtifactRoot(cwd, inputs.artifacts);
  const absolute = path.resolve(cwd, inputs.paramsPath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  try {
    writeFileSync(absolute, `${JSON.stringify(qualificationParams(inputs), null, 2)}\n`, {
      flag: 'wx',
    });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      blocked(`${inputs.paramsPath} already exists; use a fresh FLEET_QUALIFICATION_RUN_ID`);
    }
    throw error;
  }
  return absolute;
}

/**
 * Build the deterministic step commands. Only shell-inert, self-generated
 * literals are interpolated; every operator-supplied value is reached through
 * the params file.
 */
export function buildQualificationCommands(inputs) {
  const params = shellInertLiteral(inputs.paramsPath, 'params path');
  const verdict = shellInertLiteral(inputs.verdictPath, 'verdict path');
  const head = shellInertLiteral(inputs.expectedHead, 'expected head');

  return {
    preflight: [
      'set -eu',
      `test -s ${params} || { echo "BLOCKED: qualification params file is absent"; exit 2; }`,
      'test "$(git status --porcelain --untracked-files=no)" = "" || { echo "BLOCKED: tracked worktree is dirty"; exit 2; }',
      `test "$(git rev-parse HEAD)" = ${head} || { echo "BLOCKED: worktree HEAD differs from FLEET_QUALIFICATION_EXPECTED_HEAD"; exit 2; }`,
    ].join('\n'),
    sourceInventory:
      './node_modules/.bin/vitest run tests/fixtures/fleet-qualification-evidence.test.ts -t "source enumeration"',
    verifyEvidence: [
      'set -eu',
      `node scripts/fleet-qualification/verify-evidence.mjs --params ${params}`,
      `test -s ${verdict}`,
    ].join('\n'),
    finalAcceptance: [
      'set -eu',
      `node scripts/fleet-qualification/final-acceptance.mjs --params ${params}`,
    ].join('\n'),
  };
}
