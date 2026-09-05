import { createHash } from 'node:crypto';

const ASCII_EDGE = /^[\x09-\x0d\x20]+|[\x09-\x0d\x20]+$/g;
const CONTROL = /[\x00-\x1f\x7f]/;
const SHA256 = /^[0-9a-f]{64}$/;

export class QualificationNotPassError extends Error {
  constructor(message) {
    super(`NOT_PASS: ${message}`);
    this.name = 'QualificationNotPassError';
    this.retryAllowed = false;
  }
}

function notPass(message) {
  throw new QualificationNotPassError(message);
}

function requiredString(value, field) {
  if (typeof value !== 'string') notPass(`${field} must be a JSON string`);
  return value;
}

function trimAsciiEdge(value) {
  return value.replace(ASCII_EDGE, '');
}

export function normalizeDeploymentId(value, field = 'deploymentId') {
  const normalized = trimAsciiEdge(requiredString(value, field)).replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (!normalized) notPass(`${field} is empty after normalization`);
  if (CONTROL.test(normalized)) notPass(`${field} contains a control character`);
  return normalized;
}

export function normalizeSnapshotId(value, field = 'observedDaytonaSnapshotId') {
  const normalized = trimAsciiEdge(requiredString(value, field));
  if (!normalized) notPass(`${field} is empty after normalization`);
  if (CONTROL.test(normalized)) notPass(`${field} contains a control character`);
  return normalized;
}

export function normalizeSha256(value, field) {
  const normalized = trimAsciiEdge(requiredString(value, field)).replace(/[A-F]/g, (c) => c.toLowerCase());
  if (!SHA256.test(normalized)) notPass(`${field} must be a bare 64-character SHA-256 hex digest`);
  return normalized;
}

function assertJsonValue(value, path = '$') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) notPass(`${path} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    notPass(`${path} is not an RFC 8785 JSON value`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'undefined' || typeof entry === 'function' || typeof entry === 'bigint') {
      notPass(`${path}.${key} is not an RFC 8785 JSON value`);
    }
    assertJsonValue(entry, `${path}.${key}`);
  }
}

/** RFC 8785/JCS ordering uses lexicographic UTF-16 code-unit order. */
export function canonicalizeJson(value) {
  assertJsonValue(value);
  const visit = (entry) => {
    if (entry === null || typeof entry !== 'object') return JSON.stringify(entry);
    if (Array.isArray(entry)) return `[${entry.map(visit).join(',')}]`;
    return `{${Object.keys(entry)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${visit(entry[key])}`)
      .join(',')}}`;
  };
  return visit(value);
}

export function canonicalizeCandidateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    notPass('candidateManifest must be a JSON object');
  }
  if (!Object.hasOwn(manifest, 'relayfileCloudDeploymentId')) {
    notPass('candidateManifest.relayfileCloudDeploymentId is required');
  }
  const normalized = {
    ...manifest,
    relayfileCloudDeploymentId: normalizeDeploymentId(
      manifest.relayfileCloudDeploymentId,
      'candidateManifest.relayfileCloudDeploymentId'
    ),
  };
  return canonicalizeJson(normalized);
}

export function candidateManifestSha256(manifest) {
  return createHash('sha256').update(canonicalizeCandidateManifest(manifest), 'utf8').digest('hex');
}

function requireIsoTimestamp(value, field) {
  requiredString(value, field);
  if (Number.isNaN(Date.parse(value))) notPass(`${field} must be an ISO-8601 timestamp`);
}

