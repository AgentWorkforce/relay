#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadFleetMatrix, readAndValidateCampaign } from './fleet-daytona.mjs';
import { relayfileCloudEndpointIdentitySha256 } from './qualification-manifest.mjs';
import { validateCloudSnapshotAcceptanceEvidence } from './qualification-producer-artifacts.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RELAY_WORKSPACE_ID = /^rw_[a-z0-9]{8}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  const resolved = object(value, label);
  if (Object.keys(resolved).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw new Error(`${label} has an unexpected shape`);
  }
  return resolved;
}

function string(value, label, pattern) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  const resolved = value.trim();
  if (pattern && !pattern.test(resolved)) throw new Error(`${label} is invalid`);
  return resolved;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function secureHttpsUrl(value, label) {
  const raw = string(value, label);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`${label} must be a credential-free HTTPS URL`);
  }
  return raw;
}

function jsonEvidenceBytes(value, label) {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new Error(`${label} bytes are required`);
  }
  try {
    return {
      bytes: value,
      value: JSON.parse(Buffer.from(value).toString('utf8')),
    };
  } catch (error) {
    throw new Error(`${label} bytes are invalid JSON`, { cause: error });
  }
}

function sameSet(left, right) {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((value) => right.includes(value))
  );
}

function validateCreate(entry, expected) {
  const result = object(entry.result, `${entry.label} create result`);
  const credential = object(entry.credential, `${entry.label} credential`);
  const workspaceId = string(result.workspaceId, `${entry.label}.workspaceId`, UUID);
  const relayWorkspaceId = string(
    result.relayWorkspaceId,
    `${entry.label}.relayWorkspaceId`,
    RELAY_WORKSPACE_ID
  );
  if (
    credential.version !== 1 ||
    credential.workspaceId !== workspaceId ||
    credential.relayWorkspaceId !== relayWorkspaceId
  ) {
    throw new Error(`${entry.label} credential does not match the created workspace`);
  }
  if (
    !object(credential.cloud, `${entry.label} credential.cloud`).accessToken ||
    !credential.cloud.refreshToken ||
    !secureHttpsUrl(
      object(credential.relay, `${entry.label} credential.relay`).baseUrl,
      `${entry.label} credential.relay.baseUrl`
    ) ||
    !credential.relay.workspaceKey
  ) {
    throw new Error(`${entry.label} credential is incomplete`);
  }
  if (entry.mode !== '0600') throw new Error(`${entry.label} credential file is not mode 0600`);
  if (
    path.resolve(string(result.credentialFile, `${entry.label}.credentialFile`)) !==
    path.resolve(entry.credentialPath)
  ) {
    throw new Error(`${entry.label} create result points at a different credential file`);
  }
  const requestedDeploymentId = string(
    result.requestedRelayfileCloudDeploymentId,
    `${entry.label}.requestedRelayfileCloudDeploymentId`,
    PROVIDER_ID
  );
  const observedDeploymentId = string(
    result.observedRelayfileCloudDeploymentId,
    `${entry.label}.observedRelayfileCloudDeploymentId`,
    PROVIDER_ID
  );
  const attestationSha256 = string(
    result.relayfileCloudAttestationSha256,
    `${entry.label}.relayfileCloudAttestationSha256`,
    SHA256
  );
  if (
    requestedDeploymentId !== expected.deploymentId ||
    observedDeploymentId !== expected.deploymentId ||
    attestationSha256 !== expected.attestationSha256
  ) {
    throw new Error(`${entry.label} did not prove the qualified Relayfile Cloud deployment`);
  }
  return {
    workspaceId,
    relayWorkspaceId,
    credentialFile: { workspaceId, mode: entry.mode },
    requestedDeploymentId,
    observedDeploymentId,
    attestationSha256,
  };
}

