#!/usr/bin/env node

import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const SHA_RE = /^[0-9a-f]{40}$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RUN_ATTEMPT_RE = /^[1-9][0-9]*$/;
const CONTEXT = 'RelayFlow PR proof';

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function headers(token) {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'relay-pr-proof-status',
  };
}

async function githubJson(url, token, init = {}, fetchImpl = fetch) {
  // Callers construct only GitHub API URLs from the trusted API origin and
  // validated repository, PR-number, or full-SHA components.
  // codeql[js/file-access-to-http]
  const response = await fetchImpl(url, {
    ...init,
    headers: { ...headers(token), ...(init.headers ?? {}) },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.message ? `: ${payload.message}` : '';
    throw new Error(`GitHub API ${response.status} for ${url}${detail}`);
  }
  return payload;
}

function validateRepository(value) {
  if (!REPOSITORY_RE.test(value ?? '')) throw new Error('GITHUB_REPOSITORY is invalid');
  return value;
}

export async function resolvePullRequest({ payload, repository, apiUrl, token, fetchImpl }) {
  let pullRequest = payload.pull_request ?? null;
  const manualNumber = Number(payload.inputs?.pr_number);
  if (!pullRequest && Number.isInteger(manualNumber) && manualNumber > 0) {
    pullRequest = await githubJson(
      `${apiUrl}/repos/${repository}/pulls/${manualNumber}`,
      token,
      {},
      fetchImpl
    );
  }
  const number = Number(pullRequest?.number);
  const headSha = pullRequest?.head?.sha;
  if (!Number.isInteger(number) || number < 1 || !SHA_RE.test(headSha ?? '')) {
    throw new Error('The event does not identify a pull request with an exact head SHA');
  }
  return { number, headSha };
}

function targetUrl(env) {
  const server = env.GITHUB_SERVER_URL?.replace(/\/$/, '');
  const repository = env.GITHUB_REPOSITORY;
  const runId = env.GITHUB_RUN_ID;
  const runAttempt = env.GITHUB_RUN_ATTEMPT?.trim() || '1';
  if (!RUN_ATTEMPT_RE.test(runAttempt)) throw new Error('GITHUB_RUN_ATTEMPT is invalid');
  return server && repository && runId
    ? `${server}/${repository}/actions/runs/${runId}/attempts/${runAttempt}`
    : undefined;
}

export async function publishCommitStatus({ sha, state, description, env = process.env, fetchImpl = fetch }) {
  const repository = validateRepository(env.GITHUB_REPOSITORY?.trim());
  const token = env.GITHUB_TOKEN?.trim();
  const apiUrl = (env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
  if (!token) throw new Error('GITHUB_TOKEN is required to publish the PR proof status');
  if (!SHA_RE.test(sha ?? '')) throw new Error('PR proof status SHA must be a full lowercase SHA');
  if (!['pending', 'success', 'failure', 'error'].includes(state)) {
    throw new Error(`Invalid PR proof status state: ${state}`);
  }
  return githubJson(
    `${apiUrl}/repos/${repository}/statuses/${sha}`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        state,
        context: CONTEXT,
        description: description.slice(0, 140),
        target_url: targetUrl(env),
      }),
    },
    fetchImpl
  );
}

export async function publishOwnedCommitStatus({
  sha,
  state,
  description,
  env = process.env,
  fetchImpl = fetch,
}) {
  const repository = validateRepository(env.GITHUB_REPOSITORY?.trim());
  const token = env.GITHUB_TOKEN?.trim();
  const apiUrl = (env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
  const ownerTargetUrl = targetUrl(env);
  if (!token || !ownerTargetUrl) {
    throw new Error('GITHUB_TOKEN, GITHUB_SERVER_URL, and GITHUB_RUN_ID are required to finish status');
  }
  if (!SHA_RE.test(sha ?? '')) throw new Error('PR proof status SHA must be a full lowercase SHA');

  const combined = await githubJson(
    `${apiUrl}/repos/${repository}/commits/${sha}/status`,
    token,
    {},
    fetchImpl
  );
  const latest = Array.isArray(combined?.statuses)
    ? combined.statuses.find((status) => status?.context === CONTEXT)
    : null;
  if (latest?.state !== 'pending' || latest?.target_url !== ownerTargetUrl) {
    return { published: false, ownerTargetUrl, latest };
  }

  // The workflow-level concurrency group is the serialization lock for this
  // compare-and-write. GitHub permits only one running workflow in the PR's
  // group, so a replacement cannot publish its pending status until this
  // cancelled predecessor has finished this step and released the group.
  await publishCommitStatus({ sha, state, description, env, fetchImpl });
  return { published: true, ownerTargetUrl, latest };
}

function conclusionState(jobStatus) {
  if (jobStatus === 'success') return 'success';
  if (jobStatus === 'failure') return 'failure';
  return 'error';
}

export async function main() {
  const command = process.argv[2];
  const env = process.env;
  if (command === 'start') {
    const eventPath = option('--event', env.GITHUB_EVENT_PATH);
    const outputPath = option('--github-output', env.GITHUB_OUTPUT);
    const repository = validateRepository(env.GITHUB_REPOSITORY?.trim());
    const token = env.GITHUB_TOKEN?.trim();
    const apiUrl = (env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
    if (!eventPath || !token) throw new Error('GITHUB_EVENT_PATH and GITHUB_TOKEN are required');
    const payload = JSON.parse(await readFile(eventPath, 'utf8'));
    const resolved = await resolvePullRequest({ payload, repository, apiUrl, token, fetchImpl: fetch });
    await publishCommitStatus({
      sha: resolved.headSha,
      state: 'pending',
      description: `Cloud red/green proof started for PR #${resolved.number}`,
    });
    if (outputPath) {
      await appendFile(outputPath, `head_sha=${resolved.headSha}\npr_number=${resolved.number}\n`);
    }
    console.log(`PR_PROOF_STATUS_PENDING pr=${resolved.number} head=${resolved.headSha}`);
    return;
  }

  if (command === 'finish') {
    const sha = option('--sha');
    const jobStatus = option('--job-status');
    const state = conclusionState(jobStatus);
    const result = await publishOwnedCommitStatus({
      sha,
      state,
      description:
        state === 'success'
          ? 'Declared Cloud red/green proof passed'
          : state === 'failure'
            ? 'Declared Cloud red/green proof failed'
            : `Cloud red/green proof ended with ${jobStatus ?? 'unknown'} status`,
    });
    console.log(
      result.published
        ? `PR_PROOF_STATUS_FINAL head=${sha} state=${state}`
        : `PR_PROOF_STATUS_FINAL_SKIPPED head=${sha} reason=status-owned-by-newer-run`
    );
    return;
  }

  throw new Error('Usage: report-status.mjs <start|finish>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
