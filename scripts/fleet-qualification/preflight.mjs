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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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

function requiredPath(env, key, description, fileExists) {
  const value = env[key] ?? '';
  if (!value) blocked(`${key} is required`);
  if (!fileExists(value)) blocked(`${description} is absent`);
  return value;
}

/**
 * Validate every operator-supplied input up front, outside the shell.
 * @param {Record<string, string | undefined>} env
 * @param {{ fileExists?: (p: string) => boolean, now?: () => number }} [deps]
 */
export function resolveQualificationInputs(env = process.env, deps = {}) {
  const fileExists = deps.fileExists ?? existsSync;
  const now = deps.now ?? Date.now;

  const runId = env.FLEET_QUALIFICATION_RUN_ID ?? `fleet-${now()}`;
  if (!RUN_ID.test(runId)) {
    blocked('FLEET_QUALIFICATION_RUN_ID must be a safe 1-128 character artifact name');
  }

  const rawEvidence = requiredPath(env, 'FLEET_QUALIFICATION_RAW_EVIDENCE', 'raw evidence file', fileExists);
  const candidateArtifact = requiredPath(
    env,
    'FLEET_QUALIFICATION_CANDIDATE_ARTIFACT',
    'packed candidate artifact',
    fileExists
  );
  const candidateManifest = requiredPath(
    env,
    'FLEET_QUALIFICATION_CANDIDATE_MANIFEST',
    'candidate manifest',
    fileExists
  );

  const expectedHead = env.FLEET_QUALIFICATION_EXPECTED_HEAD ?? '';
  if (!GIT_SHA.test(expectedHead)) {
    blocked('FLEET_QUALIFICATION_EXPECTED_HEAD must be a full Git SHA');
  }

  const artifacts = `.workflow-artifacts/fleet-qualification/${runId}`;
  return {
    runId,
    artifacts,
    paramsPath: `${artifacts}/params.json`,
    verdictPath: `${artifacts}/verdict.json`,
    rawEvidence,
    candidateArtifact,
    candidateManifest,
    expectedHead: expectedHead.toLowerCase(),
  };
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

/** Write the params file the deterministic steps read instead of argv. */
export function writeQualificationParams(inputs, { cwd = process.cwd() } = {}) {
  const absolute = path.resolve(cwd, inputs.paramsPath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(qualificationParams(inputs), null, 2)}\n`);
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
