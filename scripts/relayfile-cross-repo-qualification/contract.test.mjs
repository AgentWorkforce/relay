import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTUAL_CPU_LIMIT_MS,
  COLD_MOUNT_FILE_COUNT,
  COLD_MOUNT_MANIFEST_SHA256,
  COLD_MOUNT_TOTAL_BYTES,
  MOUNT_CPU_LIMIT_MS,
  MOUNT_COUNT,
  MOUNT_PEAK_RSS_LIMIT_BYTES,
  MOUNT_WALL_LIMIT_MS,
  SUITE_CPU_LIMIT_MS,
  SUITE_PEAK_RSS_LIMIT_BYTES,
  SUITE_WALL_LIMIT_MS,
  aggregateVerdict,
  buildSandboxName,
  toVitestEvidenceSummary,
  validateAclEvidence,
  validateArmReport,
  validateColdMountEvidence,
  validateCheckpointSeries,
} from './contract.mjs';

test('persisted vitest evidence excludes raw secret-bearing output', () => {
  const result = toVitestEvidenceSummary({
    exitCode: 0,
    testsPassed: 7,
    testsFailed: 0,
    output: 'RELAY_API_TOKEN=must-not-enter-evidence',
    stdout: 'secret stdout',
    stderr: 'secret stderr',
  });
  assert.deepEqual(result, { exitCode: 0, testsPassed: 7, testsFailed: 0 });
  assert.doesNotMatch(JSON.stringify(result), /must-not-enter-evidence|secret stdout|secret stderr/);
});

function resource({ suite = false } = {}) {
  return {
    wallLimitMs: suite ? SUITE_WALL_LIMIT_MS : MOUNT_WALL_LIMIT_MS,
    cpuLimitMs: suite ? SUITE_CPU_LIMIT_MS : MOUNT_CPU_LIMIT_MS,
    peakRssLimitBytes: suite ? SUITE_PEAK_RSS_LIMIT_BYTES : MOUNT_PEAK_RSS_LIMIT_BYTES,
    wallMs: 1,
    cpuMs: Math.min(1, ACTUAL_CPU_LIMIT_MS),
    peakRssBytes: 1,
  };
}

function snapshot(mounts) {
  return {
    total: 31 * mounts,
    bulkRead: 28 * mounts,
    pointRead: 0,
    status429: 0,
    status5xx: 0,
    resets: 0,
    malformed: 0,
    unsupported: 0,
    requestBytes: 0,
    responseBytes: 0,
    maxBulkRequestBytes: 1,
    maxBulkResponseBytes: 1,
  };
}

function coldEvidence() {
  const faultKinds = ['429', '503', 'reset', 'malformed', 'unsupported'];
  const faults = Object.fromEntries(
    faultKinds.map((kind) => [
      kind,
      kind === 'malformed'
        ? {
            outcome: 'expected-failure',
            hashesVerified: false,
            requests: { ...snapshot(1), total: 2, bulkRead: 1, faultsInjected: 1, malformed: 1 },
          }
        : {
            outcome: 'success',
            exitCode: 0,
            hashesVerified: true,
            requests: {
              ...snapshot(1),
              ...(kind === 'unsupported' ? { total: 855, status5xx: 1 } : { total: 32 }),
              bulkRead: kind === 'unsupported' ? 1 : 29,
              pointRead: kind === 'unsupported' ? COLD_MOUNT_FILE_COUNT : 0,
              faultsInjected: 1,
              ...(kind === 'unsupported' ? { unsupported: 1 } : {}),
              ...(kind === '429' ? { status429: 1 } : {}),
              ...(kind === '503' ? { status5xx: 1 } : {}),
              ...(kind === 'reset' ? { resets: 1 } : {}),
            },
            resource: resource(),
          },
    ])
  );
  return {
    mode: 'candidate',
    artifacts: { mount: 'mount.tgz', cloud: 'cloud.tgz' },
    fixture: {
      files: COLD_MOUNT_FILE_COUNT,
      directories: 454,
      bytes: COLD_MOUNT_TOTAL_BYTES,
      manifestSha256: COLD_MOUNT_MANIFEST_SHA256,
    },
    standard: {
      initial: snapshot(1),
      concurrent: snapshot(2),
      resources: Array.from({ length: MOUNT_COUNT }, () => resource()),
      hashesVerified: [true, true, true],
      amplificationDetected: false,
    },
    faults,
    suite: resource({ suite: true }),
    cleanupVerified: true,
  };
}

