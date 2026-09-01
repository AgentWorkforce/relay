import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CASE_ID = '1631-mcp-register-timeout';
const HEALTHY_RESPONSE_DELAY_MS = 12_000;
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
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
  const { port, stderr } = await waitForServerReady(server);
  const cargoPath = ensureCargo(probeDir);

  run(
    cargoPath,
    ['build', '--locked', '-p', 'agent-relay-broker', '--bin', 'agent-relay-broker'],
    targetDir,
    'broker build'
  );

  const binaryPath = path.join(targetDir, 'target', 'debug', 'agent-relay-broker');
  const startedAt = Date.now();
  const completed = spawnSync(
    binaryPath,
    [
      'mcp-args',
      '--register',
      '--cli',
      'codex',
      '--agent-name',
      'relayflow-slow-agent',
      '--api-key',
      'rk_relayflow_timeout_probe',
      '--base-url',
      `http://127.0.0.1:${port}`,
      '--cwd',
      targetDir,
    ],
    {
      cwd: targetDir,
      encoding: 'utf8',
      timeout: 45_000,
      env: process.env,
    }
  );
  const elapsedMs = Date.now() - startedAt;
  const stdout = completed.stdout ?? '';
  const commandStderr = completed.stderr ?? '';

  if (completed.error) {
    throw new Error(`compiled mcp-args probe could not complete: ${completed.error.message}`);
  }

  const baseObserved =
    completed.status !== 0 &&
    commandStderr.includes('register timed out after 10s') &&
    elapsedMs >= 9_000 &&
    elapsedMs < 20_000;

  let parsedOutput;
  if (completed.status === 0) {
    try {
      parsedOutput = JSON.parse(stdout);
    } catch (error) {
      throw new Error(`compiled mcp-args emitted invalid JSON: ${error.message}`);
    }
  }
  const headObserved =
    completed.status === 0 &&
    parsedOutput?.agentToken === 'at_relayflow_slow_healthy' &&
    elapsedMs >= HEALTHY_RESPONSE_DELAY_MS &&
    elapsedMs < 30_000;

  let outcome;
  let signature;
  let details;
  if (baseObserved) {
    outcome = 'bug';
    signature = 'mcp_register_times_out_before_slow_healthy_response';
    details = `The compiled base broker rejected a healthy ${HEALTHY_RESPONSE_DELAY_MS}ms Relaycast response after ${elapsedMs}ms at its 10-second bound.`;
  } else if (headObserved) {
    outcome = 'fixed';
    signature = 'mcp_register_accepts_slow_healthy_response';
    details = `The compiled head broker accepted the healthy ${HEALTHY_RESPONSE_DELAY_MS}ms Relaycast response in ${elapsedMs}ms and returned its agent token.`;
  } else {
    throw new Error(
      `Unexpected compiled registration observation: ${JSON.stringify({
        arm,
        status: completed.status,
        signal: completed.signal,
        elapsedMs,
        stdout: stdout.slice(-2_000),
        stderr: `${stderr}${commandStderr}`.slice(-2_000),
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

function run(command, args, cwd, label) {
  const completed = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (completed.error) throw new Error(`${label} could not start: ${completed.error.message}`);
  if (completed.status !== 0) {
    throw new Error(
      `${label} failed with ${
        completed.signal ? `signal ${completed.signal}` : `exit code ${completed.status ?? 'unknown'}`
      }.`
    );
  }
}

function ensureCargo(workingDirectory) {
  const available = spawnSync('cargo', ['--version'], {
    cwd: workingDirectory,
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (!available.error && available.status === 0) return 'cargo';

  const home = process.env.HOME?.trim();
  if (!home) throw new Error('Cannot install the proof toolchain without HOME.');
  const installerPath = path.join(workingDirectory, 'rustup-init.sh');
  run(
    'curl',
    [
      '--proto',
      '=https',
      '--tlsv1.2',
      '--silent',
      '--show-error',
      '--fail',
      '--output',
      installerPath,
      'https://sh.rustup.rs',
    ],
    workingDirectory,
    'official rustup installer download'
  );
  run(
    'sh',
    [installerPath, '-y', '--profile', 'minimal', '--default-toolchain', 'stable', '--no-modify-path'],
    workingDirectory,
    'minimal Rust toolchain installation'
  );

  const installedCargo = path.join(home, '.cargo', 'bin', 'cargo');
  const verified = spawnSync(installedCargo, ['--version'], {
    cwd: workingDirectory,
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (verified.error || verified.status !== 0) {
    throw new Error(
      `installed Cargo is unavailable: ${verified.error?.message ?? verified.stderr ?? verified.status}`
    );
  }
  return installedCargo;
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
