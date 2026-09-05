import fs from 'node:fs';
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { composeQualificationEffects } from '../../scripts/verify-features/qualification-effect-evidence.mjs';
import { relayfileCloudEndpointIdentitySha256 } from '../../scripts/verify-features/qualification-manifest.mjs';
import { CLOUD_SNAPSHOT_ACCEPTANCE_PRODUCER } from '../../scripts/verify-features/qualification-producer-artifacts.mjs';

const workspaceIds = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const relayWorkspaceIds = ['rw_12345678', 'rw_87654321'];
const deploymentId = 'rfcloud-candidate-71';
const snapshotId = 'snap_qualified_71';
const relaySha = 'a'.repeat(40);
const cloudSha = 'd'.repeat(40);
const relayfileCloudSha = 'f'.repeat(40);
const relayfileCloudBaseUrl = 'https://candidate-relayfile.example.test';
const endpointIdentitySha256 = relayfileCloudEndpointIdentitySha256(relayfileCloudBaseUrl);
const scaleManifestSha256 = '905968a14268ec5e8ec38ae1d6b24749e855cac035976a87a65ef43f6612a55a';
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function deleteResult(workspaceId: string, relayWorkspaceId: string) {
  return {
    workspaceId,
    relayWorkspaceId,
    expiresAt: '2099-01-01T00:00:00.000Z',
    state: 'deleted',
    deleted: true,
    idempotent: false,
    operationId: `delete-${workspaceId}`,
    verifiedAt: '2026-09-05T12:00:30.000Z',
    proof: {
      daytona: { workspaceId, relayWorkspaceId, remaining: 0 },
      cloud: { workspaceId, relayWorkspaceId, appWorkspaceRowsRemaining: 0 },
      credentials: { workspaceId, relayWorkspaceId, activeSessionsRemaining: 0 },
      relaycast: {
        workspaceId,
        relayWorkspaceId,
        deleted: true,
        agentsAndNodesDeletedByWorkspaceCascade: true,
      },
      relayfile: { workspaceId, relayWorkspaceId, deleted: true },
      registry: { workspaceId, relayWorkspaceId, deleted: true },
    },
    absence: { workspaceId, status: 404, verifiedAt: '2026-09-05T12:00:31.000Z' },
  };
}

