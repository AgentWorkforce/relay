/**
 * relay#1658 — the model control command must expose a machine-readable
 * receipt. This contract probe is intentionally independent of a real
 * provider: PTY/native providers cannot truthfully claim application without
 * a typed acknowledgement, while the broker/runtime unit tests cover the
 * accepted → provider-confirmed applied path and stale fencing.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1658-model-change-receipt';
const MODEL_OPERATION_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 30_000;
const BROKER_API_KEY = 'pr-proof-broker-key';
const targetDir = requiredValue('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = requiredValue('RELAY_PR_PROOF_HARNESS_DIR');
const resultPath = requiredValue('RELAY_PR_PROOF_RESULT_PATH');
const binaryPath = requiredValue('RELAY_PR_PROOF_BROKER_BINARY');
const arm = requiredValue('RELAY_PR_PROOF_ARM');
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

function runAsync(command, args, label) {
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
      reject(new Error(`${label} timed out after ${MODEL_OPERATION_TIMEOUT_MS}ms`));
    }, MODEL_OPERATION_TIMEOUT_MS);
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
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'relay-pr-proof-1658-'));
    const brokerStateDir = await mkdtemp(path.join(os.tmpdir(), 'relay-pr-proof-1658-broker-'));
    const requestId = 'model_pr_proof_1658';
    let broker;
    let provider;
    const providerRequests = [];
    try {
      provider = createServer(async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (request.method === 'POST' && url.pathname.endsWith('/model')) {
          const body = await readRequestJson(request);
          providerRequests.push({ method: 'POST', path: url.pathname, body });
          if (body.model?.providerID === 'unsupported') {
            response.writeHead(422).end(JSON.stringify({ error: 'provider unavailable' }));
            return;
          }
          response.writeHead(204).end();
          return;
        }
        if (request.method === 'GET' && url.pathname.endsWith('/ses-proof')) {
          providerRequests.push({ method: 'GET', path: url.pathname });
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ model: { providerID: 'openai', id: 'gpt-5.4' } }));
          return;
        }
        response.writeHead(404).end();
      });
      await new Promise((resolve, reject) => {
        provider.once('error', reject);
        provider.listen(0, '127.0.0.1', resolve);
      });
      const providerAddress = provider.address();
      const providerPort = typeof providerAddress === 'object' && providerAddress ? providerAddress.port : 0;
      broker = spawn(
        binaryPath,
        ['init', '--api-port', '0', '--api-bind', '127.0.0.1', '--state-dir', brokerStateDir],
        {
          cwd: brokerStateDir,
          env: {
            PATH: process.env.PATH,
            HOME: brokerStateDir,
            TMPDIR: process.env.TMPDIR ?? '/tmp',
            RELAY_BROKER_API_KEY: BROKER_API_KEY,
            RELAY_SKIP_TELEMETRY: '1',
            RUST_LOG: 'info',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      let brokerOutput = '';
      broker.stdout.on('data', (chunk) => {
        brokerOutput += chunk;
      });
      broker.stderr.on('data', (chunk) => {
        brokerOutput += chunk;
      });
      const brokerUrl = await waitFor(async () => {
        if (broker.exitCode !== null) throw new Error(`broker exited early: ${brokerOutput}`);
        try {
          const connection = JSON.parse(await readFile(path.join(brokerStateDir, 'connection.json'), 'utf8'));
          return connection.url;
        } catch {
          return null;
        }
      }, 'the exact broker to publish its connection file');
      const api = brokerClient(brokerUrl);
      await waitFor(() => api('GET', '/api/status').then(() => true), 'the exact broker API to answer');
      await api('POST', '/api/spawn', {
        name: 'proof-worker',
        cli: 'cat',
        harness_config: {
          runtime: 'headless',
          protocol: 'opencode',
          endpoint: `http://127.0.0.1:${providerPort}`,
          sessionId: 'ses-proof',
        },
      });
      const admitted = await api('POST', '/api/spawned/proof-worker/model', {
        model: 'openai/gpt-5.4',
        timeout_ms: 30_000,
      });
      if (admitted.status !== 'accepted_pending' || admitted.applied !== false) {
        throw new Error(`broker admission was not pending: ${JSON.stringify(admitted)}`);
      }
      if (typeof admitted.request_id !== 'string') {
        throw new Error(`broker admission omitted request_id: ${JSON.stringify(admitted)}`);
      }
      const terminal = await waitFor(async () => {
        try {
          const receipt = await api(
            'GET',
            `/api/spawned/proof-worker/model?request_id=${encodeURIComponent(admitted.request_id)}`
          );
          return receipt.status === 'applied' ? receipt : null;
        } catch {
          return null;
        }
      }, 'the exact current-generation applied receipt');
      if (
        terminal.request_id !== admitted.request_id ||
        terminal.requested_model !== 'openai/gpt-5.4' ||
        terminal.effective_model !== 'openai/gpt-5.4' ||
        terminal.applied !== true ||
        terminal.pending !== false
      ) {
        throw new Error(`broker returned an invalid applied receipt: ${JSON.stringify(terminal)}`);
      }
      const beforeUnsupported = providerRequests.length;
      const unsupportedAdmission = await api('POST', '/api/spawned/proof-worker/model', {
        model: 'unsupported/model',
        timeout_ms: 30_000,
      });
      const unsupported = await waitFor(async () => {
        try {
          const receipt = await api(
            'GET',
            `/api/spawned/proof-worker/model?request_id=${encodeURIComponent(unsupportedAdmission.request_id)}`
          );
          return receipt.status === 'accepted_pending' ? null : receipt;
        } catch {
          return null;
        }
      }, 'the exact unsupported terminal receipt');
      if (
        unsupported.status !== 'rejected' ||
        unsupported.applied !== false ||
        unsupported.success !== false
      ) {
        throw new Error(`broker claimed unsupported model applied: ${JSON.stringify(unsupported)}`);
      }
      const unsupportedRequests = providerRequests.slice(beforeUnsupported);
      if (
        unsupportedRequests.length !== 1 ||
        unsupportedRequests[0].method !== 'POST' ||
        unsupportedRequests[0].body.model?.providerID !== 'unsupported'
      ) {
        throw new Error(
          `unsupported model unexpectedly reached confirmation: ${JSON.stringify(unsupportedRequests)}`
        );
      }
    } finally {
      if (broker && broker.exitCode === null) {
        broker.kill('SIGTERM');
        await new Promise((resolve) => broker.once('close', resolve));
      }
      if (provider) await new Promise((resolve) => provider.close(resolve));
      await rm(brokerStateDir, { recursive: true, force: true });
    }

    // Keep the CLI-facing check as part of the same head proof: the broker
    // receipt above is the source of truth, while this confirms JSON output is
    // advertised by the exact checkout used to build the probe.
    const server = createServer(async (request, response) => {
      if (request.headers['x-api-key'] !== 'pr-proof-key') {
        response.writeHead(401).end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      if (request.method === 'POST') {
        const body = await readRequestJson(request);
        const unsupported = body.model === 'unsupported/model';
        requests.push({ method: 'POST', model: body.model });
        if (!unsupported) {
          response.end(
            JSON.stringify({
              name: 'proof-worker',
              requested_model: 'openai/gpt-5.4',
              effective_model: null,
              applied: false,
              status: 'accepted_pending',
              request_id: requestId,
              receipt_id: requestId,
              generation: 'generation-proof',
              revision: 1,
              success: false,
              accepted: true,
              pending: true,
            })
          );
          return;
        }
        response.end(
          JSON.stringify({
            name: 'proof-worker',
            requested_model: unsupported ? 'unsupported/model' : 'openai/gpt-5.4',
            effective_model: unsupported ? null : 'openai/gpt-5.4',
            applied: !unsupported,
            status: unsupported ? 'unsupported' : 'applied',
            request_id: requestId,
            receipt_id: requestId,
            generation: 'generation-proof',
            revision: 1,
            success: !unsupported,
            accepted: true,
            pending: false,
            ...(unsupported ? { error: 'provider capability unavailable' } : {}),
          })
        );
        return;
      }
      const requestIdFromQuery = new URL(request.url, 'http://127.0.0.1').searchParams.get('request_id');
      requests.push({ method: 'GET', requestId: requestIdFromQuery });
      response.end(
        JSON.stringify({
          name: 'proof-worker',
          requested_model: 'openai/gpt-5.4',
          effective_model: 'openai/gpt-5.4',
          applied: true,
          status: 'applied',
          request_id: requestId,
          receipt_id: requestId,
          generation: 'generation-proof',
          revision: 1,
          success: true,
          accepted: true,
          pending: false,
        })
      );
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await writeFile(
      path.join(stateDir, 'connection.json'),
      JSON.stringify({ url: `http://127.0.0.1:${port}`, api_key: 'pr-proof-key', pid: process.pid })
    );
    process.env.AGENT_RELAY_STATE_DIR = stateDir;
    const requests = [];
    try {
      const receiptOutput = await runAsync(
        process.execPath,
        [cliEntry, 'node', 'agent', 'set-model', 'proof-worker', 'openai/gpt-5.4', '--json'],
        'set-model receipt'
      );
      const first = receiptOutput.indexOf('{');
      const last = receiptOutput.lastIndexOf('}');
      const receipt = JSON.parse(receiptOutput.slice(first, last + 1));
      const validReceipt =
        receipt.name === 'proof-worker' &&
        receipt.requestedModel === 'openai/gpt-5.4' &&
        receipt.effectiveModel === 'openai/gpt-5.4' &&
        receipt.applied === true &&
        receipt.status === 'applied' &&
        receipt.success === true &&
        receipt.accepted === true &&
        receipt.pending === false &&
        typeof receipt.requestId === 'string' &&
        typeof receipt.receiptId === 'string' &&
        typeof receipt.generation === 'string';
      if (!validReceipt) throw new Error(`set-model returned an invalid receipt: ${JSON.stringify(receipt)}`);
      if (
        requests.length !== 2 ||
        requests[0].method !== 'POST' ||
        requests[1].method !== 'GET' ||
        requests[1].requestId !== requestId
      ) {
        throw new Error(`set-model did not poll its correlated receipt: ${JSON.stringify(requests)}`);
      }

      const unsupportedOutput = await runAsync(
        process.execPath,
        [cliEntry, 'node', 'agent', 'set-model', 'proof-worker', 'unsupported/model', '--json'],
        'unsupported set-model receipt'
      );
      const unsupportedFirst = unsupportedOutput.indexOf('{');
      const unsupportedLast = unsupportedOutput.lastIndexOf('}');
      const unsupported = JSON.parse(unsupportedOutput.slice(unsupportedFirst, unsupportedLast + 1));
      if (
        unsupported.status !== 'unsupported' ||
        unsupported.applied !== false ||
        unsupported.success !== false
      ) {
        throw new Error(`unsupported set-model claimed application: ${JSON.stringify(unsupported)}`);
      }
      if (requests.length !== 3 || requests[2].method !== 'POST') {
        throw new Error(`unsupported set-model unexpectedly polled: ${JSON.stringify(requests)}`);
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(stateDir, { recursive: true, force: true });
      delete process.env.AGENT_RELAY_STATE_DIR;
    }
  }
  const outcome = hasJson ? 'fixed' : 'bug';
  const signature = hasJson ? 'set_model_exposes_json_receipt' : 'set_model_has_no_json_receipt';
  const details = hasJson
    ? 'The head CLI advertises --json for the correlated model receipt and rejects an unsupported terminal response without claiming application; provider application remains governed by typed runtime confirmation.'
    : 'The base CLI has no --json receipt surface, so callers cannot consume request/generation/effective model state.';
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`,
    'utf8'
  );
  process.stdout.write(`${signature}\n`);
} catch (error) {
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

function brokerClient(baseUrl) {
  return async (method, route, body) => {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-api-key': BROKER_API_KEY },
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

async function readRequestJson(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return JSON.parse(body);
}
