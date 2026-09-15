/** Run-scoped broker transfer. No artifact bytes or credentials enter code sync. */
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { validateProofInput } from './contract.mjs';
import { loadBrokerArtifact } from './stage-broker-artifacts.mjs';

export const PART_BYTES = 2 * 1024 * 1024;
export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
export const MAX_PAIR_BYTES = 2 * MAX_ARTIFACT_BYTES;
const MAX_PART_JSON = 3 * 1024 * 1024;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function binding(input, arm, runId, totalBytes) {
  const artifact = input.runtimeArtifacts?.broker?.[arm];
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId ?? '') ||
    !/^[0-9a-f]{32}$/.test(input.handoffNonce ?? '') ||
    !['base', 'head'].includes(arm) ||
    artifact?.sourceSha !== (arm === 'base' ? input.baseSha : input.headSha) ||
    !/^[0-9a-f]{40}$/.test(artifact?.sourceSha ?? '') ||
    !/^[0-9a-f]{64}$/.test(artifact?.sha256 ?? '') ||
    !Number.isSafeInteger(totalBytes) ||
    totalBytes < 1 ||
    totalBytes > MAX_ARTIFACT_BYTES
  ) {
    throw new Error('Invalid broker transfer binding or size');
  }
  return {
    version: 1,
    runId,
    nonce: input.handoffNonce,
    arm,
    sourceSha: artifact.sourceSha,
    sha256: artifact.sha256,
    totalBytes,
    count: Math.ceil(totalBytes / PART_BYTES),
  };
}

function urlFor(env, input, arm, runId, object) {
  const artifact = input.runtimeArtifacts.broker[arm];
  // Validate identifiers independently before constructing a trusted-origin URL.
  binding(input, arm, runId, 1);
  const base = new URL(env.CLOUD_API_URL);
  if (
    !['https:', 'http:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error('Invalid broker storage origin');
  }
  const loopback =
    base.hostname === '[::1]' || (isIP(base.hostname) === 4 && base.hostname.startsWith('127.'));
  if (base.protocol !== 'https:' && !loopback) {
    throw new Error('Broker transfer credentials require HTTPS outside literal loopback addresses');
  }
  const key = `pr-proof/${input.handoffNonce}/brokers/${arm}/${artifact.sourceSha}/${artifact.sha256}/${object}`;
  return new URL(
    `api/v1/workflows/runs/${encodeURIComponent(runId)}/storage/${key}`,
    base.href.replace(/\/?$/, '/')
  );
}

async function jsonResponse(response, limit) {
  if (!response.body) throw new Error('Empty broker transfer response');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) throw new Error('Broker transfer response exceeds its size limit');
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new Error('Invalid broker transfer JSON');
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function client(env, tokenName, options) {
  const token = env[tokenName]?.trim();
  if (!token) throw new Error(`Broker transfer requires ${tokenName}`);
  const lifetime = AbortSignal.timeout(options.timeoutMs ?? 120_000);
  return async (url, body, exclusive = false) => {
    try {
      return await (options.fetchImpl ?? fetch)(url, {
        method: body === undefined ? 'GET' : 'PUT',
        redirect: 'error',
        signal: AbortSignal.any([
          lifetime,
          options.signal ?? new AbortController().signal,
          AbortSignal.timeout(15_000),
        ]),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(exclusive ? { 'if-none-match': '*' } : {}),
        },
        ...(body === undefined ? {} : { body }),
      });
    } catch {
      throw new Error('Broker storage request failed');
    }
  };
}

