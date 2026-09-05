#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  RELAY_PACKAGE_POLICY,
  validateRelayPackageEnvelope,
  validateRelayPackagePayload,
  verifyRelayPackageFiles,
} from './relay-package-qualification.mjs';
import { validateCloudSnapshotAcceptanceEvidence } from './qualification-producer-artifacts.mjs';

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_SNAPSHOT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const SAFE_ARTIFACT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const SAFE_DEPLOYMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const MIN_RELAYFILE_CLOUD_LIFETIME_MS = 8 * 60 * 60 * 1000;

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function requiredSha(value, label, pattern) {
  const resolved = requiredString(value, label);
  if (!pattern.test(resolved)) throw new Error(`${label} has an invalid digest`);
  return resolved;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function normalizePositiveInteger(value, label) {
  const resolved = Number(value);
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return resolved;
}

function safeName(value, label, pattern) {
  const resolved = requiredString(value, label);
  if (!pattern.test(resolved)) throw new Error(`${label} is not safe`);
  return resolved;
}

function requiredObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

export function relayfileCloudEndpointIdentitySha256(value) {
  const raw = requiredString(value, 'Relayfile Cloud deployment baseUrl');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Relayfile Cloud deployment baseUrl is invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.hostname) {
    throw new Error('Relayfile Cloud deployment baseUrl must be a credential-free HTTPS endpoint');
  }
  const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  return createHash('sha256').update(`${url.origin}${pathname}`).digest('hex');
}