function validateNode(node, manifestDigest, candidateArtifactSha256, index) {
  const prefix = `nodes[${index}]`;
  const resourceId = normalizeSnapshotId(node?.resourceId, `${prefix}.resourceId`);
  normalizeSnapshotId(node?.name, `${prefix}.name`);
  const snapshotId = normalizeSnapshotId(
    node?.observedDaytonaSnapshotId,
    `${prefix}.observedDaytonaSnapshotId`
  );
  const imageDigest = normalizeSha256(node?.inImageManifestSha256, `${prefix}.inImageManifestSha256`);
  if (imageDigest !== manifestDigest) {
    notPass(`${prefix}.inImageManifestSha256 does not equal the canonical candidate manifest digest`);
  }
  if (node?.cleanliness?.before?.agentCount !== 0) {
    notPass(`${prefix} was not clean before its first attempt`);
  }
  requireIsoTimestamp(node?.cleanliness?.before?.observedAt, `${prefix}.cleanliness.before.observedAt`);
  if (node?.provisionedForRun !== true) notPass(`${prefix} was not provisioned fresh for this run`);
  requireIsoTimestamp(node?.createdAt, `${prefix}.createdAt`);
  if (
    node?.snapshotObservation?.source !== 'running-node' ||
    typeof node?.snapshotObservation?.command !== 'string' ||
    !node.snapshotObservation.command.trim()
  ) {
    notPass(`${prefix} snapshot identity was not read back from the running node`);
  }
  requireIsoTimestamp(node?.snapshotObservation?.observedAt, `${prefix}.snapshotObservation.observedAt`);
  if (
    node?.manifestObservation?.source !== 'in-image' ||
    typeof node?.manifestObservation?.command !== 'string' ||
    !node.manifestObservation.command.trim()
  ) {
    notPass(`${prefix} manifest digest was not read or computed in-image`);
  }
  requireIsoTimestamp(node?.manifestObservation?.observedAt, `${prefix}.manifestObservation.observedAt`);
  if (node?.cleanliness?.after?.absentById !== true) {
    notPass(`${prefix} teardown did not prove resource ${resourceId} absent by id`);
  }
  requireIsoTimestamp(node?.cleanliness?.after?.observedAt, `${prefix}.cleanliness.after.observedAt`);
  if (
    node?.artifactInstall?.kind !== 'packed' ||
    node?.artifactInstall?.installed !== true ||
    node?.artifactInstall?.checkout === true ||
    node?.artifactInstall?.symlink === true
  ) {
    notPass(`${prefix} does not prove a packed, clean-installed candidate artifact`);
  }
  const installedArtifactSha256 = normalizeSha256(
    node?.artifactInstall?.sha256,
    `${prefix}.artifactInstall.sha256`
  );
  if (installedArtifactSha256 !== candidateArtifactSha256) {
    notPass(`${prefix} installed artifact digest differs from the pinned candidate artifact`);
  }
  return {
    resourceId,
    snapshotId,
    imageDigest,
    createdAt: Date.parse(node.createdAt),
    cleanBeforeAt: Date.parse(node.cleanliness.before.observedAt),
    cleanAfterAt: Date.parse(node.cleanliness.after.observedAt),
    snapshotObservedAt: Date.parse(node.snapshotObservation.observedAt),
    manifestObservedAt: Date.parse(node.manifestObservation.observedAt),
  };
}

