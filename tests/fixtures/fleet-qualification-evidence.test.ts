import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  candidateManifestSha256,
  canonicalizeCandidateManifest,
  canonicalizeJson,
  normalizeDeploymentId,
  normalizeSha256,
  normalizeSnapshotId,
  validateQualificationEvidence,
} from '../../scripts/fleet-qualification/evidence.mjs';
import { FLEET_QUALIFICATION_OPERATIONS } from '../../scripts/fleet-qualification/matrix.mjs';

const now = '2026-09-05T09:00:00.000Z';

function validEvidence() {
  const candidateManifest = {
    relayfileCloudDeploymentId: ' Candidate-0905 ',
    packages: [{ name: 'agent-relay', sha256: 'b'.repeat(64) }],
    version: 1,
  };
  const digest = candidateManifestSha256(candidateManifest);
  const artifactSha = 'a'.repeat(64);
  const nodes = ['sandbox-a', 'sandbox-b'].map((resourceId, index) => ({
    resourceId,
    name: `qualification-${index + 1}`,
    provisionedForRun: true,
    createdAt: now,
    observedDaytonaSnapshotId: `Snapshot-${index + 1}`,
    inImageManifestSha256: digest,
    snapshotObservation: { source: 'running-node', command: 'read-snapshot-id', observedAt: now },
    manifestObservation: { source: 'in-image', command: 'sha256sum manifest.json', observedAt: now },
    cleanliness: {
      before: { agentCount: 0, observedAt: now },
      after: { absentById: true, observedAt: now },
    },
    artifactInstall: {
      kind: 'packed',
      installed: true,
      checkout: false,
      symlink: false,
      sha256: artifactSha,
    },
  }));
  const attempts = FLEET_QUALIFICATION_OPERATIONS.flatMap((operation) =>
    [1, 2].map((attempt) => ({
      operation,
      attempt,
      nodeResourceId: nodes[attempt - 1].resourceId,
      startedAt: now,
      finishedAt: now,
      exitCode: 0,
      outcome: 'pass',
      targetHostPid: 1000 + attempt,
      processEvidence: {
        pid: 1000 + attempt,
        comm: 'agent-relay',
        nodeResourceId: nodes[attempt - 1].resourceId,
        source: 'target-host',
        observedAt: now,
      },
      requestedRelayfileCloudDeploymentId: ' CANDIDATE-0905\t',
      observedRelayfileCloudDeploymentId: 'candidate-0905',
      relayfileCloudAttestationSha256: digest.toUpperCase(),
      observedDaytonaSnapshotId: nodes[attempt - 1].observedDaytonaSnapshotId,
      inImageManifestSha256: digest,
    }))
  );
  const refusal = attempts.find((attempt) => attempt.operation === 'fleet spawn' && attempt.attempt === 1)!;
  Object.assign(refusal, {
    outcome: 'expected_refusal',
    exitCode: 1,
    expectedError: 'Error: target node does not advertise spawn:claude',
    observedError: 'Error: target node does not advertise spawn:claude',
  });
  return {
    schemaVersion: 'relay-fleet-qualification/1',
    candidateArtifact: { kind: 'packed', sha256: artifactSha },
    candidateManifest,
    matrixOperations: [...FLEET_QUALIFICATION_OPERATIONS],
    nodes,
    attempts,
    coverage: {
      targetedDispatch: { passed: true, attemptRefs: ['fleet spawn#2'] },
      messagingInjection: { passed: true, attemptRefs: ['message dm send#1'] },
      attachDrive: { passed: true, attemptRefs: ['node agent attach#1'] },
      release: { passed: true, attemptRefs: ['fleet release#1'] },
      restart: { passed: true, attemptRefs: ['node up#2'] },
      failureSemantics: { passed: true, attemptRefs: ['fleet spawn#1'] },
    },
  };
}

