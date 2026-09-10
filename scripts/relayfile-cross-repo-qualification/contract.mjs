import './config.mjs';

/**
 * Relayfile cross-repo qualification contract.
 *
 * Fail-closed evaluation of the two-arm qualification:
 *   arm A and arm B each own ONE newly-created clean Daytona sandbox that runs
 *   two legs —
 *     1. cold mount: relayfile-cloud local/cold-mount-scale.ts (candidate
 *        mode) invoked with the exact contract of
 *        local/qualify-cold-mount-daytona.sh;
 *     2. ACL GET+PUT: Cloud's relay-workspace ACL backpressure suite (all
 *        five induced `workspace_busy` reasons on GET and PUT, fail-closed on
 *        unknown/absent reasons) plus relayfile-cloud's ACL admission-lane
 *        suite;
 *   — then deletes exactly its owned sandbox and proves absence.
 *
 * Every number below is pinned to the canonical benchmark
 * (relayfile-cloud local/cold-mount-scale.ts and local/cold-mount-fixture.ts).
 * Evidence produced by a weakened harness (different limits, missing fault
 * gates, missing concurrent consumers) is rejected: no skipped check ever
 * counts as a pass.
 *
 * This module is dependency-free ESM (node: builtins only) so it runs before
 * `npm install`, mirroring scripts/pr-proof/contract.mjs.
 */

/** 258 MiB, byte-exact. */
export const COLD_MOUNT_TOTAL_BYTES = 270_532_608;
export const COLD_MOUNT_FILE_COUNT = 851;
export const COLD_MOUNT_DIRECTORY_COUNT = 454;
export const COLD_MOUNT_MANIFEST_SHA256 = '905968a14268ec5e8ec38ae1d6b24749e855cac035976a87a65ef43f6612a55a';

/** ceil(851 / 32) + 1 — cold-mount-scale.ts expectedBulkReadsPerMount. */
export const EXPECTED_BULK_READS_PER_MOUNT = 28;

/** cold-mount-scale.ts mount resource limits (pinned, not configurable). */
export const MOUNT_WALL_LIMIT_MS = 600_000;
export const MOUNT_CPU_LIMIT_MS = 600_000;
export const MOUNT_PEAK_RSS_LIMIT_BYTES = 512 * 1024 * 1024;
/** Actual CPU budget for every mount and for the complete qualification suite. */
export const ACTUAL_CPU_LIMIT_MS = 120_000;

/** cold-mount-scale.ts suite limits (pinned). */
export const SUITE_WALL_LIMIT_MS = 6_000_000;
export const SUITE_CPU_LIMIT_MS = 6_000_000;
export const SUITE_PEAK_RSS_LIMIT_BYTES = 3 * 1024 * 1024 * 1024;

/** cold-mount-scale.ts network bounds (pinned). */
export const MAX_BULK_REQUEST_BYTES = 128 * 1024;
export const MAX_BULK_RESPONSE_BYTES = 64 * 1024 * 1024;
export const MAX_REQUEST_BYTES_PER_MOUNT = 16 * 1024 * 1024;
export const MAX_RESPONSE_BYTES_PER_MOUNT = COLD_MOUNT_TOTAL_BYTES * 2 + 16 * 1024 * 1024;
export const MAX_TOTAL_REQUESTS_PER_MOUNT = 64;

/** One cold mount plus two concurrent consumers. */
export const MOUNT_COUNT = 3;
export const CONCURRENT_CONSUMER_COUNT = 2;

/** cold-mount-scale.ts candidate fault gates (exact keys). */
export const FAULT_GATE_KINDS = ['429', '503', 'reset', 'malformed', 'unsupported'];

/** The five `workspace_busy` reasons relayfile-cloud emits on 429. */
export const ACL_WORKSPACE_BUSY_REASONS = [
  'write_admission_limit',
  'inflight_limit',
  'oldest_inflight_age',
  'durable_object_overloaded',
  'router_inflight_limit',
];

/** The four reasons covered by Cloud's per-reason GET and PUT it.each suites. */
export const ACL_EACH_REASONS = ACL_WORKSPACE_BUSY_REASONS.filter(
  (reason) => reason !== 'write_admission_limit'
);

/** Signature the ACL PUT uses on the reserved background write lane. */
export const ACL_WRITE_CLASS = 'background_integration';
export const ACL_PROVISIONING_CASE_ID = 'workspace-acl-provisioning-admission';
export const ACL_PROVISIONING_FIXED_SIGNATURE = 'acl_control_lane_and_rejected_request_retention';

/** relayfile-cloud ACL admission-lane suite surfaces that must be covered. */
export const ACL_ADMISSION_SURFACE_TOKENS = [
  'isAclMarkerPath',
  'resolveAclControlAdmissionSignal',
  'applyAclControlAdmissionSignal',
  'foreground lane for ACL control ops',
];

/** Environment value that authorizes sandbox creation. Anything else: no. */
export const CREATE_SANDBOXES_GATE_ENV = 'RELAYFILE_QUALIFICATION_CREATE_SANDBOXES';

/** Sandbox names embed the arm letter so distinctness is structurally visible. */
export const SANDBOX_NAME_PATTERN = /^relayfile-cross-repo-qual-\d{8}T\d{6}Z-\d+-arm-(A|B)$/;

export const ARMS = ['A', 'B'];

/** Published Relayfile prerelease must be pinned and attested before install. */
export const RELAYFILE_NPM_PACKAGE = 'relayfile';
export const RELAYFILE_NPM_VERSION_PATTERN = /^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const CANDIDATE_NAMES = ['cloud', 'relayfile', 'relayfile-cloud'];

export function buildSandboxName({ arm, now = new Date(), pid = process.pid }) {
  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  return `relayfile-cross-repo-qual-${stamp}-${pid}-arm-${arm}`;
}

/** Convert the public MiB setting to Daytona CLI's GiB unit without rounding. */
export function daytonaMemoryGiBFromMiB(raw = '4096') {
  const text = String(raw).trim();
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw new Error('RELAYFILE_DAYTONA_MEMORY_MB must be a positive integer');
  }
  const memoryMiB = Number(text);
  if (!Number.isSafeInteger(memoryMiB) || memoryMiB % 1024 !== 0) {
    throw new Error('RELAYFILE_DAYTONA_MEMORY_MB must be a safe whole number of GiB in MiB');
  }
  return String(memoryMiB / 1024);
}

