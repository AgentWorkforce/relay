import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  relayfileCloudEndpointIdentitySha256,
  validateQualificationBundle,
  validateQualificationManifest,
} from '../../scripts/verify-features/qualification-manifest.mjs';
import { CLOUD_SNAPSHOT_ACCEPTANCE_PRODUCER } from '../../scripts/verify-features/qualification-producer-artifacts.mjs';

const valid = {
  manifestVersion: 4,
  releaseId: 42,
  releaseTag: 'v11.11.0-beta.1',
  relaySha: 'a'.repeat(40),
  cloudSha: 'b'.repeat(40),
  relayfileSha: 'c'.repeat(40),
  relayfileCloudSha: 'd'.repeat(40),
  relayPackageQualification: {
    runId: 303,
    runAttempt: 1,
    payloadArtifactDigest: `sha256:${'8'.repeat(64)}`,
    attestationArtifactDigest: `sha256:${'9'.repeat(64)}`,
    payloadSha256: 'e'.repeat(64),
    attestationSha256: 'f'.repeat(64),
  },
  cloudQualification: {
    runId: 101,
    runAttempt: 2,
    artifactName: 'daytona-snapshot-manifests-101-2',
    artifactDigest: `sha256:${'6'.repeat(64)}`,
    qualificationSha256: '1'.repeat(64),
    snapshotName: 'relay-orchestrator-candidate-42-sdk-11.11.0-beta.1',
    snapshotId: 'snapshot-uuid-42',
    snapshotManifestSha256: '2'.repeat(64),
  },
  cloudSnapshotAcceptance: {
    sourceSha: 'e'.repeat(40),
    runId: 151,
    runAttempt: 1,
    artifactName: 'candidate-cold-concurrent-acceptance-151-1',
    artifactDigest: `sha256:${'4'.repeat(64)}`,
    evidenceSha256: '6'.repeat(64),
  },
  relayfileCloudQualification: {
    runId: 202,
    runAttempt: 1,
    artifactName: 'relayfile-cloud-candidate-202-1',
    artifactDigest: `sha256:${'7'.repeat(64)}`,
    attestationSha256: '3'.repeat(64),
    deploymentId: 'relayfile-cloud-preview-202',
  },
  promotion: 'none',
};

const relayPackagePayload = {
  schemaVersion: 2,
  kind: 'relayPackages',
  producer: {
    repository: 'AgentWorkforce/relay',
    workflow: 'Relay package qualification',
    workflowPath: '.github/workflows/relay-package-qualification.yml',
    event: 'workflow_dispatch',
    ref: 'main',
    sourceGitSha: valid.relaySha,
    runId: String(valid.relayPackageQualification.runId),
    runAttempt: String(valid.relayPackageQualification.runAttempt),
  },
  packages: {
    'agent-relay': '11.11.0-beta.1',
    '@agent-relay/agent': '7.1.1',
    '@agent-relay/config': '11.11.0-beta.1',
    '@agent-relay/credential-proxy': '7.1.1',
    '@agent-relay/events': '7.1.1',
    '@agent-relay/sandbox': '0.1.14',
    '@agent-relay/sdk': '11.11.0-beta.1',
  },
  registry: Object.fromEntries(
    [
      ['@agent-relay/agent', '7.1.1'],
      ['@agent-relay/credential-proxy', '7.1.1'],
      ['@agent-relay/events', '7.1.1'],
      ['@agent-relay/sandbox', '0.1.14'],
    ].map(([name, version]) => [
      name,
      {
        version,
        integrity: 'sha512-YQ==',
        shasum: 'a'.repeat(40),
      },
    ])
  ),
  candidate: {
    attestationFile: 'candidate-install-attestation.json',
    attestationSha256: 'b'.repeat(64),
    lockfileFile: 'candidate-package-lock.json',
    lockfileSha256: 'c'.repeat(64),
    tarballDirectory: 'tarballs',
  },
};

const relayPackageEnvelope = {
  ...relayPackagePayload,
  payload: {
    artifact: 'relay-package-qualification',
    artifactDigest: valid.relayPackageQualification.payloadArtifactDigest,
    file: 'relay-package-attestation.json',
    fileSha256: valid.relayPackageQualification.payloadSha256,
  },
};

