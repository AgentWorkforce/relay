// Contract for the RelayFlow regression cases under tests/relayflows/cases.
// The verify-features corpus tier (flows/verify/features.spec.ts,
// cleanroom.mjs) and the targeted runner (targeted-pr-plan.mjs,
// targeted-relayflow-case.mjs) validate every case manifest and observation
// through these functions.
import path from 'node:path';

export const CASE_CONTRACT_VERSION = 1;
export const CASE_ROOT = 'tests/relayflows/cases';
export const BROKER_RUNTIME_REQUIREMENT = 'broker-linux-x64';

const CASE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SIGNATURE_RE = /^[a-z0-9](?:[a-z0-9._:-]{0,127})$/;
const MAX_OBSERVATION_DETAILS_LENGTH = 4_000;

export class CaseContractError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'CaseContractError';
    this.details = details;
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function assertObject(value, label, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return null;
  }
  return value;
}

export function caseManifestPath(caseId) {
  if (!CASE_ID_RE.test(caseId)) {
    throw new CaseContractError(`Invalid RelayFlow case id: ${caseId}`);
  }
  return `${CASE_ROOT}/${caseId}/case.json`;
}

function validateExpectation(value, label, allowedOutcome, errors) {
  const expectation = assertObject(value, label, errors);
  if (!expectation) return null;
  const outcome = nonEmptyString(expectation.outcome);
  const signature = nonEmptyString(expectation.signature);
  if (outcome !== allowedOutcome) {
    errors.push(`${label}.outcome must be ${allowedOutcome}`);
  }
  if (!signature || !SIGNATURE_RE.test(signature)) {
    errors.push(`${label}.signature must match ${SIGNATURE_RE}`);
  }
  return outcome && signature ? { outcome, signature } : null;
}

export function validateCaseManifest(value, { caseId, kind } = {}) {
  const errors = [];
  const manifest = assertObject(value, 'case manifest', errors);
  if (!manifest) throw new CaseContractError('Invalid RelayFlow case manifest', errors);

  const id = nonEmptyString(manifest.id);
  const manifestKind = nonEmptyString(manifest.kind);
  const title = nonEmptyString(manifest.title);
  if (manifest.version !== CASE_CONTRACT_VERSION) {
    errors.push(`case manifest version must be ${CASE_CONTRACT_VERSION}`);
  }
  if (!id || !CASE_ID_RE.test(id)) errors.push('case manifest id is invalid');
  if (caseId && id !== caseId) errors.push(`case manifest id ${id} does not match declared case ${caseId}`);
  if (!['feature', 'bugfix'].includes(manifestKind)) {
    errors.push('case manifest kind must be feature or bugfix');
  }
  if (kind && manifestKind !== kind) {
    errors.push(`case manifest kind ${manifestKind} does not match PR kind ${kind}`);
  }
  if (!title || title.length > 160) errors.push('case manifest title must be 1-160 characters');

  const runner = assertObject(manifest.runner, 'case manifest runner', errors);
  const command = Array.isArray(runner?.command) ? runner.command : null;
  if (!command || command.length < 2 || command.some((entry) => !nonEmptyString(entry))) {
    errors.push('case manifest runner.command must contain an executable and case script path');
  } else {
    const executable = command[0];
    if (!['node', 'bash'].includes(executable)) {
      errors.push('case manifest runner.command executable must be node or bash');
    }
    const expectedRoot = `${CASE_ROOT}/${id}/`;
    const scriptPath = command[1].replaceAll('\\', '/');
    if (
      path.posix.isAbsolute(scriptPath) ||
      scriptPath.includes('..') ||
      !scriptPath.startsWith(expectedRoot)
    ) {
      errors.push(`case runner script must stay under ${expectedRoot}`);
    }
  }

  const timeoutSeconds = Number(manifest.timeoutSeconds);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 1800) {
    errors.push('case manifest timeoutSeconds must be an integer between 30 and 1800');
  }

  const expected = assertObject(manifest.expected, 'case manifest expected', errors);
  const baseOutcome = manifestKind === 'feature' ? 'absent' : 'bug';
  const base = validateExpectation(expected?.base, 'expected.base', baseOutcome, errors);
  const head = validateExpectation(expected?.head, 'expected.head', 'fixed', errors);

  const requirements = manifest.requirements === undefined ? [] : manifest.requirements;
  if (
    !Array.isArray(requirements) ||
    requirements.some((entry) => entry !== BROKER_RUNTIME_REQUIREMENT) ||
    new Set(requirements).size !== requirements.length
  ) {
    errors.push(
      `case manifest requirements must be a unique array containing only ${BROKER_RUNTIME_REQUIREMENT}`
    );
  }

  if (errors.length > 0) {
    throw new CaseContractError('Invalid RelayFlow case manifest', errors);
  }

  return {
    version: CASE_CONTRACT_VERSION,
    id,
    kind: manifestKind,
    title,
    runner: { command: command.map((entry) => entry.trim()) },
    requirements: [...requirements],
    timeoutSeconds,
    expected: { base, head },
  };
}

export function validateObservation(value, { caseId, arm, expected }) {
  const errors = [];
  const observation = assertObject(value, 'case observation', errors);
  if (!observation) throw new CaseContractError('Invalid case observation', errors);
  if (observation.version !== CASE_CONTRACT_VERSION)
    errors.push(`observation version must be ${CASE_CONTRACT_VERSION}`);
  if (observation.caseId !== caseId) errors.push('observation caseId does not match the dispatched case');
  if (observation.arm !== arm) errors.push('observation arm does not match the dispatched arm');
  if (observation.outcome !== expected.outcome) {
    errors.push(`observation outcome ${observation.outcome} does not match expected ${expected.outcome}`);
  }
  if (observation.signature !== expected.signature) {
    errors.push(
      `observation signature ${observation.signature} does not match expected ${expected.signature}`
    );
  }
  const details = nonEmptyString(observation.details) ?? '';
  if (details.length > MAX_OBSERVATION_DETAILS_LENGTH) {
    errors.push(`observation details must not exceed ${MAX_OBSERVATION_DETAILS_LENGTH} characters`);
  }
  if (errors.length > 0) throw new CaseContractError('Invalid case observation', errors);
  return {
    version: CASE_CONTRACT_VERSION,
    caseId,
    arm,
    outcome: observation.outcome,
    signature: observation.signature,
    details,
  };
}
