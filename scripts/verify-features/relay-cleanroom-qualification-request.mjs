#!/usr/bin/env node

import assert from 'node:assert/strict';
import { constants as fsConstants } from 'node:fs';
import { appendFile, open, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateQualificationManifest } from './qualification-manifest.mjs';

export const RELAY_REPOSITORY = 'AgentWorkforce/relay';
export const REQUEST_WORKFLOW_NAME = 'Relay cleanroom qualification request';
export const REQUEST_WORKFLOW_PATH = '.github/workflows/relay-cleanroom-qualification-request.yml';
export const REQUEST_ARTIFACT_NAME = 'relay-cleanroom-qualification-request';
export const REQUEST_FILE_NAME = 'relay-cleanroom-qualification-request.json';

const DEFAULT_BRANCH = 'main';
const QUALIFICATION_BRANCH = /^qualification\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\[bot\])?$/;
const REQUEST_SIZE_LIMIT = 256 * 1024;

function object(value, label) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function exactKeys(value, keys, label) {
  const resolved = object(value, label);
  assert.deepEqual(Object.keys(resolved).sort(), [...keys].sort(), `${label} has an unexpected shape`);
  return resolved;
}

function positiveSafeInteger(value, label) {
  assert(Number.isSafeInteger(value) && value > 0, `${label} must be a positive safe integer`);
  return value;
}

function exactString(value, expected, label) {
  assert.equal(value, expected, `${label} must be ${JSON.stringify(expected)}`);
  return value;
}

function boundedString(value, pattern, label) {
  assert(typeof value === 'string' && value.length <= 160 && pattern.test(value), `${label} is invalid`);
  return value;
}

export function validateApprovedActors(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('approved qualification actors must be a JSON array');
  }
  assert(Array.isArray(parsed), 'approved qualification actors must be a JSON array');
  assert(parsed.length > 0 && parsed.length <= 50, 'approved qualification actors must contain 1-50 entries');
  for (const actor of parsed) {
    assert(
      typeof actor === 'string' && actor.length <= 100 && GITHUB_LOGIN.test(actor),
      'approved qualification actor is invalid'
    );
  }
  assert.equal(new Set(parsed).size, parsed.length, 'approved qualification actors must be unique');
  return parsed;
}

export function validateQualificationRequestEvent(value, approvedActorsJson) {
  const event = object(value, 'event');
  exactString(
    object(event.repository, 'event.repository').full_name,
    RELAY_REPOSITORY,
    'event.repository.full_name'
  );
  const run = object(event.workflow_run, 'event.workflow_run');
  exactString(run.name, REQUEST_WORKFLOW_NAME, 'workflow_run.name');
  exactString(run.path, REQUEST_WORKFLOW_PATH, 'workflow_run.path');
  assert(
    run.event === 'workflow_dispatch' || run.event === 'repository_dispatch',
    'workflow_run.event must be workflow_dispatch or repository_dispatch'
  );
  exactString(run.status, 'completed', 'workflow_run.status');
  exactString(run.conclusion, 'success', 'workflow_run.conclusion');
  exactString(
    object(run.head_repository, 'workflow_run.head_repository').full_name,
    RELAY_REPOSITORY,
    'workflow_run.head_repository.full_name'
  );

  const approvedActors = validateApprovedActors(approvedActorsJson);
  const actor = boundedString(
    object(run.actor, 'workflow_run.actor').login,
    GITHUB_LOGIN,
    'workflow_run.actor.login'
  );
  const triggeringActor = boundedString(
    object(run.triggering_actor, 'workflow_run.triggering_actor').login,
    GITHUB_LOGIN,
    'workflow_run.triggering_actor.login'
  );
  assert(approvedActors.includes(actor), 'workflow_run.actor.login is not approved');
  assert(approvedActors.includes(triggeringActor), 'workflow_run.triggering_actor.login is not approved');

  const headBranch = boundedString(
    run.head_branch,
    run.event === 'workflow_dispatch' ? QUALIFICATION_BRANCH : /^main$/,
    'workflow_run.head_branch'
  );
  return {
    repository: RELAY_REPOSITORY,
    workflow: REQUEST_WORKFLOW_NAME,
    workflowPath: REQUEST_WORKFLOW_PATH,
    event: run.event,
    runId: positiveSafeInteger(run.id, 'workflow_run.id'),
    runAttempt: positiveSafeInteger(run.run_attempt, 'workflow_run.run_attempt'),
    headBranch,
    headSha: boundedString(run.head_sha, GIT_SHA, 'workflow_run.head_sha'),
    actor,
    triggeringActor,
  };
}

