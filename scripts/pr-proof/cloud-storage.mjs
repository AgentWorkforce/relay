#!/usr/bin/env node

const ARM_RE = /^(base|head)$/;
const NONCE_RE = /^[0-9a-f]{32}$/;

function requiredEnvironment(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for Cloud proof evidence storage`);
  return value;
}

function storageUrl(env, input, arm) {
  if (!ARM_RE.test(arm)) throw new Error(`Invalid proof arm: ${arm}`);
  if (!NONCE_RE.test(input.handoffNonce ?? '')) throw new Error('Invalid proof handoff nonce');
  const apiUrl = requiredEnvironment(env, 'CLOUD_API_URL').replace(/\/$/, '') + '/';
  const runId = encodeURIComponent(requiredEnvironment(env, 'RUN_ID'));
  const objectKey = ['pr-proof', input.handoffNonce, `${arm}.json`]
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return new URL(`api/v1/workflows/runs/${runId}/storage/${objectKey}`, apiUrl);
}

function authorization(env) {
  return `Bearer ${requiredEnvironment(env, 'CLOUD_API_ACCESS_TOKEN')}`;
}

export async function uploadCloudEvidence(input, arm, evidence, options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(storageUrl(env, input, arm), {
    method: 'PUT',
    headers: {
      accept: 'application/json',
      authorization: authorization(env),
      'content-type': 'application/json',
    },
    body: JSON.stringify(evidence),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Cloud evidence upload failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }
}

export async function downloadCloudEvidence(input, arm, options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(storageUrl(env, input, arm), {
    headers: {
      accept: 'application/json',
      authorization: authorization(env),
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Cloud evidence download failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }
  try {
    return JSON.parse(await response.text());
  } catch (error) {
    throw new Error(
      `Cloud evidence response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
