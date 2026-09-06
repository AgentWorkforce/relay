import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// @ts-expect-error JavaScript module intentionally has no declaration file.
import {
  CLOUD_SNAPSHOT_ACCEPTANCE_PRODUCER,
  CLOUD_FILES,
  CLOUD_SNAPSHOT_PRODUCER,
  RELAYFILE_CLOUD_PRODUCER,
  validateFixedProducerRun,
  verifyCloudSnapshotAcceptanceArtifact,
  verifyCloudSnapshotArtifact,
  verifyRelayfileCloudArtifact,
} from '../../scripts/verify-features/qualification-producer-artifacts.mjs';

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const expected = {
  runId: '101',
  runAttempt: '2',
  sourceSha: 'a'.repeat(40),
  artifactName: 'daytona-snapshot-manifests-101-2',
  artifactDigest: `sha256:${'b'.repeat(64)}`,
};

function run(policy = CLOUD_SNAPSHOT_PRODUCER) {
  return {
    id: 101,
    run_attempt: 2,
    head_sha: expected.sourceSha,
    status: 'completed',
    conclusion: 'success',
    name: policy.workflow,
    path: policy.workflowPath,
    event: policy.event,
    head_branch: policy.headBranch,
  };
}

function artifacts(name = expected.artifactName) {
  return [
    {
      name,
      digest: expected.artifactDigest,
      expired: false,
      workflow_run: { id: 101 },
    },
  ];
}

