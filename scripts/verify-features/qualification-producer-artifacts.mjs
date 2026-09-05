#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLOUD_SNAPSHOT_PRODUCER = Object.freeze({
  repository: 'AgentWorkforce/cloud',
  workflow: 'Rebuild Daytona Snapshot',
  workflowPath: '.github/workflows/rebuild-snapshot.yml',
  event: 'workflow_dispatch',
  headBranch: 'main',
  ref: 'refs/heads/main',
});

export const RELAYFILE_CLOUD_PRODUCER = Object.freeze({
  repository: 'AgentWorkforce/relayfile-cloud',
  workflow: 'Relayfile Cloud candidate qualification',
  workflowPath: '.github/workflows/relayfile-cloud-candidate-qualification.yml',
  event: 'workflow_dispatch',
  headBranch: 'main',
  ref: 'refs/heads/main',
});

export const CLOUD_SNAPSHOT_ACCEPTANCE_PRODUCER = Object.freeze({
  repository: 'AgentWorkforce/cloud',
  workflow: 'Accept Candidate Daytona Snapshot',
  workflowPath: '.github/workflows/accept-candidate-snapshot.yml',
  event: 'workflow_dispatch',
  headBranch: 'main',
  ref: 'refs/heads/main',
});

export const CLOUD_FILES = Object.freeze([
  'grok-producer-attestation.json',
  'qualification.json',
  'qualification.json.sha256',
  'qualification.seal.json',
  'relay-producer-attestation.json',
  'relayfile-producer-attestation.json',
  'snapshot-manifest-full.json',
  'snapshot-manifest-lite.json',
  'tools-producer-attestation.json',
  'verified-full.json',
  'verified-lite.json',
]);

export const RELAYFILE_CLOUD_FILES = Object.freeze([
  'qualification.seal.json',
  'relayfile-cloud-attestation.json',
]);
export const CLOUD_ACCEPTANCE_FILES = Object.freeze(['candidate-acceptance.json']);

const SCALE_FILES = 851;
const SCALE_DIRECTORIES = 454;
const SCALE_BYTES = 270_532_608;
const SCALE_MANIFEST_SHA256 = '905968a14268ec5e8ec38ae1d6b24749e855cac035976a87a65ef43f6612a55a';

const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ARTIFACT_SHA256 = /^sha256:[a-f0-9]{64}$/;
const DAYTONA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeRelativePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !path.posix.isAbsolute(value) &&
    !value.includes('\\') &&
    path.posix.normalize(value) === value &&
    !value.split('/').includes('..')
  );
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw new Error(`${label} has an unexpected shape`);
  }
}

function workflowPath(value) {
  return String(value ?? '').split('@')[0];
}

function workflowRef(value) {
  return String(value ?? '').split('@')[1];
}

export function validateFixedProducerRun(run, artifacts, expected, policy) {
  const runId = Number(expected.runId);
  const runAttempt = Number(expected.runAttempt);
  if (
    !Number.isSafeInteger(runId) ||
    runId < 1 ||
    !Number.isSafeInteger(runAttempt) ||
    runAttempt < 1 ||
    !SHA40.test(expected.sourceSha ?? '') ||
    !ARTIFACT_SHA256.test(expected.artifactDigest ?? '') ||
    !String(expected.artifactName ?? '').endsWith(`-${runId}-${runAttempt}`)
  ) {
    throw new Error('fixed producer expectation is invalid');
  }
  if (
    run?.id !== runId ||
    run?.run_attempt !== runAttempt ||
    run?.head_sha !== expected.sourceSha ||
    run?.status !== 'completed' ||
    run?.conclusion !== 'success' ||
    run?.name !== policy.workflow ||
    workflowPath(run?.path) !== policy.workflowPath ||
    (workflowRef(run?.path) !== undefined && workflowRef(run?.path) !== policy.ref) ||
    run?.event !== policy.event ||
    run?.head_branch !== policy.headBranch
  ) {
    throw new Error(`${policy.repository} run is outside the fixed producer policy`);
  }
  const matches = (artifacts ?? []).filter(
    (artifact) => artifact?.name === expected.artifactName && !artifact?.expired
  );
  if (
    matches.length !== 1 ||
    matches[0]?.workflow_run?.id !== runId ||
    matches[0]?.digest !== expected.artifactDigest
  ) {
    throw new Error(`${policy.repository} artifact identity or digest mismatch`);
  }
  return run;
}

