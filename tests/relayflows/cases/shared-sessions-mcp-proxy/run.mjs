#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const CASE_ID = 'shared-sessions-mcp-proxy';
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const TOOL_NAMES = ['search_shared_sessions', 'get_shared_session', 'get_shared_session_context'];

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

await rm(resultPath, { force: true });
const vitestEntry = path.join(targetDir, 'node_modules', 'vitest', 'vitest.mjs');
if (!(await pathExists(vitestEntry))) {
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], targetDir, 'dependency install');
}
// build:core is the repository's dependency-ordered package build. A clean
// npm ci leaves workspace package dist/ directories empty, so building only
// packages/cli would accidentally rely on artifacts from an earlier job.
run('npm', ['run', 'build:core'], targetDir, 'dependency-ordered CLI build');

const cliPath = path.join(targetDir, 'packages/cli/dist/cli/index.js');
const baseEnv = {
  ...process.env,
  AGENT_RELAY_TELEMETRY_DISABLED: '1',
  NO_COLOR: '1',
};
const help = capture(process.execPath, [cliPath, 'mcp', '--help'], targetDir, baseEnv, 'MCP help');

let outcome;
let signature;
let details;
if (!help.includes('--sessions-only')) {
  outcome = 'absent';
  signature = 'shared_sessions_mcp_sessions_only_absent';
  details =
    'The target CLI MCP help has no --sessions-only mode, so an installed shared-sessions plugin cannot start a history-only MCP proxy.';
} else {
  const temporaryHome = await mkdtemp(path.join(tmpdir(), 'relay-pr-proof-shared-sessions-'));
  const requests = [];
  const hosted = http.createServer(async (request, response) => {
    const body = await readRequestBody(request);
    const message = body ? JSON.parse(body) : null;
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization ?? null,
      message,
    });

    // The hosted MCP surface is stateless JSON. The SDK probes GET for an
    // optional SSE channel, which the production route deliberately rejects.
    if (request.method === 'GET') {
      response.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }

    if (!message || message.id === undefined) {
      response.writeHead(202).end();
      return;
    }

    let result;
    if (message.method === 'initialize') {
      result = {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'relayflow-shared-sessions-cloud', version: '1.0.0' },
      };
    } else if (message.method === 'tools/list') {
      result = {
        tools: TOOL_NAMES.map((name) => ({
          name,
          description: `Hosted ${name}`,
          inputSchema: {
            type: 'object',
            properties:
              name === 'search_shared_sessions'
                ? {
                    query: { type: 'string', maxLength: 240 },
                    workspace_id: { type: 'string' },
                  }
                : {
                    session_id: { type: 'string' },
                    workspace_id: { type: 'string' },
                  },
            required: [name === 'search_shared_sessions' ? 'query' : 'session_id'],
          },
        })),
      };
    } else if (message.method === 'tools/call') {
      result = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ proxied: true, params: message.params }),
          },
        ],
      };
    } else {
      throw new Error(`Unexpected hosted MCP method ${message.method}.`);
    }

    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });

  let child;
  try {
    const origin = await listen(hosted);
    child = spawn(process.execPath, [cliPath, 'mcp', '--sessions-only'], {
      cwd: targetDir,
      env: {
        ...baseEnv,
        HOME: temporaryHome,
        CLOUD_API_URL: origin,
        CLOUD_API_ACCESS_TOKEN: 'proof-access-token',
        CLOUD_API_REFRESH_TOKEN: 'proof-refresh-token',
        CLOUD_API_ACCESS_TOKEN_EXPIRES_AT: '2099-01-01T00:00:00.000Z',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const rpc = createJsonRpcQueue(child);

    send(child, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'relayflow-proof', version: '1.0.0' },
      },
    });
    await rpc.waitFor(1, 15_000);
    send(child, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    send(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const listed = await rpc.waitFor(2, 15_000);
    send(child, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'search_shared_sessions',
        arguments: { query: 'incident', workspace_id: 'workspace-proof' },
      },
    });
    const called = await rpc.waitFor(3, 15_000);

    const listedNames = listed.result?.tools?.map((tool) => tool.name);
    const callText = called.result?.content?.find((item) => item.type === 'text')?.text ?? '';
    const hostedCall = requests.find((entry) => entry.message?.method === 'tools/call');
    const posted = requests.filter((entry) => entry.method === 'POST');
    const validRequests =
      posted.length >= 4 &&
      requests.every(
        (entry) =>
          (entry.method === 'POST' || entry.method === 'GET') &&
          entry.url === '/api/v1/mcp/shared-sessions' &&
          entry.authorization === 'Bearer proof-access-token'
      ) &&
      requests.filter((entry) => entry.method === 'GET').length <= 1;
    const fixed =
      JSON.stringify(listedNames) === JSON.stringify(TOOL_NAMES) &&
      callText.includes('"proxied":true') &&
      hostedCall?.message?.params?.name === 'search_shared_sessions' &&
      hostedCall?.message?.params?.arguments?.query === 'incident' &&
      hostedCall?.message?.params?.arguments?.workspace_id === 'workspace-proof' &&
      validRequests;
    if (!fixed) {
      throw new Error(
        `Unexpected sessions-only MCP observation: ${JSON.stringify({ listedNames, callText, requests })}`
      );
    }

    outcome = 'fixed';
    signature = 'shared_sessions_mcp_sessions_only_proxies_cloud_tools';
    details =
      'The public CLI started --sessions-only with env-backed noninteractive Cloud auth, exposed exactly the three hosted shared-session tools over stdio, forwarded workspace_id through the stateless JSON MCP endpoint with its bearer, and required no Relaycast registration.';
  } finally {
    child?.kill('SIGKILL');
    hosted.closeAllConnections();
    await new Promise((resolve) => hosted.close(resolve));
    await rm(temporaryHome, { recursive: true, force: true });
  }
}

