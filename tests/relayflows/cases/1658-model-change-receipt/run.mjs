/**
 * relay#1658 — the model control command must expose a machine-readable
 * receipt. The head arm starts a real OpenCode AppServer, creates a real
 * session, and requires the broker's typed confirmation GET to report the
 * exact requested provider/model. PTY/native providers remain unsupported
 * without a typed acknowledgement; their fail-closed contract is covered by
 * the Fleet fixture and broker/runtime tests.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { startFakeRelaycast } from '../1615-api-send-recipient-reachability/fake-relaycast.mjs';

const CASE_ID = '1658-model-change-receipt';
const MODEL_OPERATION_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 30_000;
const BROKER_API_KEY = 'pr-proof-broker-key';
const targetDir = requiredValue('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = requiredValue('RELAY_PR_PROOF_HARNESS_DIR');
const resultPath = requiredValue('RELAY_PR_PROOF_RESULT_PATH');
const binaryPath = requiredValue('RELAY_PR_PROOF_BROKER_BINARY');
const arm = requiredValue('RELAY_PR_PROOF_ARM');
const activeProofDirs = new Set();
if (arm !== 'base' && arm !== 'head') {
  throw new Error(`RELAY_PR_PROOF_ARM must be base or head, received ${JSON.stringify(arm)}.`);
}
const expectedSha =
  arm === 'base' ? process.env.RELAY_PR_PROOF_BASE_SHA : process.env.RELAY_PR_PROOF_HEAD_SHA;
if (!expectedSha) throw new Error(`Missing expected ${arm} SHA.`);
const targetSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
  timeout: PROBE_TIMEOUT_MS,
}).trim();
if (targetSha !== expectedSha) {
  throw new Error(`Target checkout ${targetSha} does not match exact ${arm} SHA ${expectedSha}.`);
}
const runnerPath = fileURLToPath(import.meta.url);
const relativeRunner = path.relative(path.resolve(harnessDir), path.resolve(runnerPath));
if (!relativeRunner || relativeRunner.startsWith('..') || path.isAbsolute(relativeRunner)) {
  throw new Error('The RelayFlow runner must execute from the exact-head harness checkout.');
}

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: targetDir,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, RELAY_SKIP_TELEMETRY: '1' },
  });
  if (result.error) throw new Error(`${label} failed to run: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${label} exited with status ${result.status}: ${result.stderr ?? ''}`);
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function runAsync(command, args, label, timeoutMs = MODEL_OPERATION_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: targetDir,
      env: { ...process.env, RELAY_SKIP_TELEMETRY: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 1_000);
      child.once('close', () => clearTimeout(killTimer));
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`${label} failed to run: ${error.message}`));
    });
    child.once('close', (status) => {
      clearTimeout(timer);
      if (status !== 0) {
        reject(new Error(`${label} exited with status ${status}: ${stderr}`));
        return;
      }
      resolve(`${stdout}${stderr}`);
    });
  });
}

async function terminateChild(child, label) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  try {
    child.kill('SIGTERM');
  } catch {
    // The process may have exited between the state check and SIGTERM.
  }
  if (await waitForChildClose(child, 2_000)) return true;
  try {
    child.kill('SIGKILL');
  } catch {
    // Report the bounded wait below instead of hanging teardown.
  }
  if (await waitForChildClose(child, 2_000)) return true;
  throw new Error(`${label} did not terminate after SIGTERM/SIGKILL`);
}

function waitForChildClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('close', onClose);
      resolve(false);
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('close', onClose);
  });
}

function parseReceiptJson(output, label) {
  const text = String(output ?? '');
  for (
    let start = text.lastIndexOf('{');
    start >= 0;
    start = start > 0 ? text.lastIndexOf('{', start - 1) : -1
  ) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth !== 0) continue;
        try {
          const parsed = JSON.parse(text.slice(start, index + 1));
          if (
            parsed &&
            typeof parsed === 'object' &&
            typeof parsed.status === 'string' &&
            (typeof parsed.requestId === 'string' || typeof parsed.request_id === 'string')
          ) {
            return parsed;
          }
        } catch {
          // Ignore unrelated or malformed log objects and inspect the next one.
        }
        break;
      }
    }
  }
  throw new Error(`${label} did not emit a complete JSON receipt: ${text.slice(-500)}`);
}

try {
  // Build the CLI from the exact checkout so this probe cannot accidentally
  // execute a globally installed command or a stale dist tree.
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], 'dependency installation');
  for (const step of [
    'build:session',
    'build:config',
    'build:cloud',
    'build:utils',
    'build:policy',
    'build:sdk',
    'build:harness-driver',
    'build:harnesses',
    'build:fleet',
    'build:cli',
  ]) {
    run('npm', ['run', step], `${step} build`);
  }

  const cliEntry = path.join(targetDir, 'packages/cli/dist/cli/index.js');
  let help = run(process.execPath, [cliEntry, 'node', 'agent', 'set-model', '--help'], 'set-model help');
  const hasJson = /--json\b/.test(help);
  if (arm === 'head' && hasJson) {
    const brokerStateDir = await mkdtemp(path.join(os.tmpdir(), 'relay-pr-proof-1658-broker-'));
    activeProofDirs.add(brokerStateDir);
    let broker;
    let provider;
    let relaycast;
    let providerEndpoint;
    let providerSessionId;
    let providerOutput = '';
    let brokerOutput = '';
    let brokerUrl;
    let api;
    let workerCreated = false;
    let proofFailure;
    const previousStateDir = process.env.AGENT_RELAY_STATE_DIR;
    try {
      const providerBinary = process.env.RELAY_PR_PROOF_OPENCODE_BIN ?? 'opencode';
      const providerVersion = spawnSync(providerBinary, ['--version'], {
        cwd: brokerStateDir,
        encoding: 'utf8',
        timeout: 10_000,
        env: { ...process.env, HOME: brokerStateDir },
      });
      if (providerVersion.error || providerVersion.status !== 0) {
        throw new Error(
          `real OpenCode CLI is unavailable: ${providerVersion.error?.message ?? providerVersion.stderr ?? `exit ${providerVersion.status}`}`
        );
      }
      let providerReady = false;
      // freePort() necessarily closes its probe socket before the child binds;
      // retry a bounded number of times if another local process wins that
      // small race instead of treating the proof as a product failure.
      for (let attempt = 0; attempt < 3 && !providerReady; attempt += 1) {
        const providerPort = await freePort();
        providerEndpoint = `http://127.0.0.1:${providerPort}`;
        provider = spawn(
          providerBinary,
          ['serve', '--hostname', '127.0.0.1', '--port', String(providerPort), '--pure'],
          {
            cwd: brokerStateDir,
            env: {
              ...process.env,
              HOME: brokerStateDir,
              RELAY_SKIP_TELEMETRY: '1',
              OPENCODE_SERVER_PASSWORD: '',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        );
        provider.stdout.on('data', (chunk) => {
          providerOutput += chunk;
        });
        provider.stderr.on('data', (chunk) => {
          providerOutput += chunk;
        });
        provider.once('error', (error) => {
          providerOutput += `OpenCode process error: ${error.message}`;
        });
        try {
          await waitFor(async () => {
            if (provider.exitCode !== null) {
              throw new Error(`OpenCode exited early: ${providerOutput}`);
            }
            try {
              const response = await fetch(`${providerEndpoint}/global/health`, {
                signal: AbortSignal.timeout(2_000),
              });
              return response.ok;
            } catch {
              return null;
            }
          }, 'the real OpenCode server to answer');
          providerReady = true;
        } catch (error) {
          if (provider.exitCode === null) {
            await terminateChild(provider, 'OpenCode startup process');
          }
          provider = undefined;
          if (attempt === 2) throw error;
        }
      }
      const sessionResponse = await fetch(`${providerEndpoint}/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(5_000),
      });
      if (!sessionResponse.ok) {
        throw new Error(`OpenCode session creation failed: ${sessionResponse.status}`);
      }
      const session = await sessionResponse.json();
      if (typeof session.id !== 'string' || session.id.length === 0) {
        throw new Error(`OpenCode session creation omitted id: ${JSON.stringify(session)}`);
      }
      providerSessionId = session.id;
      relaycast = await startFakeRelaycast({
        recipientName: 'proof-worker',
        offlineRecipientName: 'offline-proof-worker',
        unknownRecipientName: 'unknown-proof-worker',
        failedRecipientName: 'failed-proof-worker',
      });
      broker = spawn(
        binaryPath,
        [
          'init',
          '--instance-name',
          'relayflow-1658-broker',
          '--workspace-key',
          'rk_relayflow_1658',
          '--api-port',
          '0',
          '--api-bind',
          '127.0.0.1',
          '--state-dir',
          brokerStateDir,
          '--channels',
          '',
        ],
        {
          cwd: brokerStateDir,
          env: {
            PATH: process.env.PATH,
            HOME: brokerStateDir,
            TMPDIR: process.env.TMPDIR ?? '/tmp',
            RELAY_BROKER_API_KEY: BROKER_API_KEY,
            RELAYCAST_BASE_URL: relaycast.baseUrl,
            RELAY_NODE_ID: 'node_relayflow_1658',
            RELAY_NODE_TOKEN: 'nt_relayflow_1658',
            RELAY_SKIP_TELEMETRY: '1',
            RUST_LOG: 'info',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      broker.stdout.on('data', (chunk) => {
        brokerOutput += chunk;
      });
      broker.stderr.on('data', (chunk) => {
        brokerOutput += chunk;
      });
      brokerUrl = await waitFor(async () => {
        if (broker.exitCode !== null) throw new Error(`broker exited early: ${brokerOutput}`);
        try {
          const connection = JSON.parse(await readFile(path.join(brokerStateDir, 'connection.json'), 'utf8'));
          return connection.url;
        } catch {
          return null;
        }
      }, 'the exact broker to publish its connection file');
      api = brokerClient(brokerUrl);
      await waitFor(
        () => {
          if (broker.exitCode !== null) {
            throw new Error(`broker exited before readiness: ${brokerOutput}`);
          }
          return api('GET', '/api/status', undefined, 2_000).then(() => true);
        },
        'the exact broker API to answer',
        60_000
      );
      process.env.AGENT_RELAY_STATE_DIR = brokerStateDir;
      await runAsync(
        process.execPath,
        [
          cliEntry,
          'node',
          'agent',
          'spawn',
          'opencode',
          '--name',
          'proof-worker',
          '--runtime',
          'headless',
          '--protocol',
          'opencode',
          '--endpoint',
          providerEndpoint,
          '--session-id',
          session.id,
          '--release',
          'delete',
        ],
        'compiled CLI AppServer spawn'
      );
      workerCreated = true;

      const receiptOutput = await runAsync(
        process.execPath,
        [cliEntry, 'node', 'agent', 'set-model', 'proof-worker', 'openai/gpt-5.4', '--json'],
        'compiled CLI set-model receipt',
        60_000
      );
      const receipt = parseReceiptJson(receiptOutput, 'compiled CLI set-model receipt');
      if (
        receipt.name !== 'proof-worker' ||
        receipt.requestedModel !== 'openai/gpt-5.4' ||
        receipt.effectiveModel !== 'openai/gpt-5.4' ||
        receipt.status !== 'applied' ||
        receipt.applied !== true ||
        receipt.accepted !== true ||
        receipt.success !== true ||
        receipt.pending !== false ||
        typeof receipt.requestId !== 'string' ||
        receipt.requestId.length === 0 ||
        receipt.receiptId !== receipt.requestId ||
        typeof receipt.generation !== 'string' ||
        receipt.generation.length === 0 ||
        !Number.isInteger(receipt.revision) ||
        receipt.revision < 1 ||
        receipt.effectiveRevision !== receipt.revision
      ) {
        throw new Error(`compiled CLI returned an invalid applied receipt: ${JSON.stringify(receipt)}`);
      }
      const correlated = await api(
        'GET',
        `/api/spawned/proof-worker/model?request_id=${encodeURIComponent(receipt.requestId)}`
      );
      if (
        correlated.request_id !== receipt.requestId ||
        correlated.receipt_id !== receipt.receiptId ||
        correlated.requested_model !== receipt.requestedModel ||
        correlated.effective_model !== receipt.effectiveModel ||
        correlated.status !== 'applied' ||
        correlated.applied !== true ||
        correlated.pending !== false ||
        correlated.generation !== receipt.generation ||
        correlated.revision !== receipt.revision ||
        correlated.effective_revision !== receipt.effectiveRevision
      ) {
        throw new Error(`broker correlation did not match the CLI receipt: ${JSON.stringify(correlated)}`);
      }

      const providerSessionUrl = `${providerEndpoint}/session/${session.id}`;
      const confirmedSessionResponse = await fetch(providerSessionUrl, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!confirmedSessionResponse.ok) {
        throw new Error(`OpenCode session confirmation failed: ${confirmedSessionResponse.status}`);
      }
      const confirmedSession = await confirmedSessionResponse.json();
      const confirmedSessionData = confirmedSession.data ?? confirmedSession;
      if (
        confirmedSessionData.model?.providerID !== 'openai' ||
        confirmedSessionData.model?.id !== 'gpt-5.4'
      ) {
        throw new Error(
          `OpenCode session did not retain the exact model: ${JSON.stringify(confirmedSession)}`
        );
      }

      const unsupportedOutput = await runAsync(
        process.execPath,
        [cliEntry, 'node', 'agent', 'set-model', 'proof-worker', 'unsupported', '--json'],
        'compiled CLI rejected model receipt',
        60_000
      );
      const unsupported = parseReceiptJson(unsupportedOutput, 'compiled CLI rejected model receipt');
      if (
        unsupported.name !== 'proof-worker' ||
        unsupported.requestedModel !== 'unsupported' ||
        unsupported.effectiveModel !== 'openai/gpt-5.4' ||
        unsupported.status !== 'rejected' ||
        unsupported.applied !== false ||
        unsupported.success !== false ||
        unsupported.accepted !== true ||
        unsupported.pending !== false ||
        typeof unsupported.requestId !== 'string' ||
        unsupported.requestId.length === 0 ||
        unsupported.receiptId !== unsupported.requestId ||
        unsupported.generation !== receipt.generation ||
        !Number.isInteger(unsupported.revision) ||
        unsupported.revision <= receipt.revision ||
        unsupported.effectiveRevision !== receipt.effectiveRevision ||
        !/provider\/model syntax/.test(unsupported.error ?? '')
      ) {
        throw new Error(`compiled CLI claimed a rejected model applied: ${JSON.stringify(unsupported)}`);
      }
      const rejectedCorrelated = await api(
        'GET',
        `/api/spawned/proof-worker/model?request_id=${encodeURIComponent(unsupported.requestId)}`
      );
      if (
        rejectedCorrelated.request_id !== unsupported.requestId ||
        rejectedCorrelated.status !== 'rejected' ||
        rejectedCorrelated.applied !== false ||
        rejectedCorrelated.effective_model !== 'openai/gpt-5.4' ||
        rejectedCorrelated.effective_revision !== receipt.effectiveRevision
      ) {
        throw new Error(
          `broker correlation did not preserve the last applied model: ${JSON.stringify(rejectedCorrelated)}`
        );
      }
      const preservedSessionResponse = await fetch(providerSessionUrl, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!preservedSessionResponse.ok) {
        throw new Error(
          `OpenCode session disappeared after rejected model: ${preservedSessionResponse.status}`
        );
      }
      const preservedSession = await preservedSessionResponse.json();
      const preservedSessionData = preservedSession.data ?? preservedSession;
      if (
        preservedSessionData.model?.providerID !== 'openai' ||
        preservedSessionData.model?.id !== 'gpt-5.4'
      ) {
        throw new Error(`OpenCode session changed after rejected model: ${JSON.stringify(preservedSession)}`);
      }

      await runAsync(
        process.execPath,
        [cliEntry, 'node', 'agent', 'release', 'proof-worker'],
        'compiled CLI AppServer release'
      );
      await waitFor(
        async () => {
          const response = await fetch(`${brokerUrl}/api/spawned/proof-worker/model`, {
            headers: { 'x-api-key': BROKER_API_KEY },
            signal: AbortSignal.timeout(2_000),
          });
          return response.status === 404;
        },
        'released compiled-CLI worker to disappear',
        15_000
      );
      await waitFor(
        async () => {
          const response = await fetch(providerSessionUrl, {
            signal: AbortSignal.timeout(2_000),
          });
          return response.status === 404;
        },
        'release-owned OpenCode session deletion',
        15_000
      );
      workerCreated = false;
      providerSessionId = undefined;
    } catch (error) {
      proofFailure = error;
      throw error;
    } finally {
      const cleanupErrors = [];
      if (broker && broker.exitCode === null && workerCreated) {
        try {
          await runAsync(
            process.execPath,
            [cliEntry, 'node', 'agent', 'release', 'proof-worker'],
            'recovery AppServer release'
          );
        } catch (error) {
          cleanupErrors.push(error.message);
        }
      }
      if (providerEndpoint && providerSessionId && provider && provider.exitCode === null) {
        try {
          const sessionUrl = `${providerEndpoint}/session/${encodeURIComponent(providerSessionId)}`;
          const deleted = await fetch(sessionUrl, {
            method: 'DELETE',
            signal: AbortSignal.timeout(2_000),
          });
          if (![200, 204, 404].includes(deleted.status)) {
            throw new Error(`OpenCode session recovery deletion failed: ${deleted.status}`);
          }
          await waitFor(
            async () => {
              try {
                const response = await fetch(sessionUrl, { signal: AbortSignal.timeout(2_000) });
                return response.status === 404;
              } catch (error) {
                return error?.cause?.code === 'ECONNREFUSED';
              }
            },
            'recovery-deleted OpenCode session to disappear',
            5_000
          );
        } catch (error) {
          cleanupErrors.push(error.message);
        }
      }
      if (broker && broker.exitCode === null) {
        try {
          await terminateChild(broker, 'broker');
        } catch (error) {
          cleanupErrors.push(error.message);
        }
      }
      if (provider && provider.exitCode === null) {
        try {
          await terminateChild(provider, 'OpenCode provider');
        } catch (error) {
          cleanupErrors.push(error.message);
        }
      }
      if (relaycast) {
        try {
          await relaycast.close();
        } catch (error) {
          cleanupErrors.push(`fake Relaycast cleanup failed: ${error.message}`);
        }
      }
      try {
        await rm(brokerStateDir, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(`broker state cleanup failed: ${error.message}`);
      }
      activeProofDirs.delete(brokerStateDir);
      if (previousStateDir === undefined) delete process.env.AGENT_RELAY_STATE_DIR;
      else process.env.AGENT_RELAY_STATE_DIR = previousStateDir;
      if (cleanupErrors.length > 0) {
        const cleanupMessage = `proof cleanup failed: ${cleanupErrors.join('; ')}`;
        if (proofFailure) {
          const primary = proofFailure instanceof Error ? proofFailure : new Error(String(proofFailure));
          primary.message = `${primary.message}; ${cleanupMessage}`;
          throw primary;
        }
        throw new Error(cleanupMessage);
      }
    }
  }
  const outcome = hasJson ? 'fixed' : 'bug';
  const signature = hasJson ? 'set_model_exposes_json_receipt' : 'set_model_has_no_json_receipt';
  const details = hasJson
    ? 'The exact compiled CLI spawned a real OpenCode AppServer worker, returned a correlated applied receipt matching provider state, preserved that effective model across rejection, and deleted the worker-owned provider session on release.'
    : 'The base CLI has no --json receipt surface, so callers cannot consume request/generation/effective model state.';
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`,
    'utf8'
  );
  process.stdout.write(`${signature}\n`);
} catch (error) {
  await Promise.all([...activeProofDirs].map((directory) => rm(directory, { recursive: true, force: true })));
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  throw error;
}

function requiredValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

async function waitFor(predicate, label, timeoutMs = MODEL_OPERATION_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}.`);
}

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address !== 'object' || !address.port) {
    throw new Error('failed to reserve a local OpenCode port');
  }
  return address.port;
}

function brokerClient(baseUrl) {
  return async (method, route, body, timeoutMs = 15_000) => {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-api-key': BROKER_API_KEY },
      signal: AbortSignal.timeout(timeoutMs),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    if (!response.ok) {
      throw new Error(`${method} ${route} -> ${response.status} ${text.slice(0, 300)}`);
    }
    return parsed;
  };
}
