#!/usr/bin/env node
import './config.mjs';

/** Execute one qualification arm. Creation is fail-closed behind the gate. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { pollUntilAbsent } from './absence.mjs';
import { classifyProbeOutput } from './probe-diagnostics.mjs';
import {
  buildSandboxName,
  daytonaMemoryGiBFromMiB,
  isRetryableDaytonaSandboxLookupFailure,
  parseVitestVerboseOutput,
  redactEnvAssignments,
  toVitestEvidenceSummary,
} from './contract.mjs';
import { PROBE_TIMEOUT_MS } from './probes.mjs';

const execFileAsync = promisify(execFile);
const arm = process.argv[2];
if (arm !== 'A' && arm !== 'B') throw new Error('usage: arm.mjs A|B');
const artifactDir =
  process.env.RELAYFILE_QUALIFICATION_ARTIFACT_DIR ??
  '.workflow-artifacts/relayfile-cross-repo-qualification';
const reportPath = path.join(artifactDir, `arm-${arm}.json`);
const runId = process.env.RELAYFILE_QUALIFICATION_RUN_ID ?? '';
const bundleDir = process.env.RELAYFILE_QUALIFICATION_BUNDLE_DIR ?? path.join(artifactDir, 'bundle');
const candidates = {
  cloud: process.env.RELAY_CLOUD_REPO ?? process.env.RELAYFILE_CLOUD_CANDIDATE ?? '../cloud',
  relayfile: process.env.RELAYFILE_REPO ?? '../relayfile',
  'relayfile-cloud': process.env.RELAYFILE_CLOUD_REPO ?? '../relayfile-cloud',
};
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const npmVersion = process.env.RELAYFILE_QUALIFICATION_NPM_VERSION?.trim() ?? '';
const npmTarballSha256 = process.env.RELAYFILE_QUALIFICATION_NPM_TARBALL_SHA256?.trim() ?? '';
const npmSourceSha = process.env.RELAYFILE_QUALIFICATION_NPM_SOURCE_SHA?.trim() ?? '';
const releaseAttestationSha256 = process.env.RELAYFILE_QUALIFICATION_RELEASE_ATTESTATION_SHA256?.trim() ?? '';
const mountTarballSha256 = process.env.RELAYFILE_QUALIFICATION_MOUNT_TARBALL_SHA256?.trim() ?? '';

async function writeReport(value) {
  await mkdir(artifactDir, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({ version: 1, runId, ...value }, null, 2)}\n`);
}
async function writeBlocked(reason, extra = {}) {
  await writeReport({ arm, status: 'BLOCKED', reason, ...extra });
  console.log(`ARM_${arm}_BLOCKED ${reason}`);
}
if (!RUN_ID_PATTERN.test(runId)) {
  await writeBlocked('RELAYFILE_QUALIFICATION_RUN_ID is missing or unsafe');
  process.exit(1);
}
if (process.env.RELAYFILE_QUALIFICATION_CREATE_SANDBOXES !== '1') {
  await writeBlocked('RELAYFILE_QUALIFICATION_CREATE_SANDBOXES is not 1; no Daytona sandbox was created');
  process.exit(1);
}
let preflight;
try {
  preflight = JSON.parse(await readFile(path.join(artifactDir, 'preflight.json'), 'utf8'));
} catch {
  await writeBlocked('qualification preflight is missing; no Daytona sandbox was created');
  process.exit(1);
}
if (
  preflight.runId !== runId ||
  preflight.status !== 'READY' ||
  preflight.sandboxCreationAuthorized !== true
) {
  await writeBlocked(
    'qualification preflight is not READY for this run or sandbox creation is unauthorized',
    {
      preflight: {
        status: preflight.status,
        runId: preflight.runId,
        sandboxCreationAuthorized: preflight.sandboxCreationAuthorized,
      },
    }
  );
  process.exit(1);
}
if (
  preflight.publishedRelayfile?.package !== 'relayfile' ||
  preflight.publishedRelayfile.mountPackage !== '@relayfile/mount-linux-x64' ||
  preflight.publishedRelayfile.version !== npmVersion ||
  preflight.publishedRelayfile.tarballSha256 !== npmTarballSha256 ||
  preflight.publishedRelayfile.sourceSha !== npmSourceSha ||
  preflight.publishedRelayfile.mountTarballSha256 !== mountTarballSha256 ||
  preflight.publishedRelayfile.releaseAttestationSha256 !== releaseAttestationSha256 ||
  preflight.publishedRelayfile.installed !== false
) {
  await writeBlocked('preflight npm prerelease attestation does not match the requested immutable install');
  process.exit(1);
}
const requiredProbeModels = { codex: 'gpt-5.6-luna', claude: 'sonnet' };
if (!Array.isArray(preflight.modelProbes) || preflight.modelProbes.length !== 2) {
  await writeBlocked('qualification preflight model probe proof is missing; no Daytona sandbox was created');
  process.exit(1);
}
for (const [name, model] of Object.entries(requiredProbeModels)) {
  const probe = preflight.modelProbes.find((value) => value?.name === name);
  if (!probe || probe.model !== model || probe.timeoutMs !== PROBE_TIMEOUT_MS || probe.ok !== true) {
    await writeBlocked(`${name} model probe did not pass; no Daytona sandbox was created`);
    process.exit(1);
  }
}
const image = process.env.RELAYFILE_QUALIFICATION_DAYTONA_IMAGE?.trim();
if (
  !candidates.cloud ||
  !candidates.relayfile ||
  !candidates['relayfile-cloud'] ||
  !image ||
  !/@sha256:[0-9a-f]{64}$/i.test(image)
) {
  await writeBlocked(
    'all three candidate paths and a digest-pinned RELAYFILE_QUALIFICATION_DAYTONA_IMAGE are required'
  );
  process.exit(1);
}

let daytonaMemoryGiB;
try {
  daytonaMemoryGiB = daytonaMemoryGiBFromMiB(process.env.RELAYFILE_DAYTONA_MEMORY_MB ?? '4096');
} catch (error) {
  await writeBlocked(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const sandboxName = buildSandboxName({ arm });
const scratch = await mkdtemp(path.join(os.tmpdir(), `relayfile-qualification-${arm.toLowerCase()}-`));
const checkpoints = [];
let sandboxId = '';
let created = false;
let createAttempted = false;
let cleanupEvidence = {
  sandboxAbsent: false,
  inventoryAbsent: false,
  scratchAbsent: false,
  contextAbsent: false,
  attempted: false,
  createAttempted: false,
};

async function run(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: options.timeoutMs ?? 120_000,
      killSignal: 'SIGKILL',
    });
    return { exitCode: 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } catch (error) {
    return {
      exitCode: Number.isInteger(error.code) ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? String(error),
    };
  }
}
async function runDaytona(args, options = {}) {
  let result;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    result = await run('daytona', args, options);
    if (!isRetryableDaytonaSandboxLookupFailure(result) || attempt === 3) return result;
    await sleep(attempt * 500);
  }
  return result;
}
async function sha256(file) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}
function checkpoint(line) {
  checkpoints.push(line);
  console.log(line);
}
async function verifyAbsent(target) {
  return pollUntilAbsent(target, { run });
}
async function parseInfo(target) {
  const result = await runDaytona(['info', target, '--format', 'json']);
  if (result.exitCode !== 0) throw new Error(`Daytona info failed for ${target}`);
  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Daytona info returned invalid JSON for ${target}`);
  }
  const sandbox = value?.sandbox ?? value;
  if (!sandbox?.id) throw new Error(`Daytona info did not return an id for ${target}`);
  return sandbox;
}
async function issue490Evidence(id) {
  // Run the published package's platform binary, never the source checkout.
  // The probe owns a delayed/429 websocket fake server and emits only its
  // structured counters (no token-bearing process output).
  const runProbe = (entrypoint) =>
    runDaytona(
      [
        'exec',
        id,
        '--cwd',
        '/qualification/relayfile-npm',
        '--',
        'node',
        '/qualification/relayfile-npm/issue-490-probe.mjs',
        entrypoint,
      ],
      { timeoutMs: 300_000 }
    );
  const [cliResult, standaloneResult] = await Promise.all([runProbe('cli'), runProbe('standalone')]);
  const parse = (result) => {
    try {
      return JSON.parse(result.stdout.trim());
    } catch {
      return {};
    }
  };
  const cli = parse(cliResult);
  const standalone = parse(standaloneResult);
  const summarize = (result, parsed) => ({
    exitCode: result.exitCode,
    testsPassed: parsed.testsPassed ?? 0,
    testsFailed: parsed.testsFailed ?? 1,
    firstExit: parsed.firstExit,
    secondExit: parsed.secondExit,
    firstDiagnostic: parsed.firstDiagnostic ?? '',
    secondDiagnostic: parsed.secondDiagnostic ?? '',
    firstOutputBytes: parsed.firstOutputBytes ?? 0,
    secondOutputBytes: parsed.secondOutputBytes ?? 0,
    firstOutputTruncated: parsed.firstOutputTruncated === true,
    secondOutputTruncated: parsed.secondOutputTruncated === true,
    runnerDiagnostic:
      Object.keys(parsed).length > 0
        ? 'structured_output'
        : classifyProbeOutput(`${result.stdout}\n${result.stderr}`),
    cursorSeeded: parsed.cursorSeeded === true,
    realtimeDialCount: parsed.realtimeDialCount ?? 99,
    pollingUpdateApplied: parsed.pollingUpdateApplied === true,
    cursorPersisted: parsed.cursorPersisted === true,
  });
  const ok = cliResult.exitCode === 0 && standaloneResult.exitCode === 0;
  return {
    issue: 490,
    delayedWebSocket429: true,
    pollingUpdateApplied: ok,
    cursorPersisted: ok,
    daemonRealtimePreserved: ok,
    daemon: { realtimeDialCount: standalone.daemonRealtimeDialCount ?? 0 },
    cli: summarize(cliResult, cli),
    standalone: summarize(standaloneResult, standalone),
  };
}
async function aclEvidence(id) {
  const cloudTest = 'tests/relay-workspace-acl-backpressure.test.ts';
  const relayTest = 'packages/relayfile/test/acl-control-admission.test.ts';
  const exactCase = 'tests/relayflows/cases/workspace-acl-provisioning-admission/run.mjs';
  const runTest = (cwd, file, extra = []) =>
    runDaytona(
      [
        'exec',
        id,
        '--cwd',
        cwd,
        '--',
        'node',
        'node_modules/vitest/vitest.mjs',
        'run',
        file,
        '--reporter=verbose',
        ...extra,
      ],
      { timeoutMs: 300_000 }
    );
  const runRelayUnit = () =>
    run(
      'daytona',
      [
        'exec',
        id,
        '--cwd',
        '/qualification/relayfile-cloud',
        '--',
        'npm',
        'exec',
        '--workspace',
        'packages/relayfile',
        '--',
        'vitest',
        'run',
        'test/acl-control-admission.test.ts',
        '--reporter=verbose',
      ],
      { timeoutMs: 300_000 }
    );
  const runExactCase = async () => {
    const execution = await runDaytona(
      [
        'exec',
        id,
        '--cwd',
        '/qualification/relayfile-cloud',
        '--',
        'env',
        'RELAY_PR_PROOF_ARM=head',
        'RELAY_PR_PROOF_RESULT_PATH=/tmp/workspace-acl-provisioning-admission.json',
        'node',
        exactCase,
      ],
      { timeoutMs: 300_000 }
    );
    if (execution.exitCode !== 0) return execution;
    const resultFile = await runDaytona(
      ['exec', id, '--', 'cat', '/tmp/workspace-acl-provisioning-admission.json'],
      { timeoutMs: 30_000 }
    );
    return {
      ...execution,
      exitCode: resultFile.exitCode === 0 ? execution.exitCode : resultFile.exitCode,
      stdout: resultFile.exitCode === 0 ? resultFile.stdout : '',
      stderr:
        resultFile.exitCode === 0
          ? execution.stderr
          : `${execution.stderr}\nresult JSON could not be read from RELAY_PR_PROOF_RESULT_PATH`,
    };
  };
  const [cloud, relay, workerd, exact] = await Promise.all([
    runTest('/qualification/cloud', cloudTest),
    runRelayUnit(),
    runTest('/qualification/relayfile-cloud', 'local/e2e.test.ts', [
      '--config',
      'local/vitest.config.ts',
      '--testNamePattern',
      'WorkspaceDO',
    ]),
    runExactCase(),
  ]);
  const parse = (r) => {
    const parsed = parseVitestVerboseOutput(`${r.stdout}\n${r.stderr}`);
    return {
      exitCode: r.exitCode,
      testsPassed: parsed.ok ? parsed.passed : 0,
      testsFailed: parsed.ok ? parsed.failed : 1,
      output: `${r.stdout}\n${r.stderr}`,
    };
  };
  const cloudResult = parse(cloud),
    relayResult = parse(relay),
    workerdResult = parse(workerd);
  let exactResult;
  const exactText = exact.stdout.trim();
  try {
    // `exact.stdout` is populated only by cat'ing RELAY_PR_PROOF_RESULT_PATH;
    // never infer this proof from the runner's diagnostic stdout.
    const value = JSON.parse(exactText);
    if (value?.caseId === 'workspace-acl-provisioning-admission') exactResult = value;
  } catch {
    // The result file was unreadable or malformed.
  }
  const cloudSource = await readFile(path.join(candidates.cloud, cloudTest), 'utf8');
  const relaySource = await readFile(path.join(candidates['relayfile-cloud'], relayTest), 'utf8');
  const workerdSource = await readFile(path.join(candidates['relayfile-cloud'], 'local/harness.ts'), 'utf8');
  const e2eSource = await readFile(path.join(candidates['relayfile-cloud'], 'local/e2e.test.ts'), 'utf8');
  const cloudText = cloudResult.output;
  const reasons = {};
  for (const reason of [
    'inflight_limit',
    'oldest_inflight_age',
    'durable_object_overloaded',
    'router_inflight_limit',
  ])
    reasons[reason] = {
      get: cloudText.includes(`GET with reason ${reason}`),
      put: cloudText.includes(`PUT with reason ${reason}`),
    };
  return {
    suites: [
      {
        repo: 'cloud',
        ...toVitestEvidenceSummary(cloudResult),
        fiveReasonEnumerationPresent: [
          'write_admission_limit',
          'inflight_limit',
          'oldest_inflight_age',
          'durable_object_overloaded',
          'router_inflight_limit',
        ].every((x) => cloudSource.includes(x)),
        reasons,
        writeAdmissionPutBoundary: cloudText.includes('four-write boundary'),
        writeAdmissionSustainedDeadlineFailClosed: cloudText.includes('sustained workspace_busy PUTs'),
        unknownReasonTerminal: cloudText.includes('unknown reason terminal'),
        absentReasonTerminal: cloudText.includes('absent reason terminal'),
      },
      {
        repo: 'relayfile-cloud',
        ...toVitestEvidenceSummary(relayResult),
        workerdRuntime: {
          command: 'vitest local/e2e.test.ts --config local/vitest.config.ts --testNamePattern WorkspaceDO',
          cwd: '/qualification/relayfile-cloud',
          exitCode: workerdResult.exitCode,
          testsPassed: workerdResult.testsPassed,
          testsFailed: workerdResult.testsFailed,
          miniflareObserved: /Miniflare|workerd/i.test(workerdSource),
          workspaceDoCaseObserved:
            workerdResult.testsPassed > 0 &&
            (/WorkspaceDO/i.test(workerdResult.output) || /WorkspaceDO/i.test(e2eSource)),
        },
        surfaceTokens: {
          isAclMarkerPath: relaySource.includes('isAclMarkerPath'),
          resolveAclControlAdmissionSignal: relaySource.includes('resolveAclControlAdmissionSignal'),
          applyAclControlAdmissionSignal: relaySource.includes('applyAclControlAdmissionSignal'),
          'foreground lane for ACL control ops': relaySource.includes('foreground lane for ACL control ops'),
        },
        parentWorkerAclUnit: {
          command: 'npm exec --workspace packages/relayfile -- vitest run test/acl-control-admission.test.ts',
          exitCode: relayResult.exitCode,
          testsPassed: relayResult.testsPassed,
          testsFailed: relayResult.testsFailed,
        },
        workspaceAclProvisioningAdmission: {
          command: `RELAY_PR_PROOF_ARM=head node ${exactCase}`,
          resultPath: '/tmp/workspace-acl-provisioning-admission.json',
          resultSource: 'RELAY_PR_PROOF_RESULT_PATH',
          exitCode: exact.exitCode,
          outcome: exactResult?.outcome,
          signature: exactResult?.signature,
          caseId: exactResult?.caseId,
          arm: exactResult?.arm,
        },
      },
    ],
  };
}

async function main() {
  await mkdir(artifactDir, { recursive: true });
  await Promise.all(Object.values(candidates).map((p) => access(p)));
  const context = await mkdtemp(
    path.join(os.tmpdir(), `relayfile-qualification-context-${arm.toLowerCase()}-`)
  );
  let artifacts = {};
  try {
    const manifest = JSON.parse(await readFile(path.join(bundleDir, 'bundle-manifest.json'), 'utf8'));
    if (manifest.runId !== runId) throw new Error('immutable bundle belongs to a different run ID');
    artifacts = manifest.artifacts;
    const candidateProvenance = manifest.candidateProvenance;
    if (!candidateProvenance || Object.keys(candidateProvenance).length !== 3)
      throw new Error('bundle manifest candidate provenance is missing or incomplete');
    for (const name of ['cloud', 'relayfile', 'relayfile-cloud']) {
      const provenance = candidateProvenance[name];
      if (
        !provenance ||
        provenance.name !== name ||
        typeof provenance.repo !== 'string' ||
        !/^[0-9a-f]{40}$/.test(provenance.head ?? '') ||
        provenance.clean !== true ||
        provenance.archive !== artifacts?.[name]?.archive ||
        provenance.sha256 !== artifacts?.[name]?.sha256
      )
        throw new Error(`bundle manifest candidate provenance is invalid for ${name}`);
    }
    for (const [name, value] of Object.entries(artifacts)) {
      const source = path.join(bundleDir, value.archive);
      if ((await sha256(source)) !== value.sha256)
        throw new Error(`bundle ${name} archive hash does not match bundle manifest`);
      const destination = path.join(context, value.archive);
      await cp(source, destination);
      const copiedHash = await sha256(destination);
      if (copiedHash !== value.sha256)
        throw new Error(`copied ${name} archive hash does not match bundle manifest`);
    }
    if (!manifest.relayfileMount?.file || !manifest.relayfileMount?.sha256)
      throw new Error('bundle manifest does not contain the pinned linux relayfile-mount binary');
    const mountSource = path.join(bundleDir, manifest.relayfileMount.file);
    const mountDestination = path.join(context, manifest.relayfileMount.file);
    await cp(mountSource, mountDestination);
    if ((await sha256(mountDestination)) !== manifest.relayfileMount.sha256)
      throw new Error('copied relayfile-mount binary hash does not match bundle manifest');
    await cp(new URL('./issue-490-probe.mjs', import.meta.url), path.join(context, 'issue-490-probe.mjs'));
    await cp(
      new URL('./probe-diagnostics.mjs', import.meta.url),
      path.join(context, 'probe-diagnostics.mjs')
    );
    const artifactHashes = Object.fromEntries(
      Object.entries(artifacts).map(([name, value]) => [name, value.sha256])
    );
    checkpoint(
      `DAYTONA_CHECKPOINT run_id=${runId} name=${sandboxName} cloud_sha256=${artifactHashes.cloud} relayfile_sha256=${artifactHashes.relayfile} relayfile_cloud_sha256=${artifactHashes['relayfile-cloud']}`
    );
    if (!(await verifyAbsent(sandboxName)))
      throw new Error(`generated sandbox name already exists: ${sandboxName}`);
    const dockerfile = path.join(context, 'Dockerfile');
    await writeFile(
      dockerfile,
      `FROM ${image}\nUSER root\nRUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends procps ca-certificates curl && rm -rf /var/lib/apt/lists/*\nRUN mkdir -p /qualification/cloud /qualification/relayfile /qualification/relayfile-cloud /qualification/relayfile-npm /tmp/relayfile-npm /tmp/mount-npm /qualification/bin\nCOPY cloud.tgz relayfile.tgz relayfile-cloud.tgz /tmp/\nCOPY issue-490-probe.mjs probe-diagnostics.mjs /qualification/relayfile-npm/\nRUN tar -xzf /tmp/cloud.tgz -C /qualification/cloud && tar -xzf /tmp/relayfile.tgz -C /qualification/relayfile && tar -xzf /tmp/relayfile-cloud.tgz -C /qualification/relayfile-cloud && cd /qualification/cloud && npm ci --no-audit --no-fund && cd /qualification/relayfile-cloud && npm ci --no-audit --no-fund && npm pack relayfile@${npmVersion} --pack-destination /tmp/relayfile-npm >/dev/null && test \"$(sha256sum /tmp/relayfile-npm/relayfile-${npmVersion}.tgz | cut -d' ' -f1)\" = \"${npmTarballSha256}\" && npm pack @relayfile/mount-linux-x64@${npmVersion} --pack-destination /tmp/mount-npm >/dev/null && test \"$(sha256sum /tmp/mount-npm/relayfile-mount-linux-x64-${npmVersion}.tgz | cut -d' ' -f1)\" = \"${mountTarballSha256}\" && curl -fsSL https://github.com/AgentWorkforce/relayfile/releases/download/v${npmVersion}/release-attestation.json -o /tmp/release-attestation.json && test \"$(sha256sum /tmp/release-attestation.json | cut -d' ' -f1)\" = \"${releaseAttestationSha256}\" && node -e \"if (require('/tmp/release-attestation.json').sourceSha !== '${npmSourceSha}') process.exit(1)\" && npm install --prefix /qualification/relayfile-npm --ignore-scripts --no-audit --no-fund /tmp/relayfile-npm/relayfile-${npmVersion}.tgz /tmp/mount-npm/relayfile-mount-linux-x64-${npmVersion}.tgz && test \"$(node -p \"require('/qualification/relayfile-npm/node_modules/relayfile/package.json').version\")\" = \"${npmVersion}\" && test -x /qualification/relayfile-npm/node_modules/@relayfile/mount-linux-x64/bin/relayfile-mount\n`.replace(
        '&& cd /qualification/cloud && npm ci --no-audit --no-fund && cd /qualification/relayfile-cloud',
        '&& cd /qualification/cloud && npm ci --no-audit --no-fund && npm run build:platform && npm run build:core && cd /qualification/relayfile-cloud'
      )
    );
    createAttempted = true;
    const create = await run(
      'daytona',
      [
        'create',
        '--name',
        sandboxName,
        '--dockerfile',
        dockerfile,
        '--context',
        context,
        '--cpu',
        process.env.RELAYFILE_DAYTONA_CPU ?? '2',
        '--memory',
        daytonaMemoryGiB,
        '--disk',
        process.env.RELAYFILE_DAYTONA_DISK_GIB ?? '10',
        '--ttl',
        process.env.RELAYFILE_DAYTONA_TTL_MINUTES ?? '90',
      ],
      { timeoutMs: 900_000 }
    );
    created = create.exitCode === 0;
    if (!created) throw new Error(`Daytona create failed: ${redactEnvAssignments(create.stderr)}`);
    const sandbox = await parseInfo(sandboxName);
    sandboxId = sandbox.id;
    checkpoint(
      `DAYTONA_CHECKPOINT run_id=${runId} id=${sandboxId} name=${sandboxName} cloud_sha256=${artifacts.cloud.sha256} relayfile_sha256=${artifacts.relayfile.sha256} relayfile_cloud_sha256=${artifacts['relayfile-cloud'].sha256}`
    );
    const cold = await runDaytona(
      [
        'exec',
        sandboxId,
        '--cwd',
        '/qualification/relayfile-cloud',
        '--',
        'env',
        'RELAYFILE_QUALIFICATION_MODE=candidate',
        'RELAYFILE_CLOUD_REPO=/qualification/relayfile-cloud',
        'RELAYFILE_MOUNT_BINARY=/qualification/relayfile-npm/node_modules/@relayfile/mount-linux-x64/bin/relayfile-mount',
        'RELAYFILE_EVIDENCE_PATH=/tmp/cold-mount-evidence.json',
        'node_modules/.bin/tsx',
        'local/cold-mount-scale.ts',
      ],
      { timeoutMs: 900_000 }
    );
    if (cold.exitCode !== 0) throw new Error(`cold-mount-scale failed: ${redactEnvAssignments(cold.stderr)}`);
    const coldRead = await runDaytona(['exec', sandboxId, '--', 'cat', '/tmp/cold-mount-evidence.json']);
    if (coldRead.exitCode !== 0) throw new Error('cold-mount evidence could not be read back');
    const coldMount = JSON.parse(coldRead.stdout);
    const acl = await aclEvidence(sandboxId);
    const issue490 = await issue490Evidence(sandboxId);
    return {
      arm,
      runId,
      status: 'COMPLETE',
      sandbox: { id: sandboxId, name: sandboxName, fresh: true },
      artifactHashes,
      artifacts,
      candidateProvenance,
      publishedRelayfile: {
        package: 'relayfile',
        mountPackage: '@relayfile/mount-linux-x64',
        version: npmVersion,
        tarballSha256: npmTarballSha256,
        mountTarballSha256,
        sourceSha: npmSourceSha,
        releaseAttestationSha256,
        installed: true,
      },
      legs: { coldMount, acl, issue490 },
      cleanup: cleanupEvidence,
      checkpoints,
    };
  } finally {
    cleanupEvidence.attempted = createAttempted;
    cleanupEvidence.createAttempted = createAttempted;
    if (createAttempted) {
      const target = sandboxId || sandboxName;
      await run('daytona', ['delete', target], { timeoutMs: 120_000 });
      // A create request may have succeeded server-side even when its CLI
      // process timed out or returned non-zero. Always probe the generated
      // name after the delete attempt and treat a proven absence as cleanup.
      cleanupEvidence.sandboxAbsent = await verifyAbsent(target);
      cleanupEvidence.inventoryAbsent = await verifyAbsent(sandboxName);
      checkpoint(
        `DAYTONA_CLEANUP run_id=${runId} verified_absent=${cleanupEvidence.sandboxAbsent && cleanupEvidence.inventoryAbsent} id=${sandboxId || 'unresolved'} name=${sandboxName} cloud_sha256=${artifacts?.cloud?.sha256 ?? 'unknown'} relayfile_sha256=${artifacts?.relayfile?.sha256 ?? 'unknown'} relayfile_cloud_sha256=${artifacts?.['relayfile-cloud']?.sha256 ?? 'unknown'}`
      );
    }
    try {
      await rm(scratch, { recursive: true, force: true });
    } catch {
      cleanupEvidence.scratchAbsent = false;
    }
    cleanupEvidence.scratchAbsent = await access(scratch)
      .then(() => false)
      .catch(() => true);
    checkpoint(
      `DAYTONA_LOCAL_CLEANUP run_id=${runId} verified_absent=${cleanupEvidence.scratchAbsent} path=${scratch} cloud_sha256=${artifacts?.cloud?.sha256 ?? 'unknown'} relayfile_sha256=${artifacts?.relayfile?.sha256 ?? 'unknown'} relayfile_cloud_sha256=${artifacts?.['relayfile-cloud']?.sha256 ?? 'unknown'}`
    );
    try {
      await rm(context, { recursive: true, force: true });
    } catch {
      cleanupEvidence.contextAbsent = false;
    }
    cleanupEvidence.contextAbsent = await access(context)
      .then(() => false)
      .catch(() => true);
    checkpoint(
      `DAYTONA_CONTEXT_CLEANUP run_id=${runId} verified_absent=${cleanupEvidence.contextAbsent} path=${context} cloud_sha256=${artifacts?.cloud?.sha256 ?? 'unknown'} relayfile_sha256=${artifacts?.relayfile?.sha256 ?? 'unknown'} relayfile_cloud_sha256=${artifacts?.['relayfile-cloud']?.sha256 ?? 'unknown'}`
    );
  }
}

try {
  const report = await main();
  await writeReport(report);
  console.log(`ARM_${arm}_COMPLETE sandbox=${report.sandbox.id}`);
} catch (error) {
  await writeBlocked(error instanceof Error ? error.message : String(error), {
    cleanup: cleanupEvidence,
    checkpoints,
  });
  process.exitCode = 1;
}
