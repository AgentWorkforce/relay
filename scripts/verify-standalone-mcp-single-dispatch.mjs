#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const binary = process.argv[2];
if (!binary) {
  process.stderr.write('Usage: verify-standalone-mcp-single-dispatch.mjs <cli-binary>\n');
  process.exit(2);
}

const STARTUP_TIMEOUT_MS = 60_000;
const RESPONSE_TIMEOUT_MS = 15_000;
const DUPLICATE_GRACE_MS = 1_000;
const SHUTDOWN_GRACE_MS = 2_000;
const DIAGNOSTIC_BYTES = 8_000;
const DIAGNOSTIC_OUTPUT_BYTES = 2_000;
const initializeId = 'single-dispatch-initialize';
const probeId = 'single-dispatch-probe';

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-mcp-dispatch-'));
const env = { ...process.env };
for (const key of [
  'RELAY_WORKSPACES_JSON',
  'RELAY_WORKSPACE_KEY',
  'AGENT_RELAY_WORKSPACE_KEY',
  'RELAY_API_KEY',
  'RELAY_AGENT_TOKEN',
  'RELAY_AGENT_NAME',
]) {
  delete env[key];
}
Object.assign(env, {
  HOME: isolatedHome,
  AGENT_RELAY_SKIP_UPDATE_CHECK: '1',
  AGENT_RELAY_TELEMETRY_DISABLED: '1',
});

const child = spawn(binary, ['mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
const responseCounts = new Map();
const responses = new Map();
const waiters = new Set();
let stdoutBuffer = '';
let stdoutDiagnostic = '';
let stderrDiagnostic = '';
let startupError;
let stdinError;
let exitResult;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const boundedAppend = (current, chunk) => `${current}${chunk}`.slice(-DIAGNOSTIC_BYTES);
const notifyWaiters = () => {
  for (const waiter of [...waiters]) waiter();
};

const spawned = new Promise((resolve, reject) => {
  child.once('spawn', resolve);
  child.once('error', reject);
});
const exited = new Promise((resolve) => {
  child.once('exit', (code, signal) => {
    exitResult = { code, signal };
    notifyWaiters();
    resolve(exitResult);
  });
});

child.on('error', (error) => {
  startupError = error;
  notifyWaiters();
});
child.stdin.on('error', (error) => {
  stdinError = error;
  notifyWaiters();
});
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdoutDiagnostic = boundedAppend(stdoutDiagnostic, chunk);
  stdoutBuffer += chunk;
  let newline;
  while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
    const line = stdoutBuffer.slice(0, newline).trim();
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (!line) continue;
    try {
      const message = JSON.parse(line);
      if (message.id === initializeId || message.id === probeId) {
        responseCounts.set(message.id, (responseCounts.get(message.id) ?? 0) + 1);
        responses.set(message.id, message);
        notifyWaiters();
      }
    } catch {
      // Retain bounded raw output for the redacted failure diagnostic.
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderrDiagnostic = boundedAppend(stderrDiagnostic, chunk);
});

async function withTimeout(promise, milliseconds, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function waitForResponse(id, milliseconds) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out after ${milliseconds} ms waiting for MCP response ${id}.`));
    }, milliseconds);
    const check = () => {
      if ((responseCounts.get(id) ?? 0) >= 1) {
        cleanup();
        resolve();
      } else if (startupError) {
        cleanup();
        reject(startupError);
      } else if (stdinError) {
        cleanup();
        reject(stdinError);
      } else if (exitResult) {
        cleanup();
        reject(
          new Error(
            `MCP child exited before response ${id} (code ${exitResult.code}, signal ${exitResult.signal}).`
          )
        );
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      waiters.delete(check);
    };
    waiters.add(check);
    check();
  });
}

function send(message) {
  return new Promise((resolve, reject) => {
    child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function stopChild() {
  if (exitResult || startupError) return true;
  child.kill('SIGTERM');
  if (await Promise.race([exited.then(() => true), delay(SHUTDOWN_GRACE_MS).then(() => false)])) {
    return true;
  }
  child.kill('SIGKILL');
  if (await Promise.race([exited.then(() => true), delay(SHUTDOWN_GRACE_MS).then(() => false)])) {
    return true;
  }
  // Do not let inherited stdio keep the verifier alive if the OS never reports
  // the forced exit. The failure below still makes the publish gate red.
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();
  return false;
}

function safeDiagnostic(value) {
  return value
    .replace(/\b(?:at|rk)_[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(
      /("(?:token|workspace_?key|api_?key|authorization|credential|secret)"\s*:\s*")[^"]+/gi,
      '$1[REDACTED]'
    )
    .slice(-DIAGNOSTIC_OUTPUT_BYTES);
}

let failure;
try {
  await withTimeout(
    spawned,
    STARTUP_TIMEOUT_MS,
    `Timed out after ${STARTUP_TIMEOUT_MS} ms starting MCP child.`
  );
  await send({
    jsonrpc: '2.0',
    id: initializeId,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'standalone-single-dispatch-check', version: '1' },
    },
  });
  // The initialize response is the readiness signal. Stdin buffers the request
  // while optional Cloud discovery runs, so cold startup has no timing race.
  await waitForResponse(initializeId, STARTUP_TIMEOUT_MS);
  await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await send({ jsonrpc: '2.0', id: probeId, method: 'tools/list', params: {} });
  await waitForResponse(probeId, RESPONSE_TIMEOUT_MS);
  // Two folded stdio servers answer the same request nearly together. Keep a
  // bounded grace window after the protocol-driven response to observe both.
  await delay(DUPLICATE_GRACE_MS);

  for (const id of [initializeId, probeId]) {
    const count = responseCounts.get(id) ?? 0;
    if (count !== 1) throw new Error(`Expected one MCP response for ${id}, received ${count}.`);
    if (responses.get(id)?.error) throw new Error(`MCP response ${id} returned an error.`);
  }
} catch (error) {
  failure = error;
} finally {
  const stopped = await stopChild();
  fs.rmSync(isolatedHome, { recursive: true, force: true });
  if (!stopped && !failure)
    failure = new Error('MCP child did not exit after SIGTERM and SIGKILL deadlines.');
}

if (failure) {
  const message = safeDiagnostic(failure instanceof Error ? failure.message : String(failure));
  const stdout = safeDiagnostic(stdoutDiagnostic);
  const stderr = safeDiagnostic(stderrDiagnostic);
  process.stderr.write(
    `Standalone MCP single-dispatch verification failed: ${message}` +
      (stdout ? `\nMCP stdout (redacted, bounded):\n${stdout}` : '') +
      (stderr ? `\nMCP stderr (redacted, bounded):\n${stderr}` : '') +
      '\n'
  );
  process.exit(1);
}

process.stdout.write('Standalone MCP single-dispatch verification passed.\n');