describe('fixed cross-repository qualification producers', () => {
  it('is an enforced gate in the cleanroom qualification workflow', async () => {
    const workflow = await readFile('.github/workflows/relay-cleanroom-qualification-consumer.yml', 'utf8');
    expect(workflow).toContain(
      'qualification-producer-artifacts.mjs cloud \\\n            --run qualification/cloud-run.json'
    );
    expect(workflow).toContain(
      'qualification-producer-artifacts.mjs relayfile-cloud \\\n            --run qualification/relayfile-cloud-run.json'
    );
    expect(workflow).toContain(
      'qualification-producer-artifacts.mjs cloud-acceptance \\\n            --run qualification/cloud-acceptance-run.json'
    );
    expect(workflow).toContain('qualification/cloud-acceptance/candidate-acceptance.json');
  });

  it('rejects workflow, event, branch, name, and artifact substitutions', () => {
    expect(validateFixedProducerRun(run(), artifacts(), expected, CLOUD_SNAPSHOT_PRODUCER)).toBeTruthy();
    for (const mutation of [
      { name: 'Deploy Production' },
      { path: '.github/workflows/other.yml' },
      { path: `${CLOUD_SNAPSHOT_PRODUCER.workflowPath}@refs/heads/other` },
      { event: 'push' },
      { head_branch: 'candidate' },
    ]) {
      expect(() =>
        validateFixedProducerRun({ ...run(), ...mutation }, artifacts(), expected, CLOUD_SNAPSHOT_PRODUCER)
      ).toThrow('fixed producer policy');
    }
    expect(() =>
      validateFixedProducerRun(run(), artifacts('caller-selected'), expected, CLOUD_SNAPSHOT_PRODUCER)
    ).toThrow('artifact identity');
    expect(() =>
      validateFixedProducerRun(
        run(),
        artifacts(),
        { ...expected, artifactName: 'daytona-snapshot-manifests-101-1' },
        CLOUD_SNAPSHOT_PRODUCER
      )
    ).toThrow('expectation');
  });

  it('verifies the Cloud seal, checksum sidecar, and exact artifact file set', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-qualification-artifact-'));
    try {
      const qualification = `${JSON.stringify({ qualification: { ref: 'refs/heads/main' } })}\n`;
      const contents = Object.fromEntries(
        CLOUD_FILES.filter(
          (file: string) => !['qualification.seal.json', 'qualification.json.sha256'].includes(file)
        ).map((file: string) => [file, file === 'qualification.json' ? qualification : `${file}\n`])
      );
      for (const [file, bytes] of Object.entries(contents)) {
        await writeFile(path.join(root, file), bytes as string);
      }
      await writeFile(
        path.join(root, 'qualification.json.sha256'),
        `${sha256(qualification)}  .artifacts/qualification.json\n`
      );
      await writeFile(
        path.join(root, 'qualification.seal.json'),
        `${JSON.stringify({
          schemaVersion: 1,
          runId: expected.runId,
          runAttempt: expected.runAttempt,
          sourceGitSha: expected.sourceSha,
          files: Object.entries(contents).map(([file, bytes]) => ({
            file,
            sha256: sha256(bytes as string),
          })),
        })}\n`
      );
      await expect(verifyCloudSnapshotArtifact(root, expected)).resolves.toBeTruthy();

      await writeFile(path.join(root, 'unsealed.txt'), 'substitution');
      await expect(verifyCloudSnapshotArtifact(root, expected)).rejects.toThrow('exact file set');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('binds the exact 258 MiB root acceptance and three independently cleaned sandboxes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-snapshot-acceptance-'));
    try {
      const acceptanceExpected = {
        ...expected,
        artifactName: 'candidate-cold-concurrent-acceptance-101-2',
        evidenceSha256: '',
        qualificationRunId: '88',
        qualificationRunAttempt: '3',
        qualificationArtifactDigest: `sha256:${'c'.repeat(64)}`,
        snapshotName: 'relay-candidate-snapshot',
        snapshotId: 'snapshot-immutable-71',
        relayfileCloudSourceSha: 'e'.repeat(40),
        relayfileCloudRunId: '202',
        relayfileCloudRunAttempt: '1',
        relayfileCloudArtifactDigest: `sha256:${'e'.repeat(64)}`,
        relayfileCloudDeploymentId: 'relayfile-cloud-preview-202',
        relayfileCloudAttestationSha256: 'f'.repeat(64),
      };
      expect(() =>
        validateFixedProducerRun(
          run(CLOUD_SNAPSHOT_ACCEPTANCE_PRODUCER),
          artifacts(acceptanceExpected.artifactName),
          acceptanceExpected,
          CLOUD_SNAPSHOT_ACCEPTANCE_PRODUCER
        )
      ).not.toThrow();
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
        sha256: 'd'.repeat(64),
        bytes: 270_532_608,
      };
      const record = (label: string, index: number) => {
        const sandboxId = `${index}1111111-1111-4111-8111-111111111111`;
        const telemetry = {
          bulkRequests: 28,
          pointRequests: 0,
          cpuMs: 3400,
          peakRssBytes: 66 * 1024 * 1024,
        };
        return {
          label,
          sandboxId,
          observedSnapshotId: acceptanceExpected.snapshotId,
          observedSnapshotName: acceptanceExpected.snapshotName,
          observedSnapshotSelector: acceptanceExpected.snapshotId,
          startedAt: `2026-09-05T12:00:0${index}.000Z`,
          finishedAt: `2026-09-05T12:00:1${index}.000Z`,
          coldStartMs: 1200 + index,
          scaleManifestSha256: scaleCorpus.manifestSha256,
          scaleFiles: scaleCorpus.files,
          scaleDirectories: scaleCorpus.directories,
          scaleBytes: scaleCorpus.bytes,
          scaleMountMs: 2500,
          bootstrap: 'complete',
          payloadSha256: additionalLargeFile.sha256,
          payloadBytes: additionalLargeFile.bytes,
          largeFileMountMs: 1800,
          scaleRemotePath: scaleCorpus.path,
          largeRemotePath: additionalLargeFile.path,
          largeRelativeFile: additionalLargeFile.relativeFile,
          mountEntrypoint: 'agent-relay fleet spawn --sandbox',
          mountMode: 'fleet-auto-mount',
          markerRelativePath: `qualification/marker-${index}.txt`,
          markerSha256: '9'.repeat(64),
          observedMarkerSha256: '9'.repeat(64),
          markerBytes: 64,
          relayfileCloudDeploymentId: acceptanceExpected.relayfileCloudDeploymentId,
          relayfileCloudSourceSha: acceptanceExpected.relayfileCloudSourceSha,
          relayfileCloudAttestationSha256: acceptanceExpected.relayfileCloudAttestationSha256,
          endpointIdentitySha256: '8'.repeat(64),
          telemetry,
          resources: {
            request: {
              source: 'relayfile-cloud-request-log',
              sandboxId,
              deploymentId: acceptanceExpected.relayfileCloudDeploymentId,
              endpointIdentitySha256: '8'.repeat(64),
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
            verifiedAt: '2026-09-05T12:00:30.000Z',
          },
        };
      };
      const evidence = {
        schemaVersion: 3,
        acceptance: {
          repository: CLOUD_SNAPSHOT_ACCEPTANCE_PRODUCER.repository,
          workflow: CLOUD_SNAPSHOT_ACCEPTANCE_PRODUCER.workflow,
          workflowPath: CLOUD_SNAPSHOT_ACCEPTANCE_PRODUCER.workflowPath,
          event: CLOUD_SNAPSHOT_ACCEPTANCE_PRODUCER.event,
          ref: CLOUD_SNAPSHOT_ACCEPTANCE_PRODUCER.ref,
          sourceGitSha: acceptanceExpected.sourceSha,
          runId: acceptanceExpected.runId,
          runAttempt: acceptanceExpected.runAttempt,
        },
        qualification: {
          runId: acceptanceExpected.qualificationRunId,
          runAttempt: acceptanceExpected.qualificationRunAttempt,
          artifactDigest: acceptanceExpected.qualificationArtifactDigest,
        },
        snapshot: { name: acceptanceExpected.snapshotName, id: acceptanceExpected.snapshotId },
        relayfileCloud: {
          sourceGitSha: acceptanceExpected.relayfileCloudSourceSha,
          runId: acceptanceExpected.relayfileCloudRunId,
          runAttempt: acceptanceExpected.relayfileCloudRunAttempt,
          artifactDigest: acceptanceExpected.relayfileCloudArtifactDigest,
          deploymentId: acceptanceExpected.relayfileCloudDeploymentId,
          attestationSha256: acceptanceExpected.relayfileCloudAttestationSha256,
          endpointIdentitySha256: '8'.repeat(64),
        },
        scaleCorpus,
        additionalLargeFile,
        cold: record('cold', 1),
        concurrent: [record('concurrent-a', 2), record('concurrent-b', 3)],
        acceptedAt: '2026-09-05T12:01:00.000Z',
      };
      const bytes = `${JSON.stringify(evidence)}\n`;
      await writeFile(path.join(root, 'candidate-acceptance.json'), bytes);
      acceptanceExpected.evidenceSha256 = sha256(bytes);
      await expect(verifyCloudSnapshotAcceptanceArtifact(root, acceptanceExpected)).resolves.toEqual(
        evidence
      );

      const substitutedSelector = structuredClone(evidence);
      substitutedSelector.cold.observedSnapshotSelector = 'mutable-candidate-name';
      const selectorBytes = `${JSON.stringify(substitutedSelector)}\n`;
      await writeFile(path.join(root, 'candidate-acceptance.json'), selectorBytes);
      await expect(
        verifyCloudSnapshotAcceptanceArtifact(root, {
          ...acceptanceExpected,
          evidenceSha256: sha256(selectorBytes),
        })
      ).rejects.toThrow('cold');

      const invalidSandbox = structuredClone(evidence);
      invalidSandbox.concurrent[0]!.sandboxId = 'sandbox-2';
      const invalidSandboxBytes = `${JSON.stringify(invalidSandbox)}\n`;
      await writeFile(path.join(root, 'candidate-acceptance.json'), invalidSandboxBytes);
      await expect(
        verifyCloudSnapshotAcceptanceArtifact(root, {
          ...acceptanceExpected,
          evidenceSha256: sha256(invalidSandboxBytes),
        })
      ).rejects.toThrow('concurrent[0]');

      const reusedCorrelation = structuredClone(evidence);
      reusedCorrelation.concurrent[0]!.resources.request.correlationIdSha256 =
        reusedCorrelation.cold.resources.request.correlationIdSha256;
      const reusedCorrelationBytes = `${JSON.stringify(reusedCorrelation)}\n`;
      await writeFile(path.join(root, 'candidate-acceptance.json'), reusedCorrelationBytes);
      await expect(
        verifyCloudSnapshotAcceptanceArtifact(root, {
          ...acceptanceExpected,
          evidenceSha256: sha256(reusedCorrelationBytes),
        })
      ).rejects.toThrow('reused a request correlation');

      const sequential = structuredClone(evidence);
      sequential.concurrent[0]!.startedAt = '2026-09-05T12:00:20.000Z';
      sequential.concurrent[0]!.finishedAt = '2026-09-05T12:00:21.000Z';
      sequential.concurrent[1]!.startedAt = '2026-09-05T12:00:22.000Z';
      sequential.concurrent[1]!.finishedAt = '2026-09-05T12:00:23.000Z';
      const sequentialBytes = `${JSON.stringify(sequential)}\n`;
      await writeFile(path.join(root, 'candidate-acceptance.json'), sequentialBytes);
      await expect(
        verifyCloudSnapshotAcceptanceArtifact(root, {
          ...acceptanceExpected,
          evidenceSha256: sha256(sequentialBytes),
        })
      ).rejects.toThrow('concurrent mount overlap');

      const substitutedDeployment = structuredClone(evidence);
      substitutedDeployment.concurrent[0]!.relayfileCloudDeploymentId = 'different-deployment';
      const substitutedBytes = `${JSON.stringify(substitutedDeployment)}\n`;
      await writeFile(path.join(root, 'candidate-acceptance.json'), substitutedBytes);
      await expect(
        verifyCloudSnapshotAcceptanceArtifact(root, {
          ...acceptanceExpected,
          evidenceSha256: sha256(substitutedBytes),
        })
      ).rejects.toThrow('concurrent[0]');

      const escapingMarker = structuredClone(evidence);
      escapingMarker.cold.markerRelativePath = '../outside.txt';
      const escapingMarkerBytes = `${JSON.stringify(escapingMarker)}\n`;
      await writeFile(path.join(root, 'candidate-acceptance.json'), escapingMarkerBytes);
      await expect(
        verifyCloudSnapshotAcceptanceArtifact(root, {
          ...acceptanceExpected,
          evidenceSha256: sha256(escapingMarkerBytes),
        })
      ).rejects.toThrow('cold');

      for (const markerRelativePath of ['.', 'qualification/']) {
        const directoryMarker = structuredClone(evidence);
        directoryMarker.cold.markerRelativePath = markerRelativePath;
        const directoryMarkerBytes = `${JSON.stringify(directoryMarker)}\n`;
        await writeFile(path.join(root, 'candidate-acceptance.json'), directoryMarkerBytes);
        await expect(
          verifyCloudSnapshotAcceptanceArtifact(root, {
            ...acceptanceExpected,
            evidenceSha256: sha256(directoryMarkerBytes),
          })
        ).rejects.toThrow('cold');
      }

      const earlyCleanup = structuredClone(evidence);
      earlyCleanup.cold.cleanup.verifiedAt = '2026-09-05T12:00:00.000Z';
      const earlyCleanupBytes = `${JSON.stringify(earlyCleanup)}\n`;
      await writeFile(path.join(root, 'candidate-acceptance.json'), earlyCleanupBytes);
      await expect(
        verifyCloudSnapshotAcceptanceArtifact(root, {
          ...acceptanceExpected,
          evidenceSha256: sha256(earlyCleanupBytes),
        })
      ).rejects.toThrow('cold');

      const absoluteLargeFile = structuredClone(evidence);
      absoluteLargeFile.additionalLargeFile.relativeFile = '/etc/passwd';
      const absoluteLargeFileBytes = `${JSON.stringify(absoluteLargeFile)}\n`;
      await writeFile(path.join(root, 'candidate-acceptance.json'), absoluteLargeFileBytes);
      await expect(
        verifyCloudSnapshotAcceptanceArtifact(root, {
          ...acceptanceExpected,
          evidenceSha256: sha256(absoluteLargeFileBytes),
        })
      ).rejects.toThrow('outside the fixed policy');

      evidence.concurrent[1]!.cleanup.state = 'present';
      const changed = `${JSON.stringify(evidence)}\n`;
      await writeFile(path.join(root, 'candidate-acceptance.json'), changed);
      await expect(
        verifyCloudSnapshotAcceptanceArtifact(root, {
          ...acceptanceExpected,
          evidenceSha256: sha256(changed),
        })
      ).rejects.toThrow('concurrent[1]');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps Relayfile Cloud red until its fixed candidate workflow emits an exact sealed artifact', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'relayfile-cloud-artifact-'));
    try {
      const relayfileExpected = {
        ...expected,
        artifactName: 'relayfile-cloud-candidate-101-2',
      };
      expect(() =>
        validateFixedProducerRun(
          run(RELAYFILE_CLOUD_PRODUCER),
          artifacts(relayfileExpected.artifactName),
          relayfileExpected,
          RELAYFILE_CLOUD_PRODUCER
        )
      ).not.toThrow();
      const attestation = '{"deployment":{"id":"candidate"}}\n';
      await writeFile(path.join(root, 'relayfile-cloud-attestation.json'), attestation);
      await writeFile(
        path.join(root, 'qualification.seal.json'),
        `${JSON.stringify({
          schemaVersion: 1,
          runId: relayfileExpected.runId,
          runAttempt: relayfileExpected.runAttempt,
          sourceGitSha: relayfileExpected.sourceSha,
          files: [
            {
              file: 'relayfile-cloud-attestation.json',
              sha256: sha256(attestation),
            },
          ],
        })}\n`
      );
      await expect(verifyRelayfileCloudArtifact(root, relayfileExpected)).resolves.toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a sealed filename that is a symbolic link', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'relayfile-cloud-symlink-'));
    const outside = path.join(root, '..', `${path.basename(root)}-outside.json`);
    try {
      const relayfileExpected = {
        ...expected,
        artifactName: 'relayfile-cloud-candidate-101-2',
      };
      const attestation = '{"deployment":{"id":"candidate"}}\n';
      await writeFile(outside, attestation);
      await symlink(outside, path.join(root, 'relayfile-cloud-attestation.json'));
      await writeFile(
        path.join(root, 'qualification.seal.json'),
        `${JSON.stringify({
          schemaVersion: 1,
          runId: relayfileExpected.runId,
          runAttempt: relayfileExpected.runAttempt,
          sourceGitSha: relayfileExpected.sourceSha,
          files: [
            {
              file: 'relayfile-cloud-attestation.json',
              sha256: sha256(attestation),
            },
          ],
        })}\n`
      );
      await expect(verifyRelayfileCloudArtifact(root, relayfileExpected)).rejects.toThrow(
        'not a regular file'
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { force: true });
    }
  });
});