async function verifyExactRegularFiles(directory, allFiles) {
  const root = path.resolve(directory);
  const actualFiles = (await readdir(root)).sort();
  if (actualFiles.join('\0') !== [...allFiles].sort().join('\0')) {
    throw new Error('qualification artifact has an unexpected exact file set');
  }
  for (const file of actualFiles) {
    const info = await lstat(path.join(root, file));
    if (!info.isFile()) {
      throw new Error(`qualification artifact entry is not a regular file: ${file}`);
    }
  }
  return root;
}

async function verifySealedDirectory(directory, expected, allFiles, sealedFiles) {
  const root = await verifyExactRegularFiles(directory, allFiles);
  const seal = JSON.parse(await readFile(path.join(root, 'qualification.seal.json'), 'utf8'));
  exactKeys(seal, ['schemaVersion', 'runId', 'runAttempt', 'sourceGitSha', 'files'], 'qualification seal');
  if (
    seal.schemaVersion !== 1 ||
    String(seal.runId) !== String(expected.runId) ||
    String(seal.runAttempt) !== String(expected.runAttempt) ||
    seal.sourceGitSha !== expected.sourceSha ||
    !Array.isArray(seal.files)
  ) {
    throw new Error('qualification seal identity is invalid');
  }
  const expectedNames = [...sealedFiles].sort();
  const entries = [...seal.files].sort((left, right) =>
    String(left?.file).localeCompare(String(right?.file))
  );
  if (entries.map((entry) => entry?.file).join('\0') !== expectedNames.join('\0')) {
    throw new Error('qualification seal has an unexpected exact file set');
  }
  for (const entry of entries) {
    exactKeys(entry, ['file', 'sha256'], `qualification seal file ${String(entry?.file)}`);
    if (!SHA256.test(entry.sha256 ?? '')) throw new Error('qualification seal digest is invalid');
    const bytes = await readFile(path.join(root, entry.file));
    if (sha256(bytes) !== entry.sha256) throw new Error(`qualification file changed: ${entry.file}`);
  }
  return seal;
}

export async function verifyCloudSnapshotArtifact(directory, expected) {
  const sealed = CLOUD_FILES.filter(
    (file) => !['qualification.seal.json', 'qualification.json.sha256'].includes(file)
  );
  const seal = await verifySealedDirectory(directory, expected, CLOUD_FILES, sealed);
  const qualificationBytes = await readFile(path.join(path.resolve(directory), 'qualification.json'));
  const checksum = await readFile(path.join(path.resolve(directory), 'qualification.json.sha256'), 'utf8');
  if (checksum.trim() !== `${sha256(qualificationBytes)}  .artifacts/qualification.json`) {
    throw new Error('Cloud qualification checksum sidecar is invalid');
  }
  const qualification = JSON.parse(qualificationBytes.toString('utf8'));
  if (qualification?.qualification?.ref !== CLOUD_SNAPSHOT_PRODUCER.ref) {
    throw new Error('Cloud qualification ref is outside the fixed producer policy');
  }
  return seal;
}

export async function verifyRelayfileCloudArtifact(directory, expected) {
  return verifySealedDirectory(directory, expected, RELAYFILE_CLOUD_FILES, [
    'relayfile-cloud-attestation.json',
  ]);
}