function aclEvidence() {
  const reasons = Object.fromEntries(
    ['inflight_limit', 'oldest_inflight_age', 'durable_object_overloaded', 'router_inflight_limit'].map(
      (reason) => [reason, { get: true, put: true }]
    )
  );
  return {
    suites: [
      {
        repo: 'cloud',
        exitCode: 0,
        testsPassed: 10,
        testsFailed: 0,
        fiveReasonEnumerationPresent: true,
        reasons,
        writeAdmissionPutBoundary: true,
        writeAdmissionSustainedDeadlineFailClosed: true,
        unknownReasonTerminal: true,
        absentReasonTerminal: true,
      },
      {
        repo: 'relayfile-cloud',
        exitCode: 0,
        testsPassed: 10,
        testsFailed: 0,
        workerdRuntime: {
          exitCode: 0,
          testsPassed: 1,
          testsFailed: 0,
          miniflareObserved: true,
          workspaceDoCaseObserved: true,
        },
        surfaceTokens: {
          isAclMarkerPath: true,
          resolveAclControlAdmissionSignal: true,
          applyAclControlAdmissionSignal: true,
          'foreground lane for ACL control ops': true,
        },
        parentWorkerAclUnit: {
          command: 'npm exec --workspace packages/relayfile -- vitest run test/acl-control-admission.test.ts',
          exitCode: 0,
          testsPassed: 10,
          testsFailed: 0,
        },
        workspaceAclProvisioningAdmission: {
          command:
            'RELAY_PR_PROOF_ARM=head node tests/relayflows/cases/workspace-acl-provisioning-admission/run.mjs',
          resultPath: '/tmp/workspace-acl-provisioning-admission.json',
          resultSource: 'RELAY_PR_PROOF_RESULT_PATH',
          exitCode: 0,
          caseId: 'workspace-acl-provisioning-admission',
          arm: 'head',
          outcome: 'fixed',
          signature: 'acl_control_lane_and_rejected_request_retention',
        },
      },
    ],
  };
}

function armReport(arm) {
  const name = buildSandboxName({ arm, now: new Date('2026-09-09T10:20:30.000Z'), pid: 42 });
  return {
    version: 1,
    arm,
    status: 'COMPLETE',
    runId: 'qualification-test-run',
    artifactHashes: { cloud: 'b'.repeat(64), relayfile: 'a'.repeat(64), 'relayfile-cloud': 'c'.repeat(64) },
    artifacts: {
      cloud: { archive: 'cloud.tgz', sha256: 'b'.repeat(64) },
      relayfile: { archive: 'relayfile.tgz', sha256: 'a'.repeat(64) },
      'relayfile-cloud': { archive: 'relayfile-cloud.tgz', sha256: 'c'.repeat(64) },
    },
    candidateProvenance: {
      cloud: {
        name: 'cloud',
        repo: '../cloud',
        head: '1'.repeat(40),
        clean: true,
        archive: 'cloud.tgz',
        sha256: 'b'.repeat(64),
      },
      relayfile: {
        name: 'relayfile',
        repo: '../relayfile',
        head: '2'.repeat(40),
        clean: true,
        archive: 'relayfile.tgz',
        sha256: 'a'.repeat(64),
      },
      'relayfile-cloud': {
        name: 'relayfile-cloud',
        repo: '../relayfile-cloud',
        head: '3'.repeat(40),
        clean: true,
        archive: 'relayfile-cloud.tgz',
        sha256: 'c'.repeat(64),
      },
    },
    publishedRelayfile: {
      package: 'relayfile',
      version: '0.10.57-qualification.1',
      tarballSha256: 'd'.repeat(64),
      sourceSha: '4'.repeat(40),
      installed: true,
    },
    sandbox: { id: `sandbox-${arm}`, name, fresh: true },
    legs: {
      coldMount: coldEvidence(),
      acl: aclEvidence(),
      issue490: {
        issue: 490,
        delayedWebSocket429: true,
        pollingUpdateApplied: true,
        cursorPersisted: true,
        daemonRealtimePreserved: true,
        cli: { exitCode: 0, testsPassed: 2, testsFailed: 0, realtimeDialCount: 0, pollingUpdateApplied: true, cursorPersisted: true },
        standalone: { exitCode: 0, testsPassed: 2, testsFailed: 0, realtimeDialCount: 0, pollingUpdateApplied: true, cursorPersisted: true },
      },
    },
    cleanup: {
      attempted: true,
      createAttempted: true,
      sandboxAbsent: true,
      inventoryAbsent: true,
      scratchAbsent: true,
      contextAbsent: true,
    },
    checkpoints: [
      `DAYTONA_CHECKPOINT run_id=qualification-test-run name=${name} cloud_sha256=${'b'.repeat(64)} relayfile_sha256=${'a'.repeat(64)} relayfile_cloud_sha256=${'c'.repeat(64)}`,
      `DAYTONA_CHECKPOINT run_id=qualification-test-run id=sandbox-${arm} name=${name} cloud_sha256=${'b'.repeat(64)} relayfile_sha256=${'a'.repeat(64)} relayfile_cloud_sha256=${'c'.repeat(64)}`,
      `DAYTONA_CLEANUP run_id=qualification-test-run verified_absent=true id=sandbox-${arm} name=${name} cloud_sha256=${'b'.repeat(64)} relayfile_sha256=${'a'.repeat(64)} relayfile_cloud_sha256=${'c'.repeat(64)}`,
      `DAYTONA_LOCAL_CLEANUP run_id=qualification-test-run verified_absent=true cloud_sha256=${'b'.repeat(64)} relayfile_sha256=${'a'.repeat(64)} relayfile_cloud_sha256=${'c'.repeat(64)}`,
      `DAYTONA_CONTEXT_CLEANUP run_id=qualification-test-run verified_absent=true path=/tmp/context cloud_sha256=${'b'.repeat(64)} relayfile_sha256=${'a'.repeat(64)} relayfile_cloud_sha256=${'c'.repeat(64)}`,
    ],
  };
}

