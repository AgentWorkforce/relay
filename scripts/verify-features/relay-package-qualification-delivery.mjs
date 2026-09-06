#!/usr/bin/env node

import assert from 'node:assert/strict';
import { appendFile, lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const RELAY_REPOSITORY = 'AgentWorkforce/relay';
export const PRODUCER_WORKFLOW_NAME = 'Relay package qualification';
export const PRODUCER_WORKFLOW_PATH = '.github/workflows/relay-package-qualification.yml';
export const REQUEST_ARTIFACT_NAME = 'relay-package-cloud-request';
export const REQUEST_FILE_NAME = 'relay-package-cloud-request.json';
export const ATTESTATION_ARTIFACT_NAME = 'relay-package-qualification-attestation';
export const CLOUD_DISPATCH_EVENT = 'relay_package_qualification_ready';

const QUALIFICATION_BRANCH = /^qualification\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const REQUEST_SIZE_LIMIT = 64 * 1024;
const ATTESTATION_SIZE_LIMIT = 256 * 1024;
const MAX_ARTIFACTS = 8;

function object(value, label) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  return value;
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
  assert(typeof value === 'string' && pattern.test(value), `${label} is invalid`);
  return value;
}

function workflowPathWithoutRef(value) {
  assert(typeof value === 'string', 'workflow_run.path must be a string');
  const parts = value.split('@');
  assert(parts.length <= 2, 'workflow_run.path must contain at most one ref suffix');
  return parts[0];
}

export function validateWorkflowRunEvent(value) {
  const event = object(value, 'event');
  const repository = object(event.repository, 'event.repository');
  exactString(repository.full_name, RELAY_REPOSITORY, 'event.repository.full_name');

  const run = object(event.workflow_run, 'event.workflow_run');
  exactString(run.name, PRODUCER_WORKFLOW_NAME, 'workflow_run.name');
  exactString(workflowPathWithoutRef(run.path), PRODUCER_WORKFLOW_PATH, 'workflow_run.path');
  exactString(run.event, 'workflow_dispatch', 'workflow_run.event');
  exactString(run.status, 'completed', 'workflow_run.status');
  exactString(run.conclusion, 'success', 'workflow_run.conclusion');
  exactString(
    object(run.head_repository, 'workflow_run.head_repository').full_name,
    RELAY_REPOSITORY,
    'workflow_run.head_repository.full_name'
  );

  const sourceBranch = boundedString(run.head_branch, QUALIFICATION_BRANCH, 'workflow_run.head_branch');
  assert(!sourceBranch.includes('..'), 'workflow_run.head_branch must not contain traversal segments');

  return {
    repository: RELAY_REPOSITORY,
    workflowName: PRODUCER_WORKFLOW_NAME,
    workflowPath: PRODUCER_WORKFLOW_PATH,
    runId: positiveSafeInteger(run.id, 'workflow_run.id'),
    runAttempt: positiveSafeInteger(run.run_attempt, 'workflow_run.run_attempt'),
    sourceGitSha: boundedString(run.head_sha, GIT_SHA, 'workflow_run.head_sha'),
    sourceBranch,
  };
}

function validateArtifact(artifact, context, name, sizeLimit) {
  const value = object(artifact, `artifact ${name}`);
  exactString(value.name, name, `artifact ${name}.name`);
  assert.equal(value.expired, false, `artifact ${name} must not be expired`);
  positiveSafeInteger(value.id, `artifact ${name}.id`);
  assert(
    Number.isSafeInteger(value.size_in_bytes) && value.size_in_bytes > 0 && value.size_in_bytes <= sizeLimit,
    `artifact ${name}.size_in_bytes must be between 1 and ${sizeLimit}`
  );
  boundedString(value.digest, SHA256_DIGEST, `artifact ${name}.digest`);
  assert.equal(
    positiveSafeInteger(
      object(value.workflow_run, `artifact ${name}.workflow_run`).id,
      `artifact ${name}.workflow_run.id`
    ),
    context.runId,
    `artifact ${name} must belong to the triggering run`
  );
  return value;
}

export function selectQualificationArtifacts(contextValue, pageValues) {
  const context = object(contextValue, 'context');
  assert(Array.isArray(pageValues) && pageValues.length > 0, 'artifact pages must be a non-empty array');

  const artifacts = pageValues.flatMap((page, index) => {
    const value = object(page, `artifact page ${index}`);
    assert(Array.isArray(value.artifacts), `artifact page ${index}.artifacts must be an array`);
    return value.artifacts;
  });
  assert(artifacts.length <= MAX_ARTIFACTS, `producer run must expose at most ${MAX_ARTIFACTS} artifacts`);

  const artifactIds = artifacts.map((artifact, index) =>
    positiveSafeInteger(object(artifact, `artifact ${index}`).id, `artifact ${index}.id`)
  );
  assert.equal(new Set(artifactIds).size, artifactIds.length, 'artifact ids must be unique');

  const exactlyOne = (name) => {
    const matches = artifacts.filter((artifact) => artifact.name === name);
    assert.equal(matches.length, 1, `producer run must expose exactly one ${name} artifact`);
    return matches[0];
  };

  const request = validateArtifact(
    exactlyOne(REQUEST_ARTIFACT_NAME),
    context,
    REQUEST_ARTIFACT_NAME,
    REQUEST_SIZE_LIMIT
  );
  const attestation = validateArtifact(
    exactlyOne(ATTESTATION_ARTIFACT_NAME),
    context,
    ATTESTATION_ARTIFACT_NAME,
    ATTESTATION_SIZE_LIMIT
  );

  return {
    requestArtifactId: request.id,
    requestArtifactDigest: request.digest,
    attestationArtifactDigest: attestation.digest,
  };
}