export function selectQualificationRequestArtifact(contextValue, pageValues) {
  const context = object(contextValue, 'context');
  assert(
    Array.isArray(pageValues) && pageValues.length === 1,
    'request artifacts must fit in exactly one API page'
  );
  const page = object(pageValues[0], 'artifact page');
  assert(Array.isArray(page.artifacts), 'artifact page.artifacts must be an array');
  assert.equal(page.total_count, page.artifacts.length, 'artifact page must contain every request artifact');
  assert.equal(page.artifacts.length, 1, 'request run must expose exactly one artifact');
  const artifact = object(page.artifacts[0], 'request artifact');
  exactString(artifact.name, REQUEST_ARTIFACT_NAME, 'request artifact.name');
  exactString(artifact.expired, false, 'request artifact.expired');
  const artifactId = positiveSafeInteger(artifact.id, 'request artifact.id');
  assert(
    Number.isSafeInteger(artifact.size_in_bytes) &&
      artifact.size_in_bytes > 0 &&
      artifact.size_in_bytes <= REQUEST_SIZE_LIMIT,
    'request artifact size is invalid'
  );
  const artifactDigest = boundedString(artifact.digest, SHA256_DIGEST, 'request artifact.digest');
  assert.equal(
    positiveSafeInteger(
      object(artifact.workflow_run, 'request artifact.workflow_run').id,
      'request artifact.workflow_run.id'
    ),
    context.runId,
    'request artifact must belong to the triggering run'
  );
  return { artifactId, artifactDigest };
}

export function validateQualificationRequest(value, contextValue, selectionValue) {
  const context = object(contextValue, 'context');
  const selection = object(selectionValue, 'selection');
  const request = exactKeys(
    value,
    ['schemaVersion', 'kind', 'producer', 'qualificationManifest'],
    'qualification request'
  );
  assert.equal(request.schemaVersion, 1, 'qualification request schemaVersion must be 1');
  exactString(request.kind, 'relayCleanroomQualificationRequest', 'qualification request.kind');
  const producer = exactKeys(
    request.producer,
    [
      'repository',
      'workflow',
      'workflowPath',
      'event',
      'runId',
      'runAttempt',
      'headBranch',
      'headSha',
      'actor',
      'triggeringActor',
    ],
    'qualification request.producer'
  );
  assert.deepEqual(producer, context, 'qualification request producer must match the triggering run');
  boundedString(selection.artifactDigest, SHA256_DIGEST, 'selection.artifactDigest');

  const manifest = validateQualificationManifest(request.qualificationManifest);
  if (context.event === 'workflow_dispatch') {
    assert.equal(
      manifest.relaySha,
      context.headSha,
      'manual qualification manifest relaySha must match the dispatched qualification ref'
    );
  }
  return {
    version: 1,
    kind: 'trustedRelayCleanroomQualification',
    requestArtifactDigest: selection.artifactDigest,
    producer: context,
    manifest,
  };
}

