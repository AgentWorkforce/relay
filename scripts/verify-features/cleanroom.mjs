#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { overwriteRegularFileNoFollow, readRegularFileNoFollow } from './safe-file.mjs';

const CONTRACT_VERSION = 1;
const NONCE_RE = /^[0-9a-f]{32}$/;
const SAFE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const STORAGE_PART_RE = /^[A-Za-z0-9._-]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_OUTPUT_BYTES = 8 * 1024;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const EVIDENCE_RANK = Object.freeze({ static: 0, contract: 1, integration: 2, fault: 3 });
const REVIEW_VERDICTS = new Set(['COMPREHENSIVELY_SATISFIED', 'FINDINGS', 'BLOCKED']);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MATRIX = path.resolve(SCRIPT_DIR, '../../tests/relayflows/cleanroom/relay.matrix.json');
const DEFAULT_ARTIFACT_ROOT = path.resolve('.workflow-artifacts/verify-cleanroom');

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected positional argument: ${token}`);
    const key = token.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) options[key] = true;
    else {
      options[key] = value;
      index += 1;
    }
  }
  return { command, options };
}

function requiredOption(options, name) {
  const value = options[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`--${name} is required`);
  return value.trim();
}

function assertSafeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value)) {
    throw new Error(`${label} must match ${SAFE_ID_RE}`);
  }
  return value;
}

function assertNonce(value) {
  if (!NONCE_RE.test(value ?? '')) throw new Error('nonce must be 32 lowercase hexadecimal characters');
  return value;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertStringArray(value, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} must be ${allowEmpty ? 'an' : 'a non-empty'} array`);
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim()) throw new Error(`${label} contains an invalid string`);
  }
  return value;
}

export function parseFeatureManifest(source) {
  if (typeof source !== 'string') throw new Error('feature manifest source must be a string');
  const categories = [];
  let inCategories = false;
  let current = null;
  for (const line of source.split(/\r?\n/)) {
    if (line === 'categories:') {
      inCategories = true;
      current = null;
      continue;
    }
    if (!inCategories) continue;
    const category = line.match(/^  ([a-z0-9-]+):\s*$/);
    if (category) {
      current = { id: category[1], criticality: null, features: [] };
      categories.push(current);
      continue;
    }
    if (!current) continue;
    const criticality = line.match(/^    criticality:\s*(critical|hot|standard)\s*$/);
    if (criticality) {
      current.criticality = criticality[1];
      continue;
    }
    const feature = line.match(/^      - id:\s*([a-z0-9-]+)\s*$/);
    if (feature) current.features.push(feature[1]);
  }
  if (categories.length === 0) throw new Error('feature manifest has no top-level categories');
  const seen = new Set();
  for (const category of categories) {
    if (!category.criticality) throw new Error(`feature category ${category.id} has no criticality`);
    if (category.features.length === 0) throw new Error(`feature category ${category.id} has no features`);
    for (const feature of category.features) {
      if (seen.has(feature)) throw new Error(`duplicate feature id: ${feature}`);
      seen.add(feature);
    }
  }
  return categories;
}

function validateCommandSpec(spec, label, profileIds) {
  assertPlainObject(spec, label);
  assertSafeId(spec.id, `${label}.id`);
  if (!Array.isArray(spec.command) || spec.command.length === 0) {
    throw new Error(`${label}.command must be a non-empty argv array`);
  }
  for (const argument of spec.command) {
    if (typeof argument !== 'string' || argument.includes('\0')) {
      throw new Error(`${label}.command contains an invalid argument`);
    }
  }
  if (!Number.isSafeInteger(spec.timeoutSeconds) || spec.timeoutSeconds < 1 || spec.timeoutSeconds > 7200) {
    throw new Error(`${label}.timeoutSeconds must be an integer from 1 to 7200`);
  }
  for (const key of ['requiredCommands', 'requiredEnvironment', 'mustContain', 'forbidOutput']) {
    if (spec[key] !== undefined) assertStringArray(spec[key], `${label}.${key}`);
  }
  if (spec.environment !== undefined) {
    assertPlainObject(spec.environment, `${label}.environment`);
    for (const [key, value] of Object.entries(spec.environment)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string') {
        throw new Error(`${label}.environment contains an invalid entry`);
      }
    }
  }
  if (spec.profiles !== undefined) {
    for (const profile of assertStringArray(spec.profiles, `${label}.profiles`, { allowEmpty: false })) {
      if (!profileIds.has(profile)) throw new Error(`${label} references unknown profile ${profile}`);
    }
  }
}

function validateLaneScopedSetup(spec, label) {
  const serialized = JSON.stringify(spec);
  for (const attemptVariable of ['runRoot', 'home', 'projectRoot', 'resultRoot']) {
    if (serialized.includes(`{{${attemptVariable}}}`)) {
      throw new Error(
        `${label} uses attempt-scoped {{${attemptVariable}}}; persistent setup resources must use {{laneRoot}} or {{fixtureRoot}}`
      );
    }
  }
}

export function validateMatrix(matrix, featureCategories) {
  assertPlainObject(matrix, 'matrix');
  if (matrix.version !== CONTRACT_VERSION) throw new Error(`matrix.version must be ${CONTRACT_VERSION}`);
  if (typeof matrix.product !== 'string' || !matrix.product.trim())
    throw new Error('matrix.product is required');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(matrix.repository ?? '')) {
    throw new Error('matrix.repository must be owner/name');
  }
  if (!Number.isSafeInteger(matrix.recentMergeDays) || matrix.recentMergeDays < 1) {
    throw new Error('matrix.recentMergeDays must be a positive integer');
  }
  for (const [name, relativePath] of Object.entries(matrix.isolatedEnvironment ?? {})) {
    if (
      !/^[A-Z][A-Z0-9_]*$/.test(name) ||
      typeof relativePath !== 'string' ||
      !relativePath ||
      path.isAbsolute(relativePath) ||
      relativePath.split(/[\\/]/).includes('..')
    ) {
      throw new Error(`matrix.isolatedEnvironment.${name} must be a safe relative path`);
    }
  }
  for (const [name, value] of Object.entries(matrix.environmentDefaults ?? {})) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || typeof value !== 'string') {
      throw new Error(`matrix.environmentDefaults.${name} is invalid`);
    }
  }
  for (const [name, relativePath] of Object.entries(matrix.artifacts ?? {})) {
    if (
      !SAFE_ID_RE.test(name) ||
      typeof relativePath !== 'string' ||
      !relativePath ||
      path.isAbsolute(relativePath) ||
      relativePath.split(/[\\/]/).includes('..')
    ) {
      throw new Error(`matrix.artifacts.${name} must be a safe relative path`);
    }
  }
  const profiles = assertPlainObject(matrix.profiles, 'matrix.profiles');
  const profileIds = new Set(Object.keys(profiles));
  if (profileIds.size === 0) throw new Error('matrix.profiles must not be empty');
  const policy = assertPlainObject(matrix.evidencePolicy, 'matrix.evidencePolicy');
  for (const criticality of ['critical', 'hot', 'standard']) {
    if (!(policy[criticality] in EVIDENCE_RANK)) {
      throw new Error(`matrix.evidencePolicy.${criticality} is invalid`);
    }
  }
  const lanes = matrix.lanes;
  if (!Array.isArray(lanes) || lanes.length === 0) throw new Error('matrix.lanes must be non-empty');
  const declaredCategories = new Set(featureCategories.map(({ id }) => id));
  const featureToCategory = new Map(
    featureCategories.flatMap(({ id, features }) => features.map((feature) => [feature, id]))
  );
  const laneIds = new Set();
  const scenarioIds = new Set();
  const explicitlyRoutedIssues = new Map();
  const assignedCategories = new Map();
  let fallbackCount = 0;
  for (const lane of lanes) {
    assertPlainObject(lane, 'lane');
    assertSafeId(lane.id, 'lane.id');
    if (laneIds.has(lane.id)) throw new Error(`duplicate lane id: ${lane.id}`);
    laneIds.add(lane.id);
    assertStringArray(lane.featureCategories, `lane ${lane.id}.featureCategories`);
    assertStringArray(lane.issueMatch, `lane ${lane.id}.issueMatch`);
    assertStringArray(lane.requiredArtifacts ?? [], `lane ${lane.id}.requiredArtifacts`);
    for (const artifact of lane.requiredArtifacts ?? []) {
      if (!Object.hasOwn(matrix.artifacts ?? {}, artifact)) {
        throw new Error(`lane ${lane.id} requires unknown artifact ${artifact}`);
      }
    }
    if (!Number.isSafeInteger(lane.routingPriority ?? 0)) {
      throw new Error(`lane ${lane.id}.routingPriority must be an integer`);
    }
    if (!Array.isArray(lane.issueNumbers ?? [])) {
      throw new Error(`lane ${lane.id}.issueNumbers must be an array`);
    }
    for (const issue of lane.issueNumbers ?? []) {
      if (!Number.isSafeInteger(issue) || issue < 1) {
        throw new Error(`lane ${lane.id}.issueNumbers must contain positive integers`);
      }
      if (explicitlyRoutedIssues.has(issue)) {
        throw new Error(`issue #${issue} is explicitly routed to multiple lanes`);
      }
      explicitlyRoutedIssues.set(issue, lane.id);
    }
    if (lane.fallbackIssues === true) fallbackCount += 1;
    for (const category of lane.featureCategories) {
      if (assignedCategories.has(category)) {
        throw new Error(`feature category ${category} is assigned to multiple lanes`);
      }
      assignedCategories.set(category, lane.id);
    }
    if (!Array.isArray(lane.setup)) throw new Error(`lane ${lane.id}.setup must be an array`);
    lane.setup.forEach((step, index) => {
      const label = `lane ${lane.id}.setup[${index}]`;
      validateCommandSpec(step, label, profileIds);
      validateLaneScopedSetup(step, label);
    });
    if (!Array.isArray(lane.scenarios) || lane.scenarios.length === 0) {
      throw new Error(`lane ${lane.id}.scenarios must be non-empty`);
    }
    for (const [index, scenario] of lane.scenarios.entries()) {
      assertPlainObject(scenario, `lane ${lane.id}.scenarios[${index}]`);
      assertSafeId(scenario.id, `lane ${lane.id}.scenarios[${index}].id`);
      if (scenarioIds.has(scenario.id)) throw new Error(`duplicate scenario id: ${scenario.id}`);
      scenarioIds.add(scenario.id);
      const kind = scenario.kind ?? 'command';
      if (!['command', 'coverage-gap', 'relayflow-corpus'].includes(kind)) {
        throw new Error(`scenario ${scenario.id} has unsupported kind ${kind}`);
      }
      if (!(scenario.evidence in EVIDENCE_RANK))
        throw new Error(`scenario ${scenario.id} has invalid evidence`);
      if (kind === 'command') validateCommandSpec(scenario, `scenario ${scenario.id}`, profileIds);
      else {
        if (
          kind === 'relayflow-corpus' &&
          (!Number.isSafeInteger(scenario.timeoutSeconds) || scenario.timeoutSeconds < 1)
        ) {
          throw new Error(`scenario ${scenario.id}.timeoutSeconds must be positive`);
        }
        if (scenario.profiles !== undefined) {
          for (const profile of assertStringArray(scenario.profiles, `scenario ${scenario.id}.profiles`)) {
            if (!profileIds.has(profile))
              throw new Error(`scenario ${scenario.id} references unknown profile ${profile}`);
          }
        }
        if (kind === 'coverage-gap' && (typeof scenario.reason !== 'string' || !scenario.reason.trim())) {
          throw new Error(`coverage-gap scenario ${scenario.id} requires a reason`);
        }
      }
      if (scenario.coversCategories !== undefined) {
        assertStringArray(scenario.coversCategories, `scenario ${scenario.id}.coversCategories`);
      }
      for (const category of scenario.coversCategories ?? []) {
        if (!lane.featureCategories.includes(category)) {
          throw new Error(`scenario ${scenario.id} covers category ${category} outside its lane`);
        }
      }
      if (scenario.coversFeatures !== undefined) {
        assertStringArray(scenario.coversFeatures, `scenario ${scenario.id}.coversFeatures`);
        for (const feature of scenario.coversFeatures) {
          const category = featureToCategory.get(feature);
          if (!category) throw new Error(`scenario ${scenario.id} covers unknown feature ${feature}`);
          if (!lane.featureCategories.includes(category)) {
            throw new Error(`scenario ${scenario.id} covers feature ${feature} outside its lane`);
          }
        }
      }
      if (scenario.issues !== undefined) {
        if (
          !Array.isArray(scenario.issues) ||
          scenario.issues.some((value) => !Number.isSafeInteger(value))
        ) {
          throw new Error(`scenario ${scenario.id}.issues must contain integers`);
        }
      }
      if (scenario.merges !== undefined) {
        if (
          !Array.isArray(scenario.merges) ||
          scenario.merges.some((value) => !Number.isSafeInteger(value))
        ) {
          throw new Error(`scenario ${scenario.id}.merges must contain integers`);
        }
      }
      for (const proofFlag of ['provesIssues', 'provesMerges']) {
        if (scenario[proofFlag] !== undefined && typeof scenario[proofFlag] !== 'boolean') {
          throw new Error(`scenario ${scenario.id}.${proofFlag} must be boolean`);
        }
      }
    }
  }
  if (fallbackCount !== 1) throw new Error('exactly one lane must set fallbackIssues');
  for (const category of declaredCategories) {
    if (!assignedCategories.has(category))
      throw new Error(`feature category ${category} is not assigned to a lane`);
  }
  for (const category of assignedCategories.keys()) {
    if (!declaredCategories.has(category))
      throw new Error(`matrix assigns unknown feature category ${category}`);
  }
  for (const [profileId, profile] of Object.entries(profiles)) {
    assertPlainObject(profile, `profile ${profileId}`);
    const enabledLanes = assertStringArray(profile.lanes, `profile ${profileId}.lanes`, {
      allowEmpty: false,
    });
    if (new Set(enabledLanes).size !== enabledLanes.length)
      throw new Error(`profile ${profileId} repeats a lane`);
    for (const lane of enabledLanes) {
      if (!laneIds.has(lane)) throw new Error(`profile ${profileId} references unknown lane ${lane}`);
    }
    if (
      !Number.isSafeInteger(profile.defaultRepeats) ||
      profile.defaultRepeats < 1 ||
      profile.defaultRepeats > 50
    ) {
      throw new Error(`profile ${profileId}.defaultRepeats must be an integer from 1 to 50`);
    }
    if (typeof profile.requireFreshSandbox !== 'boolean') {
      throw new Error(`profile ${profileId}.requireFreshSandbox must be boolean`);
    }
  }
  if (!Array.isArray(matrix.commonSetup)) throw new Error('matrix.commonSetup must be an array');
  matrix.commonSetup.forEach((step, index) => {
    const label = `commonSetup[${index}]`;
    validateCommandSpec(step, label, profileIds);
    validateLaneScopedSetup(step, label);
  });
  return matrix;
}

