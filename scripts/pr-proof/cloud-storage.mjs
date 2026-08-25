#!/usr/bin/env node

const ARM_RE = /^(base|head)$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_TIMER_MS = 2_147_483_647;

function requiredEnvironment(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for Cloud proof evidence storage`);
  return value;
}

function storageUrl(env, input, arm) {
  if (!ARM_RE.test(arm)) throw new Error(`Invalid proof arm: ${arm}`);
  if (!NONCE_RE.test(input.handoffNonce ?? '')) throw new Error('Invalid proof handoff nonce');
  const apiUrl = requiredEnvironment(env, 'CLOUD_API_URL').replace(/\/$/, '') + '/';
  const orchestratorRunId = env.RUN_ID?.trim();
  const workerRunId = env.AGENT_RELAY_CLOUD_WORKER_RUN_ID?.trim();
  if (orchestratorRunId && workerRunId && orchestratorRunId !== workerRunId) {
    throw new Error('Cloud proof runtime exposed conflicting workflow run IDs');
  }
  const runId = encodeURIComponent(orchestratorRunId || workerRunId || requiredEnvironment(env, 'RUN_ID'));
  const objectKey = ['pr-proof', input.handoffNonce, `${arm}.json`]
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return new URL(`api/v1/workflows/runs/${runId}/storage/${objectKey}`, apiUrl);
}

function authorization(env) {
  return `Bearer ${requiredEnvironment(env, 'CLOUD_API_ACCESS_TOKEN')}`;
}

export function validateCloudEvidenceEnvironment(input, arm, env = process.env) {
  storageUrl(env, input, arm);
  authorization(env);
}

function requestSignal(options) {
  if (options.signal) return options.signal;
  const requested = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new Error('Cloud evidence request timeout must be a positive finite number');
  }
  const timeoutMs = Math.min(Math.floor(requested), MAX_TIMER_MS);
  if (timeoutMs < 1) {
    throw new Error('Cloud evidence request timeout must be at least one millisecond');
  }
  return AbortSignal.timeout(timeoutMs);
}

export async function uploadCloudEvidence(input, arm, evidence, options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  // The origin is the trusted Cloud runtime URL; run ID, nonce, and arm are
  // strictly validated/encoded run-scoped identifiers, not arbitrary hosts.
  // codeql[js/file-access-to-http]
  const response = await fetchImpl(storageUrl(env, input, arm), {
    method: 'PUT',
    signal: requestSignal(options),
    headers: {
      accept: 'application/json',
      authorization: authorization(env),
      'content-type': 'application/json',
    },
    // Evidence is intentionally sent to this run's authenticated storage
    // object after the trusted wrapper has validated its complete contract.
    // codeql[js/file-access-to-http]
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
  // The trusted Cloud runtime origin and encoded run-scoped identifiers above
  // prevent file-derived data from selecting an arbitrary destination.
  // codeql[js/file-access-to-http]
  const response = await fetchImpl(storageUrl(env, input, arm), {
    signal: requestSignal(options),
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
