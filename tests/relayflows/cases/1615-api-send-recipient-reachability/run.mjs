import { execFileSync, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { startFakeRelaycast } from './fake-relaycast.mjs';

const CASE_ID = '1615-api-send-recipient-reachability';
const RECIPIENT = 'relayflow-live-recipient';
const OFFLINE_RECIPIENT = 'relayflow-offline-recipient';
const UNKNOWN_RECIPIENT = 'relayflow-unknown-recipient';
const FAILED_RECIPIENT = 'relayflow-failed-recipient';
const API_KEY = 'br_relayflow_1615';
const targetDir = requiredDirectory('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = requiredDirectory('RELAY_PR_PROOF_HARNESS_DIR');
const binaryPath = await requiredExecutable('RELAY_PR_PROOF_BROKER_BINARY');
const resultPath = requiredValue('RELAY_PR_PROOF_RESULT_PATH');
const arm = requiredValue('RELAY_PR_PROOF_ARM');

if (arm !== 'base' && arm !== 'head') {
  throw new Error(`RELAY_PR_PROOF_ARM must be base or head, received ${JSON.stringify(arm)}.`);
}
const expectedSha =
  arm === 'base' ? process.env.RELAY_PR_PROOF_BASE_SHA : process.env.RELAY_PR_PROOF_HEAD_SHA;
if (!expectedSha) throw new Error(`Missing expected ${arm} SHA.`);
const targetSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
if (targetSha !== expectedSha) {
  throw new Error(`Target checkout ${targetSha} does not match exact ${arm} SHA ${expectedSha}.`);
}
const runnerPath = fileURLToPath(import.meta.url);
if (!isWithin(harnessDir, runnerPath)) {
  throw new Error('The RelayFlow runner must execute from the exact-head harness checkout.');
}

const probeDir = await mkdtemp(path.join(tmpdir(), 'relayflow-1615-'));
const stateDir = path.join(probeDir, 'state');
const binDir = path.join(probeDir, 'bin');
const fakeClaudePath = path.join(binDir, 'claude');
// Keep each nonce shorter than the remaining PTY column width after Relay's
// injected message prefix, so the terminal renderer cannot visually wrap and
// split the byte marker the effect oracle searches for.
const positiveNonce = `R${expectedSha.slice(0, 8)}${arm[0]}`;
const negativeNonce = `U${expectedSha.slice(0, 8)}${arm[0]}`;
const selfNonce = `S${expectedSha.slice(0, 8)}${arm[0]}`;
const fakeClaudeSource = String.raw`#!/usr/bin/env node
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdout.write('RELAYFLOW_RECIPIENT_READY\r\n❯');
process.stdin.on('data', (chunk) => process.stdout.write(chunk));
`;

let broker;
let relaycast;
let brokerStderr = '';
let teardownProved = false;
try {
  await mkdir(binDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(fakeClaudePath, fakeClaudeSource, { encoding: 'utf8', mode: 0o700 });
  await chmod(fakeClaudePath, 0o700);
  relaycast = await startFakeRelaycast({
    recipientName: RECIPIENT,
    offlineRecipientName: OFFLINE_RECIPIENT,
    unknownRecipientName: UNKNOWN_RECIPIENT,
    failedRecipientName: FAILED_RECIPIENT,
    // The publish itself completes immediately. Keeping the independent
    // reachability read slower than the configured publish deadline proves a
    // best-effort probe cannot turn durable acceptance into a send failure.
    agentReadDelayMs: 750,
    // A failed publication must cancel this now-useless observation instead
    // of parking the single broker runtime actor until the probe completes.
    failedAgentReadDelayMs: 1_500,
  });

  broker = spawn(
    binaryPath,
    [
      'init',
      '--instance-name',
      'relayflow-1615-broker',
      '--workspace-key',
      'rk_relayflow_1615',
      '--state-dir',
      stateDir,
      '--api-port',
      '0',
      '--channels',
      '',
    ],
    {
      cwd: probeDir,
      env: {
        ...process.env,
        PATH: `${binDir}:${path.dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        RELAYCAST_BASE_URL: relaycast.baseUrl,
        RELAY_BROKER_API_KEY: API_KEY,
        RELAY_NODE_ID: 'node_relayflow_1615',
        RELAY_NODE_TOKEN: 'nt_relayflow_1615',
        RELAY_INJECT_RATE_MS: '0',
        AGENT_RELAY_HTTP_API_RELAYCAST_SEND_TIMEOUT_MS: '100',
        AGENT_RELAY_NO_DEBUG_FILES: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  broker.stderr.on('data', (chunk) => {
    brokerStderr = `${brokerStderr}${chunk}`.slice(-16_000);
  });

  const brokerUrl = await waitForConnection(path.join(stateDir, 'connection.json'), broker);
  const api = async (pathname, { timeoutMs = 15_000, ...options } = {}) => {
    const response = await fetch(`${brokerUrl}${pathname}`, {
      ...options,
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        ...(options.headers ?? {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await response.text();
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = { raw };
    }
    return { status: response.status, body };
  };

  await waitFor(
    async () => (await api('/api/session', { timeoutMs: 2_000 })).status === 200,
    30_000,
    'broker readiness'
  );
  const spawned = await api('/api/spawn', {
    method: 'POST',
    body: JSON.stringify({
      name: RECIPIENT,
      cli: 'claude',
      channels: [],
      skip_relay_prompt: true,
    }),
  });
  if (spawned.status !== 200 || spawned.body?.success !== true) {
    throw new Error(`Real broker could not spawn the recipient: ${JSON.stringify(spawned)}`);
  }
  await waitForSnapshot(api, 'RELAYFLOW_RECIPIENT_READY', 20_000);

  let positiveSettled = false;
  const positivePromise = api('/api/send', {
    method: 'POST',
    body: JSON.stringify({ to: RECIPIENT, text: positiveNonce, mode: 'steer' }),
  }).finally(() => {
    positiveSettled = true;
  });
  let runtimeResponsiveDuringProbe;
  if (arm === 'head') {
    await new Promise((resolve) => setTimeout(resolve, 100));
    let concurrentSnapshot;
    const snapshotStartedAt = performance.now();
    try {
      concurrentSnapshot = await api(`/api/spawned/${encodeURIComponent(RECIPIENT)}/snapshot`, {
        timeoutMs: 400,
      });
    } catch {
      concurrentSnapshot = undefined;
    }
    const snapshotElapsedMs = performance.now() - snapshotStartedAt;
    runtimeResponsiveDuringProbe =
      !positiveSettled && concurrentSnapshot?.status === 200 && snapshotElapsedMs < 400;
    if (!runtimeResponsiveDuringProbe) {
      throw new Error(
        `Slow reachability probe blocked the serialized runtime actor: ${JSON.stringify({
          positiveSettled,
          concurrentSnapshot,
          snapshotElapsedMs,
        })}`
      );
    }
  }
  const positive = await positivePromise;
  let positiveScreen;
  try {
    positiveScreen = await waitForSnapshot(api, positiveNonce, 20_000);
  } catch (error) {
    const snapshot = await api(`/api/spawned/${encodeURIComponent(RECIPIENT)}/snapshot`, {
      timeoutMs: 2_000,
    });
    throw new Error(
      `${error.message}; positive=${JSON.stringify(positive)}; nodeFrames=${JSON.stringify(
        relaycast.state.nodeFrames
      )}; directMessages=${JSON.stringify(relaycast.state.directMessages)}; snapshot=${JSON.stringify(
        snapshot
      )}`
    );
  }

  const self = await api('/api/send', {
    method: 'POST',
    body: JSON.stringify({ to: '@self', from: RECIPIENT, text: selfNonce, mode: 'steer' }),
  });
  const selfScreen = await waitForSnapshot(api, selfNonce, 20_000);

  const negative = await api('/api/send', {
    method: 'POST',
    body: JSON.stringify({ to: OFFLINE_RECIPIENT, text: negativeNonce, mode: 'steer' }),
  });
  const unknown = await api('/api/send', {
    method: 'POST',
    body: JSON.stringify({ to: UNKNOWN_RECIPIENT, text: 'unknown-probe-control' }),
  });
  const nonRecipientTargets = ['#general', 'thread', 'dm_relayflow_existing', 'conv_relayflow_existing'];
  const nonRecipientResponses = [];
  for (const target of nonRecipientTargets) {
    nonRecipientResponses.push(
      await api('/api/send', {
        method: 'POST',
        body: JSON.stringify({ to: target, text: `non-recipient-control:${target}` }),
      })
    );
  }
  const failedSendStartedAt = performance.now();
  const failed = await api('/api/send', {
    method: 'POST',
    body: JSON.stringify({ to: FAILED_RECIPIENT, text: 'failed-publication-control' }),
  });
  const failedSendElapsedMs = performance.now() - failedSendStartedAt;
  if (failed.status < 400 || failedSendElapsedMs >= 1_000) {
    throw new Error(
      `Failed publication waited for its irrelevant reachability probe: ${JSON.stringify({
        failed,
        failedSendElapsedMs,
      })}`
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  const finalSnapshot = await api(`/api/spawned/${encodeURIComponent(RECIPIENT)}/snapshot`, {
    timeoutMs: 2_000,
  });
  const finalScreen = finalSnapshot.body?.screen ?? '';

  const positiveInjectionCount = occurrences(positiveScreen, positiveNonce);
  const selfInjectionCount = occurrences(selfScreen, selfNonce);
  const negativeInjectionCount = occurrences(finalScreen, negativeNonce);
  const deliveryEffectDiscriminates =
    positiveInjectionCount === 1 && selfInjectionCount === 1 && negativeInjectionCount === 0;
  if (!deliveryEffectDiscriminates) {
    throw new Error(
      `The must-fire/must-not-fire PTY control did not discriminate: ${JSON.stringify({
        positiveInjectionCount,
        selfInjectionCount,
        negativeInjectionCount,
        finalScreen: finalScreen.slice(-2_000),
      })}`
    );
  }
  const controlledPublications = relaycast.state.directMessages.filter(
    (message) => message?.to === RECIPIENT || message?.to === OFFLINE_RECIPIENT
  );
  if (controlledPublications.length !== 2) {
    throw new Error(
      `Expected both delivery controls to cross the real broker publish boundary, observed ${controlledPublications.length}.`
    );
  }

  const nonRecipientFieldsOmitted = nonRecipientResponses.every(
    ({ status, body }) =>
      status === 200 &&
      body?.relaycast_published === true &&
      !('recipient_live' in body) &&
      !('recipient_status' in body)
  );
  const sharedObservationControls =
    self.status === 200 &&
    self.body?.relaycast_published === true &&
    unknown.status === 200 &&
    unknown.body?.relaycast_published === true &&
    nonRecipientFieldsOmitted;
  const baseObserved =
    sharedObservationControls &&
    positive.status === 200 &&
    negative.status === 200 &&
    positive.body?.success === true &&
    negative.body?.success === true &&
    positive.body?.relaycast_published === true &&
    negative.body?.relaycast_published === true &&
    !('delivery_status' in positive.body) &&
    !('delivery_status' in negative.body) &&
    !('recipient_live' in unknown.body) &&
    !('recipient_status' in unknown.body) &&
    !('recipient_live' in self.body) &&
    !('recipient_status' in self.body) &&
    equivalentExceptEventId(positive.body, negative.body);
  const headObserved =
    sharedObservationControls &&
    positive.status === 200 &&
    negative.status === 200 &&
    positive.body?.success === true &&
    negative.body?.success === true &&
    positive.body?.delivery_status === 'published_unconfirmed' &&
    negative.body?.delivery_status === 'published_unconfirmed' &&
    positive.body?.recipient_live === true &&
    positive.body?.recipient_status === 'active' &&
    negative.body?.recipient_live === false &&
    negative.body?.recipient_status === 'offline' &&
    self.body?.recipient_live === true &&
    self.body?.recipient_status === 'active' &&
    unknown.status === 200 &&
    unknown.body?.relaycast_published === true &&
    unknown.body?.recipient_live === null &&
    unknown.body?.recipient_status === 'unknown' &&
    nonRecipientFieldsOmitted;

  const released = await api(`/api/spawned/${encodeURIComponent(RECIPIENT)}`, {
    method: 'DELETE',
    body: '{}',
  });
  if (released.status !== 200) {
    throw new Error(`Recipient release failed during teardown: ${JSON.stringify(released)}`);
  }
  await waitFor(
    async () =>
      (
        await api(`/api/spawned/${encodeURIComponent(RECIPIENT)}/snapshot`, {
          timeoutMs: 2_000,
        })
      ).status === 404,
    10_000,
    'recipient absence after release'
  );
  teardownProved = true;

  let outcome;
  let signature;
  let details;
  if (baseObserved) {
    outcome = 'bug';
    signature = 'api_send_hides_unroutable_recipient';
    details =
      'The real base broker published both DMs and injected only the routable nonce, yet returned equivalent successful responses after removing the random event id.';
  } else if (headObserved) {
    outcome = 'fixed';
    signature = 'api_send_reports_recipient_reachability';
    details =
      'The real head broker published both DMs, injected only the routable nonce, and separately reported live versus offline recipient observations without claiming delivery.';
  } else {
    throw new Error(
      `Unexpected /api/send observation: ${JSON.stringify({
        arm,
        positive,
        negative,
        self,
        unknown,
        failed,
        failedSendElapsedMs,
        nonRecipientResponses,
        brokerStderr,
      })}`
    );
  }

  await mkdir(path.dirname(resultPath), { recursive: true });
  // The PR-proof runner owns resultPath. Persist only the bounded effect
  // summary below—never raw broker, PTY, Relaycast, or response content.
  await writeFile(
    resultPath,
    `${JSON.stringify({
      version: 1,
      caseId: CASE_ID,
      arm,
      outcome,
      signature,
      details,
      evidence: {
        positiveInjectionCount,
        selfInjectionCount,
        negativeInjectionCount,
        relaycastPublications: relaycast.state.directMessages.length + relaycast.state.channelMessages.length,
        unknownProbeReported: unknown.body?.recipient_status ?? 'omitted',
        nonRecipientFieldsOmitted,
        failedSendReturnedBeforeProbe: failed.status >= 400 && failedSendElapsedMs < 1_000,
        runtimeResponsiveDuringProbe,
        teardownProved,
      },
    })}\n`,
    'utf8'
  );
} finally {
  if (broker && broker.exitCode === null) {
    broker.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => broker.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (broker.exitCode === null) broker.kill('SIGKILL');
  }
  await relaycast?.close();
  await rm(probeDir, { recursive: true, force: true });
}

async function waitForConnection(connectionPath, child) {
  let lastError;
  return waitFor(
    async () => {
      if (child.exitCode !== null) {
        throw new Error(`Broker exited during startup (${child.exitCode}): ${brokerStderr}`);
      }
      try {
        const connection = JSON.parse(await readFile(connectionPath, 'utf8'));
        const url = new URL(connection.url);
        if (
          url.protocol !== 'http:' ||
          url.hostname !== '127.0.0.1' ||
          url.username !== '' ||
          url.password !== '' ||
          url.pathname !== '/' ||
          url.search !== '' ||
          url.hash !== '' ||
          !/^\d+$/.test(url.port)
        ) {
          throw new Error(`Broker connection URL is not a plain loopback origin: ${url.origin}`);
        }
        return `http://127.0.0.1:${Number(url.port)}`;
      } catch (error) {
        lastError = error;
        return false;
      }
    },
    30_000,
    `connection metadata (${lastError?.message ?? 'not written'})`
  );
}

async function waitForSnapshot(api, marker, timeoutMs) {
  return waitFor(
    async () => {
      const snapshot = await api(`/api/spawned/${encodeURIComponent(RECIPIENT)}/snapshot`, {
        timeoutMs: 2_000,
      });
      if (snapshot.status !== 200) return false;
      const screen = snapshot.body?.screen ?? '';
      return screen.includes(marker) ? screen : false;
    },
    timeoutMs,
    `recipient PTY marker ${marker}`
  );
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}; broker=${brokerStderr}`
  );
}

function equivalentExceptEventId(left, right) {
  const normalize = (value) => {
    const copy = { ...value };
    delete copy.event_id;
    return JSON.stringify(copy, Object.keys(copy).sort());
  };
  return normalize(left) === normalize(right);
}

function occurrences(value, needle) {
  return value.split(needle).length - 1;
}

function requiredValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

function requiredDirectory(name) {
  return path.resolve(requiredValue(name));
}

async function requiredExecutable(name) {
  const candidate = path.resolve(requiredValue(name));
  try {
    await access(candidate, fsConstants.R_OK | fsConstants.X_OK);
  } catch {
    throw new Error(`${name} must name a readable executable file.`);
  }
  return candidate;
}

function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}
