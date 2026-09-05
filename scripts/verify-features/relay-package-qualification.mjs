#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateCandidateInstallAttestation,
  validateCandidateLockfile,
} from './relay-candidate-install.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '../..');
const EXTERNAL_PINS = path.join(ROOT, 'tests/relayflows/cleanroom/snapshot-external-package-pins.json');

export const RELAY_PACKAGE_PRODUCER = Object.freeze({
  repository: 'AgentWorkforce/relay',
  workflow: 'Relay package qualification',
  workflowPath: '.github/workflows/relay-package-qualification.yml',
  event: 'workflow_dispatch',
  ref: 'main',
});

export const RELAY_PACKAGE_POLICY = Object.freeze({
  artifact: 'relay-package-qualification',
  file: 'relay-package-attestation.json',
  attestationArtifact: 'relay-package-qualification-attestation',
  attestationFile: 'relay-package-qualification-attestation.json',
});

const PACKAGE_NAMES = Object.freeze([
  'agent-relay',
  '@agent-relay/agent',
  '@agent-relay/config',
  '@agent-relay/credential-proxy',
  '@agent-relay/events',
  '@agent-relay/sandbox',
  '@agent-relay/sdk',
]);
const SOURCE_PACKAGE_NAMES = Object.freeze(['agent-relay', '@agent-relay/config', '@agent-relay/sdk']);
const EXTERNAL_PACKAGE_NAMES = Object.freeze([
  '@agent-relay/agent',
  '@agent-relay/credential-proxy',
  '@agent-relay/events',
  '@agent-relay/sandbox',
]);
const EXACT_SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const EXACT_PRERELEASE_SEMVER =
  /^[0-9]+\.[0-9]+\.[0-9]+-[0-9A-Za-z](?:[0-9A-Za-z.-]*[0-9A-Za-z])?(?:\+[0-9A-Za-z.-]+)?$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const ARTIFACT_DIGEST = /^sha256:[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.join('\0') !== expected.join('\0')) {
    throw new Error(`${label} must contain exactly: ${expected.join(', ')}`);
  }
}

function requireExactVersions(packages, names, label) {
  exactKeys(packages, names, label);
  for (const name of names) {
    if (!EXACT_SEMVER.test(packages[name])) throw new Error(`${label}.${name} must be exact semver`);
  }
}

function validateProducer(producer) {
  exactKeys(
    producer,
    ['repository', 'workflow', 'workflowPath', 'event', 'ref', 'sourceGitSha', 'runId', 'runAttempt'],
    'producer'
  );
  for (const [key, expected] of Object.entries(RELAY_PACKAGE_PRODUCER)) {
    if (producer[key] !== expected) throw new Error(`producer.${key} must equal ${expected}`);
  }
  if (!GIT_SHA.test(producer.sourceGitSha)) throw new Error('producer.sourceGitSha must be 40 hex');
  if (!POSITIVE_INTEGER.test(String(producer.runId))) throw new Error('producer.runId is invalid');
  if (!POSITIVE_INTEGER.test(String(producer.runAttempt))) throw new Error('producer.runAttempt is invalid');
}

export function validateRelayPackagePayload(value) {
  exactKeys(value, ['schemaVersion', 'kind', 'producer', 'packages', 'registry', 'candidate'], 'payload');
  if (value.schemaVersion !== 2 || value.kind !== 'relayPackages') {
    throw new Error('payload schema/kind mismatch');
  }
  validateProducer(value.producer);
  requireExactVersions(value.packages, PACKAGE_NAMES, 'packages');
  if (value.packages['@agent-relay/config'] !== value.packages['@agent-relay/sdk']) {
    throw new Error('@agent-relay/config and @agent-relay/sdk must use one release line');
  }
  if (value.packages['agent-relay'] !== value.packages['@agent-relay/sdk']) {
    throw new Error('agent-relay and @agent-relay/sdk must use one release line');
  }
  exactKeys(value.registry, EXTERNAL_PACKAGE_NAMES, 'registry');
  for (const name of EXTERNAL_PACKAGE_NAMES) {
    const entry = value.registry[name];
    exactKeys(entry, ['version', 'integrity', 'shasum'], `registry.${name}`);
    if (
      entry.version !== value.packages[name] ||
      !SHA512_INTEGRITY.test(entry.integrity) ||
      !SHA1.test(entry.shasum)
    ) {
      throw new Error(`registry.${name} identity is invalid`);
    }
  }
  exactKeys(
    value.candidate,
    ['attestationFile', 'attestationSha256', 'lockfileFile', 'lockfileSha256', 'tarballDirectory'],
    'candidate'
  );
  if (
    value.candidate.attestationFile !== 'candidate-install-attestation.json' ||
    value.candidate.lockfileFile !== 'candidate-package-lock.json' ||
    value.candidate.tarballDirectory !== 'tarballs' ||
    !SHA256.test(value.candidate.attestationSha256) ||
    !SHA256.test(value.candidate.lockfileSha256)
  ) {
    throw new Error('candidate clean-install artifact identity is invalid');
  }
  return value;
}