/** Prepare and verify both artifacts locally before starting the remote run. */
export async function prepareBrokerTransfer(inputPath, options = {}) {
  const text = await readFile(inputPath, 'utf8');
  if (Buffer.byteLength(text) > 128 * 1024) throw new Error('Proof input exceeds its size limit');
  const input = validateProofInput(JSON.parse(text));
  if (!input.runtimeArtifacts?.broker) return null;
  const artifacts = [];
  for (const arm of ['base', 'head']) {
    const loaded = await loadBrokerArtifact({ arm, expectedSha: input[`${arm}Sha`], root: options.root });
    if (!equal(loaded.artifact, input.runtimeArtifacts.broker[arm]))
      throw new Error('Broker upload binding changed');
    artifacts.push({ arm, bytes: loaded.contents });
  }
  if (artifacts.reduce((total, item) => total + item.bytes.length, 0) > MAX_PAIR_BYTES) {
    throw new Error('Broker transfer exceeds aggregate size limit');
  }
  return createBrokerTransfer(input, artifacts, options);
}

export function createBrokerTransfer(input, artifacts, options = {}) {
  if (
    artifacts.length !== 2 ||
    artifacts[0].arm !== 'base' ||
    artifacts[1].arm !== 'head' ||
    artifacts.reduce((total, item) => total + item.bytes.length, 0) > MAX_PAIR_BYTES
  ) {
    throw new Error('Broker transfer requires one bounded artifact per arm');
  }
  let ownedRunId;
  let pending;
  let cleaned = false;
  const env = options.env ?? process.env;
  const uploadAbort = new AbortController();
  const objectNames = (item) => [
    'manifest.json',
    ...Array.from({ length: Math.ceil(item.bytes.length / PART_BYTES) }, (_, index) => `part-${index}.json`),
  ];
  for (const item of artifacts) {
    binding(input, item.arm, 'validation', item.bytes.length);
    if (sha256(item.bytes) !== input.runtimeArtifacts.broker[item.arm].sha256)
      throw new Error('Broker upload hash mismatch');
  }
  return {
    start(runId) {
      if (ownedRunId && ownedRunId !== runId) throw new Error('Broker upload run changed');
      if (cleaned) throw new Error('Broker upload already cleaned');
      ownedRunId = runId;
      pending ??= (async () => {
        // The aggregate transfer lifetime starts with the first upload, not at
        // preparation: the prepared run ID may arrive well after this transfer
        // was created, and that launch delay must not consume the budget.
        const request = client(env, 'CLOUD_API_KEY', {
          ...options,
          signal: AbortSignal.any([uploadAbort.signal, options.signal ?? new AbortController().signal]),
        });
        for (const item of artifacts) {
          const identity = binding(input, item.arm, runId, item.bytes.length);
          for (let index = 0; index < identity.count; index++) {
            const bytes = item.bytes.subarray(index * PART_BYTES, (index + 1) * PART_BYTES);
            const body = JSON.stringify({
              ...identity,
              index,
              partSha256: sha256(bytes),
              data: bytes.toString('base64'),
            });
            if (Buffer.byteLength(body) > MAX_PART_JSON)
              throw new Error('Broker chunk exceeds its size limit');
            const response = await request(
              urlFor(env, input, item.arm, runId, `part-${index}.json`),
              body,
              true
            );
            if (!response.ok) throw new Error(`Broker chunk upload refused (${response.status})`);
          }
          // Publish the readiness marker only after every exclusive part write succeeded.
          const response = await request(
            urlFor(env, input, item.arm, runId, 'manifest.json'),
            JSON.stringify(identity),
            true
          );
          if (!response.ok) throw new Error(`Broker manifest upload refused (${response.status})`);
        }
      })();
      return pending;
    },
    release() {
      cleaned = true;
      for (const item of artifacts) item.bytes.fill(0);
    },
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      uploadAbort.abort();
      await pending?.catch(() => {});
      if (!ownedRunId) return;
      let failed = false;
      const cleanupRequest = client(env, 'CLOUD_API_KEY', {
        ...options,
        signal: undefined,
        timeoutMs: 60_000,
      });
      // Cloud has no object DELETE route. Tombstone only this nonce/run's keys,
      // manifest first, before cancellation revokes the prepared-run write grant.
      for (const item of artifacts)
        for (const object of objectNames(item)) {
          try {
            const response = await cleanupRequest(urlFor(env, input, item.arm, ownedRunId, object), '');
            if (!response.ok) failed = true;
          } catch {
            failed = true;
          }
        }
      for (const item of artifacts) item.bytes.fill(0);
      if (failed) throw new Error('Broker transfer cleanup incomplete');
    },
  };
}