function validateDelete(entry, expected) {
  const result = exactKeys(
    entry.result,
    [
      'workspaceId',
      'relayWorkspaceId',
      'expiresAt',
      'state',
      'deleted',
      'idempotent',
      'operationId',
      'verifiedAt',
      'proof',
      'absence',
    ],
    `${entry.label} delete result`
  );
  const proof = exactKeys(
    result.proof,
    ['daytona', 'cloud', 'credentials', 'relaycast', 'relayfile', 'registry'],
    `${entry.label} delete proof`
  );
  const workspaceId = string(result.workspaceId, `${entry.label}.workspaceId`, UUID);
  const relayWorkspaceId = string(
    result.relayWorkspaceId,
    `${entry.label}.relayWorkspaceId`,
    RELAY_WORKSPACE_ID
  );
  const operationId = string(result.operationId, `${entry.label}.operationId`, PROVIDER_ID);
  const absence = exactKeys(
    result.absence,
    ['workspaceId', 'status', 'verifiedAt'],
    `${entry.label} delete absence`
  );
  const section = (name, keys) => {
    const value = exactKeys(proof[name], keys, `${entry.label} delete proof.${name}`);
    if (value.workspaceId !== workspaceId || value.relayWorkspaceId !== relayWorkspaceId) {
      throw new Error(`${entry.label} delete proof.${name} targets a different workspace`);
    }
    return value;
  };
  const cloud = section('cloud', [
    'workspaceId',
    'relayWorkspaceId',
    'appWorkspaceRowsRemaining',
    'workflowLaunchesInProgress',
  ]);
  const daytona = section('daytona', ['workspaceId', 'relayWorkspaceId', 'remaining']);
  const credentials = section('credentials', ['workspaceId', 'relayWorkspaceId', 'activeSessionsRemaining']);
  const relaycast = section('relaycast', [
    'workspaceId',
    'relayWorkspaceId',
    'deleted',
    'agentsAndNodesDeletedByWorkspaceCascade',
  ]);
  const relayfile = section('relayfile', ['workspaceId', 'relayWorkspaceId', 'deleted']);
  const registry = section('registry', ['workspaceId', 'relayWorkspaceId', 'deleted']);
  const elapsedSeconds = Number(entry.elapsedSeconds);
  if (
    workspaceId !== expected.workspaceId ||
    relayWorkspaceId !== expected.relayWorkspaceId ||
    result.deleted !== true ||
    result.state !== 'deleted' ||
    typeof result.idempotent !== 'boolean' ||
    !Number.isFinite(Date.parse(result.expiresAt ?? '')) ||
    !Number.isFinite(Date.parse(result.verifiedAt ?? '')) ||
    cloud.appWorkspaceRowsRemaining !== 0 ||
    cloud.workflowLaunchesInProgress !== 0 ||
    daytona.remaining !== 0 ||
    credentials.activeSessionsRemaining !== 0 ||
    relaycast.deleted !== true ||
    relaycast.agentsAndNodesDeletedByWorkspaceCascade !== true ||
    relayfile.deleted !== true ||
    registry.deleted !== true ||
    absence.workspaceId !== workspaceId ||
    absence.status !== 404 ||
    !Number.isFinite(Date.parse(absence.verifiedAt ?? '')) ||
    entry.timingWorkspaceId !== workspaceId ||
    entry.timingOperationId !== operationId ||
    !Number.isFinite(elapsedSeconds) ||
    elapsedSeconds < 0 ||
    elapsedSeconds > 120
  ) {
    throw new Error(`${entry.label} did not prove complete cascade deletion inside the 120s SLO`);
  }
  return {
    workspaceId,
    relayWorkspaceId,
    operationId,
    verifiedAt: result.verifiedAt,
    absenceVerifiedAt: absence.verifiedAt,
    elapsedSeconds,
  };
}