describe('fleet qualification interface normalization', () => {
  it('normalizes both deployment-id sides with the agreed ASCII-only rule', () => {
    expect(normalizeDeploymentId('\t DEPLOY-A \r')).toBe('deploy-a');
    expect(() => normalizeDeploymentId('deploy\u0000-a')).toThrow(/NOT_PASS/);
    expect(normalizeSnapshotId('\tSnap-A ')).toBe('Snap-A');
    expect(normalizeSha256(` ${'A'.repeat(64)}\n`, 'digest')).toBe('a'.repeat(64));
    expect(() => normalizeSha256(`sha256:${'a'.repeat(64)}`, 'digest')).toThrow(/bare 64-character/);
  });

  it('canonicalizes object keys, preserves arrays, and hashes exact UTF-8 bytes without a newline', () => {
    const manifest = {
      z: [3, { b: true, a: false }],
      relayfileCloudDeploymentId: ' DEPLOY-A ',
      a: null,
    };
    const canonical = canonicalizeCandidateManifest(manifest);
    expect(canonical).toBe('{"a":null,"relayfileCloudDeploymentId":"deploy-a","z":[3,{"a":false,"b":true}]}');
    expect(canonical.endsWith('\n')).toBe(false);
    expect(candidateManifestSha256(manifest)).toBe(
      createHash('sha256').update(canonical, 'utf8').digest('hex')
    );
    expect(canonicalizeJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});

describe('fleet qualification source enumeration', () => {
  it('is exactly the public CLI inventory minus the 30-command Cloud subtree', () => {
    const source = readFileSync('packages/cli/src/cli/bootstrap.test.ts', 'utf8');
    const arrayBody = source.match(/const expectedLeafCommands = \[([\s\S]*?)\n\];/)?.[1];
    expect(arrayBody).toBeTruthy();
    const publicLeaves = [...arrayBody!.matchAll(/^\s*'([^']+)',/gm)].map((match) => match[1]);
    const observerListIndex = publicLeaves.indexOf('observer list');
    expect(observerListIndex).toBeGreaterThanOrEqual(0);
    const publicOperations = publicLeaves.toSpliced(observerListIndex, 0, 'observer');
    const cloudOperations = publicOperations.filter((operation) => operation.startsWith('cloud '));
    const nonCloudOperations = publicOperations.filter((operation) => !operation.startsWith('cloud '));

    expect(publicOperations).toHaveLength(125);
    expect(cloudOperations).toHaveLength(30);
    expect(nonCloudOperations).toEqual(FLEET_QUALIFICATION_OPERATIONS);
  });
});

describe('fleet qualification deterministic acceptance', () => {
  it('accepts exactly 95 operations with two cross-node attempts and complete proof', () => {
    expect(validateQualificationEvidence(validEvidence(), FLEET_QUALIFICATION_OPERATIONS)).toMatchObject({
      verdict: 'PASS',
      operationCount: 95,
      attemptCount: 190,
      nodeResourceIds: ['sandbox-a', 'sandbox-b'],
    });
  });

  it('rejects asymmetric requested/observed normalization tricks', () => {
    const evidence = validEvidence();
    evidence.attempts[0].observedRelayfileCloudDeploymentId = 'candidate-0905 ';
    evidence.attempts[0].requestedRelayfileCloudDeploymentId = 'candidate-0905\u00a0';
    expect(() => validateQualificationEvidence(evidence, FLEET_QUALIFICATION_OPERATIONS)).toThrow(
      /requested\/observed\/manifest deployment IDs differ/
    );
  });

  it('rejects configured snapshot identity when observed identity is absent', () => {
    const evidence = validEvidence() as any;
    evidence.attempts[0].configuredDaytonaSnapshotId = 'Snapshot-1';
    delete evidence.attempts[0].observedDaytonaSnapshotId;
    expect(() => validateQualificationEvidence(evidence, FLEET_QUALIFICATION_OPERATIONS)).toThrow(
      /observedDaytonaSnapshotId must be a JSON string/
    );
  });

  it('rejects a provision-time snapshot value without running-node readback provenance', () => {
    const evidence = validEvidence() as any;
    evidence.nodes[0].configuredDaytonaSnapshotId = evidence.nodes[0].observedDaytonaSnapshotId;
    delete evidence.nodes[0].snapshotObservation;
    expect(() => validateQualificationEvidence(evidence, FLEET_QUALIFICATION_OPERATIONS)).toThrow(
      /snapshot identity was not read back from the running node/
    );
  });

  it('rejects spawned true and a roster row when no real target-host PID is present', () => {
    const evidence = validEvidence() as any;
    evidence.attempts[0].spawned = true;
    evidence.attempts[0].roster = { live: true };
    delete evidence.attempts[0].targetHostPid;
    expect(() => validateQualificationEvidence(evidence, FLEET_QUALIFICATION_OPERATIONS)).toThrow(
      /lacks a real positive target-host PID/
    );
  });

  it('rejects manifest digest or deployment-id mismatches without allowing retry', () => {
    const evidence = validEvidence();
    evidence.attempts[0].inImageManifestSha256 = 'f'.repeat(64);
    try {
      validateQualificationEvidence(evidence, FLEET_QUALIFICATION_OPERATIONS);
      throw new Error('expected validation to reject');
    } catch (error: any) {
      expect(error.message).toMatch(/^NOT_PASS:/);
      expect(error.retryAllowed).toBe(false);
    }
  });

  it('rejects a node installed from anything other than the pinned packed artifact', () => {
    const evidence = validEvidence();
    evidence.nodes[0].artifactInstall.sha256 = 'c'.repeat(64);
    expect(() => validateQualificationEvidence(evidence, FLEET_QUALIFICATION_OPERATIONS)).toThrow(
      /installed artifact digest differs from the pinned candidate artifact/
    );
  });

  it('rejects incomplete operations and same-node duplicate attempts', () => {
    const incomplete = validEvidence();
    incomplete.attempts.pop();
    expect(() => validateQualificationEvidence(incomplete, FLEET_QUALIFICATION_OPERATIONS)).toThrow(
      /expected 190 attempts, found 189/
    );

    const duplicate = validEvidence();
    duplicate.attempts[1].nodeResourceId = duplicate.attempts[0].nodeResourceId;
    duplicate.attempts[1].processEvidence.nodeResourceId = duplicate.attempts[0].nodeResourceId;
    duplicate.attempts[1].observedDaytonaSnapshotId = duplicate.attempts[0].observedDaytonaSnapshotId;
    expect(() => validateQualificationEvidence(duplicate, FLEET_QUALIFICATION_OPERATIONS)).toThrow(
      /attempts must run on two distinct Daytona resource IDs/
    );
  });

  it('rejects reused resources and cleanup that was not proved absent by exact id', () => {
    const reused = validEvidence();
    reused.nodes[1].resourceId = reused.nodes[0].resourceId;
    expect(() => validateQualificationEvidence(reused, FLEET_QUALIFICATION_OPERATIONS)).toThrow(
      /Daytona resource IDs must be distinct/
    );

    const leaked = validEvidence();
    leaked.nodes[0].cleanliness.after.absentById = false;
    expect(() => validateQualificationEvidence(leaked, FLEET_QUALIFICATION_OPERATIONS)).toThrow(
      /teardown did not prove resource sandbox-a absent by id/
    );

    const premature = validEvidence();
    premature.nodes[0].cleanliness.after.observedAt = '2026-09-05T08:59:59.000Z';
    expect(() => validateQualificationEvidence(premature, FLEET_QUALIFICATION_OPERATIONS)).toThrow(
      /teardown absence was not observed after its final attempt/
    );
  });

  it('counts an exact non-zero refusal as an operation and rejects changed error text', () => {
    const valid = validEvidence();
    expect(() => validateQualificationEvidence(valid, FLEET_QUALIFICATION_OPERATIONS)).not.toThrow();

    const refusal = valid.attempts.find(
      (attempt) => attempt.operation === 'fleet spawn' && attempt.attempt === 1
    )!;
    refusal.observedError = 'different';
    expect(() => validateQualificationEvidence(valid, FLEET_QUALIFICATION_OPERATIONS)).toThrow(
      /refusal error differs from the exact expected error/
    );
  });

  it('rejects happy-path-only evidence with no exact failure-semantics operation', () => {
    const evidence = validEvidence();
    const refusal = evidence.attempts.find(
      (attempt) => attempt.operation === 'fleet spawn' && attempt.attempt === 1
    )!;
    Object.assign(refusal, { outcome: 'pass', exitCode: 0 });
    expect(() => validateQualificationEvidence(evidence, FLEET_QUALIFICATION_OPERATIONS)).toThrow(
      /failureSemantics must cite an exact expected-refusal attempt/
    );
  });
});