export function validateRelayPackageEnvelope(value) {
  exactKeys(
    value,
    ['schemaVersion', 'kind', 'producer', 'packages', 'registry', 'candidate', 'payload'],
    'envelope'
  );
  validateRelayPackagePayload({
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    producer: value.producer,
    packages: value.packages,
    registry: value.registry,
    candidate: value.candidate,
  });
  exactKeys(value.payload, ['artifact', 'artifactDigest', 'file', 'fileSha256'], 'envelope.payload');
  if (
    value.payload.artifact !== RELAY_PACKAGE_POLICY.artifact ||
    value.payload.file !== RELAY_PACKAGE_POLICY.file ||
    !ARTIFACT_DIGEST.test(value.payload.artifactDigest) ||
    !SHA256.test(value.payload.fileSha256)
  ) {
    throw new Error('envelope payload identity is invalid');
  }
  return value;
}

function npmJson(args) {
  return JSON.parse(
    execFileSync('npm', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 16 * 1024 * 1024,
    })
  );
}

async function registryEvidence(packages) {
  const registry = {};
  for (const name of EXTERNAL_PACKAGE_NAMES) {
    const version = packages[name];
    const dist = npmJson(['view', `${name}@${version}`, 'dist', '--json']);
    if (!SHA512_INTEGRITY.test(dist?.integrity ?? '') || !SHA1.test(dist?.shasum ?? '')) {
      throw new Error(`${name}@${version} has no valid npm distribution integrity`);
    }
    registry[name] = { version, integrity: dist.integrity, shasum: dist.shasum };
  }
  return registry;
}

export function assertUnpublishedNpmView(result, name, version) {
  if (result?.status === 0) {
    throw new Error(`${name}@${version} is already published; candidate bytes require a unique version`);
  }
  const detail = `${result?.stderr ?? ''}\n${result?.stdout ?? ''}`;
  if (!/(?:E404|404 Not Found|is not in this registry)/i.test(detail)) {
    throw new Error(`could not prove ${name}@${version} is unpublished`);
  }
}

export function assertPrereleaseVersion(version) {
  if (!EXACT_PRERELEASE_SEMVER.test(version)) {
    throw new Error(`candidate version ${version} must be an exact prerelease semver`);
  }
}