const cloudQualification = {
  schemaVersion: 1,
  qualification: {
    runId: '101',
    runAttempt: '2',
    workflow: 'Rebuild Relay Daytona snapshot',
    ref: 'refs/heads/candidate',
    sha: valid.cloudSha,
    conclusion: 'success-required-from-workflow-api',
  },
  full: {
    snapshot: valid.cloudQualification.snapshotName,
    snapshotId: valid.cloudQualification.snapshotId,
    manifestSha256: valid.cloudQualification.snapshotManifestSha256,
  },
  lite: {
    snapshot: 'relay-orchestrator-lite-candidate',
    snapshotId: 'snapshot-lite-uuid',
    manifestSha256: '4'.repeat(64),
  },
};

const snapshotManifest = {
  schemaVersion: 1,
  snapshot: {
    name: valid.cloudQualification.snapshotName,
    requestedName: valid.cloudQualification.snapshotName,
    variant: 'full',
    mode: 'candidate',
  },
  promotion: { ssmWrite: false, selectorWrite: false, deploy: false },
  source: { gitSha: valid.cloudSha },
  packages: { '@agent-relay/sdk': '11.11.0-beta.1' },
  relayProducer: {
    ...relayPackageEnvelope,
    attestationArtifact: 'relay-package-qualification-attestation',
    attestationFile: 'relay-package-qualification-attestation.json',
    attestationArtifactDigest: valid.relayPackageQualification.attestationArtifactDigest,
  },
  relayfileMount: { sourceGitSha: valid.relayfileSha, sha256: '5'.repeat(64) },
};

const relayfileCloudAttestation = {
  schemaVersion: 1,
  qualification: {
    runId: '202',
    runAttempt: '1',
    sha: valid.relayfileCloudSha,
    conclusion: 'success-required-from-workflow-api',
  },
  deployment: {
    id: valid.relayfileCloudQualification.deploymentId,
    baseUrl: 'https://candidate-relayfile.example.test',
    expiresAt: '2099-09-06T12:00:00.000Z',
  },
};

const endpointIdentitySha256 = relayfileCloudEndpointIdentitySha256(
  relayfileCloudAttestation.deployment.baseUrl
);
const scaleCorpus = {
  path: '/qualification/scale-root',
  files: 851,
  directories: 454,
  bytes: 270_532_608,
  manifestSha256: '905968a14268ec5e8ec38ae1d6b24749e855cac035976a87a65ef43f6612a55a',
};
const additionalLargeFile = {
  path: '/qualification/large-root',
  relativeFile: 'large.bin',
  sha256: '7'.repeat(64),
  bytes: 270_532_608,
};
const acceptanceRecord = (label: string, index: number) => {
  const sandboxId = `${index}1111111-1111-4111-8111-111111111111`;
  const telemetry = {
    bulkRequests: 28,
    pointRequests: 0,
    cpuMs: 3_400,
    peakRssBytes: 66 * 1024 * 1024,
  };
  return {
    label,
    sandboxId,
    observedSnapshotId: valid.cloudQualification.snapshotId,
    observedSnapshotName: valid.cloudQualification.snapshotName,
    observedSnapshotSelector: valid.cloudQualification.snapshotId,
    startedAt: `2026-09-05T12:00:0${index}.000Z`,
    finishedAt: `2026-09-05T12:00:1${index}.000Z`,
    coldStartMs: 1_200 + index,
    scaleManifestSha256: scaleCorpus.manifestSha256,
    scaleFiles: scaleCorpus.files,
    scaleDirectories: scaleCorpus.directories,
    scaleBytes: scaleCorpus.bytes,
    scaleMountMs: 2_500,
    bootstrap: 'complete',
    payloadSha256: additionalLargeFile.sha256,
    payloadBytes: additionalLargeFile.bytes,
    largeFileMountMs: 1_800,
    scaleRemotePath: scaleCorpus.path,
    largeRemotePath: additionalLargeFile.path,
    largeRelativeFile: additionalLargeFile.relativeFile,
    mountEntrypoint: 'agent-relay fleet spawn --sandbox',
    mountMode: 'fleet-auto-mount',
    markerRelativePath: `qualification/marker-${index}.txt`,
    markerSha256: '9'.repeat(64),
    observedMarkerSha256: '9'.repeat(64),
    markerBytes: 64,
    relayfileCloudDeploymentId: valid.relayfileCloudQualification.deploymentId,
    relayfileCloudSourceSha: valid.relayfileCloudSha,
    relayfileCloudAttestationSha256: valid.relayfileCloudQualification.attestationSha256,
    endpointIdentitySha256,
    telemetry,
    resources: {
      request: {
        source: 'relayfile-cloud-request-log',
        sandboxId,
        deploymentId: valid.relayfileCloudQualification.deploymentId,
        endpointIdentitySha256,
        operation: 'fleet-auto-mount-bulk-manifest',
        correlationIdSha256: `${'a'.repeat(63)}${index}`,
        bulkRequests: telemetry.bulkRequests,
        pointRequests: telemetry.pointRequests,
      },
      process: {
        source: 'daytona-cgroup-v2',
        sandboxId,
        cpuMs: telemetry.cpuMs,
        peakRssBytes: telemetry.peakRssBytes,
      },
    },
    cleanup: {
      sandboxId,
      state: 'absent',
      verifiedAt: '2026-09-05T12:00:00.000Z',
    },
  };
};
const cloudAcceptance = {
  schemaVersion: 3,
  acceptance: {
    repository: CLOUD_SNAPSHOT_ACCEPTANCE_PRODUCER.repository,
    workflow: CLOUD_SNAPSHOT_ACCEPTANCE_PRODUCER.workflow,
    workflowPath: CLOUD_SNAPSHOT_ACCEPTANCE_PRODUCER.workflowPath,
    event: CLOUD_SNAPSHOT_ACCEPTANCE_PRODUCER.event,
    ref: CLOUD_SNAPSHOT_ACCEPTANCE_PRODUCER.ref,
    sourceGitSha: valid.cloudSnapshotAcceptance.sourceSha,
    runId: String(valid.cloudSnapshotAcceptance.runId),
    runAttempt: String(valid.cloudSnapshotAcceptance.runAttempt),
  },
  qualification: {
    runId: String(valid.cloudQualification.runId),
    runAttempt: String(valid.cloudQualification.runAttempt),
    artifactDigest: valid.cloudQualification.artifactDigest,
  },
  snapshot: {
    name: valid.cloudQualification.snapshotName,
    id: valid.cloudQualification.snapshotId,
  },
  relayfileCloud: {
    sourceGitSha: valid.relayfileCloudSha,
    runId: String(valid.relayfileCloudQualification.runId),
    runAttempt: String(valid.relayfileCloudQualification.runAttempt),
    artifactDigest: valid.relayfileCloudQualification.artifactDigest,
    deploymentId: valid.relayfileCloudQualification.deploymentId,
    attestationSha256: valid.relayfileCloudQualification.attestationSha256,
    endpointIdentitySha256,
  },
  scaleCorpus,
  additionalLargeFile,
  cold: acceptanceRecord('cold', 1),
  concurrent: [acceptanceRecord('concurrent-a', 2), acceptanceRecord('concurrent-b', 3)],
  acceptedAt: '2026-09-05T12:01:00.000Z',
};