/** Retry only a Daytona CLI failure that proves the command never got past its sandbox lookup. */
export function isRetryableDaytonaSandboxLookupFailure(result) {
  if (!result || result.exitCode === 0) return false;
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return (
    /Get "https:\/\/app\.daytona\.io\/api\/sandbox\/[^"?]+"/i.test(text) &&
    /(connection reset by peer|unexpected EOF|i\/o timeout|context deadline exceeded)/i.test(text)
  );
}

/** Strip credential-looking env assignments before anything is logged. */
export function redactEnvAssignments(text) {
  return String(text).replace(
    /([A-Za-z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD)[A-Za-z0-9_]*=)[^\s"']+/gi,
    '$1<redacted>'
  );
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isHex64(value) {
  return typeof value === 'string' && HEX64.test(value);
}

/** Validate immutable source provenance and its archive/hash relationship. */
export function validateCandidateProvenance(provenance, artifacts, artifactHashes) {
  const failures = [];
  const fail = (message) => failures.push(`provenance: ${message}`);
  if (!isPlainObject(provenance)) {
    return { ok: false, failures: ['provenance: candidateProvenance is missing or not an object'] };
  }
  const keys = Object.keys(provenance).sort();
  if (keys.join('\0') !== [...CANDIDATE_NAMES].sort().join('\0'))
    fail('candidate names must be exactly cloud, relayfile, and relayfile-cloud');
  const names = new Set();
  const repos = new Set();
  for (const key of CANDIDATE_NAMES) {
    const value = provenance[key];
    if (!isPlainObject(value)) {
      fail(`${key} provenance is missing or not an object`);
      continue;
    }
    if (value.name !== key) fail(`${key} provenance name is ${JSON.stringify(value.name)}`);
    if (names.has(value.name)) fail(`candidate name ${JSON.stringify(value.name)} is duplicated`);
    names.add(value.name);
    if (typeof value.repo !== 'string' || value.repo.length === 0) fail(`${key} repo is missing`);
    else {
      if (repos.has(value.repo)) fail(`candidate repo ${JSON.stringify(value.repo)} is duplicated`);
      repos.add(value.repo);
    }
    if (!HEX40.test(value.head ?? '')) fail(`${key} head is not a full 40-hex commit`);
    if (value.clean !== true) fail(`${key} clean is not true`);
    if (typeof value.archive !== 'string' || value.archive.length === 0) fail(`${key} archive is missing`);
    if (!isHex64(value.sha256)) fail(`${key} sha256 is not a 64-hex digest`);
    const artifact = artifacts?.[key];
    if (!isPlainObject(artifact)) fail(`${key} archive record is missing`);
    else {
      if (artifact.archive !== value.archive) fail(`${key} archive does not agree with provenance`);
      if (artifact.sha256 !== value.sha256) fail(`${key} archive hash does not agree with provenance`);
    }
    if (artifactHashes?.[key] !== value.sha256)
      fail(`${key} archive hash does not agree with report artifactHashes`);
  }
  if (names.size !== CANDIDATE_NAMES.length) fail('candidate names are not three distinct names');
  if (repos.size !== CANDIDATE_NAMES.length) fail('candidate repos are not three distinct paths');
  return { ok: failures.length === 0, failures };
}

/**
 * Validate one cold-mount QualificationEvidence blob exactly as the canonical
 * gate asserts it (candidate mode): fixture shape, request accounting for one
 * cold plus two concurrent consumers, resource limits with pinned limit
 * records, all five fault gates, suite bounds, and cleanup. Mirrors
 * cold-mount-scale.ts verifyMount / verifyCandidateRequestDelta /
 * runFaultGate / verifyResource — never weaker.
 */
export function validateColdMountEvidence(evidence) {
  const failures = [];
  const fail = (message) => failures.push(`cold-mount: ${message}`);
  const check = (proofs) => proofs;

  if (!isPlainObject(evidence)) {
    return { ok: false, failures: ['cold-mount: evidence is not an object'] };
  }
  if (evidence.mode !== 'candidate') {
    fail(`mode is ${JSON.stringify(evidence.mode)}, want "candidate"`);
  }
  if (!isPlainObject(evidence.artifacts)) {
    fail('artifacts is missing or not an object');
  } else {
    for (const key of ['mount', 'cloud']) {
      if (typeof evidence.artifacts[key] !== 'string' || evidence.artifacts[key].length === 0) {
        fail(`artifacts.${key} is missing or empty`);
      }
    }
  }

  if (!isPlainObject(evidence.fixture)) {
    fail('fixture is missing or not an object');
  } else {
    if (evidence.fixture.files !== COLD_MOUNT_FILE_COUNT) {
      fail(`fixture.files is ${evidence.fixture.files}, want ${COLD_MOUNT_FILE_COUNT}`);
    }
    if (evidence.fixture.directories !== COLD_MOUNT_DIRECTORY_COUNT) {
      fail(`fixture.directories is ${evidence.fixture.directories}, want ${COLD_MOUNT_DIRECTORY_COUNT}`);
    }
    if (evidence.fixture.bytes !== COLD_MOUNT_TOTAL_BYTES) {
      fail(`fixture.bytes is ${evidence.fixture.bytes}, want ${COLD_MOUNT_TOTAL_BYTES}`);
    }
    if (evidence.fixture.manifestSha256 !== COLD_MOUNT_MANIFEST_SHA256) {
      fail(
        `fixture.manifestSha256 is ${evidence.fixture.manifestSha256}, want ${COLD_MOUNT_MANIFEST_SHA256}`
      );
    }
  }

  const standard = evidence.standard;
  if (!isPlainObject(standard)) {
    fail('standard is missing or not an object');
    return { ok: false, failures };
  }

  verifyProxySnapshot('standard.initial', standard.initial, 1, fail);
  verifyProxySnapshot('standard.concurrent', standard.concurrent, CONCURRENT_CONSUMER_COUNT, fail);
  if (standard.initial?.total !== 31)
    fail(`standard.initial.total is ${standard.initial?.total}, want exactly 31`);
  if (standard.concurrent?.total !== 62)
    fail(`standard.concurrent.total is ${standard.concurrent?.total}, want exactly 62`);

  if (!Array.isArray(standard.resources)) {
    fail('standard.resources is missing or not an array');
  } else {
    if (standard.resources.length !== MOUNT_COUNT) {
      fail(
        `standard.resources has ${standard.resources.length} entries, want ${MOUNT_COUNT} (one cold mount plus two concurrent consumers)`
      );
    }
    standard.resources.forEach((resource, index) =>
      verifyResource(
        `standard.resources[${index}]`,
        resource,
        {
          wallLimitMs: MOUNT_WALL_LIMIT_MS,
          cpuLimitMs: MOUNT_CPU_LIMIT_MS,
          peakRssLimitBytes: MOUNT_PEAK_RSS_LIMIT_BYTES,
          actualCpuLimitMs: ACTUAL_CPU_LIMIT_MS,
        },
        fail
      )
    );
  }

  if (!Array.isArray(standard.hashesVerified)) {
    fail('standard.hashesVerified is missing or not an array');
  } else {
    if (standard.hashesVerified.length !== MOUNT_COUNT) {
      fail(`standard.hashesVerified has ${standard.hashesVerified.length} entries, want ${MOUNT_COUNT}`);
    }
    standard.hashesVerified.forEach((value, index) => {
      if (value !== true) fail(`standard.hashesVerified[${index}] is not true`);
    });
  }
  if (standard.amplificationDetected !== false) {
    fail(`standard.amplificationDetected is ${standard.amplificationDetected}, want false`);
  }

  if (!isPlainObject(evidence.faults)) {
    fail('faults is missing or not an object (candidate mode requires all fault gates)');
  } else {
    for (const kind of FAULT_GATE_KINDS) {
      const gate = evidence.faults[kind];
      if (!isPlainObject(gate)) {
        fail(`faults["${kind}"] is missing`);
        continue;
      }
      verifyFaultGate(kind, gate, fail);
    }
    for (const key of Object.keys(evidence.faults)) {
      if (!FAULT_GATE_KINDS.includes(key)) {
        fail(`faults has unexpected gate "${key}"`);
      }
    }
  }

  verifyResource(
    'suite',
    evidence.suite,
    {
      wallLimitMs: SUITE_WALL_LIMIT_MS,
      cpuLimitMs: SUITE_CPU_LIMIT_MS,
      peakRssLimitBytes: SUITE_PEAK_RSS_LIMIT_BYTES,
      actualCpuLimitMs: ACTUAL_CPU_LIMIT_MS,
    },
    fail
  );

  if (evidence.cleanupVerified !== true) {
    fail('cleanupVerified is not true');
  }

  return { ok: failures.length === 0, failures };
}

/**
 * Validate the executable issue-#490 proof captured from the published
 * Relayfile package. Both entrypoints must avoid realtime while --once is
 * under a delayed/429 websocket, apply a healthy poll update, and persist its
 * cursor; the daemon path must retain realtime support.
 */
export function validateIssue490Evidence(evidence) {
  const failures = [];
  const fail = (message) => failures.push(`issue-490: ${message}`);
  if (!isPlainObject(evidence)) return { ok: false, failures: ['issue-490: evidence is not an object'] };
  if (evidence.issue !== 490) fail(`issue is ${JSON.stringify(evidence.issue)}, want 490`);
  if (evidence.delayedWebSocket429 !== true) fail('delayedWebSocket429 is not true');
  if (evidence.pollingUpdateApplied !== true) fail('pollingUpdateApplied is not true');
  if (evidence.cursorPersisted !== true) fail('cursorPersisted is not true');
  if (evidence.daemonRealtimePreserved !== true) fail('daemonRealtimePreserved is not true');
  if (
    !isPlainObject(evidence.daemon) ||
    !isCount(evidence.daemon.realtimeDialCount) ||
    evidence.daemon.realtimeDialCount < 1
  )
    fail('daemon proof did not record a realtime dial');
  for (const name of ['cli', 'standalone']) {
    const entry = evidence[name];
    if (!isPlainObject(entry)) {
      fail(`${name} proof is missing`);
      continue;
    }
    if (entry.exitCode !== 0) fail(`${name}.exitCode is ${entry.exitCode}, want 0`);
    if (!isCount(entry.testsPassed) || entry.testsPassed < 1) fail(`${name}.testsPassed is not positive`);
    if (entry.testsFailed !== 0) fail(`${name}.testsFailed is ${entry.testsFailed}, want 0`);
    if (entry.realtimeDialCount !== 0)
      fail(`${name}.realtimeDialCount is ${entry.realtimeDialCount}, want 0`);
    if (entry.pollingUpdateApplied !== true) fail(`${name}.pollingUpdateApplied is not true`);
    if (entry.cursorPersisted !== true) fail(`${name}.cursorPersisted is not true`);
  }
  return { ok: failures.length === 0, failures };
}

/** Validate the exact npm prerelease/source attestation used by the sandbox. */
export function validatePublishedRelayfileAttestation(attestation) {
  const failures = [];
  const fail = (message) => failures.push(`npm-attestation: ${message}`);
  if (!isPlainObject(attestation))
    return { ok: false, failures: ['npm-attestation: attestation is not an object'] };
  if (attestation.package !== RELAYFILE_NPM_PACKAGE)
    fail(`package is ${JSON.stringify(attestation.package)}`);
  if (attestation.mountPackage !== '@relayfile/mount-linux-x64')
    fail('mountPackage is not @relayfile/mount-linux-x64');
  if (typeof attestation.version !== 'string' || !RELAYFILE_NPM_VERSION_PATTERN.test(attestation.version))
    fail('version is not an exact prerelease semver');
  if (!isHex64(attestation.tarballSha256)) fail('tarballSha256 is not a 64-hex digest');
  if (!isHex64(attestation.mountTarballSha256)) fail('mountTarballSha256 is not a 64-hex digest');
  if (!HEX40.test(attestation.sourceSha ?? '')) fail('sourceSha is not a full 40-hex commit');
  if (!isHex64(attestation.releaseAttestationSha256)) fail('releaseAttestationSha256 is not a 64-hex digest');
  if (
    attestation.registry !== undefined &&
    (typeof attestation.registry !== 'string' || !/^https:\/\//.test(attestation.registry))
  )
    fail('registry must be an HTTPS URL');
  if (attestation.installed !== true) fail('installed is not true');
  return { ok: failures.length === 0, failures };
}

function verifyProxySnapshot(label, snapshot, mounts, fail) {
  if (!isPlainObject(snapshot)) {
    fail(`${label} is missing or not an object`);
    return;
  }
  const expectedBulk = EXPECTED_BULK_READS_PER_MOUNT * mounts;
  if (snapshot.bulkRead !== expectedBulk) {
    fail(`${label}.bulkRead is ${snapshot.bulkRead}, want exactly ${expectedBulk}`);
  }
  if (snapshot.pointRead !== 0) {
    fail(`${label}.pointRead is ${snapshot.pointRead}, want 0`);
  }
  for (const key of ['status429', 'status5xx', 'resets', 'malformed', 'unsupported']) {
    if (snapshot[key] !== 0) {
      fail(`${label}.${key} is ${snapshot[key]}, want 0`);
    }
  }
  if (!isCount(snapshot.total)) {
    fail(`${label}.total is not a non-negative number`);
  } else if (snapshot.total > MAX_TOTAL_REQUESTS_PER_MOUNT * mounts) {
    fail(`${label}.total is ${snapshot.total}, limit is ${MAX_TOTAL_REQUESTS_PER_MOUNT * mounts}`);
  }
  if (!isCount(snapshot.requestBytes)) {
    fail(`${label}.requestBytes is not a non-negative number`);
  } else if (snapshot.requestBytes > MAX_REQUEST_BYTES_PER_MOUNT * mounts) {
    fail(
      `${label}.requestBytes is ${snapshot.requestBytes}, limit is ${MAX_REQUEST_BYTES_PER_MOUNT * mounts}`
    );
  }
  if (!isCount(snapshot.responseBytes)) {
    fail(`${label}.responseBytes is not a non-negative number`);
  } else if (snapshot.responseBytes > MAX_RESPONSE_BYTES_PER_MOUNT * mounts) {
    fail(
      `${label}.responseBytes is ${snapshot.responseBytes}, limit is ${MAX_RESPONSE_BYTES_PER_MOUNT * mounts}`
    );
  }
  if (!isCount(snapshot.maxBulkRequestBytes)) {
    fail(`${label}.maxBulkRequestBytes is not a non-negative number`);
  } else if (snapshot.maxBulkRequestBytes > MAX_BULK_REQUEST_BYTES) {
    fail(
      `${label}.maxBulkRequestBytes is ${snapshot.maxBulkRequestBytes}, limit is ${MAX_BULK_REQUEST_BYTES}`
    );
  }
  if (!isCount(snapshot.maxBulkResponseBytes)) {
    fail(`${label}.maxBulkResponseBytes is not a non-negative number`);
  } else if (snapshot.maxBulkResponseBytes > MAX_BULK_RESPONSE_BYTES) {
    fail(
      `${label}.maxBulkResponseBytes is ${snapshot.maxBulkResponseBytes}, limit is ${MAX_BULK_RESPONSE_BYTES}`
    );
  }
}

function verifyResource(label, resource, limits, fail) {
  if (!isPlainObject(resource)) {
    fail(`${label} is missing or not an object`);
    return;
  }
  // Pin the recorded limits so evidence from a weakened harness is rejected.
  for (const [key, want] of [
    ['wallLimitMs', limits.wallLimitMs],
    ['cpuLimitMs', limits.cpuLimitMs],
    ['peakRssLimitBytes', limits.peakRssLimitBytes],
  ]) {
    if (resource[key] !== want) {
      fail(`${label}.${key} is ${resource[key]}, want the canonical ${want}`);
    }
  }
  if (!isCount(resource.wallMs)) {
    fail(`${label}.wallMs is not a non-negative number`);
  } else if (resource.wallMs > limits.wallLimitMs) {
    fail(`${label}.wallMs is ${resource.wallMs}, limit is ${limits.wallLimitMs}`);
  }
  if (!isCount(resource.cpuMs)) {
    fail(`${label}.cpuMs is not a non-negative number`);
  } else if (resource.cpuMs > limits.cpuLimitMs) {
    fail(`${label}.cpuMs is ${resource.cpuMs}, limit is ${limits.cpuLimitMs}`);
  } else if (limits.actualCpuLimitMs !== undefined && resource.cpuMs > limits.actualCpuLimitMs) {
    fail(`${label}.cpuMs is ${resource.cpuMs}, actual CPU limit is ${limits.actualCpuLimitMs}`);
  }
  if (!isCount(resource.peakRssBytes)) {
    fail(`${label}.peakRssBytes is not a non-negative number`);
  } else if (resource.peakRssBytes > limits.peakRssLimitBytes) {
    fail(`${label}.peakRssBytes is ${resource.peakRssBytes}, limit is ${limits.peakRssLimitBytes}`);
  }
}

function verifyFaultGate(kind, gate, fail) {
  const label = `faults["${kind}"]`;
  const requests = gate.requests;
  if (kind === 'malformed') {
    if (gate.outcome !== 'expected-failure') {
      fail(`${label}.outcome is ${JSON.stringify(gate.outcome)}, want "expected-failure"`);
    }
    if (gate.hashesVerified !== false) {
      fail(
        `${label}.hashesVerified is ${gate.hashesVerified}, want false (malformed must not materialize the fixture)`
      );
    }
    if (isPlainObject(requests)) {
      if (requests.bulkRead !== 1) {
        fail(`${label}.requests.bulkRead is ${requests.bulkRead}, want 1`);
      }
      if (requests.pointRead !== 0) {
        fail(`${label}.requests.pointRead is ${requests.pointRead}, want 0`);
      }
      if (requests.malformed !== 1) {
        fail(`${label}.requests.malformed is ${requests.malformed}, want 1`);
      }
      if (requests.faultsInjected !== 1) {
        fail(`${label}.requests.faultsInjected is ${requests.faultsInjected}, want 1`);
      }
      verifyFaultCounters(label, requests, { total: 2, malformed: 1 }, fail);
      verifyNetworkBounds(label, requests, 1, fail);
    } else {
      fail(`${label}.requests is missing or not an object`);
    }
    return;
  }

  if (gate.outcome !== 'success') {
    fail(`${label}.outcome is ${JSON.stringify(gate.outcome)}, want "success"`);
  }
  if (gate.exitCode !== 0) {
    fail(`${label}.exitCode is ${gate.exitCode}, want 0`);
  }
  if (gate.hashesVerified !== true) {
    fail(`${label}.hashesVerified is ${gate.hashesVerified}, want true`);
  }
  if (!isPlainObject(requests)) {
    fail(`${label}.requests is missing or not an object`);
    return;
  }
  if (requests.faultsInjected !== 1) {
    fail(`${label}.requests.faultsInjected is ${requests.faultsInjected}, want 1`);
  }
  if (kind === 'unsupported') {
    if (requests.unsupported !== 1) {
      fail(`${label}.requests.unsupported is ${requests.unsupported}, want 1`);
    }
    if (requests.bulkRead !== 1) {
      fail(`${label}.requests.bulkRead is ${requests.bulkRead}, want 1`);
    }
    if (requests.pointRead !== COLD_MOUNT_FILE_COUNT) {
      fail(
        `${label}.requests.pointRead is ${requests.pointRead}, want the exact ${COLD_MOUNT_FILE_COUNT}-file fallback`
      );
    }
    verifyFaultCounters(label, requests, { total: 855, status5xx: 1, unsupported: 1 }, fail);
  } else {
    if (requests.bulkRead !== EXPECTED_BULK_READS_PER_MOUNT + 1) {
      fail(`${label}.requests.bulkRead is ${requests.bulkRead}, want ${EXPECTED_BULK_READS_PER_MOUNT + 1}`);
    }
    if (requests.pointRead !== 0) {
      fail(`${label}.requests.pointRead is ${requests.pointRead}, want 0`);
    }
    const observed = { 429: 'status429', 503: 'status5xx', reset: 'resets' }[kind];
    verifyFaultCounters(label, requests, { total: 32, [observed]: 1 }, fail);
  }
  verifyNetworkBounds(label, requests, 1, fail);
  verifyResource(
    `${label}.resource`,
    gate.resource,
    {
      wallLimitMs: MOUNT_WALL_LIMIT_MS,
      cpuLimitMs: MOUNT_CPU_LIMIT_MS,
      peakRssLimitBytes: MOUNT_PEAK_RSS_LIMIT_BYTES,
      actualCpuLimitMs: ACTUAL_CPU_LIMIT_MS,
    },
    fail
  );
}

function verifyFaultCounters(label, requests, expected, fail) {
  for (const key of ['status429', 'status5xx', 'resets', 'malformed', 'unsupported']) {
    const want = expected[key] ?? 0;
    if (requests[key] !== want) fail(`${label}.requests.${key} is ${requests[key]}, want exactly ${want}`);
  }
  if (requests.total !== expected.total)
    fail(`${label}.requests.total is ${requests.total}, want exactly ${expected.total}`);
}

function verifyNetworkBounds(label, snapshot, mounts, fail) {
  if (!isCount(snapshot.maxBulkRequestBytes)) {
    fail(`${label}.maxBulkRequestBytes is not a non-negative number`);
  } else if (snapshot.maxBulkRequestBytes > MAX_BULK_REQUEST_BYTES) {
    fail(
      `${label}.maxBulkRequestBytes is ${snapshot.maxBulkRequestBytes}, limit is ${MAX_BULK_REQUEST_BYTES}`
    );
  }
  if (!isCount(snapshot.maxBulkResponseBytes)) {
    fail(`${label}.maxBulkResponseBytes is not a non-negative number`);
  } else if (snapshot.maxBulkResponseBytes > MAX_BULK_RESPONSE_BYTES) {
    fail(
      `${label}.maxBulkResponseBytes is ${snapshot.maxBulkResponseBytes}, limit is ${MAX_BULK_RESPONSE_BYTES}`
    );
  }
  if (!isCount(snapshot.requestBytes)) {
    fail(`${label}.requestBytes is not a non-negative number`);
  } else if (snapshot.requestBytes > MAX_REQUEST_BYTES_PER_MOUNT * mounts) {
    fail(
      `${label}.requestBytes is ${snapshot.requestBytes}, limit is ${MAX_REQUEST_BYTES_PER_MOUNT * mounts}`
    );
  }
  if (!isCount(snapshot.responseBytes)) {
    fail(`${label}.responseBytes is not a non-negative number`);
  } else if (snapshot.responseBytes > MAX_RESPONSE_BYTES_PER_MOUNT * mounts) {
    fail(
      `${label}.responseBytes is ${snapshot.responseBytes}, limit is ${MAX_RESPONSE_BYTES_PER_MOUNT * mounts}`
    );
  }
}

/**
 * Parse vitest --reporter=verbose output. Fail closed: a missing or
 * unparseable summary line, or a required token only observed on a failing
 * line, is never a pass.
 */
export function parseVitestVerboseOutput(output) {
  const text =
    typeof output === 'string'
      ? output.replace(
          /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
          ''
        )
      : '';
  const lines = text.split(/\r?\n/);
  const summary = /Tests\s+([\d,]+)\s+passed(?:\s*\|\s*([\d,]+)\s+failed)?/.exec(text);
  if (!summary) {
    return { ok: false, reason: 'vitest summary line ("Tests  N passed") was not found' };
  }
  const passed = Number(summary[1].replace(/,/g, ''));
  const failed = summary[2] ? Number(summary[2].replace(/,/g, '')) : 0;
  return { ok: true, passed, failed, lines };
}

/**
 * Persist only the structured test result needed by the qualification gate.
 * Runner stdout/stderr is intentionally excluded: failure output may contain
 * credentials and must not be copied into arm evidence or reviewer prompts.
 */
export function toVitestEvidenceSummary(result) {
  return {
    exitCode: result?.exitCode,
    testsPassed: result?.testsPassed,
    testsFailed: result?.testsFailed,
  };
}

/** True only when a token appears on a passing line and never on a failing one. */
export function verboseTokenPassed(parsed, token) {
  if (!parsed.ok) return false;
  let sawPass = false;
  for (const line of parsed.lines) {
    if (!line.includes(token)) continue;
    if (/[×✗✘]|FAIL|Failed Tests/.test(line)) return false;
    if (/[✓√]/.test(line)) sawPass = true;
  }
  return sawPass;
}

/**
 * Validate the ACL leg evidence: Cloud's ACL backpressure suite must be green
 * with every induced `workspace_busy` reason exercised on GET and PUT, the
 * write-admission boundary and sustained-busy deadline behaviors present, the
 * unknown/absent-reason fail-closed proofs present, and the five-reason
 * enumeration proven in the candidate source; relayfile-cloud's ACL
 * admission-lane suite must be green with its control-lane surfaces covered.
 */
export function validateAclEvidence(evidence) {
  const failures = [];
  const fail = (message) => failures.push(`acl: ${message}`);
  if (!isPlainObject(evidence)) {
    return { ok: false, failures: ['acl: evidence is not an object'] };
  }
  if (!Array.isArray(evidence.suites)) {
    return { ok: false, failures: ['acl: suites is missing or not an array'] };
  }
  const cloudSuite = evidence.suites.find((suite) => suite && suite.repo === 'cloud');
  const relayfileCloudSuite = evidence.suites.find((suite) => suite && suite.repo === 'relayfile-cloud');
  if (!cloudSuite) fail('cloud ACL suite result is missing');
  if (!relayfileCloudSuite) fail('relayfile-cloud ACL admission suite result is missing');
  if (!cloudSuite || !relayfileCloudSuite) return { ok: false, failures };

  verifySuiteExit('cloud ACL suite', cloudSuite, fail);
  if (cloudSuite.exitCode === 0 && cloudSuite.testsFailed === 0) {
    if (cloudSuite.fiveReasonEnumerationPresent !== true) {
      fail(
        'cloud ACL suite did not prove the five workspace_busy reasons are enumerated in the candidate source'
      );
    }
    const reasons = isPlainObject(cloudSuite.reasons) ? cloudSuite.reasons : {};
    for (const reason of ACL_EACH_REASONS) {
      const coverage = reasons[reason];
      if (!isPlainObject(coverage)) {
        fail(`reason "${reason}" has no GET/PUT coverage record`);
        continue;
      }
      if (coverage.put !== true) fail(`reason "${reason}" was not proven on an induced-busy PUT`);
      if (coverage.get !== true) fail(`reason "${reason}" was not proven on an induced-busy GET`);
    }
    if (cloudSuite.writeAdmissionPutBoundary !== true) {
      fail('write_admission_limit PUT four-write boundary case was not proven');
    }
    if (cloudSuite.writeAdmissionSustainedDeadlineFailClosed !== true) {
      fail('sustained workspace_busy deadline fail-closed case was not proven');
    }
    if (cloudSuite.unknownReasonTerminal !== true) {
      fail('unknown workspace_busy reason terminal (fail-closed) case was not proven');
    }
    if (cloudSuite.absentReasonTerminal !== true) {
      fail('absent workspace_busy reason terminal (fail-closed) case was not proven');
    }
  }

  verifySuiteExit('relayfile-cloud ACL suite', relayfileCloudSuite, fail);
  if (relayfileCloudSuite.exitCode === 0 && relayfileCloudSuite.testsFailed === 0) {
    const parentUnit = relayfileCloudSuite.parentWorkerAclUnit;
    if (
      !isPlainObject(parentUnit) ||
      parentUnit.exitCode !== 0 ||
      !isCount(parentUnit.testsPassed) ||
      parentUnit.testsPassed < 1 ||
      parentUnit.testsFailed !== 0
    )
      fail('parent Worker ACL unit suite did not pass');
    if (!isPlainObject(relayfileCloudSuite.workerdRuntime)) {
      fail('relayfile-cloud ACL suite did not execute the real Workerd/Miniflare path');
    } else {
      if (
        relayfileCloudSuite.workerdRuntime.exitCode !== 0 ||
        relayfileCloudSuite.workerdRuntime.testsFailed !== 0
      ) {
        fail('relayfile-cloud Workerd/Miniflare ACL path did not pass');
      }
      if (relayfileCloudSuite.workerdRuntime.miniflareObserved !== true) {
        fail('relayfile-cloud Workerd/Miniflare runtime marker was not observed');
      }
      if (relayfileCloudSuite.workerdRuntime.workspaceDoCaseObserved !== true) {
        fail('specific WorkspaceDO ACL Workerd case was not observed');
      }
    }
    const tokens = isPlainObject(relayfileCloudSuite.surfaceTokens) ? relayfileCloudSuite.surfaceTokens : {};
    for (const token of ACL_ADMISSION_SURFACE_TOKENS) {
      if (tokens[token] !== true) {
        fail(`relayfile-cloud ACL suite did not prove the "${token}" surface`);
      }
    }
  }
  const exactCase = relayfileCloudSuite.workspaceAclProvisioningAdmission;
  if (!isPlainObject(exactCase)) {
    fail('exact workspace-acl-provisioning-admission case evidence is missing');
  } else {
    if (exactCase.exitCode !== 0) fail(`exact workspace ACL case exited ${exactCase.exitCode}, want 0`);
    if (exactCase.resultPath !== '/tmp/workspace-acl-provisioning-admission.json')
      fail('exact workspace ACL case result was not read from RELAY_PR_PROOF_RESULT_PATH');
    if (exactCase.resultSource !== 'RELAY_PR_PROOF_RESULT_PATH')
      fail('exact workspace ACL case result source is not RELAY_PR_PROOF_RESULT_PATH');
    if (exactCase.caseId !== ACL_PROVISIONING_CASE_ID)
      fail(`exact workspace ACL caseId is ${exactCase.caseId}, want ${ACL_PROVISIONING_CASE_ID}`);
    if (exactCase.arm !== 'head') fail(`exact workspace ACL case arm is ${exactCase.arm}, want head`);
    if (exactCase.outcome !== 'fixed')
      fail(`exact workspace ACL case outcome is ${exactCase.outcome}, want fixed`);
    if (exactCase.signature !== ACL_PROVISIONING_FIXED_SIGNATURE)
      fail(
        `exact workspace ACL case signature is ${exactCase.signature}, want ${ACL_PROVISIONING_FIXED_SIGNATURE}`
      );
  }

  return { ok: failures.length === 0, failures };
}

function verifySuiteExit(label, suite, fail) {
  if (suite.exitCode !== 0) {
    fail(`${label} exited ${suite.exitCode}, want 0`);
  }
  if (!isCount(suite.testsPassed) || suite.testsPassed < 1) {
    fail(`${label} recorded no passing tests — an unexecuted suite is not a pass`);
  }
  if (!isCount(suite.testsFailed) || suite.testsFailed !== 0) {
    fail(`${suite.testsFailed ?? 'an unknown number of'} ${label} tests failed`);
  }
}

/** Parse one DAYTONA_* machine line. Unrecognized lines yield null. */
export function parseCheckpointLine(line) {
  const text = typeof line === 'string' ? line.trim() : '';
  const prefixes = {
    DAYTONA_CHECKPOINT: 'checkpoint',
    DAYTONA_CLEANUP: 'cleanup',
    DAYTONA_LOCAL_CLEANUP: 'local-cleanup',
    DAYTONA_CONTEXT_CLEANUP: 'context-cleanup',
  };
  for (const [prefix, kind] of Object.entries(prefixes)) {
    if (text === prefix || text.startsWith(`${prefix} `)) {
      const fields = {};
      let malformed = false;
      for (const token of text.slice(prefix.length).trim().split(/\s+/).filter(Boolean)) {
        const eq = token.indexOf('=');
        if (eq <= 0) {
          malformed = true;
          continue;
        }
        fields[token.slice(0, eq)] = token.slice(eq + 1);
      }
      return { kind, fields, malformed };
    }
  }
  return null;
}

/**
 * Validate the full checkpoint series of one arm log: the pre-create name
 * checkpoint with both artifact digests, the post-create id checkpoint, the
 * post-delete cleanup line, and the local scratch cleanup line. The cleanup
 * lines must repeat the exact captured id and name.
 */
export function validateCheckpointSeries(lines) {
  const failures = [];
  const parsed = (Array.isArray(lines) ? lines : [])
    .map((line) => parseCheckpointLine(line))
    .filter((entry) => entry !== null);
  const nameCheckpoint = parsed.find(
    (entry) => entry.kind === 'checkpoint' && entry.fields.name && !entry.fields.id
  );
  const idCheckpoint = parsed.find(
    (entry) => entry.kind === 'checkpoint' && entry.fields.id && entry.fields.name
  );
  const cleanup = parsed.find((entry) => entry.kind === 'cleanup');
  const localCleanup = parsed.find((entry) => entry.kind === 'local-cleanup');

  for (const kind of ['cleanup', 'local-cleanup', 'context-cleanup']) {
    const count = parsed.filter((entry) => entry.kind === kind).length;
    if (count !== 1) {
      failures.push(`checkpoint series: expected exactly one ${kind} line, found ${count}`);
    }
  }
  const checkpointCount = parsed.filter((entry) => entry.kind === 'checkpoint').length;
  if (checkpointCount !== 2) {
    failures.push(`checkpoint series: expected exactly two checkpoint lines, found ${checkpointCount}`);
  }

  if (!nameCheckpoint) failures.push('checkpoint series: name checkpoint line is missing');
  if (!idCheckpoint) failures.push('checkpoint series: id checkpoint line is missing');
  if (!cleanup) failures.push('checkpoint series: DAYTONA_CLEANUP line is missing');
  if (!localCleanup) failures.push('checkpoint series: DAYTONA_LOCAL_CLEANUP line is missing');
  if (parsed.some((entry) => entry.malformed)) {
    failures.push('checkpoint series: contains a malformed key=value field');
  }
  for (const entry of parsed) {
    if (!entry.fields.run_id) failures.push(`checkpoint series: ${entry.kind} line is missing run_id`);
    for (const key of ['cloud_sha256', 'relayfile_sha256', 'relayfile_cloud_sha256']) {
      if (!isHex64(entry.fields[key]))
        failures.push(`checkpoint series: ${entry.kind} line has invalid ${key}`);
    }
  }
  if (nameCheckpoint && !isHex64(nameCheckpoint.fields.cloud_sha256)) {
    failures.push('checkpoint series: cloud_sha256 is not a sha-256 hex digest');
  }
  if (nameCheckpoint && !isHex64(nameCheckpoint.fields.relayfile_sha256)) {
    failures.push('checkpoint series: relayfile_sha256 is not a sha-256 hex digest');
  }
  if (nameCheckpoint && !isHex64(nameCheckpoint.fields.relayfile_cloud_sha256)) {
    failures.push('checkpoint series: relayfile_cloud_sha256 is not a sha-256 hex digest');
  }
  if (nameCheckpoint && !nameCheckpoint.fields.run_id) {
    failures.push('checkpoint series: run_id is missing');
  }
  if (nameCheckpoint && idCheckpoint && nameCheckpoint.fields.name !== idCheckpoint.fields.name) {
    failures.push('checkpoint series: id checkpoint names a different sandbox than the name checkpoint');
  }
  if (nameCheckpoint && idCheckpoint && nameCheckpoint.fields.run_id !== idCheckpoint.fields.run_id) {
    failures.push('checkpoint series: id checkpoint has a different run_id');
  }
  if (nameCheckpoint) {
    for (const entry of parsed) {
      if (entry.fields.run_id !== nameCheckpoint.fields.run_id)
        failures.push(`checkpoint series: ${entry.kind} has a different run_id`);
      for (const key of ['cloud_sha256', 'relayfile_sha256', 'relayfile_cloud_sha256']) {
        if (entry.fields[key] !== nameCheckpoint.fields[key])
          failures.push(`checkpoint series: ${entry.kind} has a different artifact hash ${key}`);
      }
    }
  }
  if (idCheckpoint && cleanup) {
    if (cleanup.fields.verified_absent !== 'true') {
      failures.push('checkpoint series: DAYTONA_CLEANUP lacks verified_absent=true');
    }
    if (cleanup.fields.id !== idCheckpoint.fields.id) {
      failures.push('checkpoint series: DAYTONA_CLEANUP repeats a different sandbox id');
    }
    if (cleanup.fields.name !== idCheckpoint.fields.name) {
      failures.push('checkpoint series: DAYTONA_CLEANUP repeats a different sandbox name');
    }
    if (cleanup.fields.run_id !== idCheckpoint.fields.run_id) {
      failures.push('checkpoint series: DAYTONA_CLEANUP has a different run_id');
    }
  }
  if (localCleanup && localCleanup.fields.verified_absent !== 'true') {
    failures.push('checkpoint series: DAYTONA_LOCAL_CLEANUP lacks verified_absent=true');
  }
  const contextCleanup = parsed.find((entry) => entry.kind === 'context-cleanup');
  if (contextCleanup && contextCleanup.fields.verified_absent !== 'true') {
    failures.push('checkpoint series: DAYTONA_CONTEXT_CLEANUP lacks verified_absent=true');
  }
  return {
    ok: failures.length === 0,
    failures,
    sandboxId: idCheckpoint ? idCheckpoint.fields.id : undefined,
    sandboxName: idCheckpoint ? idCheckpoint.fields.name : undefined,
    runId: nameCheckpoint ? nameCheckpoint.fields.run_id : undefined,
    cloudSha256: nameCheckpoint ? nameCheckpoint.fields.cloud_sha256 : undefined,
    relayfileSha256: nameCheckpoint ? nameCheckpoint.fields.relayfile_sha256 : undefined,
    relayfileCloudSha256: nameCheckpoint ? nameCheckpoint.fields.relayfile_cloud_sha256 : undefined,
  };
}

/** Validate one arm report end to end. No field, no pass. */
export function validateArmReport(report) {
  const failures = [];
  const fail = (message) => failures.push(`arm: ${message}`);
  if (!isPlainObject(report)) {
    return { ok: false, failures: ['arm: report is not an object'] };
  }
  if (!ARMS.includes(report.arm)) fail(`arm is ${JSON.stringify(report.arm)}, want "A" or "B"`);
  if (report.version !== 1) fail(`version is ${JSON.stringify(report.version)}, want 1`);
  if (report.status !== 'COMPLETE') fail(`status is ${JSON.stringify(report.status)}, want "COMPLETE"`);
  if (typeof report.runId !== 'string' || report.runId.length === 0) fail('runId is missing');
  if (!isPlainObject(report.artifactHashes)) fail('artifactHashes is missing');
  else
    for (const key of ['cloud', 'relayfile', 'relayfile-cloud'])
      if (!isHex64(report.artifactHashes[key])) fail(`artifactHashes.${key} is not a sha-256 digest`);
  failures.push(
    ...validateCandidateProvenance(report.candidateProvenance, report.artifacts, report.artifactHashes)
      .failures
  );
  failures.push(...validatePublishedRelayfileAttestation(report.publishedRelayfile).failures);

  const sandbox = report.sandbox;
  if (!isPlainObject(sandbox)) {
    fail('sandbox is missing or not an object');
  } else {
    if (typeof sandbox.id !== 'string' || sandbox.id.length === 0) {
      fail('sandbox.id is missing or empty — the exact sandbox ID must be captured');
    }
    if (typeof sandbox.name !== 'string' || sandbox.name.length === 0) {
      fail('sandbox.name is missing or empty — the exact sandbox name must be captured');
    }
    if (typeof sandbox.name === 'string' && !SANDBOX_NAME_PATTERN.test(sandbox.name)) {
      fail(`sandbox.name "${sandbox.name}" does not match the qualification naming scheme`);
    }
    if (
      typeof sandbox.name === 'string' &&
      ARMS.includes(report.arm) &&
      !sandbox.name.endsWith(`-arm-${report.arm}`)
    ) {
      fail(`sandbox.name "${sandbox.name}" does not belong to arm ${report.arm}`);
    }
    if (sandbox.fresh !== true) {
      fail('sandbox.fresh is not true — the arm must run in a newly-created sandbox');
    }
  }

  const legs = isPlainObject(report.legs) ? report.legs : {};
  for (const key of Object.keys(legs)) {
    if (!['coldMount', 'acl', 'issue490'].includes(key)) {
      fail(`unexpected leg "${key}" — qualification has only coldMount and acl legs`);
    }
  }
  const cold = validateColdMountEvidence(legs.coldMount);
  failures.push(...cold.failures);
  const acl = validateAclEvidence(legs.acl);
  failures.push(...acl.failures);
  failures.push(...validateIssue490Evidence(legs.issue490).failures);

  if (!isPlainObject(report.cleanup)) {
    fail('cleanup is missing or not an object');
  } else {
    if (report.cleanup.attempted !== true) fail('cleanup.attempted is not true');
    if (report.cleanup.createAttempted !== true) fail('cleanup.createAttempted is not true');
    if (report.cleanup.sandboxAbsent !== true) {
      fail('cleanup.sandboxAbsent is not true — exact owned-sandbox absence was not proven');
    }
    if (report.cleanup.inventoryAbsent !== true) {
      fail('cleanup.inventoryAbsent is not true — absence from the Daytona inventory was not proven');
    }
    if (report.cleanup.scratchAbsent !== true) {
      fail('cleanup.scratchAbsent is not true — the local build context was not removed');
    }
    if (report.cleanup.contextAbsent !== true) {
      fail('cleanup.contextAbsent is not true — the immutable bundle build context was not removed');
    }
  }

  const checkpoints = validateCheckpointSeries(report.checkpoints);
  failures.push(...checkpoints.failures);
  if (
    checkpoints.ok &&
    isPlainObject(sandbox) &&
    (checkpoints.sandboxId !== sandbox.id ||
      checkpoints.sandboxName !== sandbox.name ||
      checkpoints.runId !== report.runId)
  ) {
    fail("checkpoint series does not repeat the report's exact sandbox id and name");
  }
  if (
    checkpoints.ok &&
    (checkpoints.cloudSha256 !== report.artifactHashes?.cloud ||
      checkpoints.relayfileSha256 !== report.artifactHashes?.relayfile ||
      checkpoints.relayfileCloudSha256 !== report.artifactHashes?.['relayfile-cloud'])
  )
    fail('checkpoint artifact hashes do not match report artifact hashes');

  return { ok: failures.length === 0, failures };
}

/** The two arms must own two distinct sandboxes, proven by id and by name. */
export function assertDistinctArms(reportA, reportB) {
  const failures = [];
  const idA = reportA && reportA.sandbox && reportA.sandbox.id;
  const idB = reportB && reportB.sandbox && reportB.sandbox.id;
  const nameA = reportA && reportA.sandbox && reportA.sandbox.name;
  const nameB = reportB && reportB.sandbox && reportB.sandbox.name;
  if (!idA || !idB || !nameA || !nameB) {
    failures.push('distinctness: both arms must capture exact sandbox ids and names');
  }
  if (idA && idB && idA === idB) {
    failures.push(`distinctness: both arms report the same sandbox id "${idA}"`);
  }
  if (nameA && nameB && nameA === nameB) {
    failures.push(`distinctness: both arms report the same sandbox name "${nameA}"`);
  }
  return { ok: failures.length === 0, failures };
}

/** Final verdict: PASS only when both arms pass, distinctness holds, and the required signoffs agree. */
export function aggregateVerdict({ reportA, reportB, signoffs, requireSignoffs = true }) {
  const failures = [];
  const armA = validateArmReport(reportA);
  const armB = validateArmReport(reportB);
  failures.push(...armA.failures.map((f) => `[arm A] ${f}`));
  failures.push(...armB.failures.map((f) => `[arm B] ${f}`));
  const distinct = assertDistinctArms(reportA, reportB);
  failures.push(...distinct.failures);
  const requiredSignoffs = isPlainObject(signoffs) ? signoffs : {};
  if (requireSignoffs) {
    for (const reviewer of ['claude', 'codex']) {
      if (requiredSignoffs[reviewer] !== true) {
        failures.push(`signoff: the ${reviewer} fresh-eyes review did not record COMPREHENSIVELY_SATISFIED`);
      }
    }
  }
  return { ok: failures.length === 0, failures, verdict: failures.length === 0 ? 'PASS' : 'FAIL' };
}
