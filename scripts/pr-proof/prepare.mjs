#!/usr/bin/env node

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  BROKER_RUNTIME_REQUIREMENT,
  INPUT_PATH,
  PR_PROOF_VERSION,
  PrProofContractError,
  caseManifestPath,
  changedRelayFlowCaseIds,
  classifyPullRequest,
  validateCaseManifest,
} from './contract.mjs';

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function githubHeaders(token) {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'relay-pr-proof-dispatcher',
  };
}

async function githubJson(url, token) {
  const response = await fetch(url, { headers: githubHeaders(token) });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} for ${url}`);
  }
  return response.json();
}

async function pullRequestFiles(apiUrl, repository, number, token) {
  const files = [];
  for (let page = 1; page <= 30; page += 1) {
    const batch = await githubJson(
      `${apiUrl}/repos/${repository}/pulls/${number}/files?per_page=100&page=${page}`,
      token
    );
    if (!Array.isArray(batch)) throw new Error('GitHub pull request files response was not an array');
    files.push(...batch.map((entry) => entry.filename).filter((entry) => typeof entry === 'string'));
    if (batch.length < 100) return files;
  }
  throw new Error('PR changes more than 3,000 files; RelayFlow proof dispatch refuses ambiguous scope');
}

export function pullRequestSnapshot(pullRequest) {
  return {
    number: pullRequest?.number,
    headSha: pullRequest?.head?.sha,
    baseSha: pullRequest?.base?.sha,
    headRepository: pullRequest?.head?.repo?.full_name,
    title: pullRequest?.title,
    body: pullRequest?.body ?? '',
  };
}

export function assertSamePullRequestSnapshot(expected, actual) {
  const next = pullRequestSnapshot(actual);
  for (const key of Object.keys(expected)) {
    if (next[key] !== expected[key]) {
      throw new Error(
        `Pull request changed during proof preparation (${key}: ${JSON.stringify(expected[key])} -> ${JSON.stringify(next[key])}); dispatch the latest event instead`
      );
    }
  }
}

async function readHeadFile(apiUrl, repository, filePath, headSha, token) {
  const payload = await githubJson(
    `${apiUrl}/repos/${repository}/contents/${filePath}?ref=${encodeURIComponent(headSha)}`,
    token
  );
  if (payload?.encoding !== 'base64' || typeof payload.content !== 'string') {
    throw new Error(`GitHub did not return base64 content for ${filePath}`);
  }
  return Buffer.from(payload.content.replaceAll('\n', ''), 'base64').toString('utf8');
}

function pullRequestFromPayload(payload) {
  if (payload.pull_request) return payload.pull_request;
  return null;
}

async function writeGithubOutput(values, outputPath) {
  if (!outputPath) return;
  await appendFile(
    outputPath,
    Object.entries(values)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join('\n') + '\n'
  );
}

async function writeSummary(lines, summaryPath) {
  if (!summaryPath) return;
  // GitHub supplies the summary destination; PR fields are rendered only as
  // inert Markdown text after classification/snapshot validation.
  // codeql[js/http-to-file-access]
  await appendFile(summaryPath, `${lines.join('\n')}\n`);
}

export async function main() {
  const eventPath = option('--event', process.env.GITHUB_EVENT_PATH);
  const outputPath = option('--output', INPUT_PATH);
  const githubOutput = option('--github-output', process.env.GITHUB_OUTPUT);
  const summaryPath = option('--summary', process.env.GITHUB_STEP_SUMMARY);
  const expectedHeadSha = option('--expected-head-sha');
  const token = process.env.GITHUB_TOKEN?.trim();
  const repository = process.env.GITHUB_REPOSITORY?.trim();
  const apiUrl = (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
  if (!eventPath || !token || !repository) {
    throw new Error('GITHUB_EVENT_PATH, GITHUB_TOKEN, and GITHUB_REPOSITORY are required');
  }

  const payload = JSON.parse(await readFile(eventPath, 'utf8'));
  const eventPullRequest = pullRequestFromPayload(payload);
  let pullRequest = eventPullRequest;
  const manualNumber = Number(payload.inputs?.pr_number);
  if (!pullRequest && Number.isInteger(manualNumber) && manualNumber > 0) {
    pullRequest = await githubJson(`${apiUrl}/repos/${repository}/pulls/${manualNumber}`, token);
  }
  if (!pullRequest) throw new Error('The event does not identify a pull request');

  const eventNumber = Number(pullRequest.number);
  if (!Number.isInteger(eventNumber) || eventNumber < 1) {
    throw new Error('Pull request payload is missing a valid number');
  }
  // The event can be stale after a synchronize/edited cancellation. Resolve a
  // live snapshot before reading the live files endpoint, then compare the
  // same fields again after all file and manifest reads.
  pullRequest = await githubJson(`${apiUrl}/repos/${repository}/pulls/${eventNumber}`, token);

  const number = pullRequest.number;
  const headSha = pullRequest.head?.sha;
  const baseSha = pullRequest.base?.sha;
  const headRepository = pullRequest.head?.repo?.full_name;
  if (!Number.isInteger(number) || !headSha || !baseSha || !headRepository) {
    throw new Error('Pull request payload is missing number, repository, or exact SHAs');
  }
  if (expectedHeadSha && headSha !== expectedHeadSha) {
    throw new Error(
      `Pull request head changed during dispatch: status targets ${expectedHeadSha}, preparation resolved ${headSha}`
    );
  }
  const snapshot = pullRequestSnapshot(pullRequest);

  // Fetch the diff BEFORE classifying: whether a proof is required is decided
  // by what changed, not by how the title was worded.
  const changedFiles = await pullRequestFiles(apiUrl, repository, number, token);
  const classification = classifyPullRequest({
    title: pullRequest.title,
    body: pullRequest.body ?? '',
    changedFiles,
  });
  if (classification.errors.length > 0) {
    throw new PrProofContractError(
      'Pull request does not satisfy the RelayFlow proof contract',
      classification.errors
    );
  }
  if (!classification.required) {
    const finalPullRequest = await githubJson(`${apiUrl}/repos/${repository}/pulls/${number}`, token);
    assertSamePullRequestSnapshot(snapshot, finalPullRequest);
    await writeGithubOutput({ required: false, case_id: 'n/a' }, githubOutput);
    await writeSummary(
      ['## RelayFlow PR proof', '', 'Cloud proof is not required for this non-functional change.'],
      summaryPath
    );
    return;
  }
  if (headRepository !== repository) {
    throw new PrProofContractError('Fork pull requests cannot receive the credential-bearing Cloud proof', [
      `head repository ${headRepository} is not the trusted repository ${repository}`,
      'A maintainer must reproduce the change on a same-repository branch before merge.',
    ]);
  }

  const caseId = classification.caseId;
  const manifestPath = caseManifestPath(caseId);
  const caseRoot = path.posix.dirname(manifestPath) + '/';
  const changedCaseIds = changedRelayFlowCaseIds(changedFiles);
  if (!changedFiles.some((file) => file === manifestPath || file.startsWith(caseRoot))) {
    throw new PrProofContractError('The declared RelayFlow case is not changed by this PR', [
      `expected a changed file under ${caseRoot}`,
    ]);
  }
  if (changedCaseIds.length !== 1 || changedCaseIds[0] !== caseId) {
    throw new PrProofContractError('A PR must change exactly its one declared RelayFlow case', [
      `declared ${caseId}; changed ${changedCaseIds.join(', ') || 'none'}`,
    ]);
  }

  const manifestSource = await readHeadFile(apiUrl, repository, manifestPath, headSha, token);
  let manifestJson;
  try {
    manifestJson = JSON.parse(manifestSource);
  } catch (error) {
    throw new PrProofContractError(`RelayFlow case manifest is not valid JSON: ${manifestPath}`, [
      error instanceof Error ? error.message : String(error),
    ]);
  }
  const manifest = validateCaseManifest(manifestJson, {
    caseId,
    kind: classification.kind,
  });

  const finalPullRequest = await githubJson(`${apiUrl}/repos/${repository}/pulls/${number}`, token);
  assertSamePullRequestSnapshot(snapshot, finalPullRequest);

  const proofInput = {
    version: PR_PROOF_VERSION,
    repository,
    pullRequest: number,
    baseSha,
    headSha,
    caseId,
    kind: classification.kind,
    handoffNonce: randomBytes(16).toString('hex'),
    manifestPath,
    manifest,
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  // The workflow fixes outputPath, and every network-derived property has
  // passed strict type/path/SHA/manifest validation plus a final PR snapshot.
  // codeql[js/http-to-file-access]
  await writeFile(outputPath, `${JSON.stringify(proofInput, null, 2)}\n`);
  await writeGithubOutput(
    {
      required: true,
      case_id: caseId,
      input_path: outputPath,
      broker_artifacts_required: manifest.requirements.includes(BROKER_RUNTIME_REQUIREMENT),
    },
    githubOutput
  );
  await writeSummary(
    [
      '## RelayFlow PR proof',
      '',
      `- Case: \`${caseId}\``,
      `- Base: \`${baseSha}\``,
      `- Head: \`${headSha}\``,
      '- Order: reproduce on base, then verify on head',
    ],
    summaryPath
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (error) => {
    const details = error instanceof PrProofContractError ? error.details : [];
    const lines = ['## RelayFlow PR proof', '', `**Contract failure:** ${error.message}`];
    if (details.length > 0) lines.push('', ...details.map((detail) => `- ${detail}`));
    await writeSummary(lines, option('--summary', process.env.GITHUB_STEP_SUMMARY)).catch(() => {});
    console.error(error.message);
    for (const detail of details) console.error(`- ${detail}`);
    process.exitCode = 1;
  });
}