const digests = {
  relayPayloadSha256: valid.relayPackageQualification.payloadSha256,
  relayAttestationSha256: valid.relayPackageQualification.attestationSha256,
  qualificationSha256: valid.cloudQualification.qualificationSha256,
  snapshotManifestSha256: valid.cloudQualification.snapshotManifestSha256,
  attestationSha256: valid.relayfileCloudQualification.attestationSha256,
  acceptanceSha256: valid.cloudSnapshotAcceptance.evidenceSha256,
};

describe('qualification manifest', () => {
  it('uses a Node runtime that satisfies the locked dependency engine floor', async () => {
    const workflow = await readFile('.github/workflows/relay-cleanroom-qualification.yml', 'utf8');
    expect(workflow.match(/node-version: 22\.22\.0/g)).toHaveLength(2);
    expect(workflow).not.toContain('node-version: 22.14.0');
  });

  it('binds four repositories, package/rebuild/acceptance producers, and the non-promoting snapshot', () => {
    expect(validateQualificationManifest(valid, { releaseId: 42, releaseTag: valid.releaseTag })).toEqual(
      valid
    );
  });

  it.each([
    ['promotion', { ...valid, promotion: 'production' }],
    ['release identity', { ...valid, releaseId: 43 }],
    ['source SHA', { ...valid, cloudSha: 'main' }],
    [
      'snapshot manifest',
      {
        ...valid,
        cloudQualification: { ...valid.cloudQualification, snapshotManifestSha256: 'missing' },
      },
    ],
    [
      'snapshot name',
      {
        ...valid,
        cloudQualification: { ...valid.cloudQualification, snapshotName: 'candidate; deploy' },
      },
    ],
    [
      'acceptance artifact name',
      {
        ...valid,
        cloudSnapshotAcceptance: {
          ...valid.cloudSnapshotAcceptance,
          artifactName: 'caller-selected-acceptance',
        },
      },
    ],
  ])('rejects an invalid %s', (_label, candidate) => {
    expect(() =>
      validateQualificationManifest(candidate, { releaseId: 42, releaseTag: valid.releaseTag })
    ).toThrow();
  });

  it('verifies the downloaded Cloud snapshot and Relayfile Cloud deployment evidence', () => {
    expect(
      validateQualificationBundle(
        valid,
        cloudQualification,
        snapshotManifest,
        relayfileCloudAttestation,
        relayPackagePayload,
        relayPackageEnvelope,
        digests,
        cloudAcceptance
      ).expectedRelayVersion
    ).toBe('11.11.0-beta.1');
  });

  it('rejects a Relayfile Cloud deployment that cannot outlive the qualification job', () => {
    expect(() =>
      validateQualificationBundle(
        valid,
        cloudQualification,
        snapshotManifest,
        {
          ...relayfileCloudAttestation,
          deployment: {
            ...relayfileCloudAttestation.deployment,
            expiresAt: new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString(),
          },
        },
        relayPackagePayload,
        relayPackageEnvelope,
        digests,
        cloudAcceptance
      )
    ).toThrow(/at least 8 hours/);
  });

  it('rejects Cloud acceptance endpoint substitution and changed acceptance bytes', () => {
    const substitutedEndpoint = structuredClone(cloudAcceptance);
    substitutedEndpoint.relayfileCloud.endpointIdentitySha256 = '0'.repeat(64);
    for (const record of [substitutedEndpoint.cold, ...substitutedEndpoint.concurrent]) {
      record.endpointIdentitySha256 = '0'.repeat(64);
      record.resources.request.endpointIdentitySha256 = '0'.repeat(64);
    }
    expect(() =>
      validateQualificationBundle(
        valid,
        cloudQualification,
        snapshotManifest,
        relayfileCloudAttestation,
        relayPackagePayload,
        relayPackageEnvelope,
        digests,
        substitutedEndpoint
      )
    ).toThrow(/endpoint identity/);

    expect(() =>
      validateQualificationBundle(
        valid,
        cloudQualification,
        snapshotManifest,
        relayfileCloudAttestation,
        relayPackagePayload,
        relayPackageEnvelope,
        { ...digests, acceptanceSha256: '0'.repeat(64) },
        cloudAcceptance
      )
    ).toThrow(/acceptanceSha256/);
  });

  it.each([
    [
      'Cloud source substitution',
      { ...cloudQualification, qualification: { ...cloudQualification.qualification, sha: 'f'.repeat(40) } },
      snapshotManifest,
      relayfileCloudAttestation,
      digests,
    ],
    [
      'promoting snapshot',
      cloudQualification,
      { ...snapshotManifest, promotion: { ...snapshotManifest.promotion, selectorWrite: true } },
      relayfileCloudAttestation,
      digests,
    ],
    [
      'Relayfile source substitution',
      cloudQualification,
      {
        ...snapshotManifest,
        relayfileMount: { ...snapshotManifest.relayfileMount, sourceGitSha: 'f'.repeat(40) },
      },
      relayfileCloudAttestation,
      digests,
    ],
    [
      'Relayfile Cloud deployment substitution',
      cloudQualification,
      snapshotManifest,
      {
        ...relayfileCloudAttestation,
        deployment: { ...relayfileCloudAttestation.deployment, id: 'different-deployment' },
      },
      digests,
    ],
    [
      'downloaded artifact digest mismatch',
      cloudQualification,
      snapshotManifest,
      relayfileCloudAttestation,
      { ...digests, qualificationSha256: '9'.repeat(64) },
    ],
  ])('rejects %s', (_label, cloud, snapshot, dataPlane, actualDigests) => {
    expect(() =>
      validateQualificationBundle(
        valid,
        cloud,
        snapshot,
        dataPlane,
        relayPackagePayload,
        relayPackageEnvelope,
        actualDigests,
        cloudAcceptance
      )
    ).toThrow();
  });

  it('rejects Relay source, run, payload, or snapshot-producer substitution', () => {
    expect(() =>
      validateQualificationBundle(
        valid,
        cloudQualification,
        snapshotManifest,
        relayfileCloudAttestation,
        {
          ...relayPackagePayload,
          producer: { ...relayPackagePayload.producer, sourceGitSha: '0'.repeat(40) },
        },
        relayPackageEnvelope,
        digests,
        cloudAcceptance
      )
    ).toThrow(/Relay producer/);
    expect(() =>
      validateQualificationBundle(
        valid,
        cloudQualification,
        { ...snapshotManifest, relayProducer: { ...snapshotManifest.relayProducer, packages: {} } },
        relayfileCloudAttestation,
        relayPackagePayload,
        relayPackageEnvelope,
        digests,
        cloudAcceptance
      )
    ).toThrow(/snapshot Relay producer/);
  });
});