function validateAcceptanceRecord(record, evidence, label) {
  exactKeys(
    record,
    [
      'label',
      'sandboxId',
      'observedSnapshotId',
      'observedSnapshotName',
      'observedSnapshotSelector',
      'startedAt',
      'finishedAt',
      'coldStartMs',
      'scaleManifestSha256',
      'scaleFiles',
      'scaleDirectories',
      'scaleBytes',
      'scaleMountMs',
      'bootstrap',
      'payloadSha256',
      'payloadBytes',
      'largeFileMountMs',
      'scaleRemotePath',
      'largeRemotePath',
      'largeRelativeFile',
      'mountEntrypoint',
      'mountMode',
      'markerRelativePath',
      'markerSha256',
      'observedMarkerSha256',
      'markerBytes',
      'relayfileCloudDeploymentId',
      'relayfileCloudSourceSha',
      'relayfileCloudAttestationSha256',
      'endpointIdentitySha256',
      'telemetry',
      'resources',
      'cleanup',
    ],
    `${label} candidate acceptance record`
  );
  exactKeys(
    record.telemetry,
    ['bulkRequests', 'pointRequests', 'cpuMs', 'peakRssBytes'],
    `${label} candidate acceptance telemetry`
  );
  exactKeys(record.cleanup, ['sandboxId', 'state', 'verifiedAt'], `${label} candidate acceptance cleanup`);
  exactKeys(record.resources, ['request', 'process'], `${label} candidate acceptance resources`);
  exactKeys(
    record.resources.request,
    [
      'source',
      'sandboxId',
      'deploymentId',
      'endpointIdentitySha256',
      'operation',
      'correlationIdSha256',
      'bulkRequests',
      'pointRequests',
    ],
    `${label} candidate acceptance request evidence`
  );
  exactKeys(
    record.resources.process,
    ['source', 'sandboxId', 'cpuMs', 'peakRssBytes'],
    `${label} candidate acceptance process evidence`
  );
  const startedAt = Date.parse(record.startedAt ?? '');
  const finishedAt = Date.parse(record.finishedAt ?? '');
  if (
    !record ||
    typeof record !== 'object' ||
    Array.isArray(record) ||
    !DAYTONA_UUID.test(record.sandboxId ?? '') ||
    record.observedSnapshotId !== evidence.snapshot.id ||
    record.observedSnapshotName !== evidence.snapshot.name ||
    record.observedSnapshotSelector !== evidence.snapshot.id ||
    !Number.isFinite(startedAt) ||
    !Number.isFinite(finishedAt) ||
    finishedAt <= startedAt ||
    record.scaleManifestSha256 !== SCALE_MANIFEST_SHA256 ||
    record.scaleFiles !== SCALE_FILES ||
    record.scaleDirectories !== SCALE_DIRECTORIES ||
    record.scaleBytes !== SCALE_BYTES ||
    record.bootstrap !== 'complete' ||
    record.scaleRemotePath !== evidence.scaleCorpus.path ||
    record.largeRemotePath !== evidence.additionalLargeFile.path ||
    record.largeRelativeFile !== evidence.additionalLargeFile.relativeFile ||
    record.payloadSha256 !== evidence.additionalLargeFile.sha256 ||
    record.payloadBytes !== SCALE_BYTES ||
    record.mountEntrypoint !== 'agent-relay fleet spawn --sandbox' ||
    record.mountMode !== 'fleet-auto-mount' ||
    !safeRelativePath(record.markerRelativePath) ||
    !SHA256.test(record.markerSha256 ?? '') ||
    record.observedMarkerSha256 !== record.markerSha256 ||
    !Number.isSafeInteger(record.markerBytes) ||
    record.markerBytes < 1 ||
    record.relayfileCloudDeploymentId !== evidence.relayfileCloud.deploymentId ||
    record.relayfileCloudSourceSha !== evidence.relayfileCloud.sourceGitSha ||
    record.relayfileCloudAttestationSha256 !== evidence.relayfileCloud.attestationSha256 ||
    record.endpointIdentitySha256 !== evidence.relayfileCloud.endpointIdentitySha256 ||
    !Number.isSafeInteger(record.telemetry.bulkRequests) ||
    record.telemetry.bulkRequests < 1 ||
    record.telemetry.pointRequests !== 0 ||
    !Number.isSafeInteger(record.telemetry.cpuMs) ||
    record.telemetry.cpuMs < 0 ||
    record.telemetry.cpuMs > 120_000 ||
    !Number.isSafeInteger(record.telemetry.peakRssBytes) ||
    record.telemetry.peakRssBytes < 1 ||
    record.telemetry.peakRssBytes > 3 * 1024 * 1024 * 1024 ||
    record.resources.request.source !== 'relayfile-cloud-request-log' ||
    record.resources.request.sandboxId !== record.sandboxId ||
    record.resources.request.deploymentId !== evidence.relayfileCloud.deploymentId ||
    record.resources.request.endpointIdentitySha256 !== evidence.relayfileCloud.endpointIdentitySha256 ||
    record.resources.request.operation !== 'fleet-auto-mount-bulk-manifest' ||
    !SHA256.test(record.resources.request.correlationIdSha256 ?? '') ||
    record.resources.request.bulkRequests !== record.telemetry.bulkRequests ||
    record.resources.request.pointRequests !== record.telemetry.pointRequests ||
    record.resources.process.source !== 'daytona-cgroup-v2' ||
    record.resources.process.sandboxId !== record.sandboxId ||
    record.resources.process.cpuMs !== record.telemetry.cpuMs ||
    record.resources.process.peakRssBytes !== record.telemetry.peakRssBytes ||
    !Number.isSafeInteger(record.coldStartMs) ||
    record.coldStartMs < 0 ||
    !Number.isSafeInteger(record.scaleMountMs) ||
    record.scaleMountMs < 0 ||
    !Number.isSafeInteger(record.largeFileMountMs) ||
    record.largeFileMountMs < 0 ||
    !record.cleanup ||
    record.cleanup.sandboxId !== record.sandboxId ||
    record.cleanup.state !== 'absent' ||
    !Number.isFinite(Date.parse(record.cleanup.verifiedAt ?? '')) ||
    Date.parse(record.cleanup.verifiedAt) < finishedAt
  ) {
    throw new Error(`${label} candidate acceptance record is invalid`);
  }
}