test('accepts the canonical cold-mount and ACL evidence shape', () => {
  assert.equal(validateColdMountEvidence(coldEvidence()).ok, true);
  assert.equal(validateAclEvidence(aclEvidence()).ok, true);
  assert.equal(validateArmReport(armReport('A')).ok, true);
});

test('fails closed when issue 490 or published npm attestation proof is incomplete', () => {
  const report = armReport('A');
  report.legs.issue490.cli.realtimeDialCount = 1;
  assert.equal(validateArmReport(report).ok, false);
  const unpinned = armReport('A');
  unpinned.publishedRelayfile.version = '0.10.57';
  assert.equal(validateArmReport(unpinned).ok, false);
  const wrongSource = armReport('A');
  wrongSource.publishedRelayfile.sourceSha = 'not-a-sha';
  assert.equal(validateArmReport(wrongSource).ok, false);
});

test('requires three distinct clean candidates with full HEAD provenance and matching archives', () => {
  const report = armReport('A');
  assert.equal(validateArmReport(report).ok, true);
  report.candidateProvenance.relayfile.head = 'short';
  assert.equal(validateArmReport(report).ok, false);
  report.candidateProvenance.relayfile.head = '2'.repeat(40);
  report.candidateProvenance['relayfile-cloud'].clean = false;
  assert.equal(validateArmReport(report).ok, false);
  report.candidateProvenance['relayfile-cloud'].clean = true;
  report.candidateProvenance.cloud.sha256 = 'f'.repeat(64);
  assert.equal(validateArmReport(report).ok, false);
});

test('rejects weakened CPU evidence and unexpected legs', () => {
  const report = armReport('A');
  report.legs.coldMount.suite.cpuMs = ACTUAL_CPU_LIMIT_MS + 1;
  assert.equal(validateColdMountEvidence(report.legs.coldMount).ok, false);
  const withFakeLeg = armReport('A');
  withFakeLeg.legs.unexpectedClientLeg = {};
  assert.equal(validateArmReport(withFakeLeg).ok, false);
});

test('fails closed on incomplete arms, cleanup not attempted, and request-count drift', () => {
  const incomplete = armReport('A');
  incomplete.status = 'BLOCKED';
  assert.equal(validateArmReport(incomplete).ok, false);
  const unattempted = armReport('A');
  unattempted.cleanup.attempted = false;
  assert.equal(validateArmReport(unattempted).ok, false);
  const uncreated = armReport('A');
  uncreated.cleanup.createAttempted = false;
  assert.equal(validateArmReport(uncreated).ok, false);
  const drift = armReport('A');
  drift.legs.coldMount.standard.initial.total = 30;
  drift.legs.coldMount.faults['429'].requests.total = 31;
  assert.equal(validateArmReport(drift).ok, false);
});

test('requires the full checkpoint series and distinct arm identities', () => {
  const a = armReport('A');
  const b = armReport('B');
  assert.equal(validateCheckpointSeries(a.checkpoints).ok, true);
  assert.equal(
    aggregateVerdict({ reportA: a, reportB: b, signoffs: { claude: true, codex: true } }).verdict,
    'PASS'
  );
  b.sandbox.id = a.sandbox.id;
  assert.equal(
    aggregateVerdict({ reportA: a, reportB: b, signoffs: { claude: true, codex: true } }).verdict,
    'FAIL'
  );
});

test('fails closed on stale run, missing context cleanup, ACL runtime, or artifact hash drift', () => {
  const stale = armReport('A');
  stale.runId = 'old-run';
  stale.cleanup.contextAbsent = false;
  stale.legs.acl.suites[1].workerdRuntime.miniflareObserved = false;
  stale.artifactHashes.cloud = 'd'.repeat(64);
  stale.checkpoints[0] = stale.checkpoints[0].replace(
    'cloud_sha256=' + 'b'.repeat(64),
    'cloud_sha256=' + 'e'.repeat(64)
  );
  const result = validateArmReport(stale);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((failure) => failure.includes('contextAbsent')));
  assert.ok(result.failures.some((failure) => failure.includes('runId') || failure.includes('hash')));
});

test('fails closed when the specific Workerd WorkspaceDO case is absent', () => {
  const report = armReport('A');
  report.legs.acl.suites[1].workerdRuntime.workspaceDoCaseObserved = false;
  assert.equal(validateArmReport(report).ok, false);
});