export function validateQualificationManifest(value, expected = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('qualification manifest must be an object');
  }
  if (value.manifestVersion !== 4) throw new Error('unsupported qualification manifest version');
  if (value.promotion !== 'none') {
    throw new Error('qualification manifest must declare promotion="none"');
  }
  const releaseId = positiveInteger(value.releaseId, 'releaseId');
  const releaseTag = requiredString(value.releaseTag, 'releaseTag');
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(releaseTag)) {
    throw new Error('releaseTag must be an exact semver tag');
  }
  const cloud = requiredObject(value.cloudQualification, 'cloudQualification');
  const cloudAcceptance = requiredObject(value.cloudSnapshotAcceptance, 'cloudSnapshotAcceptance');
  const relayPackages = requiredObject(value.relayPackageQualification, 'relayPackageQualification');
  const relayfileCloud = requiredObject(value.relayfileCloudQualification, 'relayfileCloudQualification');
  const manifest = {
    manifestVersion: 4,
    releaseId,
    releaseTag,
    relaySha: requiredSha(value.relaySha, 'relaySha', SHA40),
    cloudSha: requiredSha(value.cloudSha, 'cloudSha', SHA40),
    relayfileSha: requiredSha(value.relayfileSha, 'relayfileSha', SHA40),
    relayfileCloudSha: requiredSha(value.relayfileCloudSha, 'relayfileCloudSha', SHA40),
    relayPackageQualification: {
      runId: positiveInteger(relayPackages.runId, 'relayPackageQualification.runId'),
      runAttempt: positiveInteger(relayPackages.runAttempt, 'relayPackageQualification.runAttempt'),
      payloadArtifactDigest: requiredString(
        relayPackages.payloadArtifactDigest,
        'relayPackageQualification.payloadArtifactDigest'
      ),
      attestationArtifactDigest: requiredString(
        relayPackages.attestationArtifactDigest,
        'relayPackageQualification.attestationArtifactDigest'
      ),
      payloadSha256: requiredSha(
        relayPackages.payloadSha256,
        'relayPackageQualification.payloadSha256',
        SHA256
      ),
      attestationSha256: requiredSha(
        relayPackages.attestationSha256,
        'relayPackageQualification.attestationSha256',
        SHA256
      ),
    },
    cloudQualification: {
      runId: positiveInteger(cloud.runId, 'cloudQualification.runId'),
      runAttempt: positiveInteger(cloud.runAttempt, 'cloudQualification.runAttempt'),
      artifactName: safeName(cloud.artifactName, 'cloudQualification.artifactName', SAFE_ARTIFACT),
      artifactDigest: requiredString(cloud.artifactDigest, 'cloudQualification.artifactDigest'),
      qualificationSha256: requiredSha(
        cloud.qualificationSha256,
        'cloudQualification.qualificationSha256',
        SHA256
      ),
      snapshotName: safeName(cloud.snapshotName, 'cloudQualification.snapshotName', SAFE_SNAPSHOT),
      snapshotId: safeName(cloud.snapshotId, 'cloudQualification.snapshotId', SAFE_DEPLOYMENT),
      snapshotManifestSha256: requiredSha(
        cloud.snapshotManifestSha256,
        'cloudQualification.snapshotManifestSha256',
        SHA256
      ),
    },
    cloudSnapshotAcceptance: {
      sourceSha: requiredSha(cloudAcceptance.sourceSha, 'cloudSnapshotAcceptance.sourceSha', SHA40),
      runId: positiveInteger(cloudAcceptance.runId, 'cloudSnapshotAcceptance.runId'),
      runAttempt: positiveInteger(cloudAcceptance.runAttempt, 'cloudSnapshotAcceptance.runAttempt'),
      artifactName: safeName(
        cloudAcceptance.artifactName,
        'cloudSnapshotAcceptance.artifactName',
        SAFE_ARTIFACT
      ),
      artifactDigest: requiredString(
        cloudAcceptance.artifactDigest,
        'cloudSnapshotAcceptance.artifactDigest'
      ),
      evidenceSha256: requiredSha(
        cloudAcceptance.evidenceSha256,
        'cloudSnapshotAcceptance.evidenceSha256',
        SHA256
      ),
    },
    relayfileCloudQualification: {
      runId: positiveInteger(relayfileCloud.runId, 'relayfileCloudQualification.runId'),
      runAttempt: positiveInteger(relayfileCloud.runAttempt, 'relayfileCloudQualification.runAttempt'),
      artifactName: safeName(
        relayfileCloud.artifactName,
        'relayfileCloudQualification.artifactName',
        SAFE_ARTIFACT
      ),
      artifactDigest: requiredString(
        relayfileCloud.artifactDigest,
        'relayfileCloudQualification.artifactDigest'
      ),
      attestationSha256: requiredSha(
        relayfileCloud.attestationSha256,
        'relayfileCloudQualification.attestationSha256',
        SHA256
      ),
      deploymentId: safeName(
        relayfileCloud.deploymentId,
        'relayfileCloudQualification.deploymentId',
        SAFE_DEPLOYMENT
      ),
    },
    promotion: 'none',
  };
  const expectedCloudArtifact = `daytona-snapshot-manifests-${manifest.cloudQualification.runId}-${manifest.cloudQualification.runAttempt}`;
  if (manifest.cloudQualification.artifactName !== expectedCloudArtifact) {
    throw new Error('cloudQualification.artifactName is not derived from its exact run and attempt');
  }
  const expectedAcceptanceArtifact = `candidate-cold-concurrent-acceptance-${manifest.cloudSnapshotAcceptance.runId}-${manifest.cloudSnapshotAcceptance.runAttempt}`;
  if (manifest.cloudSnapshotAcceptance.artifactName !== expectedAcceptanceArtifact) {
    throw new Error('cloudSnapshotAcceptance.artifactName is not derived from its exact run and attempt');
  }
  const expectedRelayfileCloudArtifact = `relayfile-cloud-candidate-${manifest.relayfileCloudQualification.runId}-${manifest.relayfileCloudQualification.runAttempt}`;
  if (manifest.relayfileCloudQualification.artifactName !== expectedRelayfileCloudArtifact) {
    throw new Error('relayfileCloudQualification.artifactName is not derived from its exact run and attempt');
  }
  for (const [label, digest] of [
    [
      'relayPackageQualification.payloadArtifactDigest',
      manifest.relayPackageQualification.payloadArtifactDigest,
    ],
    [
      'relayPackageQualification.attestationArtifactDigest',
      manifest.relayPackageQualification.attestationArtifactDigest,
    ],
    ['cloudQualification.artifactDigest', manifest.cloudQualification.artifactDigest],
    ['cloudSnapshotAcceptance.artifactDigest', manifest.cloudSnapshotAcceptance.artifactDigest],
    ['relayfileCloudQualification.artifactDigest', manifest.relayfileCloudQualification.artifactDigest],
  ]) {
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`${label} is invalid`);
  }
  if (expected.releaseId !== undefined && manifest.releaseId !== Number(expected.releaseId)) {
    throw new Error('qualification manifest releaseId does not match the event');
  }
  if (expected.releaseTag !== undefined && manifest.releaseTag !== expected.releaseTag) {
    throw new Error('qualification manifest releaseTag does not match the event');
  }
  return manifest;
}

