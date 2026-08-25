import path from 'node:path';

export const PR_PROOF_VERSION = 1;
export const CASE_ROOT = 'tests/relayflows/cases';
export const INPUT_PATH = '.relayflow/pr-proof-input.json';
export const ARTIFACT_ROOT = '.workflow-artifacts/pr-proof';

const CASE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SIGNATURE_RE = /^[a-z0-9](?:[a-z0-9._:-]{0,127})$/;
const REQUIRED_TITLE_RE = /^(feat|fix)(?:\([^)]*\))?!?:/i;
const TYPE_MARKER_RE = /^\s*-\s*Change type:\s*`([^`]+)`\s*<!--\s*relay-pr-proof:type\s*-->\s*$/im;
const CASE_MARKER_RE = /^\s*-\s*RelayFlow case:\s*`([^`]+)`\s*<!--\s*relay-pr-proof:case\s*-->\s*$/im;

export class PrProofContractError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'PrProofContractError';
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
    throw new PrProofContractError(`Invalid RelayFlow case id: ${caseId}`);
  }
  return `${CASE_ROOT}/${caseId}/case.json`;
}

export function changedRelayFlowCaseIds(files = []) {
  const prefix = `${CASE_ROOT}/`;
  return [
    ...new Set(
      files
        .filter((file) => typeof file === 'string' && file.startsWith(prefix))
        .map((file) => file.slice(prefix.length).split('/'))
        .filter((parts) => parts.length > 1 && CASE_ID_RE.test(parts[0]))
        .map((parts) => parts[0])
    ),
  ].sort();
}

export function parsePrProofMetadata(body = '') {
  const valuesFor = (pattern) =>
    [...body.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))].map((match) =>
      match[1].trim().toLowerCase()
    );
  const changeTypes = valuesFor(TYPE_MARKER_RE);
  const caseIds = valuesFor(CASE_MARKER_RE);
  return {
    changeType: changeTypes[0] ?? null,
    caseId: caseIds[0] ?? null,
    changeTypeCount: changeTypes.length,
    caseIdCount: caseIds.length,
  };
}