export async function readQualificationRequestDirectory(directory, context, selection) {
  const entries = await readdir(directory, { withFileTypes: true });
  assert.equal(entries.length, 1, 'qualification request artifact must contain exactly one entry');
  assert.equal(
    entries[0].name,
    REQUEST_FILE_NAME,
    `qualification request entry must be ${REQUEST_FILE_NAME}`
  );
  assert(entries[0].isFile(), 'qualification request entry must be a regular file');
  assert(Number.isInteger(fsConstants.O_NOFOLLOW), 'qualification request validation requires O_NOFOLLOW');
  const handle = await open(
    path.join(directory, REQUEST_FILE_NAME),
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
  );
  try {
    const metadata = await handle.stat();
    assert(metadata.isFile(), 'qualification request must be a regular file');
    assert(
      metadata.size > 0 && metadata.size <= REQUEST_SIZE_LIMIT,
      'qualification request exceeds its size bound'
    );
    const source = await handle.readFile('utf8');
    assert(
      Buffer.byteLength(source, 'utf8') <= REQUEST_SIZE_LIMIT,
      'qualification request content exceeds its size bound'
    );
    return validateQualificationRequest(JSON.parse(source), context, selection);
  } finally {
    await handle.close();
  }
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    assert(key?.startsWith('--') && value !== undefined, `invalid argument ${key ?? '<missing>'}`);
    const name = key.slice(2);
    assert(!(name in options), `duplicate argument --${name}`);
    options[name] = value;
  }
  return { command, options };
}

function requireOptions(options, names) {
  assert.deepEqual(
    Object.keys(options).sort(),
    [...names].sort(),
    'command arguments must exactly match the contract'
  );
}

async function readJson(file, label) {
  const source = await readFile(path.resolve(file), 'utf8');
  assert(Buffer.byteLength(source, 'utf8') <= 1024 * 1024, `${label} exceeds its size bound`);
  return JSON.parse(source);
}

async function writeJson(file, value) {
  await writeFile(path.resolve(file), `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

async function appendOutputs(file, values) {
  const lines = Object.entries(values).map(([name, value]) => {
    const rendered = String(value);
    assert(!rendered.includes('\n') && !rendered.includes('\r'), `output ${name} contains a newline`);
    return `${name}=${rendered}`;
  });
  await appendFile(path.resolve(file), `${lines.join('\n')}\n`, 'utf8');
}

export async function runCli(argv) {
  const { command, options } = parseArguments(argv);
  if (command === 'validate-event') {
    requireOptions(options, ['event', 'approved-actors-json', 'output', 'github-output']);
    const context = validateQualificationRequestEvent(
      await readJson(options.event, 'workflow event'),
      options['approved-actors-json']
    );
    await writeJson(options.output, context);
    await appendOutputs(options['github-output'], { run_id: context.runId });
    return;
  }
  if (command === 'select-artifact') {
    requireOptions(options, ['context', 'artifact-pages', 'output', 'github-output']);
    const context = await readJson(options.context, 'request context');
    const selection = selectQualificationRequestArtifact(
      context,
      await readJson(options['artifact-pages'], 'artifact pages')
    );
    await writeJson(options.output, selection);
    await appendOutputs(options['github-output'], {
      request_artifact_id: selection.artifactId,
      request_artifact_digest: selection.artifactDigest,
    });
    return;
  }
  if (command === 'validate-request') {
    requireOptions(options, ['context', 'selection', 'directory', 'output', 'github-output']);
    const normalized = await readQualificationRequestDirectory(
      path.resolve(options.directory),
      await readJson(options.context, 'request context'),
      await readJson(options.selection, 'artifact selection')
    );
    await writeJson(options.output, normalized);
    await appendOutputs(options['github-output'], {
      manifest_json: JSON.stringify(normalized.manifest),
      relay_sha: normalized.manifest.relaySha,
      release_tag: normalized.manifest.releaseTag,
      relay_package_run_id: normalized.manifest.relayPackageQualification.runId,
      relay_package_run_attempt: normalized.manifest.relayPackageQualification.runAttempt,
    });
    return normalized;
  }
  throw new Error(`unknown command ${command ?? '<missing>'}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