function validateAttempt(attempt, operation, attemptNumber, nodesById, manifest, manifestDigest) {
  const prefix = `attempts[${operation}#${attemptNumber}]`;
  if (attempt?.operation !== operation || attempt?.attempt !== attemptNumber) {
    notPass(`${prefix} has the wrong operation or attempt number`);
  }
  const nodeResourceId = normalizeSnapshotId(attempt?.nodeResourceId, `${prefix}.nodeResourceId`);
  const node = nodesById.get(nodeResourceId);
  if (!node) notPass(`${prefix} names an unknown Daytona resource id`);
  if (!Number.isSafeInteger(attempt.targetHostPid) || attempt.targetHostPid <= 0) {
    notPass(`${prefix} lacks a real positive target-host PID`);
  }
  if (
    attempt?.processEvidence?.pid !== attempt.targetHostPid ||
    normalizeSnapshotId(
      attempt?.processEvidence?.nodeResourceId,
      `${prefix}.processEvidence.nodeResourceId`
    ) !== nodeResourceId ||
    typeof attempt?.processEvidence?.comm !== 'string' ||
    !attempt.processEvidence.comm.trim() ||
    attempt?.processEvidence?.source !== 'target-host'
  ) {
    notPass(`${prefix} process evidence does not bind PID and comm to the target node`);
  }
  requireIsoTimestamp(attempt?.processEvidence?.observedAt, `${prefix}.processEvidence.observedAt`);
  requireIsoTimestamp(attempt.startedAt, `${prefix}.startedAt`);
  requireIsoTimestamp(attempt.finishedAt, `${prefix}.finishedAt`);
  if (Date.parse(attempt.finishedAt) < Date.parse(attempt.startedAt)) {
    notPass(`${prefix} finished before it started`);
  }

  const requested = normalizeDeploymentId(
    attempt.requestedRelayfileCloudDeploymentId,
    `${prefix}.requestedRelayfileCloudDeploymentId`
  );
  const observed = normalizeDeploymentId(
    attempt.observedRelayfileCloudDeploymentId,
    `${prefix}.observedRelayfileCloudDeploymentId`
  );
  const manifestId = normalizeDeploymentId(
    manifest.relayfileCloudDeploymentId,
    'candidateManifest.relayfileCloudDeploymentId'
  );
  if (requested !== observed || requested !== manifestId) {
    notPass(`${prefix} requested/observed/manifest deployment IDs differ after symmetric normalization`);
  }
  const attestation = normalizeSha256(
    attempt.relayfileCloudAttestationSha256,
    `${prefix}.relayfileCloudAttestationSha256`
  );
  const imageDigest = normalizeSha256(attempt.inImageManifestSha256, `${prefix}.inImageManifestSha256`);
  const snapshotId = normalizeSnapshotId(
    attempt.observedDaytonaSnapshotId,
    `${prefix}.observedDaytonaSnapshotId`
  );
  if (snapshotId !== node.snapshotId) {
    notPass(`${prefix} snapshot identity differs from the running-node observation`);
  }
  if (attestation !== manifestDigest || imageDigest !== manifestDigest) {
    notPass(`${prefix} manifest attestation does not match canonical manifest bytes`);
  }

  if (attempt.outcome === 'pass') {
    if (attempt.exitCode !== 0) notPass(`${prefix} pass outcome has non-zero exit code`);
  } else if (attempt.outcome === 'expected_refusal') {
    if (!Number.isInteger(attempt.exitCode) || attempt.exitCode === 0) {
      notPass(`${prefix} expected refusal must exit non-zero`);
    }
    const expected = requiredString(attempt.expectedError, `${prefix}.expectedError`);
    const observedError = requiredString(attempt.observedError, `${prefix}.observedError`);
    if (!expected || observedError !== expected) {
      notPass(`${prefix} refusal error differs from the exact expected error`);
    }
  } else {
    notPass(`${prefix}.outcome must be pass or expected_refusal`);
  }
}