export function validateQualificationBundle(
  manifestValue,
  cloudQualificationValue,
  snapshotManifestValue,
  relayfileCloudAttestationValue,
  relayPackagePayloadValue,
  relayPackageEnvelopeValue,
  digests,
  cloudAcceptanceValue
) {
  const manifest = validateQualificationManifest(manifestValue);
  const relayPayload = validateRelayPackagePayload(relayPackagePayloadValue);
  const relayEnvelope = validateRelayPackageEnvelope(relayPackageEnvelopeValue);
  const relayQualification = manifest.relayPackageQualification;
  if (
    relayEnvelope.producer.sourceGitSha !== manifest.relaySha ||
    Number(relayEnvelope.producer.runId) !== relayQualification.runId ||
    Number(relayEnvelope.producer.runAttempt) !== relayQualification.runAttempt ||
    relayEnvelope.payload.artifactDigest !== relayQualification.payloadArtifactDigest ||
    relayEnvelope.payload.fileSha256 !== relayQualification.payloadSha256 ||
    !isDeepStrictEqual(relayPayload.producer, relayEnvelope.producer) ||
    !isDeepStrictEqual(relayPayload.packages, relayEnvelope.packages) ||
    !isDeepStrictEqual(relayPayload.registry, relayEnvelope.registry) ||
    !isDeepStrictEqual(relayPayload.candidate, relayEnvelope.candidate)
  ) {
    throw new Error('Relay producer payload/envelope does not match the qualified source/run');
  }
  const cloud = requiredObject(cloudQualificationValue, 'Cloud qualification');
  const cloudRun = requiredObject(cloud.qualification, 'Cloud qualification.qualification');
  const cloudFull = requiredObject(cloud.full, 'Cloud qualification.full');
  if (
    cloud.schemaVersion !== 1 ||
    normalizePositiveInteger(cloudRun.runId, 'Cloud qualification runId') !==
      manifest.cloudQualification.runId ||
    normalizePositiveInteger(cloudRun.runAttempt, 'Cloud qualification runAttempt') !==
      manifest.cloudQualification.runAttempt ||
    cloudRun.sha !== manifest.cloudSha ||
    cloudRun.conclusion !== 'success-required-from-workflow-api'
  ) {
    throw new Error('Cloud qualification identity does not match the Relay manifest');
  }
  if (
    cloudFull.snapshot !== manifest.cloudQualification.snapshotName ||
    cloudFull.snapshotId !== manifest.cloudQualification.snapshotId ||
    cloudFull.manifestSha256 !== manifest.cloudQualification.snapshotManifestSha256
  ) {
    throw new Error('Cloud full snapshot record does not match the Relay manifest');
  }

  const snapshot = requiredObject(snapshotManifestValue, 'snapshot manifest');
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.snapshot?.name !== manifest.cloudQualification.snapshotName ||
    snapshot.snapshot?.variant !== 'full' ||
    snapshot.snapshot?.mode !== 'candidate' ||
    snapshot.source?.gitSha !== manifest.cloudSha
  ) {
    throw new Error('baked full snapshot identity does not match the qualified Cloud source');
  }
  if (
    snapshot.promotion?.ssmWrite !== false ||
    snapshot.promotion?.selectorWrite !== false ||
    snapshot.promotion?.deploy !== false
  ) {
    throw new Error('snapshot qualification must be non-promoting');
  }
  const expectedRelayVersion = manifest.releaseTag.replace(/^v/, '');
  if (snapshot.packages?.['@agent-relay/sdk'] !== expectedRelayVersion) {
    throw new Error('snapshot Relay SDK version does not match the release candidate');
  }
  const expectedSealedRelayProducer = {
    ...relayEnvelope,
    attestationArtifact: RELAY_PACKAGE_POLICY.attestationArtifact,
    attestationFile: RELAY_PACKAGE_POLICY.attestationFile,
    attestationArtifactDigest: relayQualification.attestationArtifactDigest,
  };
  if (!isDeepStrictEqual(snapshot.relayProducer, expectedSealedRelayProducer)) {
    throw new Error('snapshot Relay producer attestation does not match the Relay qualification');
  }
  if (snapshot.relayfileMount?.sourceGitSha !== manifest.relayfileSha) {
    throw new Error('snapshot Relayfile source does not match the qualified Relayfile candidate');
  }
  if (!SHA256.test(snapshot.relayfileMount?.sha256 ?? '')) {
    throw new Error('snapshot Relayfile artifact digest is invalid');
  }

  const dataPlane = requiredObject(relayfileCloudAttestationValue, 'Relayfile Cloud attestation');
  const dataPlaneRun = requiredObject(dataPlane.qualification, 'Relayfile Cloud attestation.qualification');
  const deployment = requiredObject(dataPlane.deployment, 'Relayfile Cloud attestation.deployment');
  if (
    dataPlane.schemaVersion !== 1 ||
    normalizePositiveInteger(dataPlaneRun.runId, 'Relayfile Cloud runId') !==
      manifest.relayfileCloudQualification.runId ||
    normalizePositiveInteger(dataPlaneRun.runAttempt, 'Relayfile Cloud runAttempt') !==
      manifest.relayfileCloudQualification.runAttempt ||
    dataPlaneRun.sha !== manifest.relayfileCloudSha ||
    dataPlaneRun.conclusion !== 'success-required-from-workflow-api' ||
    deployment.id !== manifest.relayfileCloudQualification.deploymentId
  ) {
    throw new Error('Relayfile Cloud deployment attestation does not match the Relay manifest');
  }
  const endpointIdentitySha256 = relayfileCloudEndpointIdentitySha256(deployment.baseUrl);
  const deploymentExpiry = Date.parse(deployment.expiresAt ?? '');
  if (!Number.isFinite(deploymentExpiry) || deploymentExpiry - Date.now() < MIN_RELAYFILE_CLOUD_LIFETIME_MS) {
    throw new Error('Relayfile Cloud candidate deployment must remain valid for at least 8 hours');
  }
  const expectedDigests = {
    relayPayloadSha256: manifest.relayPackageQualification.payloadSha256,
    relayAttestationSha256: manifest.relayPackageQualification.attestationSha256,
    qualificationSha256: manifest.cloudQualification.qualificationSha256,
    snapshotManifestSha256: manifest.cloudQualification.snapshotManifestSha256,
    attestationSha256: manifest.relayfileCloudQualification.attestationSha256,
    acceptanceSha256: manifest.cloudSnapshotAcceptance.evidenceSha256,
  };
  for (const [key, expectedDigest] of Object.entries(expectedDigests)) {
    if (digests?.[key] !== expectedDigest) throw new Error(`${key} does not match downloaded bytes`);
  }
  const acceptance = validateCloudSnapshotAcceptanceEvidence(cloudAcceptanceValue, {
    sourceSha: manifest.cloudSnapshotAcceptance.sourceSha,
    runId: manifest.cloudSnapshotAcceptance.runId,
    runAttempt: manifest.cloudSnapshotAcceptance.runAttempt,
    qualificationRunId: manifest.cloudQualification.runId,
    qualificationRunAttempt: manifest.cloudQualification.runAttempt,
    qualificationArtifactDigest: manifest.cloudQualification.artifactDigest,
    snapshotName: manifest.cloudQualification.snapshotName,
    snapshotId: manifest.cloudQualification.snapshotId,
    relayfileCloudSourceSha: manifest.relayfileCloudSha,
    relayfileCloudRunId: manifest.relayfileCloudQualification.runId,
    relayfileCloudRunAttempt: manifest.relayfileCloudQualification.runAttempt,
    relayfileCloudArtifactDigest: manifest.relayfileCloudQualification.artifactDigest,
    relayfileCloudDeploymentId: manifest.relayfileCloudQualification.deploymentId,
    relayfileCloudAttestationSha256: manifest.relayfileCloudQualification.attestationSha256,
  });
  if (acceptance.relayfileCloud.endpointIdentitySha256 !== endpointIdentitySha256) {
    throw new Error('Cloud acceptance endpoint identity does not match Relayfile Cloud attestation');
  }
  return { manifest, cloud, snapshot, dataPlane, acceptance, expectedRelayVersion };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument ${token}`);
    const name = token.slice(2);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    options[name] = value;
    index += 1;
  }
  return { command, options };
}

async function appendOutputs(target, manifest) {
  if (!target) return;
  const lines = [
    `relay_sha=${manifest.relaySha}`,
    `cloud_sha=${manifest.cloudSha}`,
    `relayfile_sha=${manifest.relayfileSha}`,
    `relayfile_cloud_sha=${manifest.relayfileCloudSha}`,
    `relay_package_run_id=${manifest.relayPackageQualification.runId}`,
    `relay_package_run_attempt=${manifest.relayPackageQualification.runAttempt}`,
    `relay_package_payload_artifact_digest=${manifest.relayPackageQualification.payloadArtifactDigest}`,
    `relay_package_attestation_artifact_digest=${manifest.relayPackageQualification.attestationArtifactDigest}`,
    `snapshot_name=${manifest.cloudQualification.snapshotName}`,
    `snapshot_id=${manifest.cloudQualification.snapshotId}`,
    `snapshot_manifest_sha256=${manifest.cloudQualification.snapshotManifestSha256}`,
    `cloud_qualification_run_id=${manifest.cloudQualification.runId}`,
    `cloud_qualification_run_attempt=${manifest.cloudQualification.runAttempt}`,
    `cloud_qualification_artifact_name=${manifest.cloudQualification.artifactName}`,
    `cloud_qualification_artifact_digest=${manifest.cloudQualification.artifactDigest}`,
    `cloud_acceptance_source_sha=${manifest.cloudSnapshotAcceptance.sourceSha}`,
    `cloud_acceptance_run_id=${manifest.cloudSnapshotAcceptance.runId}`,
    `cloud_acceptance_run_attempt=${manifest.cloudSnapshotAcceptance.runAttempt}`,
    `cloud_acceptance_artifact_name=${manifest.cloudSnapshotAcceptance.artifactName}`,
    `cloud_acceptance_artifact_digest=${manifest.cloudSnapshotAcceptance.artifactDigest}`,
    `cloud_acceptance_evidence_sha256=${manifest.cloudSnapshotAcceptance.evidenceSha256}`,
    `relayfile_cloud_run_id=${manifest.relayfileCloudQualification.runId}`,
    `relayfile_cloud_run_attempt=${manifest.relayfileCloudQualification.runAttempt}`,
    `relayfile_cloud_artifact_name=${manifest.relayfileCloudQualification.artifactName}`,
    `relayfile_cloud_artifact_digest=${manifest.relayfileCloudQualification.artifactDigest}`,
    `relayfile_cloud_deployment_id=${manifest.relayfileCloudQualification.deploymentId}`,
    `relayfile_cloud_attestation_sha256=${manifest.relayfileCloudQualification.attestationSha256}`,
    `release_tag=${manifest.releaseTag}`,
  ];
  const current = await readFile(target, 'utf8').catch(() => '');
  await writeFile(target, `${current}${lines.join('\n')}\n`, { mode: 0o600 });
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!['validate', 'verify-bundle'].includes(command)) {
    throw new Error('usage: qualification-manifest.mjs <validate|verify-bundle> --file <json>');
  }
  const file = path.resolve(requiredString(options.file, '--file'));
  const event = options.event ? JSON.parse(await readFile(path.resolve(options.event), 'utf8')) : undefined;
  const expected = event?.release ? { releaseId: event.release.id, releaseTag: event.release.tag_name } : {};
  const manifest = validateQualificationManifest(JSON.parse(await readFile(file, 'utf8')), expected);
  if (command === 'verify-bundle') {
    const cloudQualificationPath = path.resolve(
      requiredString(options['cloud-qualification'], '--cloud-qualification')
    );
    const snapshotManifestPath = path.resolve(
      requiredString(options['snapshot-manifest'], '--snapshot-manifest')
    );
    const relayfileCloudAttestationPath = path.resolve(
      requiredString(options['relayfile-cloud-attestation'], '--relayfile-cloud-attestation')
    );
    const cloudAcceptancePath = path.resolve(
      requiredString(options['cloud-acceptance'], '--cloud-acceptance')
    );
    const relayPackagePayloadPath = path.resolve(
      requiredString(options['relay-package-payload'], '--relay-package-payload')
    );
    const relayPackageAttestationPath = path.resolve(
      requiredString(options['relay-package-attestation'], '--relay-package-attestation')
    );
    const [
      cloudBytes,
      snapshotBytes,
      dataPlaneBytes,
      acceptanceBytes,
      relayPayloadBytes,
      relayAttestationBytes,
    ] = await Promise.all([
      readFile(cloudQualificationPath),
      readFile(snapshotManifestPath),
      readFile(relayfileCloudAttestationPath),
      readFile(cloudAcceptancePath),
      readFile(relayPackagePayloadPath),
      readFile(relayPackageAttestationPath),
    ]);
    const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
    validateQualificationBundle(
      manifest,
      JSON.parse(cloudBytes.toString('utf8')),
      JSON.parse(snapshotBytes.toString('utf8')),
      JSON.parse(dataPlaneBytes.toString('utf8')),
      JSON.parse(relayPayloadBytes.toString('utf8')),
      JSON.parse(relayAttestationBytes.toString('utf8')),
      {
        relayPayloadSha256: digest(relayPayloadBytes),
        relayAttestationSha256: digest(relayAttestationBytes),
        qualificationSha256: digest(cloudBytes),
        snapshotManifestSha256: digest(snapshotBytes),
        attestationSha256: digest(dataPlaneBytes),
        acceptanceSha256: digest(acceptanceBytes),
      },
      JSON.parse(acceptanceBytes.toString('utf8'))
    );
    await verifyRelayPackageFiles(
      JSON.parse(relayPayloadBytes.toString('utf8')),
      path.dirname(relayPackagePayloadPath)
    );
  }
  if (options.output) {
    await writeFile(path.resolve(options.output), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
  }
  await appendOutputs(options['github-output'], manifest);
  process.stdout.write(
    `QUALIFICATION_${command === 'verify-bundle' ? 'BUNDLE' : 'MANIFEST'}_VALID release=${manifest.releaseTag} snapshot=${manifest.cloudQualification.snapshotName}\n`
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
