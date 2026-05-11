import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'vitest';

import { AgentRelayClient } from '../client.js';

const BROKER_STDOUT_DRAIN_TIMEOUT_MS = 5_000;

test('spawn drains broker stdout after startup so event floods cannot wedge the broker', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-relay-sdk-stdout-drain-'));

  try {
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(cwd, 'init'),
      [
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
        '  console.log(`[agent-relay] API listening on http://127.0.0.1:${address.port}`);',
        '  let index = 0;',
        "  const chunk = 'x'.repeat(1024);",
        '  const writeMore = () => {',
        '    let ok = true;',
        '    while (index < 20000 && ok) {',
        '      ok = process.stdout.write(`event-${index}:${chunk}\\n`);',
        '      index += 1;',
        '    }',
        '    if (index >= 20000) {',
        '      setTimeout(() => process.exit(0), 25);',
        '      return;',
        '    }',
        "    process.stdout.once('drain', writeMore);",
        '  };',
        '  writeMore();',
        '});',
        '',
      ].join('\n'),
      'utf8'
    );

    const client = await AgentRelayClient.spawn({
      binaryPath: process.execPath,
      cwd,
      startupTimeoutMs: 3_000,
      requestTimeoutMs: 3_000,
    });

    const child = client.child;
    assert.ok(child, 'spawned client should retain broker child process');
    const outcome =
      child.exitCode !== null
        ? 'exited'
        : await Promise.race([
            new Promise<'exited'>((resolve) => child.once('exit', () => resolve('exited'))),
            sleep(BROKER_STDOUT_DRAIN_TIMEOUT_MS).then(() => 'blocked' as const),
          ]);

    client.disconnect();
    if (outcome !== 'exited') {
      child.kill('SIGKILL');
    }

    assert.equal(outcome, 'exited');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