async function verifyCandidateUnpublished() {
  const candidateAttestationPath = readFlag('--candidate-attestation');
  if (!candidateAttestationPath) throw new Error('--candidate-attestation is required');
  const candidate = validateCandidateInstallAttestation(
    JSON.parse(await readFile(path.resolve(candidateAttestationPath), 'utf8'))
  );
  assertPrereleaseVersion(candidate.packageVersion);
  for (const entry of candidate.packages) {
    const result = spawnSync('npm', ['view', `${entry.name}@${entry.version}`, 'version', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) throw result.error;
    assertUnpublishedNpmView(result, entry.name, entry.version);
  }
  process.stdout.write(
    `RELAY_CANDIDATE_VERSION_UNPUBLISHED version=${candidate.packageVersion} packages=${candidate.packages.length}\n`
  );
}

export async function verifyRelayPackageFiles(value, directory) {
  const payload = validateRelayPackagePayload(value);
  const root = path.resolve(directory);
  const expectedRootFiles = [
    RELAY_PACKAGE_POLICY.file,
    payload.candidate.attestationFile,
    payload.candidate.lockfileFile,
    'tarballs',
  ];
  const actualRootFiles = (await readdir(root)).sort();
  if (actualRootFiles.join('\0') !== expectedRootFiles.sort().join('\0')) {
    throw new Error('Relay package payload contains an unexpected file set');
  }
  for (const file of [
    RELAY_PACKAGE_POLICY.file,
    payload.candidate.attestationFile,
    payload.candidate.lockfileFile,
  ]) {
    const info = await lstat(path.join(root, file));
    if (!info.isFile()) throw new Error(`Relay package payload entry is not a regular file: ${file}`);
  }
  const tarballDirectoryInfo = await lstat(path.join(root, payload.candidate.tarballDirectory));
  if (!tarballDirectoryInfo.isDirectory()) {
    throw new Error('Relay package candidate tarballs entry is not a directory');
  }
  const candidateBytes = await readFile(path.join(root, payload.candidate.attestationFile));
  if (sha256(candidateBytes) !== payload.candidate.attestationSha256) {
    throw new Error('candidate clean-install attestation bytes changed');
  }
  const candidate = validateCandidateInstallAttestation(JSON.parse(candidateBytes.toString('utf8')), {
    sourceSha: payload.producer.sourceGitSha,
    packageVersion: payload.packages['agent-relay'],
  });
  if (candidate.platform !== 'linux' || candidate.arch !== 'x64') {
    throw new Error('candidate clean install must target linux-x64 snapshots');
  }
  const lockfileBytes = await readFile(path.join(root, payload.candidate.lockfileFile));
  if (
    sha256(lockfileBytes) !== payload.candidate.lockfileSha256 ||
    payload.candidate.lockfileSha256 !== candidate.lockfileSha256
  ) {
    throw new Error('candidate clean-install lockfile bytes changed');
  }
  validateCandidateLockfile(JSON.parse(lockfileBytes.toString('utf8')), candidate.packages);
  const candidateNames = new Set(candidate.packages.map((entry) => entry.name));
  for (const name of SOURCE_PACKAGE_NAMES) {
    if (!candidateNames.has(name)) throw new Error(`candidate clean install is missing ${name}`);
  }
  const tarballRoot = path.join(root, payload.candidate.tarballDirectory);
  const expectedTarballs = candidate.packages.map((entry) => entry.tarballFile).sort();
  const actualTarballs = (await readdir(tarballRoot)).sort();
  if (actualTarballs.join('\0') !== expectedTarballs.join('\0')) {
    throw new Error('candidate clean-install tarball set changed');
  }
  for (const entry of candidate.packages) {
    const tarballPath = path.join(tarballRoot, entry.tarballFile);
    const info = await lstat(tarballPath);
    if (!info.isFile()) throw new Error(`candidate tarball is not a regular file: ${entry.name}`);
    const bytes = await readFile(tarballPath);
    if (sha256(bytes) !== entry.tarballSha256) {
      throw new Error(`${entry.name} candidate tarball bytes changed`);
    }
  }
  return { payload, candidate };
}

async function packageVersions() {
  const [config, sdk, external] = await Promise.all([
    readFile(path.join(ROOT, 'packages/config/package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(ROOT, 'packages/sdk/package.json'), 'utf8').then(JSON.parse),
    readFile(EXTERNAL_PINS, 'utf8').then(JSON.parse),
  ]);
  if (external.schemaVersion !== 1) throw new Error('external pin schemaVersion must equal 1');
  requireExactVersions(external.packages, EXTERNAL_PACKAGE_NAMES, 'external packages');
  if (config.name !== '@agent-relay/config' || sdk.name !== '@agent-relay/sdk') {
    throw new Error('local SDK-line package names are invalid');
  }
  if (config.version !== sdk.version || !EXACT_SEMVER.test(config.version)) {
    throw new Error('local config and SDK versions must be the same exact semver');
  }
  return {
    'agent-relay': sdk.version,
    '@agent-relay/agent': external.packages['@agent-relay/agent'],
    '@agent-relay/config': config.version,
    '@agent-relay/credential-proxy': external.packages['@agent-relay/credential-proxy'],
    '@agent-relay/events': external.packages['@agent-relay/events'],
    '@agent-relay/sandbox': external.packages['@agent-relay/sandbox'],
    '@agent-relay/sdk': sdk.version,
  };
}

function readFlag(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function writeJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function createPayload() {
  const output = readFlag('--output');
  const sourceGitSha = readFlag('--source-sha');
  const runId = readFlag('--run-id');
  const runAttempt = readFlag('--run-attempt');
  const candidateAttestationPath = readFlag('--candidate-attestation');
  const candidateTarballsPath = readFlag('--candidate-tarballs');
  if (!output || !candidateAttestationPath || !candidateTarballsPath) {
    throw new Error('--output, --candidate-attestation, and --candidate-tarballs are required');
  }
  const packages = await packageVersions();
  const outputPath = path.resolve(output);
  const outputDirectory = path.dirname(outputPath);
  const candidateBytes = await readFile(path.resolve(candidateAttestationPath));
  const candidate = validateCandidateInstallAttestation(JSON.parse(candidateBytes.toString('utf8')), {
    sourceSha: sourceGitSha,
    packageVersion: packages['agent-relay'],
  });
  if (candidate.platform !== 'linux' || candidate.arch !== 'x64') {
    throw new Error('package qualification must be produced on linux-x64');
  }
  const payload = validateRelayPackagePayload({
    schemaVersion: 2,
    kind: 'relayPackages',
    producer: { ...RELAY_PACKAGE_PRODUCER, sourceGitSha, runId, runAttempt },
    packages,
    registry: await registryEvidence(packages),
    candidate: {
      attestationFile: 'candidate-install-attestation.json',
      attestationSha256: sha256(candidateBytes),
      lockfileFile: candidate.lockfileFile,
      lockfileSha256: candidate.lockfileSha256,
      tarballDirectory: 'tarballs',
    },
  });
  await mkdir(path.join(outputDirectory, 'tarballs'), { recursive: true });
  await copyFile(
    path.resolve(candidateAttestationPath),
    path.join(outputDirectory, payload.candidate.attestationFile)
  );
  await copyFile(
    path.join(path.dirname(path.resolve(candidateAttestationPath)), candidate.lockfileFile),
    path.join(outputDirectory, payload.candidate.lockfileFile)
  );
  for (const entry of candidate.packages) {
    await copyFile(
      path.join(path.resolve(candidateTarballsPath), entry.tarballFile),
      path.join(outputDirectory, payload.candidate.tarballDirectory, entry.tarballFile)
    );
  }
  await writeJson(outputPath, payload);
  await verifyRelayPackageFiles(payload, outputDirectory);
}

async function createEnvelope() {
  const payloadPath = readFlag('--payload');
  const artifactDigest = readFlag('--artifact-digest');
  const output = readFlag('--output');
  if (!payloadPath || !output) throw new Error('--payload and --output are required');
  const payloadBytes = await readFile(path.resolve(payloadPath));
  const payload = validateRelayPackagePayload(JSON.parse(payloadBytes.toString('utf8')));
  const envelope = validateRelayPackageEnvelope({
    ...payload,
    payload: {
      artifact: RELAY_PACKAGE_POLICY.artifact,
      artifactDigest,
      file: RELAY_PACKAGE_POLICY.file,
      fileSha256: sha256(payloadBytes),
    },
  });
  await writeJson(path.resolve(output), envelope);
}

async function validateFile() {
  const target = readFlag('--file');
  const kind = readFlag('--kind');
  if (!target || !['payload', 'envelope'].includes(kind)) {
    throw new Error('validate requires --kind payload|envelope --file <json>');
  }
  const value = JSON.parse(await readFile(path.resolve(target), 'utf8'));
  if (kind === 'payload') validateRelayPackagePayload(value);
  else validateRelayPackageEnvelope(value);
}

async function verifyFiles() {
  const target = readFlag('--file');
  const directory = readFlag('--directory');
  if (!target || !directory) throw new Error('verify-files requires --file and --directory');
  await verifyRelayPackageFiles(
    JSON.parse(await readFile(path.resolve(target), 'utf8')),
    path.resolve(directory)
  );
}

async function main() {
  const action = process.argv[2];
  if (action === 'create-payload') return createPayload();
  if (action === 'create-envelope') return createEnvelope();
  if (action === 'validate') return validateFile();
  if (action === 'verify-files') return verifyFiles();
  if (action === 'verify-candidate-unpublished') return verifyCandidateUnpublished();
  throw new Error(`unknown action ${JSON.stringify(action)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export { PACKAGE_NAMES };