export function classifyPullRequest({ title = '', body = '' }) {
  const metadata = parsePrProofMetadata(body);
  const conventionalKind = REQUIRED_TITLE_RE.exec(title)?.[1]?.toLowerCase() ?? null;
  const titleKind = conventionalKind === 'feat' ? 'feature' : conventionalKind === 'fix' ? 'bugfix' : null;
  const errors = [];

  if (metadata.changeTypeCount === 0) {
    errors.push('PR body must declare a RelayFlow Proof change type');
  }
  if (metadata.changeTypeCount > 1) {
    errors.push('PR body must contain exactly one RelayFlow Proof change type marker');
  }
  if (metadata.caseIdCount === 0) {
    errors.push('PR body must declare a RelayFlow Proof case');
  }
  if (metadata.caseIdCount > 1) {
    errors.push('PR body must contain exactly one RelayFlow Proof case marker');
  }

  if (!metadata.changeType) {
    return {
      required: Boolean(titleKind),
      kind: titleKind,
      caseId: null,
      metadata,
      errors,
      reason: 'missing proof metadata',
    };
  }

  if (!['feature', 'bugfix', 'non-functional'].includes(metadata.changeType)) {
    errors.push(
      `Unsupported RelayFlow Proof change type ${JSON.stringify(metadata.changeType)}; expected feature, bugfix, or non-functional`
    );
  }

  const metadataKind =
    metadata.changeType === 'feature' || metadata.changeType === 'bugfix' ? metadata.changeType : null;
  if (titleKind && metadata.changeType === 'non-functional') {
    errors.push(`PR title declares a ${titleKind}, so the change type cannot be non-functional`);
  }
  if (titleKind && metadataKind && titleKind !== metadataKind) {
    errors.push(`PR title declares ${titleKind}, but the PR body declares ${metadataKind}`);
  }

  const required = Boolean(metadataKind || titleKind);
  const kind = metadataKind ?? titleKind;
  if (required) {
    if (!metadata.caseId || metadata.caseId === 'n/a') {
      errors.push('Feature and bug-fix PRs must declare exactly one RelayFlow case id');
    } else if (!CASE_ID_RE.test(metadata.caseId)) {
      errors.push(`Invalid RelayFlow case id: ${metadata.caseId}`);
    }
  } else if (metadata.caseId !== 'n/a') {
    errors.push('Non-functional PRs must declare the RelayFlow case as n/a');
  }

  return {
    required,
    kind,
    caseId: required && metadata.caseId !== 'n/a' ? metadata.caseId : null,
    metadata,
    errors,
    reason: required ? `declared ${kind}` : 'declared non-functional',
  };
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
  if (!manifest) throw new PrProofContractError('Invalid RelayFlow case manifest', errors);

  const id = nonEmptyString(manifest.id);
  const manifestKind = nonEmptyString(manifest.kind);
  const title = nonEmptyString(manifest.title);
  if (manifest.version !== PR_PROOF_VERSION) {
    errors.push(`case manifest version must be ${PR_PROOF_VERSION}`);
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

  if (errors.length > 0) {
    throw new PrProofContractError('Invalid RelayFlow case manifest', errors);
  }

  return {
    version: PR_PROOF_VERSION,
    id,
    kind: manifestKind,
    title,
    runner: { command: command.map((entry) => entry.trim()) },
    timeoutSeconds,
    expected: { base, head },
  };
}

export function validateProofInput(value) {
  const errors = [];
  const input = assertObject(value, 'proof input', errors);
  if (!input) throw new PrProofContractError('Invalid PR proof input', errors);

  const repository = nonEmptyString(input.repository);
  const baseSha = nonEmptyString(input.baseSha);
  const headSha = nonEmptyString(input.headSha);
  const caseId = nonEmptyString(input.caseId);
  const kind = nonEmptyString(input.kind);
  const pullRequest = Number(input.pullRequest);
  if (input.version !== PR_PROOF_VERSION) errors.push(`proof input version must be ${PR_PROOF_VERSION}`);
  if (!repository || !REPOSITORY_RE.test(repository)) errors.push('proof input repository is invalid');
  if (!Number.isInteger(pullRequest) || pullRequest < 1) {
    errors.push('proof input pullRequest must be a positive integer');
  }
  if (!baseSha || !SHA_RE.test(baseSha)) errors.push('proof input baseSha must be a full lowercase SHA');
  if (!headSha || !SHA_RE.test(headSha)) errors.push('proof input headSha must be a full lowercase SHA');
  if (baseSha && headSha && baseSha === headSha) errors.push('proof input baseSha and headSha must differ');
  if (!caseId || !CASE_ID_RE.test(caseId)) errors.push('proof input caseId is invalid');
  if (!['feature', 'bugfix'].includes(kind)) errors.push('proof input kind must be feature or bugfix');

  let manifest = null;
  try {
    manifest = validateCaseManifest(input.manifest, { caseId, kind });
  } catch (error) {
    if (error instanceof PrProofContractError) errors.push(...error.details);
    else throw error;
  }
  if (errors.length > 0) throw new PrProofContractError('Invalid PR proof input', errors);

  return {
    version: PR_PROOF_VERSION,
    repository,
    pullRequest,
    baseSha,
    headSha,
    caseId,
    kind,
    manifest,
  };
}

export function validateObservation(value, { caseId, arm, expected }) {
  const errors = [];
  const observation = assertObject(value, 'case observation', errors);
  if (!observation) throw new PrProofContractError('Invalid case observation', errors);
  if (observation.version !== PR_PROOF_VERSION)
    errors.push(`observation version must be ${PR_PROOF_VERSION}`);
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
  if (errors.length > 0) throw new PrProofContractError('Invalid case observation', errors);
  return {
    version: PR_PROOF_VERSION,
    caseId,
    arm,
    outcome: observation.outcome,
    signature: observation.signature,
    details: nonEmptyString(observation.details) ?? '',
  };
}

export function validateEvidence(value, input, arm) {
  const errors = [];
  const evidence = assertObject(value, `${arm} evidence`, errors);
  if (!evidence) throw new PrProofContractError(`Invalid ${arm} evidence`, errors);
  const expectedSha = arm === 'base' ? input.baseSha : input.headSha;
  const expected = input.manifest.expected[arm];
  if (evidence.version !== PR_PROOF_VERSION) errors.push(`${arm} evidence version is invalid`);
  if (evidence.caseId !== input.caseId) errors.push(`${arm} evidence caseId is invalid`);
  if (evidence.arm !== arm) errors.push(`${arm} evidence arm is invalid`);
  if (evidence.repository !== input.repository) errors.push(`${arm} evidence repository is invalid`);
  if (evidence.pullRequest !== input.pullRequest) {
    errors.push(`${arm} evidence pull request is invalid`);
  }
  if (evidence.targetSha !== expectedSha) errors.push(`${arm} evidence target SHA is invalid`);
  if (evidence.harnessSha !== input.headSha) errors.push(`${arm} evidence harness SHA is invalid`);
  if (!nonEmptyString(evidence.sandboxId)) errors.push(`${arm} evidence sandboxId is missing`);
  if (evidence.runnerExitCode !== 0) errors.push(`${arm} evidence runner exit code is not zero`);
  if (evidence.outcome !== expected.outcome) errors.push(`${arm} evidence outcome is invalid`);
  if (evidence.signature !== expected.signature) errors.push(`${arm} evidence signature is invalid`);
  if (errors.length > 0) throw new PrProofContractError(`Invalid ${arm} evidence`, errors);
  return evidence;
}