export function expectedCloudDispatch(contextValue, selectionValue) {
  const context = object(contextValue, 'context');
  const selection = object(selectionValue, 'selection');
  return {
    event_type: CLOUD_DISPATCH_EVENT,
    client_payload: {
      schemaVersion: 1,
      kind: 'relayPackageQualificationReady',
      relay: {
        runId: positiveSafeInteger(context.runId, 'context.runId'),
        runAttempt: positiveSafeInteger(context.runAttempt, 'context.runAttempt'),
        sourceGitSha: boundedString(context.sourceGitSha, GIT_SHA, 'context.sourceGitSha'),
        attestationArtifactDigest: boundedString(
          selection.attestationArtifactDigest,
          SHA256_DIGEST,
          'selection.attestationArtifactDigest'
        ),
      },
    },
  };
}

export function validateCloudDispatchRequest(requestValue, context, selection) {
  const expected = expectedCloudDispatch(context, selection);
  assert.deepEqual(requestValue, expected, 'request artifact must exactly match trusted producer identity');
  return expected;
}

export async function validateRequestArtifactDirectory(directory, context, selection) {
  const entries = await readdir(directory, { withFileTypes: true });
  assert.equal(entries.length, 1, 'request artifact must contain exactly one entry');
  assert.equal(entries[0].name, REQUEST_FILE_NAME, `request artifact entry must be ${REQUEST_FILE_NAME}`);
  assert(entries[0].isFile(), 'request artifact entry must be a regular file');

  const requestPath = path.join(directory, REQUEST_FILE_NAME);
  const metadata = await lstat(requestPath);
  assert(metadata.isFile() && !metadata.isSymbolicLink(), 'request artifact must not be a symlink');
  assert(
    metadata.size > 0 && metadata.size <= REQUEST_SIZE_LIMIT,
    'request artifact file exceeds its size bound'
  );

  const source = await readFile(requestPath, 'utf8');
  assert(
    Buffer.byteLength(source, 'utf8') <= REQUEST_SIZE_LIMIT,
    'request artifact content exceeds its size bound'
  );
  return validateCloudDispatchRequest(JSON.parse(source), context, selection);
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
  const source = await readFile(file, 'utf8');
  assert(Buffer.byteLength(source, 'utf8') <= 1024 * 1024, `${label} exceeds its size bound`);
  return JSON.parse(source);
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function appendOutputs(file, values) {
  const lines = Object.entries(values).map(([name, value]) => {
    const rendered = String(value);
    assert(!rendered.includes('\n') && !rendered.includes('\r'), `output ${name} contains a newline`);
    return `${name}=${rendered}`;
  });
  await appendFile(file, `${lines.join('\n')}\n`, 'utf8');
}

export async function runCli(argv) {
  const { command, options } = parseArguments(argv);
  if (command === 'validate-event') {
    requireOptions(options, ['event', 'output', 'github-output']);
    const context = validateWorkflowRunEvent(await readJson(options.event, 'workflow event'));
    await writeJson(options.output, context);
    await appendOutputs(options['github-output'], { run_id: context.runId });
    return;
  }
  if (command === 'select-artifacts') {
    requireOptions(options, ['context', 'artifact-pages', 'output', 'github-output']);
    const context = await readJson(options.context, 'producer context');
    const selection = selectQualificationArtifacts(
      context,
      await readJson(options['artifact-pages'], 'artifact pages')
    );
    await writeJson(options.output, selection);
    await appendOutputs(options['github-output'], {
      request_artifact_id: selection.requestArtifactId,
      run_id: context.runId,
      run_attempt: context.runAttempt,
      source_git_sha: context.sourceGitSha,
      attestation_artifact_digest: selection.attestationArtifactDigest,
    });
    return;
  }
  if (command === 'validate-request') {
    requireOptions(options, ['context', 'selection', 'directory']);
    await validateRequestArtifactDirectory(
      options.directory,
      await readJson(options.context, 'producer context'),
      await readJson(options.selection, 'artifact selection')
    );
    return;
  }
  throw new Error(`unknown command ${command ?? '<missing>'}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
