#!/usr/bin/env node

import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const SHA_RE = /^[0-9a-f]{40}$/;
const WORKFLOW_PATH = '.github/workflows/relayflow-pr-proof-broker.yml';
const BROKER_PRODUCER_TIMEOUT_MS = 30 * 60_000;
const BROKER_QUEUE_HEADROOM_MS = 10 * 60_000;
const RESOLVE_POLL_INTERVAL_MS = 10_000;
const RESOLVE_POLL_SLACK_ATTEMPTS = 2;
const MAX_RESOLVE_ATTEMPTS =
  Math.ceil((BROKER_PRODUCER_TIMEOUT_MS + BROKER_QUEUE_HEADROOM_MS) / RESOLVE_POLL_INTERVAL_MS) +
  1 +
  RESOLVE_POLL_SLACK_ATTEMPTS;
const MAX_TIMER_MS = 2_147_483_647;

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

function abortReason(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('Broker artifact resolution aborted');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

async function githubJson(url, token, fetchImpl, signal) {
  throwIfAborted(signal);
  const response = await fetchImpl(url, { headers: headers(token), signal });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}`);
  return response.json();
}

function sleep(milliseconds, { signal } = {}) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function resolveBrokerArtifact({
  apiUrl,
  repository,
  token,
  sha,
  fetchImpl = fetch,
  maxAttempts = MAX_RESOLVE_ATTEMPTS,
  pollIntervalMs = RESOLVE_POLL_INTERVAL_MS,
  sleepImpl = sleep,
  signal,
}) {
  if (!SHA_RE.test(sha)) throw new Error('broker artifact SHA must be a full lowercase SHA');
  if (
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    !Number.isInteger(pollIntervalMs) ||
    pollIntervalMs < 1 ||
    pollIntervalMs > MAX_TIMER_MS
  ) {
    throw new Error('broker artifact polling bounds are invalid');
  }
  const artifactName = `relayflow-broker-${sha}`;
  let sawExpiredArtifact = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const listing = await githubJson(
      `${apiUrl}/repos/${repository}/actions/artifacts?name=${artifactName}&per_page=100`,
      token,
      fetchImpl,
      signal
    );
    const artifacts = Array.isArray(listing.artifacts)
      ? listing.artifacts.filter((artifact) => artifact?.name === artifactName)
      : [];
    sawExpiredArtifact ||= artifacts.some((artifact) => artifact.expired);
    const candidates = artifacts
      .filter((artifact) => !artifact.expired)
      .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));

    for (const artifact of candidates) {
      const runId = artifact.workflow_run?.id;
      if (!Number.isInteger(runId) || runId < 1) continue;
      const run = await githubJson(
        `${apiUrl}/repos/${repository}/actions/runs/${runId}`,
        token,
        fetchImpl,
        signal
      );
      const trustedEvent =
        run.event === 'pull_request_target' ||
        (['push', 'schedule'].includes(run.event) && run.head_branch === 'main');
      if (
        run.path !== WORKFLOW_PATH ||
        run.conclusion !== 'success' ||
        run.head_sha !== sha ||
        !trustedEvent
      ) {
        continue;
      }
      return { artifactName, runId };
    }

    if (attempt < maxAttempts) await sleepImpl(pollIntervalMs, { signal });
  }

  const recovery = sawExpiredArtifact
    ? ' The prior artifact expired after the 90-day retention window; update/rebase the PR onto current main and push a refreshed head to trigger trusted exact-SHA rebuilds.'
    : '';
  throw new Error(
    `No successful ${WORKFLOW_PATH} artifact named ${artifactName} after ${maxAttempts} attempts. The default resolver budget allows 10 minutes for Actions queue/start delay and 30 minutes for producer execution, plus poll slack.${recovery}`
  );
}

export async function resolveBrokerArtifactPair({ baseSha, headSha, ...options }) {
  const controller = new AbortController();
  const resolveOne = async (sha) => {
    try {
      return await resolveBrokerArtifact({ ...options, sha, signal: controller.signal });
    } catch (error) {
      controller.abort(error);
      throw error;
    }
  };
  const [base, head] = await Promise.all([resolveOne(baseSha), resolveOne(headSha)]);
  return { base, head };
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
  const { base, head } = await resolveBrokerArtifactPair({
    apiUrl,
    repository,
    token,
    baseSha: input.baseSha,
    headSha: input.headSha,
  });
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
