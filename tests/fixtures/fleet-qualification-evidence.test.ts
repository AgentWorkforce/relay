import { createHash } from 'node:crypto';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { createProgram } from '../../packages/cli/src/cli/bootstrap.js';

import {
  candidateManifestSha256,
  canonicalizeCandidateManifest,
  canonicalizeJson,
  commandArgvSha256,
  normalizeDeploymentId,
  normalizeSha256,
  normalizeSnapshotId,
  validateQualificationEvidence,
} from '../../scripts/fleet-qualification/evidence.mjs';
import { FLEET_QUALIFICATION_OPERATIONS } from '../../scripts/fleet-qualification/matrix.mjs';

const times = {
  created: '2026-09-05T09:00:00.000Z',
  provisioned: '2026-09-05T09:00:01.000Z',
  snapshot: '2026-09-05T09:00:02.000Z',
  artifact: '2026-09-05T09:00:03.000Z',
  manifest: '2026-09-05T09:00:04.000Z',
  cleanBefore: '2026-09-05T09:00:05.000Z',
  attemptStart: '2026-09-05T09:00:06.000Z',
  attemptObserved: '2026-09-05T09:00:07.000Z',
  attemptFinish: '2026-09-05T09:00:08.000Z',
  cleanAfter: '2026-09-05T09:00:09.000Z',
};
const relayCommitSha = '1'.repeat(40);

function validate(evidence: ReturnType<typeof validEvidence>) {
  return validateQualificationEvidence(evidence, FLEET_QUALIFICATION_OPERATIONS, {
    expectedRelayCommitSha: relayCommitSha,
    expectedCandidateArtifactSha256: evidence.candidateArtifact.sha256,
    expectedCandidateManifestSha256: candidateManifestSha256(evidence.candidateManifest),
  });
}

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
    createdAt: times.created,
    observedDaytonaSnapshotId: `Snapshot-${index + 1}`,
    inImageManifestSha256: digest,
    provisionObservation: {
      source: 'daytona-control-plane',
      command: `daytona create --name qualification-${index + 1}`,
      exitCode: 0,
      stdoutResourceId: resourceId,
      observedAt: times.provisioned,
    },
    snapshotObservation: {
      source: 'running-node',
      command: 'read-snapshot-id',
      exitCode: 0,
      stdout: `Snapshot-${index + 1}`,
      observedAt: times.snapshot,
    },
    manifestObservation: {
      source: 'in-image',
      command: 'sha256sum manifest.json',
      exitCode: 0,
      stdout: digest,
      observedAt: times.manifest,
    },
    cleanliness: {
      before: {
        agentCount: 0,
        observedAgentIds: [],
        source: 'target-host',
        command: 'agent-relay node agent list --json',
        exitCode: 0,
        observedAt: times.cleanBefore,
      },
      after: {
        absentById: true,
        source: 'daytona-control-plane',
        queriedResourceId: resourceId,
        command: `daytona info ${resourceId} -f json`,
        status: 'not_found',
        exitCode: 1,
        observedError: `sandbox ${resourceId} not found`,
        observedAt: times.cleanAfter,
      },
    },
    artifactInstall: {
      kind: 'packed',
      installed: true,
      checkout: false,
      symlink: false,
      sha256: artifactSha,
      source: 'target-host',
      command: 'sha256sum agent-relay.tgz',
      exitCode: 0,
      stdout: artifactSha,
      observedAt: times.artifact,
    },
  }));
  const attempts = FLEET_QUALIFICATION_OPERATIONS.flatMap((operation) =>
    [1, 2].map((attempt) => {
      const argv = ['agent-relay', ...operation.split(' '), '--qualification-fixture'];
      return {
        operation,
        attempt,
        nodeResourceId: nodes[attempt - 1].resourceId,
        startedAt: times.attemptStart,
        finishedAt: times.attemptFinish,
        exitCode: 0,
        outcome: 'pass',
        targetHostPid: 1000 + attempt,
        processEvidence: {
          pid: 1000 + attempt,
          comm: 'agent-relay',
          nodeResourceId: nodes[attempt - 1].resourceId,
          source: 'target-host',
          probeCommand: `ps -p ${1000 + attempt} -o pid=,comm=`,
          probeExitCode: 0,
          argvSha256: commandArgvSha256(argv),
          observedAt: times.attemptObserved,
        },
        executionEvidence: {
          source: 'target-host',
          argv,
          argvSha256: commandArgvSha256(argv),
          exitCode: 0,
          stdoutSha256: createHash('sha256').update('', 'utf8').digest('hex'),
          stderrSha256: createHash('sha256').update('', 'utf8').digest('hex'),
          observedAt: times.attemptObserved,
        },
        requestedRelayfileCloudDeploymentId: ' CANDIDATE-0905\t',
        observedRelayfileCloudDeploymentId: 'candidate-0905',
        relayfileCloudAttestationSha256: digest.toUpperCase(),
        observedDaytonaSnapshotId: nodes[attempt - 1].observedDaytonaSnapshotId,
        inImageManifestSha256: digest,
      };
    })
  );
  const refusal = attempts.find((attempt) => attempt.operation === 'fleet spawn' && attempt.attempt === 1)!;
  Object.assign(refusal, {
    outcome: 'expected_refusal',
    exitCode: 1,
    expectedError: 'Error: target node does not advertise spawn:claude',
    observedError: 'Error: target node does not advertise spawn:claude',
  });
  refusal.executionEvidence.exitCode = 1;
  refusal.executionEvidence.stderrSha256 = createHash('sha256')
    .update(refusal.observedError, 'utf8')
    .digest('hex');
  return {
    schemaVersion: 'relay-fleet-qualification/1',
    relayCommitSha,
    collector: { kind: 'committed-relayflow', machineGenerated: true },
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
    const isHidden = (command: Command) => (command as unknown as { _hidden?: boolean })._hidden === true;
    const publicLeaves: string[] = [];
    const visit = (command: Command, parents: string[]) => {
      for (const child of command.commands) {
        if (isHidden(child)) continue;
        const path = [...parents, child.name()];
        if (child.commands.length === 0) publicLeaves.push(path.join(' '));
        else visit(child, path);
      }
    };
    const program = createProgram();
    visit(program, []);
    const observerListIndex = publicLeaves.indexOf('observer list');
    expect(observerListIndex).toBeGreaterThanOrEqual(0);
    const publicOperations = publicLeaves.toSpliced(observerListIndex, 0, 'observer');
    const cloudOperations = publicOperations.filter((operation) => operation.startsWith('cloud '));
    const nonCloudOperations = publicOperations.filter((operation) => !operation.startsWith('cloud '));

    expect(publicOperations).toHaveLength(125);
    expect(cloudOperations).toHaveLength(30);
    expect([...nonCloudOperations].sort()).toEqual([...FLEET_QUALIFICATION_OPERATIONS].sort());
  });
});

