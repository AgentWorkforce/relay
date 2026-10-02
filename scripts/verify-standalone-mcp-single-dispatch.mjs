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
let stdout = '';
let stderr = '';
let responseCount = 0;

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdout += chunk;
  let newline;
  while ((newline = stdout.indexOf('\n')) >= 0) {
    const line = stdout.slice(0, newline).trim();
    stdout = stdout.slice(newline + 1);
    if (!line) continue;
    try {
      const message = JSON.parse(line);
      if (message.id === 'single-dispatch-probe') responseCount += 1;
    } catch {
      // Preserve non-JSON output for the failure diagnostic below.
      stdout = `${line}\n${stdout}`;
      break;
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
try {
  // Both buggy startup paths perform the optional Cloud discovery first. Give
  // them time to attach to stdin before sending exactly one JSON-RPC request.
  await delay(4_000);
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 'single-dispatch-probe',
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'standalone-single-dispatch-check', version: '1' },
      },
    })}\n`
  );
  await delay(2_000);
} finally {
  child.kill('SIGTERM');
  fs.rmSync(isolatedHome, { recursive: true, force: true });
}

if (responseCount !== 1) {
  const safeStderr = stderr.replace(/(?:at_live_|rk_live_)[A-Za-z0-9_-]+/g, '[REDACTED]');
  process.stderr.write(
    `Expected one MCP response for one request, received ${responseCount}.` +
      (safeStderr ? `\nMCP stderr:\n${safeStderr.slice(0, 2_000)}` : '') +
      '\n'
  );
  process.exit(1);
}

process.stdout.write('Standalone MCP single-dispatch verification passed.\n');