export async function loadCatalog(matrixPath = DEFAULT_MATRIX) {
  const resolvedMatrix = path.resolve(matrixPath);
  const matrix = JSON.parse(await readFile(resolvedMatrix, 'utf8'));
  const repoRoot = path.resolve(path.dirname(resolvedMatrix), '../../..');
  const manifestPath = path.resolve(repoRoot, matrix.featureManifest);
  const categories = parseFeatureManifest(await readFile(manifestPath, 'utf8'));
  validateMatrix(matrix, categories);
  return { matrix, categories, repoRoot, matrixPath: resolvedMatrix, manifestPath };
}

function sourceMode(requested = 'auto', env = process.env) {
  if (!['auto', 'cloud', 'files'].includes(requested))
    throw new Error('--source must be auto, cloud, or files');
  if (requested !== 'auto') return requested;
  return env.CLOUD_API_URL &&
    env.CLOUD_API_ACCESS_TOKEN &&
    (env.RUN_ID || env.AGENT_RELAY_CLOUD_WORKER_RUN_ID)
    ? 'cloud'
    : 'files';
}

function validateStorageKind(kind) {
  const parts = String(kind).split('/');
  if (parts.length === 0 || parts.some((part) => !STORAGE_PART_RE.test(part))) {
    throw new Error(`invalid storage kind: ${kind}`);
  }
  return parts;
}

function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function validateCloudApiBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('CLOUD_API_URL must be an absolute URL');
  }
  const secure = url.protocol === 'https:';
  const localDevelopment = url.protocol === 'http:' && isLoopbackHostname(url.hostname);
  if (!secure && !localDevelopment) {
    throw new Error('CLOUD_API_URL must use HTTPS (HTTP is allowed only for loopback testing)');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('CLOUD_API_URL must not contain credentials, a query, or a fragment');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

export function validateGithubApiUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('GitHub inventory URL must be absolute');
  }
  if (url.origin !== 'https://api.github.com' || url.username || url.password || url.hash) {
    throw new Error('GitHub inventory pagination must remain on https://api.github.com');
  }
  return url;
}

function encodeRecord(value, { pretty = false } = {}) {
  const encoded = JSON.stringify(value, null, pretty ? 2 : undefined);
  if (encoded === undefined) throw new Error('evidence record must be JSON serializable');
  if (Buffer.byteLength(encoded, 'utf8') > MAX_RECORD_BYTES) {
    throw new Error(`evidence record exceeds ${MAX_RECORD_BYTES} bytes`);
  }
  return encoded;
}

