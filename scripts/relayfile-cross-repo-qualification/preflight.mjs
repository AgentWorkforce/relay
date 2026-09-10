#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { PROBES, PROBE_KILL_SIGNAL, PROBE_TIMEOUT_MS, redactProbeEvidence, runProbe } from './probes.mjs';
const execFileAsync = promisify(execFile);
const probeOptions = { timeout: PROBE_TIMEOUT_MS, killSignal: PROBE_KILL_SIGNAL };
const artifactDir =
  process.env.RELAYFILE_QUALIFICATION_ARTIFACT_DIR ??
  '.workflow-artifacts/relayfile-cross-repo-qualification';
const runId = process.env.RELAYFILE_QUALIFICATION_RUN_ID ?? '';
const gate = process.env.RELAYFILE_QUALIFICATION_CREATE_SANDBOXES === '1';
const npmVersion = process.env.RELAYFILE_QUALIFICATION_NPM_VERSION?.trim() ?? '';
const npmTarballSha256 = process.env.RELAYFILE_QUALIFICATION_NPM_TARBALL_SHA256?.trim() ?? '';
const npmSourceSha = process.env.RELAYFILE_QUALIFICATION_NPM_SOURCE_SHA?.trim() ?? '';
const candidates = {
  cloud: process.env.RELAY_CLOUD_REPO ?? process.env.RELAYFILE_CLOUD_CANDIDATE ?? '../cloud',
  relayfile: process.env.RELAYFILE_REPO ?? '../relayfile',
  'relayfile-cloud': process.env.RELAYFILE_CLOUD_REPO ?? '../relayfile-cloud',
};
const required = {
  cloud: ['package.json', 'tests/relay-workspace-acl-backpressure.test.ts'],
  relayfile: ['go.mod', 'cmd/relayfile-mount'],
  'relayfile-cloud': [
    'package.json',
    'local/cold-mount-scale.ts',
    'local/cold-mount-fixture.ts',
    'local/harness.ts',
    'local/e2e.test.ts',
    'packages/relayfile/test/acl-control-admission.test.ts',
    'tests/relayflows/cases/workspace-acl-provisioning-admission/run.mjs',
  ],
};
const failures = [];
const modelProbes = [];
if (new Set(Object.values(candidates).map((candidate) => path.resolve(candidate))).size !== 3)
  failures.push('cloud, relayfile, and relayfile-cloud candidates must be three distinct paths');
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(runId)) failures.push('run ID is missing or unsafe');
for (const [name, candidate] of Object.entries(candidates)) {
  try {
    await access(candidate);
  } catch {
    failures.push(`${name} candidate directory is unavailable: ${candidate}`);
    continue;
  }
  for (const relative of required[name])
    try {
      await access(path.join(candidate, relative));
    } catch {
      failures.push(`${name} required path is missing: ${relative}`);
    }
}
if (gate) {
  if (!/^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/.test(npmVersion)) failures.push('RELAYFILE_QUALIFICATION_NPM_VERSION must be an exact prerelease semver');
  if (!/^[0-9a-f]{64}$/.test(npmTarballSha256)) failures.push('RELAYFILE_QUALIFICATION_NPM_TARBALL_SHA256 must be a 64-hex digest');
  if (!/^[0-9a-f]{40}$/.test(npmSourceSha)) failures.push('RELAYFILE_QUALIFICATION_NPM_SOURCE_SHA must be a full 40-hex commit');
  // These real model/auth probes must complete before any Daytona API call or
  // bundle step can run. Version checks alone falsely report unauthenticated
  // or unsupported model configurations as ready.
  for (const probe of PROBES) {
    const result = await runProbe(probe, { timeoutMs: PROBE_TIMEOUT_MS });
    const failure = result.ok ? undefined : redactProbeEvidence(result.failure);
    modelProbes.push({
      name: probe.name,
      model: probe.model,
      timeoutMs: PROBE_TIMEOUT_MS,
      ok: result.ok,
      ...(result.ok ? {} : { failure }),
    });
    if (!result.ok) failures.push(failure);
  }
  const image = process.env.RELAYFILE_QUALIFICATION_DAYTONA_IMAGE?.trim() ?? '';
  if (!image) failures.push('RELAYFILE_QUALIFICATION_DAYTONA_IMAGE is required');
  else if (!/@sha256:[0-9a-f]{64}$/i.test(image))
    failures.push('RELAYFILE_QUALIFICATION_DAYTONA_IMAGE must be digest-pinned');
  try {
    await execFileAsync('daytona', ['version'], probeOptions);
    await execFileAsync('daytona', ['list', '--format', 'json', '--limit', '1'], probeOptions);
  } catch {
    failures.push('daytona CLI is unavailable or stored login is unauthenticated');
  }
}
try {
  for (const name of await readdir(artifactDir)) {
    if (!name.endsWith('.json') || name === 'preflight.json') continue;
    try {
      const value = JSON.parse(await readFile(path.join(artifactDir, name), 'utf8'));
      if (value.runId && value.runId !== runId)
        failures.push(`stale artifact ${name} belongs to run ${value.runId}`);
      if (!value.runId) failures.push(`stale artifact ${name} has no run ID`);
    } catch {
      failures.push(`artifact ${name} is not valid JSON`);
    }
  }
} catch {
  /* first run */
}
if (!gate) {
  for (const probe of PROBES) {
    modelProbes.push({
      name: probe.name,
      model: probe.model,
      timeoutMs: PROBE_TIMEOUT_MS,
      ok: false,
      failure: 'probe skipped because sandbox creation is disabled',
    });
  }
}
await mkdir(artifactDir, { recursive: true });
const result = {
  version: 1,
  runId,
  status: failures.length === 0 && gate ? 'READY' : 'BLOCKED',
  sandboxCreationAuthorized: gate,
  candidates,
  required,
  modelProbes,
  publishedRelayfile: { package: 'relayfile', version: npmVersion, tarballSha256: npmTarballSha256, sourceSha: npmSourceSha, installed: false },
  failures,
  note: gate
    ? 'Preflight proved candidate paths, CLI, auth, image, and run freshness.'
    : 'Daytona creation is disabled; this is a dry-run evidence record.',
};
await writeFile(path.join(artifactDir, 'preflight.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(`QUALIFICATION_PREFLIGHT ${result.status}`);
for (const failure of failures) console.log(`QUALIFICATION_PREFLIGHT_FAILURE ${failure}`);
process.exitCode = 0;