export function validateCloudSnapshotAcceptanceEvidence(value, expected) {
  exactKeys(
    value,
    [
      'schemaVersion',
      'acceptance',
      'qualification',
      'snapshot',
      'relayfileCloud',
      'scaleCorpus',
      'additionalLargeFile',
      'cold',
      'concurrent',
      'acceptedAt',
    ],
    'Cloud candidate acceptance evidence'
  );
  exactKeys(
    value.acceptance,
    ['repository', 'workflow', 'workflowPath', 'event', 'ref', 'sourceGitSha', 'runId', 'runAttempt'],
    'Cloud candidate acceptance producer'
  );
  exactKeys(
    value.qualification,
    ['runId', 'runAttempt', 'artifactDigest'],
    'Cloud candidate acceptance qualification binding'
  );
  exactKeys(value.snapshot, ['name', 'id'], 'Cloud candidate acceptance snapshot binding');
  exactKeys(
    value.relayfileCloud,
    [
      'sourceGitSha',
      'runId',
      'runAttempt',
      'artifactDigest',
      'deploymentId',
      'attestationSha256',
      'endpointIdentitySha256',
    ],
    'Cloud candidate acceptance Relayfile Cloud binding'
  );
  exactKeys(
    value.scaleCorpus,
    ['path', 'files', 'directories', 'bytes', 'manifestSha256'],
    'Cloud candidate acceptance scale corpus'
  );
  exactKeys(
    value.additionalLargeFile,
    ['path', 'relativeFile', 'sha256', 'bytes'],
    'Cloud candidate acceptance additional large file'
  );
  if (
    value.schemaVersion !== 3 ||
    value.acceptance?.repository !== CLOUD_SNAPSHOT_ACCEPTANCE_PRODUCER.repository ||
    value.acceptance?.workflow !== CLOUD_SNAPSHOT_ACCEPTANCE_PRODUCER.workflow ||
    value.acceptance?.workflowPath !== CLOUD_SNAPSHOT_ACCEPTANCE_PRODUCER.workflowPath ||
    value.acceptance?.event !== CLOUD_SNAPSHOT_ACCEPTANCE_PRODUCER.event ||
    value.acceptance?.ref !== CLOUD_SNAPSHOT_ACCEPTANCE_PRODUCER.ref ||
    value.acceptance?.sourceGitSha !== expected.sourceSha ||
    String(value.acceptance?.runId ?? '') !== String(expected.runId) ||
    String(value.acceptance?.runAttempt ?? '') !== String(expected.runAttempt) ||
    String(value.qualification?.runId ?? '') !== String(expected.qualificationRunId) ||
    String(value.qualification?.runAttempt ?? '') !== String(expected.qualificationRunAttempt) ||
    value.qualification?.artifactDigest !== expected.qualificationArtifactDigest ||
    value.snapshot?.name !== expected.snapshotName ||
    value.snapshot?.id !== expected.snapshotId ||
    value.relayfileCloud?.sourceGitSha !== expected.relayfileCloudSourceSha ||
    String(value.relayfileCloud?.runId ?? '') !== String(expected.relayfileCloudRunId) ||
    String(value.relayfileCloud?.runAttempt ?? '') !== String(expected.relayfileCloudRunAttempt) ||
    value.relayfileCloud?.artifactDigest !== expected.relayfileCloudArtifactDigest ||
    value.relayfileCloud?.deploymentId !== expected.relayfileCloudDeploymentId ||
    value.relayfileCloud?.attestationSha256 !== expected.relayfileCloudAttestationSha256 ||
    !SHA256.test(value.relayfileCloud?.endpointIdentitySha256 ?? '') ||
    value.scaleCorpus?.files !== SCALE_FILES ||
    value.scaleCorpus?.directories !== SCALE_DIRECTORIES ||
    value.scaleCorpus?.bytes !== SCALE_BYTES ||
    value.scaleCorpus?.manifestSha256 !== SCALE_MANIFEST_SHA256 ||
    typeof value.scaleCorpus?.path !== 'string' ||
    !value.scaleCorpus.path ||
    value.additionalLargeFile?.bytes !== SCALE_BYTES ||
    typeof value.additionalLargeFile?.path !== 'string' ||
    !value.additionalLargeFile.path ||
    !safeRelativePath(value.additionalLargeFile?.relativeFile) ||
    !SHA256.test(value.additionalLargeFile?.sha256 ?? '') ||
    !Number.isFinite(Date.parse(value.acceptedAt ?? '')) ||
    !Array.isArray(value.concurrent) ||
    value.concurrent.length !== 2
  ) {
    throw new Error('Cloud candidate acceptance evidence is outside the fixed policy');
  }
  validateAcceptanceRecord(value.cold, value, 'cold');
  value.concurrent.forEach((record, index) =>
    validateAcceptanceRecord(record, value, `concurrent[${index}]`)
  );
  const ids = [value.cold, ...value.concurrent].map((record) => record.sandboxId);
  if (new Set(ids).size !== ids.length) {
    throw new Error('Cloud candidate acceptance reused a Daytona sandbox');
  }
  const overlapStartedAt = Math.max(...value.concurrent.map((record) => Date.parse(record.startedAt)));
  const overlapFinishedAt = Math.min(...value.concurrent.map((record) => Date.parse(record.finishedAt)));
  if (overlapStartedAt >= overlapFinishedAt) {
    throw new Error('Cloud candidate acceptance did not prove concurrent mount overlap');
  }
  return value;
}