function fixture() {
  const snapshotManifest = { snapshot: { mode: 'candidate' }, source: { gitSha: cloudSha } };
  const snapshotManifestBytes = Buffer.from(`${JSON.stringify(snapshotManifest)}\n`);
  const snapshotManifestSha256 = sha256(snapshotManifestBytes);
  const relayfileCloudAttestation = {
    deployment: { id: deploymentId, baseUrl: relayfileCloudBaseUrl },
  };
  const relayfileCloudAttestationBytes = Buffer.from(`${JSON.stringify(relayfileCloudAttestation)}\n`);
  const attestationSha256 = sha256(relayfileCloudAttestationBytes);
  const acceptanceRecord = (label: string, index: number) => {
    const sandboxId = `${index}1111111-1111-4111-8111-111111111111`;
    const telemetry = {
      bulkRequests: 28,
      pointRequests: 0,
      cpuMs: 3_400 + index,
      peakRssBytes: 66 * 1024 * 1024,
    };
    return {
      label,
      sandboxId,
      observedSnapshotId: snapshotId,
      observedSnapshotName: 'relay-candidate-snapshot',
      observedSnapshotSelector: snapshotId,
      startedAt: `2026-09-05T12:00:0${index}.000Z`,
      finishedAt: `2026-09-05T12:00:1${index}.000Z`,
      coldStartMs: 1_200 + index,
      scaleManifestSha256,
      scaleFiles: 851,
      scaleDirectories: 454,
      scaleBytes: 270_532_608,
      scaleMountMs: 2_500,
      bootstrap: 'complete',
      payloadSha256: '8'.repeat(64),
      payloadBytes: 270_532_608,
      largeFileMountMs: 1_800,
      scaleRemotePath: '/qualification/scale-root',
      largeRemotePath: '/qualification/large-root',
      largeRelativeFile: 'large.bin',
      mountEntrypoint: 'agent-relay fleet spawn --sandbox',
      mountMode: 'fleet-auto-mount',
      markerRelativePath: `qualification/marker-${index}.txt`,
      markerSha256: '9'.repeat(64),
      observedMarkerSha256: '9'.repeat(64),
      markerBytes: 64,
      relayfileCloudDeploymentId: deploymentId,
      relayfileCloudSourceSha: relayfileCloudSha,
      relayfileCloudAttestationSha256: attestationSha256,
      endpointIdentitySha256,
      telemetry,
      resources: {
        request: {
          source: 'relayfile-cloud-request-log',
          sandboxId,
          deploymentId,
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
        verifiedAt: '2026-09-05T12:00:30.000Z',
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
      sourceGitSha: 'e'.repeat(40),
      runId: '151',
      runAttempt: '1',
    },
    qualification: {
      runId: '101',
      runAttempt: '2',
      artifactDigest: `sha256:${'6'.repeat(64)}`,
    },
    snapshot: { name: 'relay-candidate-snapshot', id: snapshotId },
    relayfileCloud: {
      sourceGitSha: relayfileCloudSha,
      runId: '202',
      runAttempt: '1',
      artifactDigest: `sha256:${'5'.repeat(64)}`,
      deploymentId,
      attestationSha256,
      endpointIdentitySha256,
    },
    scaleCorpus: {
      path: '/qualification/scale-root',
      files: 851,
      directories: 454,
      bytes: 270_532_608,
      manifestSha256: scaleManifestSha256,
    },
    additionalLargeFile: {
      path: '/qualification/large-root',
      relativeFile: 'large.bin',
      sha256: '8'.repeat(64),
      bytes: 270_532_608,
    },
    cold: acceptanceRecord('cold', 1),
    concurrent: [acceptanceRecord('concurrent-a', 2), acceptanceRecord('concurrent-b', 3)],
    acceptedAt: '2026-09-05T12:01:00.000Z',
  };
  const cloudAcceptanceBytes = Buffer.from(`${JSON.stringify(cloudAcceptance)}\n`);
  const cloudAcceptanceSha256 = sha256(cloudAcceptanceBytes);
  return {
    manifest: {
      relaySha,
      cloudSha,
      relayfileCloudSha,
      cloudQualification: {
        runId: 101,
        runAttempt: 2,
        artifactDigest: `sha256:${'6'.repeat(64)}`,
        snapshotName: 'relay-candidate-snapshot',
        snapshotId,
        snapshotManifestSha256,
      },
      cloudSnapshotAcceptance: {
        sourceSha: 'e'.repeat(40),
        runId: 151,
        runAttempt: 1,
        evidenceSha256: cloudAcceptanceSha256,
      },
      relayfileCloudQualification: {
        runId: 202,
        runAttempt: 1,
        artifactDigest: `sha256:${'5'.repeat(64)}`,
        deploymentId,
        attestationSha256,
      },
    },
    snapshotManifest,
    snapshotManifestBytes,
    relayfileCloudAttestation,
    relayfileCloudAttestationBytes,
    cloudAcceptance,
    cloudAcceptanceBytes,
    fleetCampaign: {
      verdict: 'GREEN',
      productVerdict: 'GREEN',
      infrastructureStatus: 'PASS',
      workspaceIds,
      controlledProvenance: {
        sourceCommit: relaySha,
        requestedSnapshotId: snapshotId,
        requestedSnapshotManifestSha256: snapshotManifestSha256,
        candidateCleanInstall: true,
        candidateInstallSourceSha: relaySha,
        candidateInstallAttestationSha256: 'e'.repeat(64),
      },
    },
    fleetAttempts: ['a', 'b'].map((nonce, index) => ({
      nonce,
      evidence: {
        provenance: { resolvedWorkspaceId: workspaceIds[index] },
        environment: { expectedRelayWorkspaceId: relayWorkspaceIds[index] },
        resources: [
          { type: 'daytona-sandbox', id: `sandbox-${nonce}-1`, observedSnapshotId: snapshotId },
          { type: 'daytona-sandbox', id: `sandbox-${nonce}-2`, observedSnapshotId: snapshotId },
        ],
      },
    })),
    fleetSignoffVerified: true,
    workspaceCreates: workspaceIds.map((workspaceId, index) => ({
      label: index === 0 ? 'a' : 'b',
      result: {
        workspaceId,
        relayWorkspaceId: relayWorkspaceIds[index],
        credentialFile: `/tmp/credential-${index}.json`,
        requestedRelayfileCloudDeploymentId: deploymentId,
        observedRelayfileCloudDeploymentId: deploymentId,
        relayfileCloudAttestationSha256: attestationSha256,
      },
      credential: {
        version: 1,
        workspaceId,
        relayWorkspaceId: relayWorkspaceIds[index],
        cloud: { accessToken: 'secret', refreshToken: 'secret' },
        relay: { baseUrl: 'https://relay.example', workspaceKey: 'secret' },
      },
      credentialPath: `/tmp/credential-${index}.json`,
      mode: '0600',
    })),
    workspaceDeletes: workspaceIds.map((workspaceId, index) => ({
      label: index === 0 ? 'a' : 'b',
      result: deleteResult(workspaceId, relayWorkspaceIds[index]!),
      elapsedSeconds: 37 + index,
      timingWorkspaceId: workspaceId,
      timingOperationId: `delete-${workspaceId}`,
    })),
  };
}

describe('qualification runtime effect composer', () => {
  it('is an invoked release gate after both timed cleanup operations', () => {
    const workflow = fs.readFileSync('.github/workflows/relay-cleanroom-qualification.yml', 'utf8');
    const composer = workflow.indexOf('qualification-effect-evidence.mjs');
    expect(workflow.indexOf('workspace-delete-a-timing.json')).toBeGreaterThan(-1);
    expect(workflow.indexOf('workspace-delete-b-timing.json')).toBeGreaterThan(-1);
    expect(workflow.indexOf('workspace-delete-a-timing.json')).toBeLessThan(composer);
    expect(workflow.indexOf('workspace-delete-b-timing.json')).toBeLessThan(composer);
    expect(workflow).toContain('--effect-evidence ../qualification/runtime-effects.json');
    expect(workflow).toContain(
      '--cloud-acceptance ../qualification/cloud-acceptance/candidate-acceptance.json'
    );
    expect(workflow).toContain(
      'VERIFY_FLEET_NONCE: qualification-${{ github.run_id }}-${{ github.run_attempt }}'
    );
    expect(workflow).toContain('Hydrate the exact producer-packed Relay candidate');
    expect(workflow).toContain('VERIFY_FLEET_CANDIDATE_ATTESTATION:');
    expect(workflow.match(/--ttl 24h/g)).toHaveLength(2);
    expect(workflow).toContain("VERIFY_FLEET_MIN_CREDENTIAL_LIFETIME_SECONDS: '21600'");
    expect(workflow).toContain('git/ref/tags/${encodeURIComponent(tag)}');
    expect(workflow).toContain("object?.type !== 'commit' || object.sha !== expected");
    expect(workflow).not.toContain('node relay/packages/cli/dist/cli/index.js cloud workspace create');
    expect(workflow).not.toContain('node relay/packages/cli/dist/cli/index.js cloud workspace delete');
  });

  it('emits only non-secret PASS effects after all exact runtime identities agree', () => {
    const effects = composeQualificationEffects(fixture());

    expect(effects['candidate-snapshot-selector']).toMatchObject({
      status: 'PASS',
      requestedSnapshotId: snapshotId,
      observedSnapshotId: snapshotId,
      relayCandidateInstallAttestationSha256: 'e'.repeat(64),
    });
    expect(effects['ephemeral-cloud-workspace-create']).toMatchObject({ status: 'PASS', workspaceIds });
    expect(effects['qualified-relayfile-cloud-binding']).toMatchObject({
      status: 'PASS',
      requestedDeploymentId: deploymentId,
      observedDeploymentId: deploymentId,
      sourceGitSha: relayfileCloudSha,
    });
    expect(effects['relayfile-258-mib-fleet-auto-mount']).toMatchObject({
      status: 'PASS',
      deploymentId,
      sourceGitSha: relayfileCloudSha,
      endpointIdentitySha256,
      mountEntrypoint: 'agent-relay fleet spawn --sandbox',
      mountMode: 'fleet-auto-mount',
      scaleBytes: 270_532_608,
      totalPointRequests: 0,
      exactCleanup: true,
    });
    expect(effects['ephemeral-cloud-workspace-delete']).toMatchObject({
      status: 'PASS',
      fleetAbsent: true,
      elapsedSeconds: 38,
    });
    expect(JSON.stringify(effects)).not.toContain('secret');
  });

  it('rejects a candidate binding that merely requested but did not observe the deployment', () => {
    const input = fixture();
    input.workspaceCreates[1]!.result.observedRelayfileCloudDeploymentId = 'production';
    expect(() => composeQualificationEffects(input)).toThrow('did not prove the qualified');

    const insecure = fixture();
    insecure.workspaceCreates[0]!.credential.relay.baseUrl = 'http://relay.example';
    expect(() => composeQualificationEffects(insecure)).toThrow('credential-free HTTPS');
  });

  it('rejects aggregate deletion counts that target another workspace or remain readable', () => {
    const wrongTarget = fixture();
    wrongTarget.workspaceDeletes[0]!.result.proof.daytona.workspaceId = workspaceIds[1];
    expect(() => composeQualificationEffects(wrongTarget)).toThrow('targets a different workspace');

    const stillPresent = fixture();
    stillPresent.workspaceDeletes[0]!.result.absence.status = 200;
    expect(() => composeQualificationEffects(stillPresent)).toThrow('complete cascade deletion');

    const unrelatedTiming = fixture();
    unrelatedTiming.workspaceDeletes[0]!.timingOperationId = 'delete-other';
    expect(() => composeQualificationEffects(unrelatedTiming)).toThrow('complete cascade deletion');

    const wrongRelayWorkspace = fixture();
    wrongRelayWorkspace.workspaceDeletes[0]!.result.proof.relaycast.relayWorkspaceId = relayWorkspaceIds[1]!;
    expect(() => composeQualificationEffects(wrongRelayWorkspace)).toThrow('targets a different workspace');
  });

  it('binds distinct Relay workspaces and each Fleet attempt to its matching create', () => {
    const duplicateRelayWorkspace = fixture();
    duplicateRelayWorkspace.workspaceCreates[1]!.result.relayWorkspaceId = relayWorkspaceIds[0]!;
    duplicateRelayWorkspace.workspaceCreates[1]!.credential.relayWorkspaceId = relayWorkspaceIds[0]!;
    expect(() => composeQualificationEffects(duplicateRelayWorkspace)).toThrow('distinct Relay workspace');

    const mismatchedAttempt = fixture();
    mismatchedAttempt.fleetAttempts[1]!.evidence.environment.expectedRelayWorkspaceId = relayWorkspaceIds[0]!;
    expect(() => composeQualificationEffects(mismatchedAttempt)).toThrow(
      'Fleet attempts are not bound to their distinct created Relay workspaces'
    );
  });

  it('rejects a mutable snapshot or mismatched snapshot observation', () => {
    const mutable = fixture();
    mutable.snapshotManifest.snapshot.mode = 'production';
    mutable.snapshotManifestBytes = Buffer.from(`${JSON.stringify(mutable.snapshotManifest)}\n`);
    mutable.manifest.cloudQualification.snapshotManifestSha256 = sha256(mutable.snapshotManifestBytes);
    mutable.fleetCampaign.controlledProvenance.requestedSnapshotManifestSha256 =
      mutable.manifest.cloudQualification.snapshotManifestSha256;
    expect(() => composeQualificationEffects(mutable)).toThrow('provenance');

    const input = fixture();
    input.fleetAttempts[1]!.evidence.resources[0]!.observedSnapshotId = 'snap_other';
    expect(() => composeQualificationEffects(input)).toThrow('did not observe the exact immutable snapshot');
  });

  it('rejects substituted or unsealed 258 MiB Fleet auto-mount acceptance evidence', () => {
    const substituted = fixture();
    substituted.cloudAcceptance.concurrent[1]!.relayfileCloudDeploymentId = 'production';
    substituted.cloudAcceptanceBytes = Buffer.from(`${JSON.stringify(substituted.cloudAcceptance)}\n`);
    substituted.manifest.cloudSnapshotAcceptance.evidenceSha256 = sha256(substituted.cloudAcceptanceBytes);
    expect(() => composeQualificationEffects(substituted)).toThrow('concurrent[1]');

    const changedBytes = fixture();
    changedBytes.cloudAcceptanceBytes = Buffer.concat([changedBytes.cloudAcceptanceBytes, Buffer.from(' ')]);
    expect(() => composeQualificationEffects(changedBytes)).toThrow('acceptance bytes');
  });

  it('rejects an unsigned campaign and deletion outside the cleanup SLO', () => {
    const unsigned = fixture();
    unsigned.fleetSignoffVerified = false;
    expect(() => composeQualificationEffects(unsigned)).toThrow('signoff');

    const slow = fixture();
    slow.workspaceDeletes[0]!.elapsedSeconds = 121;
    expect(() => composeQualificationEffects(slow)).toThrow('120s SLO');

    const mismatchedTiming = fixture();
    mismatchedTiming.workspaceDeletes[0]!.timingWorkspaceId = workspaceIds[1]!;
    expect(() => composeQualificationEffects(mismatchedTiming)).toThrow('120s SLO');
  });
});