export function validateQualificationEvidence(evidence, operations) {
  if (evidence?.schemaVersion !== 'relay-fleet-qualification/1') {
    notPass('schemaVersion must be relay-fleet-qualification/1');
  }
  if (!Array.isArray(operations) || operations.length !== 95 || new Set(operations).size !== 95) {
    notPass('the source-derived operation inventory must contain exactly 95 unique operations');
  }
  if (
    !Array.isArray(evidence.matrixOperations) ||
    evidence.matrixOperations.join('\n') !== operations.join('\n')
  ) {
    notPass('matrixOperations differs from the source-derived ordered inventory');
  }
  const manifestDigest = candidateManifestSha256(evidence.candidateManifest);
  if (evidence?.candidateArtifact?.kind !== 'packed') {
    notPass('candidateArtifact.kind must be packed');
  }
  const candidateArtifactSha256 = normalizeSha256(
    evidence?.candidateArtifact?.sha256,
    'candidateArtifact.sha256'
  );
  if (!Array.isArray(evidence.nodes) || evidence.nodes.length < 2) {
    notPass('at least two fresh Daytona nodes are required');
  }
  const validatedNodes = evidence.nodes.map((node, index) =>
    validateNode(node, manifestDigest, candidateArtifactSha256, index)
  );
  const nodesById = new Map(validatedNodes.map((node) => [node.resourceId, node]));
  if (nodesById.size !== evidence.nodes.length) notPass('Daytona resource IDs must be distinct');
  if (!Array.isArray(evidence.attempts)) notPass('attempts must be an array');

  const expectedAttempts = operations.length * 2;
  if (evidence.attempts.length !== expectedAttempts) {
    notPass(`expected ${expectedAttempts} attempts, found ${evidence.attempts.length}`);
  }
  for (const operation of operations) {
    const attempts = evidence.attempts
      .filter((attempt) => attempt?.operation === operation)
      .sort((a, b) => a.attempt - b.attempt);
    if (attempts.length !== 2) notPass(`${operation} must have exactly two attempts`);
    validateAttempt(attempts[0], operation, 1, nodesById, evidence.candidateManifest, manifestDigest);
    validateAttempt(attempts[1], operation, 2, nodesById, evidence.candidateManifest, manifestDigest);
    if (attempts[0].nodeResourceId === attempts[1].nodeResourceId) {
      notPass(`${operation} attempts must run on two distinct Daytona resource IDs`);
    }
  }

  for (const node of validatedNodes) {
    const nodeAttempts = evidence.attempts.filter(
      (attempt) => normalizeSnapshotId(attempt.nodeResourceId, 'attempt.nodeResourceId') === node.resourceId
    );
    const firstAttemptAt = Math.min(...nodeAttempts.map((attempt) => Date.parse(attempt.startedAt)));
    const lastAttemptAt = Math.max(...nodeAttempts.map((attempt) => Date.parse(attempt.finishedAt)));
    if (
      node.createdAt > node.cleanBeforeAt ||
      node.cleanBeforeAt > firstAttemptAt ||
      node.snapshotObservedAt > firstAttemptAt ||
      node.manifestObservedAt > firstAttemptAt
    ) {
      notPass(`resource ${node.resourceId} lacks ordered pre-attempt cleanliness and identity proof`);
    }
    if (node.cleanAfterAt < lastAttemptAt) {
      notPass(`resource ${node.resourceId} teardown absence was not observed after its final attempt`);
    }
  }

  const attemptsByRef = new Map(
    evidence.attempts.map((attempt) => [`${attempt.operation}#${attempt.attempt}`, attempt])
  );
  for (const capability of [
    'targetedDispatch',
    'messagingInjection',
    'attachDrive',
    'release',
    'restart',
    'failureSemantics',
  ]) {
    const proof = evidence?.coverage?.[capability];
    if (proof?.passed !== true || !Array.isArray(proof.attemptRefs) || proof.attemptRefs.length === 0) {
      notPass(`coverage.${capability} must cite at least one passing matrix attempt`);
    }
    for (const ref of proof.attemptRefs) {
      if (!attemptsByRef.has(ref)) notPass(`coverage.${capability} cites unknown attempt ${String(ref)}`);
    }
  }
  if (
    !evidence.coverage.failureSemantics.attemptRefs.some(
      (ref) => attemptsByRef.get(ref)?.outcome === 'expected_refusal'
    )
  ) {
    notPass('coverage.failureSemantics must cite an exact expected-refusal attempt');
  }

  return {
    verdict: 'PASS',
    retryAllowed: false,
    operationCount: operations.length,
    attemptCount: expectedAttempts,
    nodeResourceIds: [...nodesById.keys()],
    candidateManifestSha256: manifestDigest,
    candidateArtifactSha256,
    completedAt: new Date(Math.max(...validatedNodes.map((node) => node.cleanAfterAt))).toISOString(),
  };
}
