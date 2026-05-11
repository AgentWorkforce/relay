import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'vitest';

import { AgentRelayClient } from '../client.js';

const BROKER_STDIO_DRAIN_TIMEOUT_MS = 5_000;
// Spawning Node + binding an HTTP server inside a Vitest worker can take
// several seconds on cold machines; give startup generous headroom so the
// drain assertion (not startup latency) is what's being measured.
const BROKER_STARTUP_TIMEOUT_MS = 30_000;
// Test timeout must cover startup + drain wait + cleanup with margin.
const TEST_TIMEOUT_MS = 60_000;

function fakeBrokerSource(stream: 'stdout' | 'stderr'): string {
  return [
    "const http = require('node:http');",
    'const server = http.createServer((req, res) => {',
    "  if (req.url === '/api/session') {",
    "    res.writeHead(200, { 'content-type': 'application/json' });",
    "    res.end(JSON.stringify({ workspace_key: 'wk_fake', mode: 'test', uptime_secs: 0 }));",
    '    return;',
    '  }',
    "  if (req.url === '/api/session/renew' || req.url === '/api/shutdown') {",
    "    res.writeHead(200, { 'content-type': 'application/json' });",
    '    res.end(JSON.stringify({ ok: true }));',
    '    return;',
    '  }',
    "  res.writeHead(404, { 'content-type': 'application/json' });",
    "  res.end(JSON.stringify({ error: 'not found' }));",
    '});',
    "server.listen(0, '127.0.0.1', () => {",
    '  const address = server.address();',
    // Startup URL always goes to stdout so the SDK can parse it.
    '  console.log(`[agent-relay] API listening on http://127.0.0.1:${address.port}`);',
    `  const sink = process.${stream};`,
    '  let index = 0;',
    "  const chunk = 'x'.repeat(1024);",
    '  const writeMore = () => {',
    '    let ok = true;',
    '    while (index < 20000 && ok) {',
    '      ok = sink.write(`event-${index}:${chunk}\\n`);',
    '      index += 1;',
    '    }',
    '    if (index >= 20000) {',
    '      setTimeout(() => process.exit(0), 25);',
    '      return;',
    '    }',
    "    sink.once('drain', writeMore);",
    '  };',
    '  writeMore();',
    '});',
    '',
  ].join('\n');
}

async function runFakeBrokerAndAssertDrains(stream: 'stdout' | 'stderr'): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), `agent-relay-sdk-${stream}-drain-`));

  try {
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, 'init'), fakeBrokerSource(stream), 'utf8');

    const client = await AgentRelayClient.spawn({
      binaryPath: process.execPath,
      cwd,
      startupTimeoutMs: BROKER_STARTUP_TIMEOUT_MS,
      requestTimeoutMs: 3_000,
    });

    const child = client.child;
    assert.ok(child, 'spawned client should retain broker child process');
    const outcome =
      child.exitCode !== null
        ? 'exited'
        : await Promise.race([
            new Promise<'exited'>((resolve) => child.once('exit', () => resolve('exited'))),
            sleep(BROKER_STDIO_DRAIN_TIMEOUT_MS).then(() => 'blocked' as const),
          ]);

    client.disconnect();
    if (outcome !== 'exited') {
      child.kill('SIGKILL');
    }

    assert.equal(outcome, 'exited');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test(
  'spawn drains broker stdout after startup so event floods cannot wedge the broker',
  async () => {
    await runFakeBrokerAndAssertDrains('stdout');
  },
  TEST_TIMEOUT_MS
);

test(
  'spawn drains broker stderr after startup so tracing/log floods cannot wedge the broker',
  async () => {
    // The Rust broker routes `tracing` output to stderr (rule: rust.md). Under
    // heavy fanout stderr fills its kernel pipe (~64KB on macOS) and blocks
    // the broker process exactly like stdout did before the existing drain.
    await runFakeBrokerAndAssertDrains('stderr');
  },
  TEST_TIMEOUT_MS
);