export async function readBoundedResponseText(response, label, maxBytes = MAX_RECORD_BYTES) {
  const declaredLength = response.headers?.get?.('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    await response.body?.cancel?.().catch(() => undefined);
    throw new Error(`${label} exceeds ${maxBytes} bytes`);
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new Error(`${label} did not expose a readable response body`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${label} exceeds ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

async function writePrivateGeneratedArtifact(destination, value, label) {
  if (Buffer.byteLength(value, 'utf8') > MAX_RECORD_BYTES) {
    throw new Error(`${label} exceeds ${MAX_RECORD_BYTES} bytes`);
  }
  // The path is nonce-bound, uses exclusive creation, and the validated payload is capped.
  // codeql[js/http-to-file-access]
  await writeFile(destination, value, { flag: 'wx', mode: 0o600 });
}

function cloudStorageUrl(nonce, kind, env = process.env) {
  assertNonce(nonce);
  const apiUrl = env.CLOUD_API_URL?.trim();
  const token = env.CLOUD_API_ACCESS_TOKEN?.trim();
  const orchestratorRunId = env.RUN_ID?.trim();
  const workerRunId = env.AGENT_RELAY_CLOUD_WORKER_RUN_ID?.trim();
  if (!apiUrl || !token || (!orchestratorRunId && !workerRunId)) {
    throw new Error('Cloud evidence storage requires CLOUD_API_URL, CLOUD_API_ACCESS_TOKEN, and a run ID');
  }
  if (orchestratorRunId && workerRunId && orchestratorRunId !== workerRunId) {
    throw new Error('Cloud runtime exposed conflicting workflow run IDs');
  }
  const rawRunId = orchestratorRunId || workerRunId;
  if (typeof rawRunId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(rawRunId)) {
    throw new Error('Cloud workflow run ID is invalid');
  }
  const runId = encodeURIComponent(rawRunId);
  const objectKey = ['cleanroom', nonce, ...validateStorageKind(kind)]
    .map((part) => encodeURIComponent(part))
    .join('/');
  const baseUrl = validateCloudApiBaseUrl(apiUrl);
  return {
    url: new URL(`api/v1/workflows/runs/${runId}/storage/${objectKey}.json`, baseUrl),
    token,
  };
}

function requestSignal() {
  return AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS);
}

export async function putRecord({
  nonce,
  kind,
  value,
  source = 'auto',
  artifactRoot = DEFAULT_ARTIFACT_ROOT,
}) {
  const mode = sourceMode(source);
  if (mode === 'files') {
    const destination =
      path.join(path.resolve(artifactRoot), assertNonce(nonce), ...validateStorageKind(kind)) + '.json';
    await mkdir(path.dirname(destination), { recursive: true });
    const encoded = `${encodeRecord(value, { pretty: true })}\n`;
    try {
      // The destination uses a fixed artifact root, validated nonce/kind segments, and O_EXCL.
      // codeql[js/http-to-file-access]
      await writePrivateGeneratedArtifact(destination, encoded, `local evidence ${kind}`);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error(`evidence storage already contains ${kind}`);
      }
      throw error;
    }
    const { bytes } = await readRegularFileNoFollow(destination, {
      label: `local evidence ${kind}`,
      maxBytes: MAX_RECORD_BYTES,
      privateMode: true,
      currentUserOwned: true,
    });
    if (recordDigest(JSON.parse(bytes.toString('utf8'))) !== recordDigest(value)) {
      throw new Error(`local evidence read-after-write verification failed for ${kind}`);
    }
    return destination;
  }
  const { url, token } = cloudStorageUrl(nonce, kind);
  const encoded = encodeRecord(value);
  // This intentionally uploads bounded evidence only to the HTTPS-validated Cloud origin.
  // codeql[js/file-access-to-http]
  const response = await fetch(url, {
    method: 'PUT',
    redirect: 'error',
    signal: requestSignal(),
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'if-none-match': '*',
    },
    body: encoded,
  });
  if (response.status === 412) {
    throw new Error(`Cloud evidence storage already contains ${kind} (412)`);
  }
  if (!response.ok)
    throw new Error(
      `Cloud evidence upload failed (${response.status}): ${await readBoundedResponseText(response, 'Cloud evidence upload error')}`
    );
  const confirmation = await fetch(url, {
    redirect: 'error',
    signal: requestSignal(),
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (!confirmation.ok) {
    throw new Error(
      `Cloud evidence read-after-write failed (${confirmation.status}): ${await readBoundedResponseText(confirmation, 'Cloud evidence confirmation error')}`
    );
  }
  let stored;
  try {
    stored = JSON.parse(await readBoundedResponseText(confirmation, 'Cloud evidence confirmation'));
  } catch (error) {
    throw new Error(
      `Cloud evidence read-after-write returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (recordDigest(stored) !== recordDigest(value)) {
    throw new Error(`Cloud evidence read-after-write digest mismatch for ${kind}`);
  }
  return url.toString();
}

export async function verifyWriteOnceStorage({
  nonce,
  source = 'auto',
  artifactRoot = DEFAULT_ARTIFACT_ROOT,
}) {
  const kind = 'write-once-probe';
  const first = { version: CONTRACT_VERSION, kind, nonce, value: 'first' };
  const conflicting = { ...first, value: 'conflicting' };
  await putRecord({ nonce, kind, value: first, source, artifactRoot });
  let rejected = false;
  try {
    await putRecord({ nonce, kind, value: conflicting, source, artifactRoot });
  } catch (error) {
    if (!/(?:already contains|412)/.test(error instanceof Error ? error.message : String(error))) {
      throw error;
    }
    rejected = true;
  }
  const stored = await getRecord({ nonce, kind, source, artifactRoot });
  if (!rejected || recordDigest(stored) !== recordDigest(first)) {
    throw new Error('evidence storage does not enforce atomic write-once objects');
  }
  return stored;
}

async function getRecord({ nonce, kind, source = 'auto', artifactRoot = DEFAULT_ARTIFACT_ROOT }) {
  const mode = sourceMode(source);
  if (mode === 'files') {
    const sourcePath =
      path.join(path.resolve(artifactRoot), assertNonce(nonce), ...validateStorageKind(kind)) + '.json';
    const { bytes } = await readRegularFileNoFollow(sourcePath, {
      label: `local evidence ${kind}`,
      maxBytes: MAX_RECORD_BYTES,
      privateMode: true,
      currentUserOwned: true,
    });
    return JSON.parse(bytes.toString('utf8'));
  }
  const { url, token } = cloudStorageUrl(nonce, kind);
  // The URL is confined to Cloud; its key consists only of validated run/nonce/kind data.
  // codeql[js/file-access-to-http]
  const response = await fetch(url, {
    redirect: 'error',
    signal: requestSignal(),
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (!response.ok)
    throw new Error(
      `Cloud evidence download failed (${response.status}): ${await readBoundedResponseText(response, 'Cloud evidence download error')}`
    );
  return JSON.parse(await readBoundedResponseText(response, 'Cloud evidence response'));
}

function outputCapture(maxBytes = MAX_OUTPUT_BYTES) {
  let text = '';
  let bytes = 0;
  let truncated = false;
  return {
    append(value) {
      const chunk = String(value ?? '');
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (truncated) return;
      if (bytes > maxBytes) {
        // Never retain or emit a partial credential after overflow. A truncated
        // command cannot supply complete verification evidence in any case.
        text = '';
        truncated = true;
        return;
      }
      text += chunk;
    },
    result(secrets = []) {
      return {
        text: truncated
          ? `[OUTPUT OMITTED: exceeded ${maxBytes} byte evidence limit]`
          : redactEvidence(text, secrets),
        bytes,
        truncated,
      };
    },
  };
}

export function captureBoundedOutput(chunks, maxBytes = MAX_OUTPUT_BYTES, secrets = []) {
  const capture = outputCapture(maxBytes);
  for (const chunk of chunks) capture.append(chunk);
  return capture.result(secrets);
}

function recordDigest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function fileEvidence(filePath, repoRoot) {
  try {
    const contents = await readFile(filePath);
    const metadata = await stat(filePath);
    return {
      path: path.relative(repoRoot, filePath),
      size: metadata.size,
      sha256: createHash('sha256').update(contents).digest('hex'),
    };
  } catch (error) {
    return {
      path: path.relative(repoRoot, filePath),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function redactEvidence(value, secrets = []) {
  let redacted = String(value ?? '');
  for (const secret of new Set(secrets.filter((entry) => typeof entry === 'string' && entry.length >= 8))) {
    redacted = redacted.split(secret).join('[REDACTED_DECLARED_SECRET]');
  }
  return redacted
    .replace(/\b(?:rk|at|ot|ct|sk)_(?:live|test)_[A-Za-z0-9._-]+\b/g, '[REDACTED_RELAY_TOKEN]')
    .replace(/\bgh[opsu]_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]{16,}/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:token|key|secret)=)[^&\s]+/gi, '$1[REDACTED]');
}

function gitValue(repoRoot, args) {
  const result = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

function substitute(value, context) {
  return String(value).replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g, (match, key) => {
    if (!(key in context)) throw new Error(`unknown command template variable ${match}`);
    return context[key];
  });
}

async function executableExists(command, env) {
  if (command.includes(path.sep)) {
    try {
      await access(command, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  for (const directory of String(env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    try {
      await access(path.join(directory, command), fsConstants.X_OK);
      return true;
    } catch {
      // Try the next PATH entry.
    }
  }
  return false;
}

async function processGroupExists(pid) {
  if (!pid || process.platform === 'win32') return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessGroupExit(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (await processGroupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

async function killProcessGroup(child, signal = 'SIGKILL') {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process already exited.
    }
  }
}

async function runProcess(argv, { cwd, env, timeoutSeconds, secrets = [] }) {
  const startedAt = new Date().toISOString();
  const stdoutCapture = outputCapture();
  const stderrCapture = outputCapture();
  let timedOut = false;
  let spawnError = null;
  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutCapture.append(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderrCapture.append(chunk);
  });
  child.on('error', (error) => {
    spawnError = error;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    void killProcessGroup(child);
  }, timeoutSeconds * 1000);
  const closed = await new Promise((resolve) =>
    child.on('close', (code, signal) => resolve({ code, signal }))
  );
  clearTimeout(timer);
  const leakedProcessGroup = await processGroupExists(child.pid);
  if (leakedProcessGroup) await killProcessGroup(child);
  const processGroupCleaned = await waitForProcessGroupExit(child.pid);
  const stdout = stdoutCapture.result(secrets);
  const stderr = stderrCapture.result(secrets);
  return {
    argv,
    cwd,
    startedAt,
    completedAt: new Date().toISOString(),
    exitCode: closed.code,
    signal: closed.signal,
    timedOut,
    leakedProcessGroup,
    processGroupCleaned,
    error: spawnError ? spawnError.message : null,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutBytes: stdout.bytes,
    stderrBytes: stderr.bytes,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
  };
}

async function fetchGithubPages(
  url,
  { token = process.env.VERIFY_GITHUB_TOKEN, maxPages = 20, stopAfterPage = null } = {}
) {
  const records = [];
  let next = validateGithubApiUrl(url);
  for (let page = 1; next && page <= maxPages; page += 1) {
    let response = null;
    let lastError = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      response = null;
      try {
        // Every initial and Link-derived URL is revalidated against the fixed GitHub HTTPS origin.
        // codeql[js/file-access-to-http]
        response = await fetch(next, {
          redirect: 'error',
          signal: requestSignal(),
          headers: {
            accept: 'application/vnd.github+json',
            'user-agent': 'relay-cleanroom-verifier',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
        });
        if (response.ok) break;
        const body = safeGithubText(
          await readBoundedResponseText(response, 'GitHub inventory error response'),
          1_000
        );
        lastError = new Error(`GitHub inventory request failed (${response.status}): ${body}`);
        if (![408, 429, 500, 502, 503, 504].includes(response.status)) throw lastError;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const retryableResponse = response && [408, 429, 500, 502, 503, 504].includes(response.status);
        if (!retryableResponse && response) throw lastError;
        if (attempt === 4) throw lastError;
      }
      if (attempt === 4) throw lastError ?? new Error('GitHub inventory request failed');
      const retryAfterSeconds = Number.parseInt(response?.headers.get('retry-after') ?? '', 10);
      const delayMs = Number.isSafeInteger(retryAfterSeconds)
        ? Math.min(retryAfterSeconds * 1_000, 15_000)
        : Math.min(500 * 2 ** (attempt - 1), 4_000);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (!response?.ok) throw lastError ?? new Error('GitHub inventory request failed');
    const pageRecords = JSON.parse(await readBoundedResponseText(response, 'GitHub inventory response'));
    if (!Array.isArray(pageRecords)) throw new Error('GitHub inventory response was not an array');
    records.push(...pageRecords);
    if (stopAfterPage?.(pageRecords)) return records;
    const link = response.headers.get('link') ?? '';
    const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
    next = nextMatch ? validateGithubApiUrl(nextMatch[1]) : null;
  }
  if (next) throw new Error(`GitHub inventory exceeded ${maxPages} pages`);
  return records;
}

function safeGithubText(value, maxLength = 500) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, maxLength);
}

function publicIssue(record) {
  return {
    number: record.number,
    title: safeGithubText(record.title),
    url: record.html_url,
    labels: (record.labels ?? [])
      .map((label) => safeGithubText(typeof label === 'string' ? label : label.name, 100))
      .filter(Boolean),
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function publicMerge(record) {
  return {
    number: record.number,
    title: safeGithubText(record.title),
    url: record.html_url,
    mergedAt: record.merged_at,
  };
}

function assertScope(scope, matrix, nonce) {
  assertPlainObject(scope, 'scope');
  if (
    scope.version !== CONTRACT_VERSION ||
    scope.kind !== 'scope' ||
    scope.nonce !== nonce ||
    scope.product !== matrix.product ||
    scope.repository !== matrix.repository
  ) {
    throw new Error('scope is not bound to this campaign');
  }
  for (const [kind, records, assignments] of [
    ['issue', scope.issues, scope.issueAssignments],
    ['merge', scope.recentMerges, scope.mergeAssignments],
  ]) {
    if (!Array.isArray(records)) throw new Error(`scope.${kind}s must be an array`);
    const expectedUrlPrefix = `https://github.com/${matrix.repository}/`;
    const recordNumbers = records.map(({ number }) => number);
    if (
      recordNumbers.some((number) => !Number.isSafeInteger(number) || number < 1) ||
      new Set(recordNumbers).size !== recordNumbers.length
    ) {
      throw new Error(`scope.${kind}s contains an invalid or duplicate number`);
    }
    if (records.some(({ url }) => typeof url !== 'string' || !url.startsWith(expectedUrlPrefix))) {
      throw new Error(`scope.${kind}s contains a URL outside ${matrix.repository}`);
    }
    assertPlainObject(assignments, `scope.${kind}Assignments`);
    const counts = new Map(records.map(({ number }) => [number, 0]));
    for (const lane of matrix.lanes) {
      const assigned = assignments[lane.id];
      if (!Array.isArray(assigned)) throw new Error(`scope is missing ${kind} assignments for ${lane.id}`);
      for (const record of assigned) {
        if (!counts.has(record.number)) throw new Error(`scope assigns unknown ${kind} #${record.number}`);
        counts.set(record.number, counts.get(record.number) + 1);
      }
    }
    const invalid = [...counts].filter(([, count]) => count !== 1);
    if (invalid.length) {
      throw new Error(`${invalid.length} ${kind}(s) are not assigned to exactly one lane`);
    }
  }
  return scope;
}

export function routeInventory(items, lanes) {
  const fallback = lanes.find((lane) => lane.fallbackIssues === true);
  if (!fallback) throw new Error('issue routing has no fallback lane');
  const byLane = Object.fromEntries(lanes.map((lane) => [lane.id, []]));
  for (const item of items) {
    const haystack = `${item.title ?? ''}\n${(item.labels ?? []).join(' ')}`.toLowerCase();
    const explicit = lanes.filter((lane) => (lane.issueNumbers ?? []).includes(item.number));
    const matches = lanes
      .filter((lane) => !lane.fallbackIssues)
      .map((lane) => ({
        lane,
        score: lane.issueMatch.filter((term) => haystack.includes(term.toLowerCase())).length,
      }))
      .filter(({ score }) => score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          (right.lane.routingPriority ?? 0) - (left.lane.routingPriority ?? 0) ||
          left.lane.id.localeCompare(right.lane.id)
      );
    const owner = explicit[0] ?? matches[0]?.lane ?? fallback;
    byLane[owner.id].push({
      ...item,
      routingReason: explicit.length
        ? 'explicit-issue-number'
        : matches.length
          ? 'keyword-score'
          : 'fallback',
      matchedLanes: matches.map(({ lane, score }) => ({ id: lane.id, score })),
    });
  }
  return byLane;
}

async function buildScope({ matrix, nonce }) {
  const [owner, repository] = matrix.repository.split('/');
  const apiRoot = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  const cutoff = Date.now() - matrix.recentMergeDays * 24 * 60 * 60 * 1000;
  const [issueRecords, pullRecords] = await Promise.all([
    fetchGithubPages(`${apiRoot}/issues?state=open&per_page=100`),
    fetchGithubPages(`${apiRoot}/pulls?state=closed&sort=updated&direction=desc&per_page=100`, {
      stopAfterPage: (records) =>
        records.length === 0 || Date.parse(records.at(-1)?.updated_at ?? '') < cutoff,
    }),
  ]);
  const issues = issueRecords.filter((record) => !record.pull_request).map(publicIssue);
  const merges = pullRecords
    .filter(
      (record) =>
        record.merged_at &&
        Date.parse(record.merged_at) >= cutoff &&
        /^(feat|fix|security|test|refactor|perf|ci)(\([^)]*\))?:/i.test(record.title ?? '')
    )
    .map(publicMerge);
  return {
    version: CONTRACT_VERSION,
    kind: 'scope',
    nonce,
    product: matrix.product,
    repository: matrix.repository,
    generatedAt: new Date().toISOString(),
    issues,
    recentMerges: merges,
    issueAssignments: routeInventory(issues, matrix.lanes),
    mergeAssignments: routeInventory(merges, matrix.lanes),
  };
}

function enabledForProfile(spec, profile) {
  return !spec.profiles || spec.profiles.includes(profile);
}

export function cleanEnvironment({
  root,
  requiredEnvironment = [],
  environment = {},
  isolatedEnvironment = {},
  environmentDefaults = {},
  context,
}) {
  const home = path.join(root, 'home');
  const tmp = path.join(root, 'tmp');
  const env = {
    PATH: process.env.PATH ?? '',
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL ?? 'C.UTF-8',
    SYSTEMROOT: process.env.SYSTEMROOT ?? '',
    WINDIR: process.env.WINDIR ?? '',
    RUSTUP_HOME: process.env.RUSTUP_HOME ?? '',
    HOME: home,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
    XDG_CACHE_HOME: path.join(root, 'xdg-cache'),
    XDG_DATA_HOME: path.join(root, 'xdg-data'),
    CI: '1',
    npm_config_cache: path.join(root, 'npm-cache'),
    CARGO_HOME: path.join(root, 'cargo-home'),
    VERIFY_CLEANROOM_RUN_ROOT: root,
  };
  for (const [name, relativePath] of Object.entries(isolatedEnvironment)) {
    env[name] = path.join(root, relativePath);
  }
  Object.assign(env, environmentDefaults);
  for (const name of requiredEnvironment) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  for (const [key, value] of Object.entries(environment)) env[key] = substitute(value, context);
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
}

async function ensureCleanDirectories(root) {
  for (const directory of [
    'home',
    'tmp',
    'relay-state',
    'xdg-config',
    'xdg-cache',
    'xdg-data',
    'npm-cache',
    'cargo-home',
    'project',
    'fixtures',
    'results',
  ]) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
}

export async function freshAttemptContext(laneContext, relativeAttemptPath) {
  const attemptRoot = path.join(laneContext.laneRoot, 'attempts', relativeAttemptPath);
  await ensureCleanDirectories(attemptRoot);
  return {
    ...laneContext,
    runRoot: attemptRoot,
    home: path.join(attemptRoot, 'home'),
    projectRoot: path.join(attemptRoot, 'project'),
    resultRoot: path.join(attemptRoot, 'results'),
  };
}

async function executeCommandSpec(spec, { baseEnv, context, repoRoot }) {
  const requiredEnvironment = spec.requiredEnvironment ?? [];
  const missingEnvironment = requiredEnvironment.filter((name) => !process.env[name]);
  const requiredCommands = new Set([spec.command[0], ...(spec.requiredCommands ?? [])]);
  const missingCommands = [];
  for (const command of requiredCommands) {
    if (!(await executableExists(substitute(command, context), baseEnv))) missingCommands.push(command);
  }
  if (missingEnvironment.length || missingCommands.length) {
    return {
      status: 'blocked',
      reason: [
        missingEnvironment.length ? `missing environment: ${missingEnvironment.join(', ')}` : '',
        missingCommands.length ? `missing commands: ${missingCommands.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('; '),
    };
  }
  const argv = spec.command.map((value) => substitute(value, context));
  const cwd = spec.cwd ? substitute(spec.cwd, context) : repoRoot;
  const env = cleanEnvironment({
    root: context.runRoot,
    requiredEnvironment,
    environment: spec.environment ?? {},
    isolatedEnvironment: context.isolatedEnvironment,
    environmentDefaults: context.environmentDefaults,
    context,
  });
  const secrets = requiredEnvironment.map((name) => process.env[name]).filter(Boolean);
  const result = await runProcess(argv, {
    cwd,
    env,
    timeoutSeconds: spec.timeoutSeconds,
    secrets,
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  const expectedExitCodes = spec.expectedExitCodes ?? [0];
  const missingText = (spec.mustContain ?? []).filter((value) => !combined.includes(value));
  const forbiddenText = (spec.forbidOutput ?? []).filter((value) => combined.includes(value));
  const passed =
    !result.timedOut &&
    !result.leakedProcessGroup &&
    result.processGroupCleaned &&
    !result.stdoutTruncated &&
    !result.stderrTruncated &&
    !result.error &&
    expectedExitCodes.includes(result.exitCode) &&
    missingText.length === 0 &&
    forbiddenText.length === 0;
  return {
    status: passed ? 'pass' : 'fail',
    reason: passed
      ? ''
      : [
          result.timedOut ? `timed out after ${spec.timeoutSeconds}s` : '',
          result.leakedProcessGroup ? 'process group remained alive after command exit' : '',
          !result.processGroupCleaned ? 'process group survived forced cleanup' : '',
          result.stdoutTruncated
            ? `stdout exceeded ${MAX_OUTPUT_BYTES} byte evidence limit (${result.stdoutBytes} bytes)`
            : '',
          result.stderrTruncated
            ? `stderr exceeded ${MAX_OUTPUT_BYTES} byte evidence limit (${result.stderrBytes} bytes)`
            : '',
          result.error ?? '',
          !expectedExitCodes.includes(result.exitCode)
            ? `exit ${result.exitCode ?? result.signal ?? 'unknown'}`
            : '',
          missingText.length ? `missing output: ${missingText.join(', ')}` : '',
          forbiddenText.length ? `forbidden output: ${forbiddenText.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('; '),
    process: result,
  };
}

async function executeCorpus(spec, { baseEnv, context, repoRoot, repeats }) {
  const caseRoot = path.join(repoRoot, 'tests/relayflows/cases');
  const contract = await import(pathToFileURL(path.join(repoRoot, 'scripts/pr-proof/contract.mjs')).href);
  const entries = (await readdir(caseRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length === 0) {
    return { status: 'fail', reason: 'regression corpus contains no case directories', cases: [] };
  }
  const headSha = gitValue(repoRoot, ['rev-parse', 'HEAD']);
  const brokerBinary = context.brokerBinary;
  const cases = [];
  for (const entry of entries) {
    const caseId = entry.name;
    const caseDirectory = path.join(caseRoot, caseId);
    let manifest;
    try {
      manifest = contract.validateCaseManifest(
        JSON.parse(await readFile(path.join(caseDirectory, 'case.json'), 'utf8')),
        { caseId }
      );
    } catch (error) {
      cases.push({ caseId, status: 'fail', reason: `manifest rejected: ${error.message}` });
      continue;
    }
    const needsBroker = (manifest.requirements ?? []).includes(contract.BROKER_RUNTIME_REQUIREMENT);
    if (needsBroker && !(await executableExists(brokerBinary, baseEnv))) {
      cases.push({ caseId, status: 'blocked', reason: 'exact-checkout broker binary is unavailable' });
      continue;
    }
    const attempts = [];
    for (let attempt = 1; attempt <= repeats; attempt += 1) {
      const attemptContext = await freshAttemptContext(context, `corpus/${caseId}/${attempt}`);
      const attemptBaseEnv = cleanEnvironment({
        root: attemptContext.runRoot,
        isolatedEnvironment: context.isolatedEnvironment,
        environmentDefaults: context.environmentDefaults,
        context: attemptContext,
      });
      const resultPath = path.join(attemptContext.resultRoot, 'observation.json');
      const caseEnv = {
        ...attemptBaseEnv,
        RELAY_PR_PROOF_ARM: 'head',
        RELAY_PR_PROOF_CASE_ID: caseId,
        RELAY_PR_PROOF_BASE_SHA: headSha,
        RELAY_PR_PROOF_HEAD_SHA: headSha,
        RELAY_PR_PROOF_TARGET_SHA: headSha,
        RELAY_PR_PROOF_TARGET_DIR: repoRoot,
        RELAY_PR_PROOF_HARNESS_DIR: repoRoot,
        RELAY_PR_PROOF_RESULT_PATH: resultPath,
        RELAY_PR_PROOF_BROKER_BINARY: needsBroker ? brokerBinary : '',
      };
      const processResult = await runProcess(manifest.runner.command, {
        cwd: repoRoot,
        env: caseEnv,
        timeoutSeconds: Math.min(manifest.timeoutSeconds, spec.timeoutSeconds),
      });
      let observation = null;
      let observationError = '';
      try {
        observation = contract.validateObservation(JSON.parse(await readFile(resultPath, 'utf8')), {
          caseId,
          arm: 'head',
          expected: manifest.expected.head,
        });
      } catch (error) {
        observationError = error instanceof Error ? error.message : String(error);
      }
      const expected = manifest.expected.head.signature;
      const passed =
        processResult.exitCode === 0 &&
        !processResult.timedOut &&
        !processResult.leakedProcessGroup &&
        processResult.processGroupCleaned &&
        !processResult.stdoutTruncated &&
        !processResult.stderrTruncated &&
        observation?.caseId === caseId &&
        observation?.arm === 'head' &&
        observation?.signature === expected;
      attempts.push({
        attempt,
        status: passed ? 'pass' : 'fail',
        expectedSignature: expected,
        actualSignature: observation?.signature ?? null,
        reason: passed
          ? ''
          : [
              `runner/evidence mismatch (exit ${processResult.exitCode ?? processResult.signal ?? 'unknown'})`,
              observationError,
            ]
              .filter(Boolean)
              .join('; '),
        process: processResult,
      });
    }
    const statuses = new Set(attempts.map(({ status }) => status));
    cases.push({
      caseId,
      status: statuses.size > 1 ? 'flaky' : attempts[0].status,
      attempts,
      issue: Number.parseInt(caseId.split('-')[0], 10) || null,
    });
  }
  const statuses = new Set(cases.map(({ status }) => status));
  const status = statuses.has('fail')
    ? 'fail'
    : statuses.has('flaky')
      ? 'flaky'
      : statuses.has('blocked')
        ? 'blocked'
        : 'pass';
  return { status, cases };
}

async function runLane({ catalog, laneId, profile, nonce, source, artifactRoot }) {
  const { matrix, repoRoot } = catalog;
  const profileSpec = matrix.profiles[profile];
  if (!profileSpec) throw new Error(`unknown profile: ${profile}`);
  if (!profileSpec.lanes.includes(laneId))
    throw new Error(`lane ${laneId} is disabled in profile ${profile}`);
  const lane = matrix.lanes.find(({ id }) => id === laneId);
  if (!lane) throw new Error(`unknown lane: ${laneId}`);
  const scope = assertScope(await getRecord({ nonce, kind: 'scope', source, artifactRoot }), matrix, nonce);
  const evidenceMode = sourceMode(source);
  const explicitSandboxId = process.env.SANDBOX_ID?.trim();
  const sandboxId =
    evidenceMode === 'cloud' && explicitSandboxId ? `cloud-${explicitSandboxId}` : `local-${process.pid}`;
  const localAllowed = process.env.VERIFY_CLEANROOM_ALLOW_LOCAL === '1';
  const runRoot = await mkdtemp(path.join(os.tmpdir(), `relay-cleanroom-${laneId}-`));
  await ensureCleanDirectories(runRoot);
  const context = {
    repoRoot,
    runRoot,
    laneRoot: runRoot,
    home: path.join(runRoot, 'home'),
    projectRoot: path.join(runRoot, 'project'),
    fixtureRoot: path.join(runRoot, 'fixtures'),
    resultRoot: path.join(runRoot, 'results'),
    brokerBinary: path.join(
      repoRoot,
      matrix.artifacts?.['broker-binary'] ?? 'target/release/agent-relay-broker'
    ),
    isolatedEnvironment: matrix.isolatedEnvironment ?? {},
    environmentDefaults: matrix.environmentDefaults ?? {},
  };
  const checkoutBaseline = gitValue(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  const baseEnv = cleanEnvironment({
    root: runRoot,
    isolatedEnvironment: context.isolatedEnvironment,
    environmentDefaults: context.environmentDefaults,
    context,
  });
  const [matrixBytes, runnerBytes] = await Promise.all([
    readFile(catalog.matrixPath),
    readFile(fileURLToPath(import.meta.url)),
  ]);
  const record = {
    version: CONTRACT_VERSION,
    kind: 'lane',
    nonce,
    product: matrix.product,
    profile,
    lane: laneId,
    sandboxId,
    commit: gitValue(repoRoot, ['rev-parse', 'HEAD']),
    matrixSha256: createHash('sha256').update(matrixBytes).digest('hex'),
    runnerSha256: createHash('sha256').update(runnerBytes).digest('hex'),
    startedAt: new Date().toISOString(),
    assignedIssues: scope.issueAssignments[laneId] ?? [],
    assignedMerges: scope.mergeAssignments[laneId] ?? [],
    setup: [],
    artifacts: {},
    scenarios: [],
    cleanup: { status: 'pending' },
  };
  let setupGreen = true;
  try {
    if (evidenceMode === 'files' && !localAllowed) {
      record.setup.push({
        id: 'local-execution-consent',
        status: 'blocked',
        reason: 'local execution requires VERIFY_CLEANROOM_ALLOW_LOCAL=1',
      });
      setupGreen = false;
    }
    if (profileSpec.requireFreshSandbox && evidenceMode !== 'cloud') {
      record.setup.push({
        id: 'fresh-sandbox-provenance',
        status: 'blocked',
        reason: `${profile} requires Cloud run storage and a fresh Cloud sandbox`,
      });
      setupGreen = false;
    }
    if (profileSpec.requireFreshSandbox && !explicitSandboxId) {
      record.setup.push({
        id: 'sandbox-identity-provenance',
        status: 'blocked',
        reason: `${profile} requires the Cloud executor's SANDBOX_ID`,
      });
      setupGreen = false;
    }
    const setupSteps = [...matrix.commonSetup, ...lane.setup].filter((step) =>
      enabledForProfile(step, profile)
    );
    for (const step of setupSteps) {
      if (!setupGreen) {
        record.setup.push({ id: step.id, status: 'blocked', reason: 'prior setup did not complete' });
        continue;
      }
      const result = await executeCommandSpec(step, { baseEnv, context, repoRoot });
      record.setup.push({ id: step.id, ...result });
      if (result.status !== 'pass') setupGreen = false;
    }
    for (const name of lane.requiredArtifacts ?? []) {
      const relativePath = matrix.artifacts[name];
      record.artifacts[name] = await fileEvidence(path.join(repoRoot, relativePath), repoRoot);
      if (record.artifacts[name].error) {
        record.setup.push({
          id: `artifact-${name}`,
          status: 'fail',
          reason: `required checkout artifact is unavailable: ${record.artifacts[name].error}`,
        });
        setupGreen = false;
      }
    }
    for (const scenario of lane.scenarios.filter((entry) => enabledForProfile(entry, profile))) {
      if (!setupGreen) {
        record.scenarios.push({
          id: scenario.id,
          title: scenario.title,
          status: 'blocked',
          evidence: scenario.evidence,
          reason: 'lane setup did not complete',
        });
        continue;
      }
      if ((scenario.kind ?? 'command') === 'coverage-gap') {
        const missing = (scenario.requiredEnvironment ?? []).filter((name) => !process.env[name]);
        record.scenarios.push({
          id: scenario.id,
          title: scenario.title,
          status: 'blocked',
          evidence: scenario.evidence,
          reason: `${scenario.reason}${missing.length ? ` Missing: ${missing.join(', ')}.` : ''}`,
        });
        continue;
      }
      const repeats = scenario.repeats?.[profile] ?? profileSpec.defaultRepeats;
      if ((scenario.kind ?? 'command') === 'relayflow-corpus') {
        const result = await executeCorpus(scenario, { baseEnv, context, repoRoot, repeats });
        record.scenarios.push({
          id: scenario.id,
          title: scenario.title,
          evidence: scenario.evidence,
          ...result,
        });
        continue;
      }
      const attempts = [];
      for (let attempt = 1; attempt <= repeats; attempt += 1) {
        const attemptContext = await freshAttemptContext(context, `${scenario.id}/${attempt}`);
        const attemptBaseEnv = cleanEnvironment({
          root: attemptContext.runRoot,
          isolatedEnvironment: context.isolatedEnvironment,
          environmentDefaults: context.environmentDefaults,
          context: attemptContext,
        });
        attempts.push({
          attempt,
          ...(await executeCommandSpec(scenario, {
            baseEnv: attemptBaseEnv,
            context: attemptContext,
            repoRoot,
          })),
        });
      }
      const statuses = new Set(attempts.map(({ status }) => status));
      const status = statuses.size > 1 ? 'flaky' : attempts[0].status;
      record.scenarios.push({
        id: scenario.id,
        title: scenario.title,
        evidence: scenario.evidence,
        status,
        reason: status === 'flaky' ? 'mixed pass/fail results across repetitions' : attempts[0].reason,
        attempts,
      });
    }
    const checkoutAfter = gitValue(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
    record.cleanup =
      checkoutAfter !== checkoutBaseline
        ? {
            status: 'fail',
            reason: `checkout state changed after lane: before=${redactEvidence(checkoutBaseline)} after=${redactEvidence(checkoutAfter)}`,
          }
        : { status: 'pass', reason: '' };
  } catch (error) {
    record.cleanup = {
      status: 'infra_error',
      reason: redactEvidence(error instanceof Error ? error.stack : String(error)),
    };
  } finally {
    record.completedAt = new Date().toISOString();
    try {
      await rm(runRoot, { recursive: true, force: true });
    } catch (error) {
      record.cleanup = {
        status: 'infra_error',
        reason: `temporary run-root cleanup failed: ${redactEvidence(error instanceof Error ? error.message : String(error))}`,
      };
    }
    const statuses = [
      ...record.setup.map(({ status }) => status),
      ...record.scenarios.map(({ status }) => status),
      record.cleanup.status,
    ];
    record.status = statuses.includes('infra_error')
      ? 'infra_error'
      : statuses.includes('fail') || statuses.includes('flaky')
        ? 'fail'
        : statuses.includes('blocked')
          ? 'blocked'
          : 'pass';
    await putRecord({ nonce, kind: `lanes/${laneId}`, value: record, source, artifactRoot });
  }
  return record;
}

function scenarioSpecifications(matrix) {
  const specifications = new Map();
  for (const lane of matrix.lanes) {
    for (const scenario of lane.scenarios) specifications.set(scenario.id, { lane, scenario });
  }
  return specifications;
}

function corpusMergeProofs(laneRecords) {
  const proved = new Set();
  for (const lane of laneRecords) {
    for (const scenario of lane.scenarios ?? []) {
      for (const caseResult of scenario.cases ?? []) {
        if (caseResult.status === 'pass' && Number.isSafeInteger(caseResult.issue))
          proved.add(caseResult.issue);
      }
    }
  }
  return proved;
}

function summarizeProcess(process) {
  if (!process) return null;
  return {
    exitCode: process.exitCode,
    signal: process.signal,
    timedOut: process.timedOut,
    leakedProcessGroup: process.leakedProcessGroup,
    processGroupCleaned: process.processGroupCleaned,
    error: process.error,
  };
}

function summarizeScenario(laneId, scenario) {
  return {
    lane: laneId,
    id: scenario.id,
    title: scenario.title,
    status: scenario.status,
    evidence: scenario.evidence,
    reason: scenario.reason ?? '',
    attempts: (scenario.attempts ?? []).map((attempt) => ({
      attempt: attempt.attempt,
      status: attempt.status,
      reason: attempt.reason ?? '',
      process: summarizeProcess(attempt.process),
    })),
    cases: (scenario.cases ?? []).map((caseResult) => ({
      caseId: caseResult.caseId,
      issue: caseResult.issue,
      status: caseResult.status,
      reason: caseResult.reason ?? '',
      attempts: (caseResult.attempts ?? []).map((attempt) => ({
        attempt: attempt.attempt,
        status: attempt.status,
        reason: attempt.reason ?? '',
        expectedSignature: attempt.expectedSignature,
        actualSignature: attempt.actualSignature,
        process: summarizeProcess(attempt.process),
      })),
    })),
  };
}

const LANE_RESULT_STATUSES = new Set(['pass', 'fail', 'flaky', 'blocked', 'infra_error']);

function validateProcessEvidence(processEvidence, commandSpec, label) {
  assertPlainObject(processEvidence, `${label}.process`);
  if (!Array.isArray(processEvidence.argv) || processEvidence.argv.length !== commandSpec.command.length) {
    throw new Error(`${label}.process.argv does not match the declared command shape`);
  }
  commandSpec.command.forEach((token, index) => {
    if (!String(token).includes('{{') && processEvidence.argv[index] !== token) {
      throw new Error(`${label}.process.argv[${index}] does not match the declared command`);
    }
  });
  if (typeof processEvidence.cwd !== 'string' || !processEvidence.cwd) {
    throw new Error(`${label}.process.cwd is missing`);
  }
  const startedAt = Date.parse(processEvidence.startedAt);
  const completedAt = Date.parse(processEvidence.completedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
    throw new Error(`${label}.process timestamps are invalid`);
  }
  if (!(processEvidence.exitCode === null || Number.isInteger(processEvidence.exitCode))) {
    throw new Error(`${label}.process.exitCode is invalid`);
  }
  for (const key of [
    'timedOut',
    'leakedProcessGroup',
    'processGroupCleaned',
    'stdoutTruncated',
    'stderrTruncated',
  ]) {
    if (typeof processEvidence[key] !== 'boolean') throw new Error(`${label}.process.${key} is invalid`);
  }
  for (const key of ['stdoutBytes', 'stderrBytes']) {
    if (!Number.isSafeInteger(processEvidence[key]) || processEvidence[key] < 0) {
      throw new Error(`${label}.process.${key} is invalid`);
    }
  }
  for (const key of ['stdout', 'stderr']) {
    if (
      typeof processEvidence[key] !== 'string' ||
      Buffer.byteLength(processEvidence[key]) > MAX_OUTPUT_BYTES
    ) {
      throw new Error(`${label}.process.${key} exceeds the evidence contract`);
    }
  }
  return processEvidence;
}

function deriveScenarioStatus(attempts) {
  const statuses = new Set(attempts.map(({ status }) => status));
  return statuses.size > 1 ? 'flaky' : attempts[0]?.status;
}

function expectedCommandEvidenceStatus(processEvidence, spec) {
  const combined = `${processEvidence.stdout}\n${processEvidence.stderr}`;
  const expectedExitCodes = spec.expectedExitCodes ?? [0];
  const passed =
    !processEvidence.timedOut &&
    !processEvidence.leakedProcessGroup &&
    processEvidence.processGroupCleaned &&
    !processEvidence.stdoutTruncated &&
    !processEvidence.stderrTruncated &&
    !processEvidence.error &&
    expectedExitCodes.includes(processEvidence.exitCode) &&
    (spec.mustContain ?? []).every((value) => combined.includes(value)) &&
    (spec.forbidOutput ?? []).every((value) => !combined.includes(value));
  return passed ? 'pass' : 'fail';
}

export function validateLaneEvidence(record, { matrix, profile, nonce, scope, bindings = {} }) {
  assertPlainObject(record, 'lane evidence');
  const lane = matrix.lanes.find(({ id }) => id === record.lane);
  if (
    !lane ||
    record.version !== CONTRACT_VERSION ||
    record.kind !== 'lane' ||
    record.nonce !== nonce ||
    record.product !== matrix.product ||
    record.profile !== profile
  ) {
    throw new Error('lane evidence identity does not match the active campaign');
  }
  if (!/^[0-9a-f]{40}$/.test(record.commit ?? '')) throw new Error(`lane ${lane.id} commit is invalid`);
  for (const key of ['matrixSha256', 'runnerSha256']) {
    if (!/^[0-9a-f]{64}$/.test(record[key] ?? '')) throw new Error(`lane ${lane.id} ${key} is invalid`);
    if (bindings[key] && record[key] !== bindings[key]) {
      throw new Error(`lane ${lane.id} ${key} does not match the active verifier`);
    }
  }
  if (bindings.sourceCommit && record.commit !== bindings.sourceCommit) {
    throw new Error(`lane ${lane.id} commit does not match the active source`);
  }
  const startedAt = Date.parse(record.startedAt);
  const completedAt = Date.parse(record.completedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
    throw new Error(`lane ${lane.id} timestamps are invalid`);
  }
  if (typeof record.sandboxId !== 'string' || !record.sandboxId) {
    throw new Error(`lane ${lane.id} sandboxId is missing`);
  }
  if (
    recordDigest(record.assignedIssues ?? []) !== recordDigest(scope.issueAssignments[lane.id] ?? []) ||
    recordDigest(record.assignedMerges ?? []) !== recordDigest(scope.mergeAssignments[lane.id] ?? [])
  ) {
    throw new Error(`lane ${lane.id} scope assignments were substituted`);
  }
  if (!Array.isArray(record.setup)) throw new Error(`lane ${lane.id} setup is invalid`);
  const declaredSetupIds = [...matrix.commonSetup, ...lane.setup]
    .filter((spec) => enabledForProfile(spec, profile))
    .map(({ id }) => id);
  const permittedSyntheticSetupIds = new Set([
    'local-execution-consent',
    'fresh-sandbox-provenance',
    'sandbox-identity-provenance',
    ...(lane.requiredArtifacts ?? []).map((name) => `artifact-${name}`),
  ]);
  const actualDeclaredSetupIds = record.setup
    .map(({ id }) => id)
    .filter((id) => declaredSetupIds.includes(id));
  if (recordDigest(actualDeclaredSetupIds) !== recordDigest(declaredSetupIds)) {
    throw new Error(`lane ${lane.id} setup command set/order is incomplete`);
  }
  if (
    record.setup.some(
      ({ id, status }) =>
        (!declaredSetupIds.includes(id) && !permittedSyntheticSetupIds.has(id)) ||
        !LANE_RESULT_STATUSES.has(status)
    )
  ) {
    throw new Error(`lane ${lane.id} setup contains an undeclared result`);
  }
  for (const [index, setup] of record.setup.entries()) {
    const spec = [...matrix.commonSetup, ...lane.setup].find(({ id }) => id === setup.id);
    if (spec && ['pass', 'fail'].includes(setup.status)) {
      validateProcessEvidence(setup.process, spec, `lane ${lane.id} setup[${index}]`);
      if (setup.status !== expectedCommandEvidenceStatus(setup.process, spec)) {
        throw new Error(`lane ${lane.id} setup ${spec.id} status is inconsistent with process evidence`);
      }
    }
  }
  assertPlainObject(record.artifacts, `lane ${lane.id}.artifacts`);
  if (
    recordDigest(Object.keys(record.artifacts).sort()) !==
    recordDigest([...(lane.requiredArtifacts ?? [])].sort())
  ) {
    throw new Error(`lane ${lane.id} artifact set is incomplete`);
  }
  for (const [name, artifact] of Object.entries(record.artifacts)) {
    assertPlainObject(artifact, `lane ${lane.id} artifact ${name}`);
    if (
      typeof artifact.path !== 'string' ||
      (!artifact.error && (!SHA256.test(artifact.sha256 ?? '') || !Number.isSafeInteger(artifact.size)))
    ) {
      throw new Error(`lane ${lane.id} artifact ${name} is invalid`);
    }
  }
  if (!Array.isArray(record.scenarios)) throw new Error(`lane ${lane.id} scenarios are invalid`);
  const scenarioSpecs = lane.scenarios.filter((scenario) => enabledForProfile(scenario, profile));
  if (
    recordDigest(record.scenarios.map(({ id }) => id)) !== recordDigest(scenarioSpecs.map(({ id }) => id))
  ) {
    throw new Error(`lane ${lane.id} scenario set/order is incomplete`);
  }
  for (const [scenarioIndex, scenario] of record.scenarios.entries()) {
    const spec = scenarioSpecs[scenarioIndex];
    if (
      scenario.title !== spec.title ||
      scenario.evidence !== spec.evidence ||
      !LANE_RESULT_STATUSES.has(scenario.status)
    ) {
      throw new Error(`lane ${lane.id} scenario ${spec.id} does not match its declaration`);
    }
    const kind = spec.kind ?? 'command';
    if (kind === 'coverage-gap') {
      if (scenario.status !== 'blocked' || scenario.attempts !== undefined || scenario.cases !== undefined) {
        throw new Error(`lane ${lane.id} coverage gap ${spec.id} has fabricated execution evidence`);
      }
      continue;
    }
    const repeats = spec.repeats?.[profile] ?? matrix.profiles[profile].defaultRepeats;
    if (kind === 'relayflow-corpus') {
      if (!Array.isArray(scenario.cases) || scenario.cases.length === 0) {
        throw new Error(`lane ${lane.id} corpus ${spec.id} has no cases`);
      }
      for (const [caseIndex, caseResult] of scenario.cases.entries()) {
        if (
          !Array.isArray(caseResult.attempts) &&
          !(
            ['fail', 'blocked'].includes(caseResult.status) &&
            typeof caseResult.reason === 'string' &&
            caseResult.reason
          )
        ) {
          throw new Error(`lane ${lane.id} corpus ${spec.id} case ${caseIndex} repeat count is invalid`);
        }
        if (!Array.isArray(caseResult.attempts)) continue;
        if (caseResult.attempts.length !== repeats) {
          throw new Error(`lane ${lane.id} corpus ${spec.id} case ${caseIndex} repeat count is invalid`);
        }
        caseResult.attempts.forEach((attempt, attemptIndex) => {
          if (attempt.attempt !== attemptIndex + 1 || !['pass', 'fail'].includes(attempt.status)) {
            throw new Error(`lane ${lane.id} corpus ${spec.id} case ${caseIndex} attempt is invalid`);
          }
          validateProcessEvidence(
            attempt.process,
            { command: attempt.process?.argv ?? [] },
            `lane ${lane.id} corpus ${spec.id} case ${caseIndex} attempt ${attemptIndex + 1}`
          );
          const passed =
            attempt.process.exitCode === 0 &&
            !attempt.process.timedOut &&
            !attempt.process.leakedProcessGroup &&
            attempt.process.processGroupCleaned &&
            !attempt.process.stdoutTruncated &&
            !attempt.process.stderrTruncated &&
            attempt.actualSignature === attempt.expectedSignature;
          if (attempt.status !== (passed ? 'pass' : 'fail')) {
            throw new Error(
              `lane ${lane.id} corpus ${spec.id} case ${caseIndex} attempt status is inconsistent`
            );
          }
        });
        if (caseResult.status !== deriveScenarioStatus(caseResult.attempts)) {
          throw new Error(`lane ${lane.id} corpus ${spec.id} case ${caseIndex} status is inconsistent`);
        }
      }
      const corpusStatus = deriveScenarioStatus(scenario.cases);
      if (scenario.status !== corpusStatus) {
        throw new Error(`lane ${lane.id} corpus ${spec.id} status is inconsistent`);
      }
      continue;
    }
    if (!Array.isArray(scenario.attempts) || scenario.attempts.length !== repeats) {
      throw new Error(`lane ${lane.id} scenario ${spec.id} repeat count is invalid`);
    }
    scenario.attempts.forEach((attempt, attemptIndex) => {
      if (attempt.attempt !== attemptIndex + 1 || !['pass', 'fail', 'blocked'].includes(attempt.status)) {
        throw new Error(`lane ${lane.id} scenario ${spec.id} attempt ${attemptIndex + 1} is invalid`);
      }
      if (['pass', 'fail'].includes(attempt.status)) {
        validateProcessEvidence(
          attempt.process,
          spec,
          `lane ${lane.id} scenario ${spec.id} attempt ${attemptIndex + 1}`
        );
        if (attempt.status !== expectedCommandEvidenceStatus(attempt.process, spec)) {
          throw new Error(
            `lane ${lane.id} scenario ${spec.id} attempt status is inconsistent with process evidence`
          );
        }
      }
    });
    if (scenario.status !== deriveScenarioStatus(scenario.attempts)) {
      throw new Error(`lane ${lane.id} scenario ${spec.id} status is inconsistent`);
    }
  }
  assertPlainObject(record.cleanup, `lane ${lane.id}.cleanup`);
  if (!['pass', 'fail', 'infra_error'].includes(record.cleanup.status)) {
    throw new Error(`lane ${lane.id} cleanup status is invalid`);
  }
  const resultStatuses = [
    ...record.setup.map(({ status }) => status),
    ...record.scenarios.map(({ status }) => status),
    record.cleanup.status,
  ];
  const derivedStatus = resultStatuses.includes('infra_error')
    ? 'infra_error'
    : resultStatuses.includes('fail') || resultStatuses.includes('flaky')
      ? 'fail'
      : resultStatuses.includes('blocked')
        ? 'blocked'
        : 'pass';
  if (record.status !== derivedStatus) throw new Error(`lane ${lane.id} status is inconsistent`);
  return record;
}

export function aggregateRecords({ matrix, categories, scope, laneRecords, profile, nonce, bindings = {} }) {
  const profileSpec = matrix.profiles[profile];
  if (!profileSpec) throw new Error(`unknown profile: ${profile}`);
  const specifications = scenarioSpecifications(matrix);
  const laneById = new Map();
  const invalidLanes = [];
  for (const record of laneRecords) {
    try {
      validateLaneEvidence(record, { matrix, profile, nonce, scope, bindings });
      if (laneById.has(record.lane)) throw new Error(`duplicate lane ${record.lane}`);
      laneById.set(record.lane, record);
    } catch {
      invalidLanes.push(record?.lane ?? 'unknown');
    }
  }
  const missingLanes = profileSpec.lanes.filter((laneId) => !laneById.has(laneId));
  const sandboxIds = profileSpec.lanes.map((laneId) => laneById.get(laneId)?.sandboxId).filter(Boolean);
  const sandboxProblems = [];
  if (profileSpec.requireFreshSandbox) {
    if (
      sandboxIds.length !== profileSpec.lanes.length ||
      sandboxIds.some((id) => !String(id).startsWith('cloud-'))
    ) {
      sandboxProblems.push('full/soak lane lacks Cloud sandbox provenance');
    }
    if (new Set(sandboxIds).size !== sandboxIds.length)
      sandboxProblems.push('lane sandbox ids are not unique');
  }
  const features = [];
  for (const category of categories) {
    const laneSpec = matrix.lanes.find((lane) => lane.featureCategories.includes(category.id));
    const laneRecord = laneSpec ? laneById.get(laneSpec.id) : null;
    for (const featureId of category.features) {
      const candidates = [];
      if (laneRecord) {
        for (const result of laneRecord.scenarios ?? []) {
          const spec = specifications.get(result.id)?.scenario;
          if (!spec) continue;
          const exactFeature = (spec.coversFeatures ?? []).includes(featureId);
          if ((spec.coversCategories ?? []).includes(category.id) || exactFeature) {
            candidates.push({
              id: result.id,
              status: result.status,
              evidence: spec.evidence,
              reason: result.reason ?? '',
              coverage: exactFeature ? 'feature' : 'category-sample',
            });
          }
        }
      }
      const requiredEvidence = matrix.evidencePolicy[category.criticality];
      const passed = candidates
        .filter(({ status }) => status === 'pass')
        .sort((left, right) => EVIDENCE_RANK[right.evidence] - EVIDENCE_RANK[left.evidence]);
      const exactPassed = passed.filter(({ coverage }) => coverage === 'feature');
      const failed = candidates.filter(
        ({ status, coverage }) => coverage === 'feature' && (status === 'fail' || status === 'flaky')
      );
      const blocked = candidates.filter(({ status }) => status === 'blocked');
      let status;
      if (failed.length) status = 'broken';
      else if (exactPassed.some(({ evidence }) => EVIDENCE_RANK[evidence] >= EVIDENCE_RANK[requiredEvidence]))
        status = 'verified';
      else if (passed.length || exactPassed.length) status = 'evidence_gap';
      else if (blocked.length) status = 'blocked';
      else status = 'uncovered';
      features.push({
        id: featureId,
        category: category.id,
        criticality: category.criticality,
        lane: laneSpec?.id ?? null,
        requiredEvidence,
        bestEvidence: passed[0]?.evidence ?? null,
        status,
        scenarios: candidates,
      });
    }
  }
  const provedIssues = new Set();
  const provedMerges = corpusMergeProofs(laneRecords);
  for (const laneRecord of laneRecords) {
    for (const result of laneRecord.scenarios ?? []) {
      const specification = specifications.get(result.id)?.scenario;
      if (result.status === 'pass' && specification?.provesIssues === true) {
        for (const issue of specification.issues ?? []) provedIssues.add(issue);
      }
      if (result.status === 'pass' && specification?.provesMerges === true) {
        for (const merge of specification.merges ?? []) provedMerges.add(merge);
      }
    }
  }
  const issueCoverage = scope.issues.map((issue) => {
    const lane =
      Object.entries(scope.issueAssignments).find(([, assigned]) =>
        assigned.some((candidate) => candidate.number === issue.number)
      )?.[0] ?? null;
    const scenarioTrace = (matrix.lanes.find(({ id }) => id === lane)?.scenarios ?? [])
      .filter((scenario) => (scenario.issues ?? []).includes(issue.number))
      .map((scenario) => ({ id: scenario.id, kind: scenario.kind ?? 'command' }));
    return {
      ...issue,
      lane,
      scenarioTrace,
      accountingStatus: scenarioTrace.length ? 'scenario-declared' : 'lane-only',
      status: provedIssues.has(issue.number) ? 'executable-proof' : 'needs-proof',
    };
  });
  const mergeCoverage = scope.recentMerges.map((merge) => ({
    ...merge,
    lane:
      Object.entries(scope.mergeAssignments).find(([, assigned]) =>
        assigned.some((candidate) => candidate.number === merge.number)
      )?.[0] ?? null,
    status: provedMerges.has(merge.number) ? 'regression-guarded' : 'needs-regression-case',
  }));
  const scenarioResults = laneRecords.flatMap((lane) =>
    (lane.scenarios ?? []).map((scenario) => summarizeScenario(lane.lane, scenario))
  );
  const laneInfra = laneRecords.filter(
    ({ status, setup, cleanup }) =>
      status === 'infra_error' ||
      (setup ?? []).some(({ status: setupStatus }) => setupStatus !== 'pass') ||
      cleanup?.status !== 'pass'
  );
  const failures = scenarioResults.filter(({ status }) => status === 'fail' || status === 'flaky');
  const blockedScenarios = scenarioResults.filter(({ status }) => status === 'blocked');
  const coverageGaps = features.filter(({ status }) => status !== 'verified');
  const unprovedIssues = issueCoverage.filter(({ status }) => status !== 'executable-proof');
  const unguardedMerges = mergeCoverage.filter(({ status }) => status !== 'regression-guarded');
  let verdict = 'GREEN';
  const reasons = [];
  if (missingLanes.length || invalidLanes.length || sandboxProblems.length || laneInfra.length) {
    verdict = 'INFRA_BLOCKED';
    if (missingLanes.length) reasons.push(`missing lane evidence: ${missingLanes.join(', ')}`);
    if (invalidLanes.length) reasons.push(`invalid lane evidence: ${invalidLanes.join(', ')}`);
    reasons.push(...sandboxProblems);
    if (laneInfra.length)
      reasons.push(`infrastructure errors: ${laneInfra.map(({ lane }) => lane).join(', ')}`);
  } else if (failures.length || features.some(({ status }) => status === 'broken')) {
    verdict = 'RED';
    reasons.push(`${failures.length} scenario(s) failed or were flaky`);
  } else if (
    coverageGaps.length ||
    blockedScenarios.length ||
    unprovedIssues.length ||
    unguardedMerges.length
  ) {
    verdict = 'YELLOW';
    if (coverageGaps.length) reasons.push(`${coverageGaps.length} feature(s) lack required evidence`);
    if (blockedScenarios.length) reasons.push(`${blockedScenarios.length} scenario(s) are blocked`);
    if (unprovedIssues.length) reasons.push(`${unprovedIssues.length} open issue(s) lack executable proof`);
    if (unguardedMerges.length)
      reasons.push(`${unguardedMerges.length} recent functional merge(s) lack a regression case`);
  }
  return {
    version: CONTRACT_VERSION,
    kind: 'aggregate',
    nonce,
    product: matrix.product,
    repository: matrix.repository,
    profile,
    verdict,
    reasons,
    generatedAt: new Date().toISOString(),
    summary: {
      laneCount: profileSpec.lanes.length,
      featureCount: features.length,
      verifiedFeatures: features.filter(({ status }) => status === 'verified').length,
      brokenFeatures: features.filter(({ status }) => status === 'broken').length,
      featureEvidenceGaps: coverageGaps.length,
      openIssueCount: issueCoverage.length,
      openIssuesWithProof: issueCoverage.length - unprovedIssues.length,
      openIssuesWithScenario: issueCoverage.filter(({ scenarioTrace }) => scenarioTrace.length > 0).length,
      recentFunctionalMerges: mergeCoverage.length,
      guardedRecentMerges: mergeCoverage.length - unguardedMerges.length,
      passingScenarios: scenarioResults.filter(({ status }) => status === 'pass').length,
      failingOrFlakyScenarios: failures.length,
      blockedScenarios: blockedScenarios.length,
    },
    infrastructure: { missingLanes, invalidLanes, sandboxProblems, sandboxIds },
    lanes: laneRecords.map((record) => ({
      lane: record.lane,
      status: record.status,
      sandboxId: record.sandboxId,
      commit: record.commit,
      cleanup: record.cleanup,
      evidenceKind: `lanes/${record.lane}`,
    })),
    scenarios: scenarioResults,
    features,
    issues: issueCoverage,
    recentMerges: mergeCoverage,
  };
}

export function aggregateMarkdown(aggregate) {
  const lines = [
    `# ${aggregate.product} clean-room verification`,
    '',
    `Verdict: **${aggregate.verdict}**`,
    '',
    `Profile: \`${aggregate.profile}\``,
    `Run nonce: \`${aggregate.nonce}\``,
    '',
    '## Summary',
    '',
    `- Features: ${aggregate.summary.verifiedFeatures}/${aggregate.summary.featureCount} at required evidence depth`,
    `- Broken features: ${aggregate.summary.brokenFeatures}`,
    `- Scenarios: ${aggregate.summary.passingScenarios} pass, ${aggregate.summary.failingOrFlakyScenarios} fail/flaky, ${aggregate.summary.blockedScenarios} blocked`,
    `- Open issues with executable proof: ${aggregate.summary.openIssuesWithProof}/${aggregate.summary.openIssueCount}`,
    `- Open issues mapped to a named scenario: ${aggregate.summary.openIssuesWithScenario}/${aggregate.summary.openIssueCount}`,
    `- Recent functional merges guarded: ${aggregate.summary.guardedRecentMerges}/${aggregate.summary.recentFunctionalMerges}`,
    '',
    '## Reasons',
    '',
    ...(aggregate.reasons.length ? aggregate.reasons.map((reason) => `- ${reason}`) : ['- none']),
    '',
    '## Lane status',
    '',
    '| Lane | Status | Sandbox | Cleanup |',
    '|---|---|---|---|',
    ...aggregate.lanes.map(
      (lane) =>
        `| ${lane.lane} | ${lane.status} | ${lane.sandboxId ?? 'missing'} | ${lane.cleanup?.status ?? 'missing'} |`
    ),
    '',
    '## First unresolved feature evidence gaps',
    '',
    ...aggregate.features
      .filter(({ status }) => status !== 'verified')
      .slice(0, 50)
      .map(
        (feature) =>
          `- \`${feature.id}\` (${feature.criticality}): ${feature.status}; requires ${feature.requiredEvidence}, best ${feature.bestEvidence ?? 'none'}`
      ),
    '',
    '## First open issues without executable proof',
    '',
    ...aggregate.issues
      .filter(({ status }) => status !== 'executable-proof')
      .slice(0, 50)
      .map((issue) => `- #${issue.number} [${issue.lane ?? 'unassigned'}] ${issue.title}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function validateReview(review, expectedRole, expectedKind = null) {
  assertPlainObject(review, 'review');
  if (review.version !== CONTRACT_VERSION) throw new Error(`review.version must be ${CONTRACT_VERSION}`);
  if (review.role !== expectedRole) throw new Error(`review.role must be ${expectedRole}`);
  if (!['review', 'fix', 'supervisor'].includes(review.kind)) throw new Error('review.kind is invalid');
  if (expectedKind && review.kind !== expectedKind) throw new Error(`review.kind must be ${expectedKind}`);
  if (!REVIEW_VERDICTS.has(review.verdict)) throw new Error('review.verdict is invalid');
  for (const key of ['aggregateDigest', 'matrixSha256', 'runnerSha256']) {
    if (!/^[0-9a-f]{64}$/.test(review[key] ?? '')) {
      throw new Error(`review.${key} must be a SHA-256 digest copied from the campaign seal`);
    }
  }
  assertStringArray(review.deterministicEvidence, 'review.deterministicEvidence');
  assertStringArray(review.remainingRisks, 'review.remainingRisks');
  if (!Array.isArray(review.findings)) throw new Error('review.findings must be an array');
  for (const [index, finding] of review.findings.entries()) {
    assertPlainObject(finding, `review.findings[${index}]`);
    for (const key of ['findingId', 'file', 'issue', 'fixRequired', 'testRequired', 'evidence']) {
      if (typeof finding[key] !== 'string' || !finding[key].trim()) {
        throw new Error(`review.findings[${index}].${key} is required`);
      }
    }
    if (!['critical', 'high', 'medium', 'low'].includes(finding.severity)) {
      throw new Error(`review.findings[${index}].severity is invalid`);
    }
    if (!['open', 'resolved', 'accepted-risk'].includes(finding.status)) {
      throw new Error(`review.findings[${index}].status is invalid`);
    }
  }
  if (review.verdict === 'COMPREHENSIVELY_SATISFIED') {
    for (const key of ['whyPassed', 'endToEndWiringVerified']) {
      if (typeof review[key] !== 'string' || !review[key].trim())
        throw new Error(`review.${key} is required on signoff`);
    }
    if (review.findings.some(({ status }) => status === 'open')) {
      throw new Error('COMPREHENSIVELY_SATISFIED review cannot contain open findings');
    }
  }
  if (review.verdict === 'FINDINGS' && review.findings.length === 0) {
    throw new Error('FINDINGS review must include at least one finding');
  }
  const encoded = JSON.stringify(review);
  if (encoded.length > 128 * 1024) throw new Error('review exceeds 128 KiB');
  return review;
}

export function validateReviewProvenance(provenance, { nonce, product, profile, role }) {
  assertPlainObject(provenance, 'review provenance');
  if (
    provenance.version !== CONTRACT_VERSION ||
    provenance.kind !== 'review-provenance' ||
    provenance.nonce !== nonce ||
    provenance.product !== product ||
    provenance.profile !== profile ||
    provenance.role !== role ||
    typeof provenance.sandboxId !== 'string' ||
    !/^(?:cloud-[A-Za-z0-9][A-Za-z0-9._:-]{0,127}|local-[a-z0-9][a-z0-9-]*)$/.test(provenance.sandboxId)
  ) {
    throw new Error('review provenance is not bound to this reviewer executor');
  }
  return provenance;
}

export function assertReviewUploadSource(profile, source = 'auto', env = process.env) {
  const mode = sourceMode(source, env);
  if (profile !== 'smoke' && mode !== 'cloud') {
    throw new Error('full/soak review upload requires write-once Cloud evidence storage');
  }
  return mode;
}

export function validateReviewDraftPath(file, artifactRoot, nonce, role) {
  const resolvedFile = path.resolve(file);
  const expectedFile = path.join(path.resolve(artifactRoot), nonce, `draft-${role}.json`);
  if (resolvedFile !== expectedFile) {
    throw new Error(`review input must be the role's exact draft path: ${expectedFile}`);
  }
  return resolvedFile;
}

function reviewExportPath(artifactRoot, nonce, role, lane = null) {
  const suffix = lane ? `-lane-${lane}` : '';
  return path.join(path.resolve(artifactRoot), nonce, `review-input-${role}${suffix}.json`);
}

async function writePrivateReviewExport(target, value) {
  await overwriteRegularFileNoFollow(target, `${JSON.stringify(value, null, 2)}\n`, {
    label: `review export target ${target}`,
    mode: 0o600,
    currentUserOwned: true,
  });
}

async function exportReviewInput({
  catalog,
  matrixPath,
  profile,
  nonce,
  source,
  artifactRoot,
  role,
  priorRoles,
}) {
  const { aggregate, seal } = await readAndValidateCleanroomSeal({
    catalog,
    matrixPath,
    profile,
    nonce,
    source,
    artifactRoot,
  });
  const laneFiles = [];
  for (const lane of catalog.matrix.profiles[profile].lanes) {
    const record = await getRecord({ nonce, kind: `lanes/${lane}`, source, artifactRoot });
    const target = reviewExportPath(artifactRoot, nonce, role, lane);
    await writePrivateReviewExport(target, record);
    laneFiles.push({
      lane,
      path: path.relative(process.cwd(), target),
      sha256: recordDigest(record),
    });
  }
  const priorReviews = [];
  for (const priorRole of priorRoles) {
    priorReviews.push(
      validateReview(
        await getRecord({ nonce, kind: `reviews/${priorRole}`, source, artifactRoot }),
        priorRole
      )
    );
  }
  const input = {
    version: CONTRACT_VERSION,
    kind: 'cleanroom-review-input',
    nonce,
    product: catalog.matrix.product,
    profile,
    role,
    aggregate,
    seal,
    laneFiles,
    priorReviews,
    exportedAt: new Date().toISOString(),
  };
  await writePrivateReviewExport(reviewExportPath(artifactRoot, nonce, role), input);
  return input;
}

async function aggregateFromStorage({ catalog, profile, nonce, source, artifactRoot }) {
  const scope = assertScope(
    await getRecord({ nonce, kind: 'scope', source, artifactRoot }),
    catalog.matrix,
    nonce
  );
  const laneRecords = [];
  for (const laneId of catalog.matrix.profiles[profile].lanes) {
    try {
      laneRecords.push(await getRecord({ nonce, kind: `lanes/${laneId}`, source, artifactRoot }));
    } catch {
      // Missing evidence is represented explicitly by aggregateRecords.
    }
  }
  const [matrixBytes, runnerBytes] = await Promise.all([
    readFile(catalog.matrixPath),
    readFile(fileURLToPath(import.meta.url)),
  ]);
  const aggregate = aggregateRecords({
    matrix: catalog.matrix,
    categories: catalog.categories,
    scope,
    laneRecords,
    profile,
    nonce,
    bindings: {
      sourceCommit: gitValue(catalog.repoRoot, ['rev-parse', 'HEAD']),
      matrixSha256: createHash('sha256').update(matrixBytes).digest('hex'),
      runnerSha256: createHash('sha256').update(runnerBytes).digest('hex'),
    },
  });
  await putRecord({ nonce, kind: 'aggregate', value: aggregate, source, artifactRoot });
  if (sourceMode(source) === 'files') {
    const reportPath = path.join(path.resolve(artifactRoot), nonce, 'REPORT.md');
    await writePrivateGeneratedArtifact(reportPath, aggregateMarkdown(aggregate), 'clean-room report');
  }
  return aggregate;
}

export function validateCleanroomSeal(seal, expected) {
  if (
    !seal ||
    typeof seal !== 'object' ||
    Array.isArray(seal) ||
    seal.version !== CONTRACT_VERSION ||
    seal.kind !== 'cleanroom-campaign-seal' ||
    seal.nonce !== expected.nonce ||
    seal.product !== expected.product ||
    seal.profile !== expected.profile
  ) {
    throw new Error('clean-room campaign seal identity is invalid');
  }
  for (const key of ['aggregateDigest', 'matrixSha256', 'runnerSha256']) {
    if (!/^[0-9a-f]{64}$/.test(seal[key] ?? '') || seal[key] !== expected[key]) {
      throw new Error(`clean-room campaign seal ${key} does not match`);
    }
  }
  return seal;
}

async function activeCleanroomTarget({ catalog, matrixPath, profile, nonce, source, artifactRoot }) {
  const aggregate = await getRecord({ nonce, kind: 'aggregate', source, artifactRoot });
  if (
    aggregate.version !== CONTRACT_VERSION ||
    aggregate.kind !== 'aggregate' ||
    aggregate.nonce !== nonce ||
    aggregate.product !== catalog.matrix.product ||
    aggregate.profile !== profile
  ) {
    throw new Error('aggregate is not bound to this campaign');
  }
  const [matrixBytes, runnerBytes] = await Promise.all([
    readFile(path.resolve(matrixPath)),
    readFile(fileURLToPath(import.meta.url)),
  ]);
  return {
    aggregate,
    expected: {
      nonce,
      product: catalog.matrix.product,
      profile,
      aggregateDigest: recordDigest(aggregate),
      matrixSha256: createHash('sha256').update(matrixBytes).digest('hex'),
      runnerSha256: createHash('sha256').update(runnerBytes).digest('hex'),
    },
  };
}

async function readAndValidateCleanroomSeal(options) {
  const target = await activeCleanroomTarget(options);
  const seal = await getRecord({
    nonce: options.nonce,
    kind: 'seal',
    source: options.source,
    artifactRoot: options.artifactRoot,
  });
  validateCleanroomSeal(seal, target.expected);
  return { ...target, seal };
}

async function finalizeSignoff({
  catalog,
  matrixPath,
  nonce,
  profile,
  source,
  artifactRoot,
  claudeRole,
  codexRole,
}) {
  const { aggregate, seal } = await readAndValidateCleanroomSeal({
    catalog,
    matrixPath,
    nonce,
    profile,
    source,
    artifactRoot,
  });
  const product = catalog.matrix.product;
  const aggregateDigest = seal.aggregateDigest;
  const claude = validateReview(
    await getRecord({ nonce, kind: `reviews/${claudeRole}`, source, artifactRoot }),
    claudeRole,
    'review'
  );
  const codex = validateReview(
    await getRecord({ nonce, kind: `reviews/${codexRole}`, source, artifactRoot }),
    codexRole,
    'review'
  );
  for (const review of [claude, codex]) {
    if (
      review.aggregateDigest !== aggregateDigest ||
      review.matrixSha256 !== seal.matrixSha256 ||
      review.runnerSha256 !== seal.runnerSha256
    ) {
      throw new Error('review signoff does not match the current campaign seal');
    }
  }
  if (profile !== 'smoke') {
    if (
      !String(claude.sandboxId).startsWith('cloud-') ||
      !String(codex.sandboxId).startsWith('cloud-') ||
      claude.sandboxId === codex.sandboxId
    ) {
      throw new Error('full/soak signoff requires distinct Cloud reviewer sandboxes');
    }
  }
  const bothSatisfied =
    claude.verdict === 'COMPREHENSIVELY_SATISFIED' && codex.verdict === 'COMPREHENSIVELY_SATISFIED';
  const signoff = {
    version: CONTRACT_VERSION,
    kind: 'signoff',
    nonce,
    product,
    profile,
    status: bothSatisfied ? 'SIGNED_OFF' : 'BLOCKED',
    productVerdict: aggregate.verdict,
    aggregateDigest,
    matrixSha256: seal.matrixSha256,
    runnerSha256: seal.runnerSha256,
    completedAt: new Date().toISOString(),
    claude: {
      role: claude.role,
      verdict: claude.verdict,
      rationale: claude.whyPassed ?? '',
      remainingRisks: claude.remainingRisks,
    },
    codex: {
      role: codex.role,
      verdict: codex.verdict,
      rationale: codex.whyPassed ?? '',
      remainingRisks: codex.remainingRisks,
    },
    evidence: ['aggregate', `reviews/${claudeRole}`, `reviews/${codexRole}`],
  };
  await putRecord({ nonce, kind: 'signoff', value: signoff, source, artifactRoot });
  if (sourceMode(source) === 'files') {
    const signoffPath = path.join(path.resolve(artifactRoot), nonce, 'SIGNOFF.md');
    await writePrivateGeneratedArtifact(
      signoffPath,
      [
        `# ${product} clean-room signoff`,
        '',
        `Evidence signoff: **${signoff.status}**`,
        `Product verdict: **${signoff.productVerdict}**`,
        '',
        `Claude (${claudeRole}): ${claude.verdict}`,
        claude.whyPassed ?? '',
        '',
        `Codex (${codexRole}): ${codex.verdict}`,
        codex.whyPassed ?? '',
        '',
      ].join('\n'),
      'clean-room signoff'
    );
  }
  return signoff;
}

async function enforceCleanroom(options) {
  const { aggregate, seal } = await readAndValidateCleanroomSeal(options);
  const signoff = await getRecord({
    nonce: options.nonce,
    kind: 'signoff',
    source: options.source,
    artifactRoot: options.artifactRoot,
  });
  if (
    signoff.version !== CONTRACT_VERSION ||
    signoff.kind !== 'signoff' ||
    signoff.nonce !== options.nonce ||
    signoff.product !== options.catalog.matrix.product ||
    signoff.profile !== options.profile ||
    signoff.status !== 'SIGNED_OFF' ||
    signoff.productVerdict !== aggregate.verdict
  ) {
    throw new Error('clean-room signoff identity is invalid or unsigned');
  }
  for (const key of ['aggregateDigest', 'matrixSha256', 'runnerSha256']) {
    if (signoff[key] !== seal[key]) throw new Error(`signoff.${key} does not match campaign seal`);
  }
  const finalEntries = [
    { provider: 'claude', entry: signoff.claude },
    { provider: 'codex', entry: signoff.codex },
  ];
  if (signoff.claude?.role === signoff.codex?.role) {
    throw new Error('clean-room signoff reviewers are not independent');
  }
  for (const { provider, entry } of finalEntries) {
    const role = assertSafeId(entry?.role, `${provider} signoff role`);
    if (!role.includes(provider)) throw new Error(`${provider} signoff has the wrong provider role`);
    const review = validateReview(
      await getRecord({
        nonce: options.nonce,
        kind: `reviews/${role}`,
        source: options.source,
        artifactRoot: options.artifactRoot,
      }),
      role,
      'review'
    );
    if (
      review.verdict !== 'COMPREHENSIVELY_SATISFIED' ||
      review.aggregateDigest !== seal.aggregateDigest ||
      review.matrixSha256 !== seal.matrixSha256 ||
      review.runnerSha256 !== seal.runnerSha256
    ) {
      throw new Error(`final review ${role} is not a satisfied sealed review`);
    }
  }
  if (aggregate.verdict !== 'GREEN') {
    throw new Error(`Relay clean-room product verdict is ${aggregate.verdict}`);
  }
  return aggregate;
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const matrixPath = typeof options.matrix === 'string' ? options.matrix : DEFAULT_MATRIX;
  const artifactRoot = typeof options.artifacts === 'string' ? options.artifacts : DEFAULT_ARTIFACT_ROOT;
  if (command === 'nonce') {
    console.log(randomBytes(16).toString('hex'));
    return;
  }
  const catalog = await loadCatalog(matrixPath);
  const profile = typeof options.profile === 'string' ? options.profile : 'full';
  if (!catalog.matrix.profiles[profile]) throw new Error(`unknown profile: ${profile}`);
  if (command === 'validate') {
    const featureCount = catalog.categories.reduce((total, category) => total + category.features.length, 0);
    console.log(
      `CLEANROOM_MATRIX_VALID product=${catalog.matrix.product} features=${featureCount} lanes=${catalog.matrix.lanes.length} profile=${profile}`
    );
    return;
  }
  const nonce = assertNonce(requiredOption(options, 'nonce'));
  const source = typeof options.source === 'string' ? options.source : 'auto';
  if (command === 'storage-preflight') {
    await verifyWriteOnceStorage({ nonce, source, artifactRoot });
    console.log('CLEANROOM_STORAGE_WRITE_ONCE_VERIFIED');
    return;
  }
  if (command === 'scope') {
    const scope = await buildScope({ matrix: catalog.matrix, nonce });
    assertScope(scope, catalog.matrix, nonce);
    await putRecord({ nonce, kind: 'scope', value: scope, source, artifactRoot });
    console.log(`CLEANROOM_SCOPE_COMPLETE issues=${scope.issues.length} merges=${scope.recentMerges.length}`);
    return;
  }
  if (command === 'gate-scope') {
    const scope = assertScope(
      await getRecord({ nonce, kind: 'scope', source, artifactRoot }),
      catalog.matrix,
      nonce
    );
    console.log(`CLEANROOM_SCOPE_VALID issues=${scope.issues.length} merges=${scope.recentMerges.length}`);
    return;
  }
  if (command === 'lane') {
    const lane = assertSafeId(requiredOption(options, 'lane'), 'lane');
    const record = await runLane({ catalog, laneId: lane, profile, nonce, source, artifactRoot });
    console.log(
      `CLEANROOM_LANE_COMPLETE lane=${lane} status=${record.status} scenarios=${record.scenarios.length} sandbox=${record.sandboxId}`
    );
    return;
  }
  if (command === 'gate-lane') {
    const lane = assertSafeId(requiredOption(options, 'lane'), 'lane');
    const record = await getRecord({ nonce, kind: `lanes/${lane}`, source, artifactRoot });
    if (
      record.version !== CONTRACT_VERSION ||
      record.nonce !== nonce ||
      record.lane !== lane ||
      record.profile !== profile
    ) {
      throw new Error(`invalid evidence for lane ${lane}`);
    }
    console.log(
      `CLEANROOM_LANE_EVIDENCE_VALID lane=${lane} status=${record.status} sandbox=${record.sandboxId}`
    );
    return;
  }
  if (command === 'aggregate') {
    const aggregate = await aggregateFromStorage({ catalog, profile, nonce, source, artifactRoot });
    if (
      aggregate.version !== CONTRACT_VERSION ||
      aggregate.kind !== 'aggregate' ||
      aggregate.nonce !== nonce ||
      aggregate.product !== catalog.matrix.product ||
      aggregate.profile !== profile
    ) {
      throw new Error('aggregate is not bound to this campaign');
    }
    console.log(
      `CLEANROOM_AGGREGATE_COMPLETE verdict=${aggregate.verdict} features=${aggregate.summary.verifiedFeatures}/${aggregate.summary.featureCount} issues=${aggregate.summary.openIssuesWithProof}/${aggregate.summary.openIssueCount}`
    );
    return;
  }
  if (command === 'seal') {
    const { expected } = await activeCleanroomTarget({
      catalog,
      matrixPath,
      profile,
      nonce,
      source,
      artifactRoot,
    });
    const seal = {
      version: CONTRACT_VERSION,
      kind: 'cleanroom-campaign-seal',
      ...expected,
      createdAt: new Date().toISOString(),
    };
    await putRecord({ nonce, kind: 'seal', value: seal, source, artifactRoot });
    await readAndValidateCleanroomSeal({
      catalog,
      matrixPath,
      profile,
      nonce,
      source,
      artifactRoot,
    });
    console.log(`CLEANROOM_CAMPAIGN_SEALED aggregate=${seal.aggregateDigest}`);
    return;
  }
  if (command === 'show') {
    const kind = requiredOption(options, 'kind');
    const role = typeof options.role === 'string' ? assertSafeId(options.role, 'role') : null;
    const storageKind = kind === 'review' ? `reviews/${role ?? requiredOption(options, 'role')}` : kind;
    console.log(JSON.stringify(await getRecord({ nonce, kind: storageKind, source, artifactRoot }), null, 2));
    return;
  }
  if (command === 'review-export') {
    const role = assertSafeId(requiredOption(options, 'role'), 'role');
    const priorRoles =
      typeof options['prior-roles'] === 'string' && options['prior-roles'].trim()
        ? options['prior-roles'].split(',').map((priorRole) => assertSafeId(priorRole, 'prior role'))
        : [];
    const input = await exportReviewInput({
      catalog,
      matrixPath,
      profile,
      nonce,
      source,
      artifactRoot,
      role,
      priorRoles,
    });
    console.log(
      `CLEANROOM_REVIEW_INPUT_EXPORTED role=${role} lanes=${input.laneFiles.length} prior=${priorRoles.length}`
    );
    return;
  }
  if (command === 'review-provenance') {
    const role = assertSafeId(requiredOption(options, 'role'), 'role');
    const evidenceMode = sourceMode(source);
    const explicitSandboxId = process.env.SANDBOX_ID?.trim();
    if (profile !== 'smoke' && (evidenceMode !== 'cloud' || !explicitSandboxId)) {
      throw new Error("full/soak review requires the reviewer Cloud executor's SANDBOX_ID");
    }
    const provenance = {
      version: CONTRACT_VERSION,
      kind: 'review-provenance',
      nonce,
      product: catalog.matrix.product,
      profile,
      role,
      sandboxId: explicitSandboxId ? `cloud-${explicitSandboxId}` : `local-${role}`,
    };
    validateReviewProvenance(provenance, {
      nonce,
      product: catalog.matrix.product,
      profile,
      role,
    });
    try {
      await putRecord({
        nonce,
        kind: `review-provenance/${role}`,
        value: provenance,
        source,
        artifactRoot,
      });
    } catch (error) {
      if (!/(?:already contains|412)/.test(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
      const stored = await getRecord({
        nonce,
        kind: `review-provenance/${role}`,
        source,
        artifactRoot,
      });
      if (recordDigest(stored) !== recordDigest(provenance)) {
        throw new Error(`review provenance for ${role} conflicts with its write-once capture`);
      }
    }
    console.log(`CLEANROOM_REVIEW_SANDBOX_CAPTURED role=${role} sandbox=${provenance.sandboxId}`);
    return;
  }
  if (command === 'review-upload') {
    assertReviewUploadSource(profile, source);
    const role = assertSafeId(requiredOption(options, 'role'), 'role');
    const reviewKind = requiredOption(options, 'review-kind');
    const file = validateReviewDraftPath(requiredOption(options, 'file'), artifactRoot, nonce, role);
    const review = validateReview(JSON.parse(await readFile(file, 'utf8')), role, reviewKind);
    const { seal } = await readAndValidateCleanroomSeal({
      catalog,
      matrixPath,
      profile,
      nonce,
      source,
      artifactRoot,
    });
    for (const key of ['aggregateDigest', 'matrixSha256', 'runnerSha256']) {
      if (review[key] !== seal[key]) throw new Error(`review.${key} does not match campaign seal`);
    }
    const provenance = validateReviewProvenance(
      await getRecord({
        nonce,
        kind: `review-provenance/${role}`,
        source,
        artifactRoot,
      }),
      { nonce, product: catalog.matrix.product, profile, role }
    );
    if (review.sandboxId !== provenance.sandboxId) {
      throw new Error('review sandboxId does not match its write-once reviewer-executor capture');
    }
    review.nonce = nonce;
    review.product = catalog.matrix.product;
    review.profile = profile;
    review.sandboxId = provenance.sandboxId;
    review.completedAt = new Date().toISOString();
    await putRecord({ nonce, kind: `reviews/${role}`, value: review, source, artifactRoot });
    console.log(`CLEANROOM_REVIEW_UPLOADED role=${role} verdict=${review.verdict}`);
    return;
  }
  if (command === 'gate-review') {
    const role = assertSafeId(requiredOption(options, 'role'), 'role');
    const reviewKind = requiredOption(options, 'review-kind');
    const review = validateReview(
      await getRecord({ nonce, kind: `reviews/${role}`, source, artifactRoot }),
      role,
      reviewKind
    );
    if (review.nonce !== nonce || review.product !== catalog.matrix.product || review.profile !== profile) {
      throw new Error(`review ${role} is not bound to this campaign`);
    }
    const { seal } = await readAndValidateCleanroomSeal({
      catalog,
      matrixPath,
      profile,
      nonce,
      source,
      artifactRoot,
    });
    for (const key of ['aggregateDigest', 'matrixSha256', 'runnerSha256']) {
      if (review[key] !== seal[key]) throw new Error(`review ${role} does not match campaign seal`);
    }
    console.log(`CLEANROOM_REVIEW_VALID role=${role} verdict=${review.verdict}`);
    return;
  }
  if (command === 'finalize') {
    const signoff = await finalizeSignoff({
      catalog,
      matrixPath,
      nonce,
      profile,
      source,
      artifactRoot,
      claudeRole: assertSafeId(requiredOption(options, 'claude-role'), 'claude-role'),
      codexRole: assertSafeId(requiredOption(options, 'codex-role'), 'codex-role'),
    });
    console.log(
      `CLEANROOM_SIGNOFF_COMPLETE status=${signoff.status} product_verdict=${signoff.productVerdict}`
    );
    if (signoff.status !== 'SIGNED_OFF') process.exitCode = 2;
    return;
  }
  if (command === 'enforce') {
    const aggregate = await enforceCleanroom({
      catalog,
      matrixPath,
      profile,
      nonce,
      source,
      artifactRoot,
    });
    console.log(`CLEANROOM_PRODUCT_GREEN nonce=${nonce} verdict=${aggregate.verdict}`);
    return;
  }
  throw new Error(
    'usage: cleanroom.mjs <nonce|validate|storage-preflight|scope|gate-scope|lane|gate-lane|aggregate|seal|show|review-export|review-provenance|review-upload|gate-review|finalize|enforce> [options]'
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(redactEvidence(error instanceof Error ? error.stack : String(error)));
    process.exitCode = 2;
  });
}
