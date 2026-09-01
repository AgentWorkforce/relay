#!/usr/bin/env node

import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const SHA_RE = /^[0-9a-f]{40}$/;
const WORKFLOW_PATH = '.github/workflows/relayflow-pr-proof-broker.yml';

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function headers(token) {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'relay-pr-proof-broker-resolver',
  };
}

async function githubJson(url, token, fetchImpl) {
  const response = await fetchImpl(url, { headers: headers(token) });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}`);
  return response.json();
}

export async function resolveBrokerArtifact({ apiUrl, repository, token, sha, fetchImpl = fetch }) {
  if (!SHA_RE.test(sha)) throw new Error('broker artifact SHA must be a full lowercase SHA');
  const artifactName = `relayflow-broker-${sha}`;
  const listing = await githubJson(
    `${apiUrl}/repos/${repository}/actions/artifacts?name=${artifactName}&per_page=100`,
    token,
    fetchImpl
  );
  const candidates = Array.isArray(listing.artifacts)
    ? listing.artifacts
        .filter((artifact) => artifact?.name === artifactName && !artifact.expired)
        .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))
    : [];

  for (const artifact of candidates) {
    const runId = artifact.workflow_run?.id;
    if (!Number.isInteger(runId) || runId < 1) continue;
    const run = await githubJson(`${apiUrl}/repos/${repository}/actions/runs/${runId}`, token, fetchImpl);
    if (run.path !== WORKFLOW_PATH || run.conclusion !== 'success') continue;
    return { artifactName, runId };
  }

  throw new Error(
    `No successful ${WORKFLOW_PATH} artifact named ${artifactName}; run the exact-SHA broker build first`
  );
}

async function main() {
  const inputPath = option('--input', '.relayflow/pr-proof-input.json');
  const outputPath = option('--github-output', process.env.GITHUB_OUTPUT);
  const token = process.env.GITHUB_TOKEN?.trim();
  const repository = process.env.GITHUB_REPOSITORY?.trim();
  const apiUrl = (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
  if (!outputPath || !token || !repository) {
    throw new Error('GITHUB_OUTPUT, GITHUB_TOKEN, and GITHUB_REPOSITORY are required');
  }
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  const base = await resolveBrokerArtifact({ apiUrl, repository, token, sha: input.baseSha });
  const head = await resolveBrokerArtifact({ apiUrl, repository, token, sha: input.headSha });
  await appendFile(
    outputPath,
    [
      `base_name=${base.artifactName}`,
      `base_run_id=${base.runId}`,
      `head_name=${head.artifactName}`,
      `head_run_id=${head.runId}`,
    ].join('\n') + '\n'
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