export function composeQualificationEffects(input) {
  const manifest = object(input.manifest, 'qualification manifest');
  const cloudQualification = object(manifest.cloudQualification, 'manifest.cloudQualification');
  const cloudSnapshotAcceptance = object(
    manifest.cloudSnapshotAcceptance,
    'manifest.cloudSnapshotAcceptance'
  );
  const relayfileCloudQualification = object(
    manifest.relayfileCloudQualification,
    'manifest.relayfileCloudQualification'
  );
  const snapshotEvidence = jsonEvidenceBytes(input.snapshotManifestBytes, 'snapshot manifest');
  const dataPlaneEvidence = jsonEvidenceBytes(
    input.relayfileCloudAttestationBytes,
    'Relayfile Cloud attestation'
  );
  const acceptanceEvidence = jsonEvidenceBytes(input.cloudAcceptanceBytes, 'Cloud snapshot acceptance');
  const snapshotManifest = object(snapshotEvidence.value, 'snapshot manifest');
  const dataPlane = object(dataPlaneEvidence.value, 'Relayfile Cloud attestation');
  const deployment = object(dataPlane.deployment, 'Relayfile Cloud attestation.deployment');
  const campaign = object(input.fleetCampaign, 'Fleet campaign');
  const attempts = input.fleetAttempts;
  if (!input.fleetSignoffVerified)
    throw new Error('Fleet dual-review signoff was not independently enforced');
  if (
    campaign.verdict !== 'GREEN' ||
    campaign.productVerdict !== 'GREEN' ||
    campaign.infrastructureStatus !== 'PASS' ||
    !Array.isArray(attempts) ||
    attempts.length < 2
  ) {
    throw new Error('Fleet campaign is not a fully green two-attempt qualification');
  }

  const snapshotId = string(cloudQualification.snapshotId, 'manifest snapshotId', PROVIDER_ID);
  const snapshotManifestSha256 = string(
    cloudQualification.snapshotManifestSha256,
    'manifest snapshotManifestSha256',
    SHA256
  );
  const cloudSha = string(manifest.cloudSha, 'manifest cloudSha', SHA40);
  const relaySha = string(manifest.relaySha, 'manifest relaySha', SHA40);
  if (
    snapshotManifest.snapshot?.mode !== 'candidate' ||
    snapshotManifest.source?.gitSha !== cloudSha ||
    sha256(snapshotEvidence.bytes) !== snapshotManifestSha256 ||
    campaign.controlledProvenance?.sourceCommit !== relaySha ||
    campaign.controlledProvenance?.requestedSnapshotId !== snapshotId ||
    campaign.controlledProvenance?.requestedSnapshotManifestSha256 !== snapshotManifestSha256
  ) {
    throw new Error('Fleet/snapshot provenance does not match the normalized qualification manifest');
  }
  if (
    campaign.controlledProvenance?.candidateCleanInstall !== true ||
    campaign.controlledProvenance?.candidateInstallSourceSha !== relaySha ||
    !SHA256.test(campaign.controlledProvenance?.candidateInstallAttestationSha256 ?? '')
  ) {
    throw new Error('Fleet campaign did not execute a source-bound clean-installed Relay candidate');
  }
  const observedSnapshotIds = attempts.flatMap(({ evidence }) =>
    evidence.resources
      .filter(({ type }) => type === 'daytona-sandbox')
      .map(({ observedSnapshotId }) => observedSnapshotId)
  );
  if (observedSnapshotIds.length === 0 || observedSnapshotIds.some((value) => value !== snapshotId)) {
    throw new Error(
      'Fleet attempts did not observe the exact immutable snapshot ID on every Daytona sandbox'
    );
  }

  const deploymentId = string(
    relayfileCloudQualification.deploymentId,
    'qualified deploymentId',
    PROVIDER_ID
  );
  const attestationSha256 = string(
    relayfileCloudQualification.attestationSha256,
    'qualified attestationSha256',
    SHA256
  );
  const relayfileCloudSourceSha = string(
    manifest.relayfileCloudSha,
    'qualified Relayfile Cloud source SHA',
    SHA40
  );
  if (deployment.id !== deploymentId || sha256(dataPlaneEvidence.bytes) !== attestationSha256) {
    throw new Error('Relayfile Cloud attestation bytes do not match the qualified deployment');
  }
  const endpointIdentitySha256 = relayfileCloudEndpointIdentitySha256(deployment.baseUrl);
  const acceptanceEvidenceSha256 = string(
    cloudSnapshotAcceptance.evidenceSha256,
    'qualified Cloud acceptance evidenceSha256',
    SHA256
  );
  if (sha256(acceptanceEvidence.bytes) !== acceptanceEvidenceSha256) {
    throw new Error('Cloud acceptance bytes do not match the qualified evidence digest');
  }
  const acceptance = validateCloudSnapshotAcceptanceEvidence(acceptanceEvidence.value, {
    sourceSha: cloudSnapshotAcceptance.sourceSha,
    runId: cloudSnapshotAcceptance.runId,
    runAttempt: cloudSnapshotAcceptance.runAttempt,
    qualificationRunId: cloudQualification.runId,
    qualificationRunAttempt: cloudQualification.runAttempt,
    qualificationArtifactDigest: cloudQualification.artifactDigest,
    snapshotName: cloudQualification.snapshotName,
    snapshotId,
    relayfileCloudSourceSha: manifest.relayfileCloudSha,
    relayfileCloudRunId: relayfileCloudQualification.runId,
    relayfileCloudRunAttempt: relayfileCloudQualification.runAttempt,
    relayfileCloudArtifactDigest: relayfileCloudQualification.artifactDigest,
    relayfileCloudDeploymentId: deploymentId,
    relayfileCloudAttestationSha256: attestationSha256,
  });
  if (acceptance.relayfileCloud.endpointIdentitySha256 !== endpointIdentitySha256) {
    throw new Error('Cloud acceptance endpoint identity does not match the qualified deployment');
  }
  const acceptanceRecords = [acceptance.cold, ...acceptance.concurrent];

  if (!Array.isArray(input.workspaceCreates) || input.workspaceCreates.length !== 2) {
    throw new Error('exactly two workspace creates are required');
  }
  const creates = input.workspaceCreates.map((entry) =>
    validateCreate(entry, { deploymentId, attestationSha256 })
  );
  const workspaceIds = creates.map(({ workspaceId }) => workspaceId);
  const relayWorkspaceIds = creates.map(({ relayWorkspaceId }) => relayWorkspaceId);
  if (new Set(relayWorkspaceIds).size !== relayWorkspaceIds.length) {
    throw new Error('the two ephemeral app workspaces must use distinct Relay workspaces');
  }
  if (!sameSet(workspaceIds, campaign.workspaceIds ?? [])) {
    throw new Error('Fleet campaign workspace IDs do not match the two created ephemeral workspaces');
  }
  const attemptBindings = attempts.map(({ evidence }, index) => {
    const attempt = object(evidence, `Fleet attempt ${index + 1} evidence`);
    return {
      workspaceId: attempt.provenance?.resolvedWorkspaceId,
      relayWorkspaceId: attempt.environment?.expectedRelayWorkspaceId,
    };
  });
  for (const created of creates) {
    if (
      !attemptBindings.some(
        (binding) =>
          binding.workspaceId === created.workspaceId && binding.relayWorkspaceId === created.relayWorkspaceId
      )
    ) {
      throw new Error('Fleet attempts are not bound to their distinct created Relay workspaces');
    }
  }

  if (!Array.isArray(input.workspaceDeletes) || input.workspaceDeletes.length !== 2) {
    throw new Error('exactly two workspace deletes are required');
  }
  const deletes = input.workspaceDeletes.map((entry) => {
    const expected = creates.find(({ workspaceId }) => workspaceId === entry.result?.workspaceId);
    if (!expected) throw new Error(`${entry.label} does not target an owned created workspace`);
    return validateDelete(entry, expected);
  });
  if (
    !sameSet(
      deletes.map(({ workspaceId }) => workspaceId),
      workspaceIds
    )
  ) {
    throw new Error('workspace deletion evidence is incomplete or duplicated');
  }

  return {
    'candidate-snapshot-selector': {
      status: 'PASS',
      requestedSnapshotId: snapshotId,
      observedSnapshotId: snapshotId,
      sourceGitSha: cloudSha,
      snapshotManifestSha256,
      relayCandidateInstallAttestationSha256: campaign.controlledProvenance.candidateInstallAttestationSha256,
      candidateMode: true,
    },
    'ephemeral-cloud-workspace-create': {
      status: 'PASS',
      workspaceIds,
      credentialFiles: creates.map(({ credentialFile }) => credentialFile),
    },
    'qualified-relayfile-cloud-binding': {
      status: 'PASS',
      requestedDeploymentId: deploymentId,
      observedDeploymentId: deploymentId,
      attestationSha256,
      sourceGitSha: relayfileCloudSourceSha,
    },
    'relayfile-258-mib-fleet-auto-mount': {
      status: 'PASS',
      sandboxIds: acceptanceRecords.map(({ sandboxId }) => sandboxId),
      deploymentId,
      attestationSha256,
      sourceGitSha: relayfileCloudSourceSha,
      endpointIdentitySha256,
      mountEntrypoint: 'agent-relay fleet spawn --sandbox',
      mountMode: 'fleet-auto-mount',
      scaleFiles: acceptance.scaleCorpus.files,
      scaleDirectories: acceptance.scaleCorpus.directories,
      scaleBytes: acceptance.scaleCorpus.bytes,
      scaleManifestSha256: acceptance.scaleCorpus.manifestSha256,
      totalBulkRequests: acceptanceRecords.reduce(
        (total, record) => total + record.telemetry.bulkRequests,
        0
      ),
      totalPointRequests: acceptanceRecords.reduce(
        (total, record) => total + record.telemetry.pointRequests,
        0
      ),
      maxCpuMs: Math.max(...acceptanceRecords.map((record) => record.telemetry.cpuMs)),
      maxPeakRssBytes: Math.max(...acceptanceRecords.map((record) => record.telemetry.peakRssBytes)),
      exactMarkerHashes: acceptanceRecords.map(({ observedMarkerSha256 }) => observedMarkerSha256),
      exactCleanup: true,
    },
    'ephemeral-cloud-workspace-delete': {
      status: 'PASS',
      workspaceIds,
      cloudAbsent: true,
      relayfileAbsent: true,
      relaycastAbsent: true,
      fleetAbsent: true,
      credentialsAbsent: true,
      registryAbsent: true,
      operationIds: deletes.map(({ operationId }) => operationId),
      absenceVerifiedAt: deletes.map((entry) => entry.absenceVerifiedAt),
      elapsedSeconds: Math.max(...deletes.map(({ elapsedSeconds }) => elapsedSeconds)),
    },
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument ${token}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} requires a value`);
    options[token.slice(2)] = value;
    index += 1;
  }
  return options;
}

async function jsonFile(file, label) {
  try {
    return JSON.parse(await readFile(path.resolve(file), 'utf8'));
  } catch (error) {
    throw new Error(`${label} is missing or invalid JSON`, { cause: error });
  }
}

async function credentialEntry(label, resultPath, credentialPath) {
  const info = await lstat(path.resolve(credentialPath));
  if (
    !info.isFile() ||
    info.size <= 0 ||
    info.size > 64 * 1024 ||
    (info.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && info.uid !== process.getuid())
  ) {
    throw new Error(`${label} credential file is not a bounded regular file`);
  }
  return {
    label,
    result: await jsonFile(resultPath, `${label} create result`),
    credential: await jsonFile(credentialPath, `${label} credential`),
    credentialPath,
    mode: (info.mode & 0o777).toString(8).padStart(4, '0'),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const required = (name) => string(options[name], `--${name}`);
  const matrixPath = path.resolve(required('fleet-matrix'));
  const matrix = await loadFleetMatrix(matrixPath);
  const nonce = required('fleet-nonce');
  const fleetArtifactRoot = path.resolve(required('fleet-artifact-root'));
  const runnerPath = fileURLToPath(new URL('./fleet-daytona.mjs', import.meta.url));
  const enforced = spawnSync(
    process.execPath,
    [runnerPath, 'enforce', '--scope', 'campaign', '--matrix', matrixPath, '--nonce', nonce],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 120_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: '1' },
    }
  );
  if (enforced.status !== 0) {
    throw new Error(`Fleet campaign/signoff enforcement failed: ${String(enforced.stderr ?? '').trim()}`);
  }
  const validatedFleet = await readAndValidateCampaign(
    matrixPath,
    matrix,
    path.join(fleetArtifactRoot, nonce),
    nonce
  );
  const snapshotManifestPath = path.resolve(required('snapshot-manifest'));
  const relayfileCloudAttestationPath = path.resolve(required('relayfile-cloud-attestation'));
  const cloudAcceptancePath = path.resolve(required('cloud-acceptance'));
  const [snapshotManifestBytes, relayfileCloudAttestationBytes, cloudAcceptanceBytes] = await Promise.all([
    readFile(snapshotManifestPath),
    readFile(relayfileCloudAttestationPath),
    readFile(cloudAcceptancePath),
  ]);
  const deletion = async (label) => {
    const timing = object(
      await jsonFile(required(`delete-${label}-timing`), `${label} delete timing`),
      `${label} delete timing`
    );
    return {
      label,
      result: await jsonFile(required(`delete-${label}`), `${label} delete result`),
      elapsedSeconds: timing.elapsedSeconds,
      timingWorkspaceId: timing.workspaceId,
      timingOperationId: timing.operationId,
    };
  };
  const effects = composeQualificationEffects({
    manifest: await jsonFile(required('manifest'), 'normalized qualification manifest'),
    snapshotManifestBytes,
    relayfileCloudAttestationBytes,
    cloudAcceptanceBytes,
    fleetCampaign: validatedFleet.campaign,
    fleetAttempts: validatedFleet.attempts,
    fleetSignoffVerified: true,
    workspaceCreates: await Promise.all([
      credentialEntry('a', required('create-a'), required('credential-a')),
      credentialEntry('b', required('create-b'), required('credential-b')),
    ]),
    workspaceDeletes: await Promise.all([deletion('a'), deletion('b')]),
  });
  await writeFile(path.resolve(required('output')), `${JSON.stringify(effects, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  process.stdout.write(`QUALIFICATION_EFFECTS_VALID nonce=${nonce} workspaces=2\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