describe('fleet qualification deterministic acceptance', () => {
  it('accepts exactly 95 operations with two cross-node attempts and complete proof', () => {
    expect(validate(validEvidence())).toMatchObject({
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
    expect(() => validate(evidence)).toThrow(/requested\/observed\/manifest deployment IDs differ/);
  });

  it('rejects configured snapshot identity when observed identity is absent', () => {
    const evidence = validEvidence() as any;
    evidence.attempts[0].configuredDaytonaSnapshotId = 'Snapshot-1';
    delete evidence.attempts[0].observedDaytonaSnapshotId;
    expect(() => validate(evidence)).toThrow(/observedDaytonaSnapshotId must be a JSON string/);
  });

  it('rejects a provision-time snapshot value without running-node readback provenance', () => {
    const evidence = validEvidence() as any;
    evidence.nodes[0].configuredDaytonaSnapshotId = evidence.nodes[0].observedDaytonaSnapshotId;
    delete evidence.nodes[0].snapshotObservation;
    expect(() => validate(evidence)).toThrow(/snapshotObservation.source must be running-node/);
  });

  it('rejects spawned true and a roster row when no real target-host PID is present', () => {
    const evidence = validEvidence() as any;
    evidence.attempts[0].spawned = true;
    evidence.attempts[0].roster = { live: true };
    delete evidence.attempts[0].targetHostPid;
    expect(() => validate(evidence)).toThrow(/lacks a real positive target-host PID/);
  });

  it('rejects manifest digest or deployment-id mismatches without allowing retry', () => {
    const evidence = validEvidence();
    evidence.attempts[0].inImageManifestSha256 = 'f'.repeat(64);
    try {
      validate(evidence);
      throw new Error('expected validation to reject');
    } catch (error: any) {
      expect(error.message).toMatch(/^NOT_PASS:/);
      expect(error.retryAllowed).toBe(false);
    }
  });

  it('rejects a node installed from anything other than the pinned packed artifact', () => {
    const evidence = validEvidence();
    evidence.nodes[0].artifactInstall.sha256 = 'c'.repeat(64);
    expect(() => validate(evidence)).toThrow(
      /installed artifact digest differs from the pinned candidate artifact/
    );
  });

  it('rejects incomplete operations and same-node duplicate attempts', () => {
    const incomplete = validEvidence();
    incomplete.attempts.pop();
    expect(() => validate(incomplete)).toThrow(/expected 190 attempts, found 189/);

    const duplicate = validEvidence();
    duplicate.attempts[1].nodeResourceId = duplicate.attempts[0].nodeResourceId;
    duplicate.attempts[1].processEvidence.nodeResourceId = duplicate.attempts[0].nodeResourceId;
    duplicate.attempts[1].observedDaytonaSnapshotId = duplicate.attempts[0].observedDaytonaSnapshotId;
    expect(() => validate(duplicate)).toThrow(/attempts must run on two distinct Daytona resource IDs/);

    const paddedDuplicate = validEvidence();
    paddedDuplicate.attempts[1].nodeResourceId = ` ${paddedDuplicate.attempts[0].nodeResourceId}`;
    paddedDuplicate.attempts[1].processEvidence.nodeResourceId = paddedDuplicate.attempts[0].nodeResourceId;
    paddedDuplicate.attempts[1].observedDaytonaSnapshotId =
      paddedDuplicate.attempts[0].observedDaytonaSnapshotId;
    expect(() => validate(paddedDuplicate)).toThrow(/two distinct Daytona resource IDs/);
  });

  it('rejects reused resources and cleanup that was not proved absent by exact id', () => {
    const reused = validEvidence();
    reused.nodes[1].resourceId = reused.nodes[0].resourceId;
    reused.nodes[1].provisionObservation.stdoutResourceId = reused.nodes[0].resourceId;
    reused.nodes[1].cleanliness.after.queriedResourceId = reused.nodes[0].resourceId;
    reused.nodes[1].cleanliness.after.observedError = `sandbox ${reused.nodes[0].resourceId} not found`;
    expect(() => validate(reused)).toThrow(/Daytona resource IDs must be distinct/);

    const leaked = validEvidence();
    leaked.nodes[0].cleanliness.after.absentById = false;
    expect(() => validate(leaked)).toThrow(/teardown did not prove resource sandbox-a absent by id/);

    const premature = validEvidence();
    premature.nodes[0].cleanliness.after.observedAt = '2026-09-05T08:59:59.000Z';
    expect(() => validate(premature)).toThrow(/teardown absence was not observed after its final attempt/);

    const ghost = validEvidence();
    ghost.nodes.push({
      ...structuredClone(ghost.nodes[1]),
      resourceId: 'sandbox-ghost',
      name: 'qualification-ghost',
      provisionObservation: {
        ...ghost.nodes[1].provisionObservation,
        stdoutResourceId: 'sandbox-ghost',
      },
      cleanliness: {
        ...structuredClone(ghost.nodes[1].cleanliness),
        after: {
          ...ghost.nodes[1].cleanliness.after,
          queriedResourceId: 'sandbox-ghost',
          observedError: 'sandbox sandbox-ghost not found',
        },
      },
    });
    expect(() => validate(ghost)).toThrow(/resource sandbox-ghost has no matrix attempts/);
  });

  it('counts an exact non-zero refusal as an operation and rejects changed error text', () => {
    const valid = validEvidence();
    expect(() => validate(valid)).not.toThrow();

    const refusal = valid.attempts.find(
      (attempt) => attempt.operation === 'fleet spawn' && attempt.attempt === 1
    )!;
    refusal.observedError = 'different';
    expect(() => validate(valid)).toThrow(/refusal error differs from the exact expected error/);
  });

  it('rejects happy-path-only evidence with no exact failure-semantics operation', () => {
    const evidence = validEvidence();
    const refusal = evidence.attempts.find(
      (attempt) => attempt.operation === 'fleet spawn' && attempt.attempt === 1
    )!;
    Object.assign(refusal, { outcome: 'pass', exitCode: 0 });
    refusal.executionEvidence.exitCode = 0;
    refusal.executionEvidence.stderrSha256 = createHash('sha256').update('', 'utf8').digest('hex');
    expect(() => validate(evidence)).toThrow(/failureSemantics must cite an exact expected-refusal attempt/);
  });

  it('rejects a wrong exact head and non-canonical timestamps', () => {
    const wrongHead = validEvidence();
    expect(() =>
      validateQualificationEvidence(wrongHead, FLEET_QUALIFICATION_OPERATIONS, {
        expectedRelayCommitSha: '2'.repeat(40),
        expectedCandidateArtifactSha256: wrongHead.candidateArtifact.sha256,
        expectedCandidateManifestSha256: candidateManifestSha256(wrongHead.candidateManifest),
      })
    ).toThrow(/does not equal the exact head/);

    const looseTime = validEvidence();
    looseTime.attempts[0].startedAt = '2026-09-05 09:00:00Z';
    expect(() => validate(looseTime)).toThrow(/canonical ISO-8601 UTC timestamp/);

    const zeroDuration = validEvidence();
    zeroDuration.attempts[0].finishedAt = zeroDuration.attempts[0].startedAt;
    zeroDuration.attempts[0].processEvidence.observedAt = zeroDuration.attempts[0].startedAt;
    zeroDuration.attempts[0].executionEvidence.observedAt = zeroDuration.attempts[0].startedAt;
    expect(() => validate(zeroDuration)).toThrow(/must finish after it starts/);
  });

  it('rejects evidence for a different manifest or packed artifact than the Relayflow inputs', () => {
    const evidence = validEvidence();
    expect(() =>
      validateQualificationEvidence(evidence, FLEET_QUALIFICATION_OPERATIONS, {
        expectedRelayCommitSha: relayCommitSha,
        expectedCandidateArtifactSha256: 'f'.repeat(64),
        expectedCandidateManifestSha256: candidateManifestSha256(evidence.candidateManifest),
      })
    ).toThrow(/packed artifact supplied to the Relayflow/);

    expect(() =>
      validateQualificationEvidence(evidence, FLEET_QUALIFICATION_OPERATIONS, {
        expectedRelayCommitSha: relayCommitSha,
        expectedCandidateArtifactSha256: evidence.candidateArtifact.sha256,
        expectedCandidateManifestSha256: 'f'.repeat(64),
      })
    ).toThrow(/manifest file supplied to the Relayflow/);
  });

  it('rejects asserted operation success not bound to target-host argv', () => {
    const evidence = validEvidence();
    const attempt = evidence.attempts[0];
    attempt.executionEvidence.argv = ['agent-relay', 'status'];
    attempt.executionEvidence.argvSha256 = commandArgvSha256(attempt.executionEvidence.argv);
    expect(() => validate(evidence)).toThrow(/does not invoke the enumerated operation/);
  });

  it('rejects snapshot, manifest, artifact, and teardown assertions without matching command output', () => {
    const snapshot = validEvidence();
    snapshot.nodes[0].snapshotObservation.stdout = 'Configured-Snapshot';
    expect(() => validate(snapshot)).toThrow(/snapshot output differs/);

    const manifest = validEvidence();
    manifest.nodes[0].manifestObservation.stdout = 'f'.repeat(64);
    expect(() => validate(manifest)).toThrow(/manifest output differs/);

    const artifact = validEvidence();
    artifact.nodes[0].artifactInstall.stdout = 'f'.repeat(64);
    expect(() => validate(artifact)).toThrow(/artifact digest output differs/);

    const teardown = validEvidence();
    teardown.nodes[0].cleanliness.after.queriedResourceId = 'sandbox-b';
    expect(() => validate(teardown)).toThrow(/not bound to an exact Daytona resource-id query/);
  });

  it('rejects non-failure coverage that cites only a refusal', () => {
    const evidence = validEvidence();
    evidence.coverage.targetedDispatch.attemptRefs = ['fleet spawn#1'];
    expect(() => validate(evidence)).toThrow(/must cite a successful operation attempt/);
  });
});
