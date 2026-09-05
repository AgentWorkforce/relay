/**
 * relay#1658 — the model control command must expose a machine-readable
 * receipt. This contract probe is intentionally independent of a real
 * provider: PTY/native providers cannot truthfully claim application without
 * a typed acknowledgement, while the broker/runtime unit tests cover the
 * accepted → provider-confirmed applied path and stale fencing.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1658-model-change-receipt';
const targetDir = requiredValue('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = requiredValue('RELAY_PR_PROOF_HARNESS_DIR');
const resultPath = requiredValue('RELAY_PR_PROOF_RESULT_PATH');
const arm = requiredValue('RELAY_PR_PROOF_ARM');
if (arm !== 'base' && arm !== 'head') {
  throw new Error(`RELAY_PR_PROOF_ARM must be base or head, received ${JSON.stringify(arm)}.`);
}
const expectedSha =
  arm === 'base' ? process.env.RELAY_PR_PROOF_BASE_SHA : process.env.RELAY_PR_PROOF_HEAD_SHA;
if (!expectedSha) throw new Error(`Missing expected ${arm} SHA.`);
const targetSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
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
    const requestId = 'model_pr_proof_1658';
    const server = createServer((request, response) => {
      if (request.headers['x-api-key'] !== 'pr-proof-key') {
        response.writeHead(401).end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      if (request.method === 'POST') {
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
    try {
      const receiptOutput = run(
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
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(stateDir, { recursive: true, force: true });
      delete process.env.AGENT_RELAY_STATE_DIR;
    }
  }
  const outcome = hasJson ? 'fixed' : 'bug';
  const signature = hasJson ? 'set_model_exposes_json_receipt' : 'set_model_has_no_json_receipt';
  const details = hasJson
    ? 'The head CLI advertises --json for the correlated model receipt; provider application remains governed by typed runtime confirmation.'
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
