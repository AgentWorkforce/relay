import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1631-mcp-register-timeout';
const HEALTHY_RESPONSE_DELAY_MS = 12_000;
const targetDir = requiredDirectory('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = requiredDirectory('RELAY_PR_PROOF_HARNESS_DIR');
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

const probeDir = await mkdtemp(path.join(tmpdir(), 'relayflow-1631-'));
const serverPath = path.join(probeDir, 'slow-relaycast.mjs');
const serverSource = String.raw`import http from 'node:http';

const delayMs = Number(process.argv[2]);
const server = http.createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/agents') {
    response.writeHead(404).end();
    return;
  }
  request.resume();
  request.once('end', () => {
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        ok: true,
        data: {
          id: 'agent_relayflow_slow',
          workspace_id: 'ws_relayflow_slow',
          name: 'relayflow-slow-agent',
          token: 'at_relayflow_slow_healthy',
          status: 'online',
          created_at: '2026-09-01T00:00:00.000Z'
        }
      }));
    }, delayMs);
  });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address.');
  process.stdout.write(JSON.stringify({ port: address.port }) + '\n');
});

process.once('SIGTERM', () => server.close(() => process.exit(0)));
`;

let server;
try {
  await writeFile(serverPath, serverSource, { encoding: 'utf8', mode: 0o600 });
  server = spawn(process.execPath, [serverPath, String(HEALTHY_RESPONSE_DELAY_MS)], {
    cwd: probeDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const { port } = await waitForServerReady(server);
  const brokerSource = await readFile(
    path.join(targetDir, 'crates', 'broker', 'src', 'cli_mcp_args.rs'),
    'utf8'
  );
  const timeoutSeconds = extractProductionTimeoutSeconds(brokerSource);
  const startedAt = Date.now();
  let responsePayload;
  let requestError;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'relayflow-slow-agent', cli: 'codex' }),
      signal: AbortSignal.timeout(timeoutSeconds * 1_000),
    });
    responsePayload = await response.json();
  } catch (error) {
    requestError = error;
  }
  const elapsedMs = Date.now() - startedAt;

  const baseObserved =
    timeoutSeconds === 10 &&
    (requestError?.name === 'TimeoutError' || requestError?.name === 'AbortError') &&
    elapsedMs >= 9_000 &&
    elapsedMs < 20_000;
  const headObserved =
    timeoutSeconds === 30 &&
    !requestError &&
    responsePayload?.data?.token === 'at_relayflow_slow_healthy' &&
    elapsedMs >= HEALTHY_RESPONSE_DELAY_MS &&
    elapsedMs < 30_000;

  let outcome;
  let signature;
  let details;
  if (baseObserved) {
    outcome = 'bug';
    signature = 'mcp_register_times_out_before_slow_healthy_response';
    details = `The exact base Rust wiring selected a 10-second registration bound, which rejected the healthy ${HEALTHY_RESPONSE_DELAY_MS}ms Relaycast response after ${elapsedMs}ms.`;
  } else if (headObserved) {
    outcome = 'fixed';
    signature = 'mcp_register_accepts_slow_healthy_response';
    details = `The exact head Rust wiring selected a 30-second registration bound, which accepted the healthy ${HEALTHY_RESPONSE_DELAY_MS}ms Relaycast response in ${elapsedMs}ms and returned its agent token.`;
  } else {
    throw new Error(
      `Unexpected registration-bound observation: ${JSON.stringify({
        arm,
        timeoutSeconds,
        elapsedMs,
        responsePayload,
        requestError: requestError ? { name: requestError.name, message: requestError.message } : undefined,
      })}.`
    );
  }

  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`,
    'utf8'
  );
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => server.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  await rm(probeDir, { recursive: true, force: true });
}

function requiredValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

function requiredDirectory(name) {
  return path.resolve(requiredValue(name));
}

function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function extractProductionTimeoutSeconds(source) {
  const namedBound = source.match(
    /const MCP_ARGS_REGISTER_TIMEOUT:\s*Duration\s*=\s*Duration::from_secs\((\d+)\);/
  );
  if (namedBound) {
    if (
      !/register_agent_token_for_mcp_args_with_timeout\([\s\S]{0,500}?MCP_ARGS_REGISTER_TIMEOUT/.test(
        source
      ) ||
      !/tokio::time::timeout\(\s*timeout,\s*client\.register_agent_token/.test(source)
    ) {
      throw new Error('The named registration timeout is not wired into the Relaycast request.');
    }
    return checkedTimeoutSeconds(namedBound[1]);
  }

  const inlineBound = source.match(
    /tokio::time::timeout\(\s*Duration::from_secs\((\d+)\),\s*client\.register_agent_token/
  );
  if (!inlineBound) {
    throw new Error('Could not resolve the production mcp-args registration timeout wiring.');
  }
  return checkedTimeoutSeconds(inlineBound[1]);
}

function checkedTimeoutSeconds(raw) {
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 120) {
    throw new Error(`Registration timeout is outside the proof range: ${JSON.stringify(raw)}.`);
  }
  return seconds;
}

function waitForServerReady(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error('slow Relaycast probe server did not start')), 10_000);

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      try {
        const ready = JSON.parse(stdout.slice(0, newline));
        if (!Number.isInteger(ready.port) || ready.port <= 0) {
          throw new Error(`invalid port ${JSON.stringify(ready.port)}`);
        }
        resolve({ port: ready.port, stderr });
      } catch (error) {
        reject(new Error(`slow Relaycast probe server emitted invalid readiness: ${error.message}`));
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(
        new Error(
          `slow Relaycast probe server exited before readiness (${signal ?? code ?? 'unknown'}): ${stderr}`
        )
      );
    });
  });
}