export async function verifyCloudSnapshotAcceptanceArtifact(directory, expected) {
  const root = await verifyExactRegularFiles(directory, CLOUD_ACCEPTANCE_FILES);
  const bytes = await readFile(path.join(root, CLOUD_ACCEPTANCE_FILES[0]));
  if (!SHA256.test(expected.evidenceSha256 ?? '') || sha256(bytes) !== expected.evidenceSha256) {
    throw new Error('Cloud candidate acceptance evidence digest changed');
  }
  return validateCloudSnapshotAcceptanceEvidence(JSON.parse(bytes.toString('utf8')), expected);
}

function flag(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? '' : (process.argv[index + 1] ?? '');
}

async function main() {
  const kind = process.argv[2];
  if (!['cloud', 'cloud-acceptance', 'relayfile-cloud'].includes(kind)) {
    throw new Error(
      'usage: qualification-producer-artifacts.mjs <cloud|cloud-acceptance|relayfile-cloud> --run ...'
    );
  }
  const run = JSON.parse(await readFile(path.resolve(flag('--run')), 'utf8'));
  const artifactDocument = JSON.parse(await readFile(path.resolve(flag('--artifacts')), 'utf8'));
  const expected = {
    runId: flag('--run-id'),
    runAttempt: flag('--run-attempt'),
    sourceSha: flag('--source-sha'),
    artifactName: flag('--artifact-name'),
    artifactDigest: flag('--artifact-digest'),
  };
  const policy =
    kind === 'cloud'
      ? CLOUD_SNAPSHOT_PRODUCER
      : kind === 'cloud-acceptance'
        ? CLOUD_SNAPSHOT_ACCEPTANCE_PRODUCER
        : RELAYFILE_CLOUD_PRODUCER;
  validateFixedProducerRun(run, artifactDocument.artifacts, expected, policy);
  if (kind === 'cloud') await verifyCloudSnapshotArtifact(flag('--directory'), expected);
  else if (kind === 'cloud-acceptance') {
    await verifyCloudSnapshotAcceptanceArtifact(flag('--directory'), {
      ...expected,
      evidenceSha256: flag('--evidence-sha256'),
      qualificationRunId: flag('--qualification-run-id'),
      qualificationRunAttempt: flag('--qualification-run-attempt'),
      qualificationArtifactDigest: flag('--qualification-artifact-digest'),
      snapshotName: flag('--snapshot-name'),
      snapshotId: flag('--snapshot-id'),
      relayfileCloudSourceSha: flag('--relayfile-cloud-source-sha'),
      relayfileCloudRunId: flag('--relayfile-cloud-run-id'),
      relayfileCloudRunAttempt: flag('--relayfile-cloud-run-attempt'),
      relayfileCloudArtifactDigest: flag('--relayfile-cloud-artifact-digest'),
      relayfileCloudDeploymentId: flag('--relayfile-cloud-deployment-id'),
      relayfileCloudAttestationSha256: flag('--relayfile-cloud-attestation-sha256'),
    });
  } else await verifyRelayfileCloudArtifact(flag('--directory'), expected);
  process.stdout.write(`QUALIFICATION_FIXED_PRODUCER_VERIFIED kind=${kind}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