await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(
  resultPath,
  `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`,
  'utf8'
);

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

async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, cwd, label) {
  const completed = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (completed.error) throw new Error(`${label} could not start: ${completed.error.message}`);
  if (completed.status !== 0) {
    throw new Error(
      `${label} failed with ${completed.signal ? `signal ${completed.signal}` : `exit code ${completed.status ?? 'unknown'}`}.`
    );
  }
}

function capture(command, args, cwd, env, label) {
  const completed = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (completed.error) throw new Error(`${label} could not start: ${completed.error.message}`);
  if (completed.status !== 0) {
    throw new Error(`${label} failed: ${(completed.stderr ?? '').slice(-2_000)}`);
  }
  return `${completed.stdout ?? ''}${completed.stderr ?? ''}`;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Missing server address.'));
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.once('end', () => resolve(body));
    request.once('error', reject);
  });
}

function send(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function createJsonRpcQueue(child) {
  const messages = [];
  const waiters = new Set();
  let failure;
  const stderr = [];
  child.stderr.on('data', (chunk) => {
    stderr.push(String(chunk));
    if (stderr.join('').length > 8_000) stderr.shift();
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      messages.push(JSON.parse(line));
    } catch (error) {
      failure = new Error(`CLI emitted invalid JSON-RPC: ${error.message}; line=${line.slice(0, 2_000)}`);
    }
    for (const wake of waiters) wake();
  });
  child.once('exit', (code, signal) => {
    failure = new Error(
      `CLI exited before proof completed (${signal ?? code ?? 'unknown'}): ${stderr.join('').slice(-8_000)}`
    );
    for (const wake of waiters) wake();
  });

  return {
    async waitFor(id, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (failure) throw failure;
        const index = messages.findIndex((message) => message.id === id);
        if (index >= 0) return messages.splice(index, 1)[0];
        await new Promise((resolve) => {
          const timeout = setTimeout(
            () => {
              waiters.delete(wake);
              resolve();
            },
            Math.min(100, Math.max(1, deadline - Date.now()))
          );
          const wake = () => {
            clearTimeout(timeout);
            waiters.delete(wake);
            resolve();
          };
          waiters.add(wake);
        });
      }
      throw new Error(`Timed out waiting for JSON-RPC response ${id}: ${stderr.join('').slice(-8_000)}`);
    },
  };
}