/** Read each bounded part once, then validate the original build hash in memory. */
export async function downloadBrokerArtifact(input, arm, options = {}) {
  const env = options.env ?? process.env;
  if (
    env.RUN_ID &&
    env.AGENT_RELAY_CLOUD_WORKER_RUN_ID &&
    env.RUN_ID !== env.AGENT_RELAY_CLOUD_WORKER_RUN_ID
  ) {
    throw new Error('Conflicting broker storage run IDs');
  }
  const runId = env.RUN_ID || env.AGENT_RELAY_CLOUD_WORKER_RUN_ID;
  const request = client(env, 'CLOUD_API_ACCESS_TOKEN', options);
  const deadline = Date.now() + 60_000;
  let manifest;
  for (;;) {
    const response = await request(urlFor(env, input, arm, runId, 'manifest.json'));
    if (response.status !== 404) {
      if (!response.ok) throw new Error(`Broker manifest unavailable (${response.status})`);
      manifest = await jsonResponse(response, 4096);
      break;
    }
    if (Date.now() >= deadline) throw new Error('Broker manifest was not published before transfer deadline');
    await delay(250, undefined, { signal: options.signal });
  }
  const identity = binding(input, arm, runId, manifest?.totalBytes);
  let result;
  let failure;
  try {
    if (!equal(manifest, identity)) throw new Error('Broker manifest binding mismatch');
    const chunks = [];
    for (let index = 0; index < identity.count; index++) {
      const response = await request(urlFor(env, input, arm, runId, `part-${index}.json`));
      if (!response.ok) throw new Error(`Broker part unavailable (${response.status})`);
      const part = await jsonResponse(response, MAX_PART_JSON);
      const { data, partSha256, index: receivedIndex, ...receivedIdentity } = part ?? {};
      if (!equal(receivedIdentity, identity) || receivedIndex !== index || typeof data !== 'string') {
        throw new Error('Broker part binding mismatch');
      }
      const bytes = Buffer.from(data, 'base64');
      const expectedLength = Math.min(PART_BYTES, identity.totalBytes - index * PART_BYTES);
      if (
        bytes.length !== expectedLength ||
        bytes.toString('base64') !== data ||
        sha256(bytes) !== partSha256
      ) {
        throw new Error('Broker part length, encoding, or hash mismatch');
      }
      chunks.push(bytes);
    }
    const contents = Buffer.concat(chunks);
    if (contents.length !== identity.totalBytes || sha256(contents) !== identity.sha256)
      throw new Error('Broker final build hash mismatch');
    result = { artifact: input.runtimeArtifacts.broker[arm], contents };
  } catch (error) {
    failure = error;
  }
  // Consume the transfer before the arm returns. Run completion/cancellation
  // may revoke its token, so cleanup cannot be deferred to the dispatcher.
  const cleanupRequest = client(env, 'CLOUD_API_ACCESS_TOKEN', {
    ...options,
    signal: undefined,
    timeoutMs: 60_000,
  });
  let failed = false;
  for (const object of [
    'manifest.json',
    ...Array.from({ length: identity.count }, (_, index) => `part-${index}.json`),
  ]) {
    try {
      const response = await cleanupRequest(urlFor(env, input, arm, runId, object), '');
      if (!response.ok) failed = true;
    } catch {
      failed = true;
    }
  }
  // A download or integrity failure is the diagnostic that matters; a cleanup
  // failure must not replace it. Refused cleanup after a good download still
  // withholds the bytes.
  if (failure) throw failure;
  if (failed) throw new Error('Broker transfer consumption cleanup incomplete');
  return result;
}
