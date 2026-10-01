import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const caseId = '1874-mcp-dm-idempotency';
const required = (name) => {
  if (!process.env[name]) throw new Error(`Missing ${name}`);
  return process.env[name];
};
const targetDir = path.resolve(required('RELAY_PR_PROOF_TARGET_DIR'));
const harnessDir = path.resolve(required('RELAY_PR_PROOF_HARNESS_DIR'));
const resultPath = required('RELAY_PR_PROOF_RESULT_PATH');
const arm = required('RELAY_PR_PROOF_ARM');
if (!['base', 'head'].includes(arm)) throw new Error(`Invalid arm: ${arm}`);
const expectedSha = required(arm === 'base' ? 'RELAY_PR_PROOF_BASE_SHA' : 'RELAY_PR_PROOF_HEAD_SHA');
const actualSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (actualSha !== expectedSha) throw new Error(`Target ${actualSha} differs from expected ${expectedSha}`);
const runnerPath = fileURLToPath(import.meta.url);
const relative = path.relative(harnessDir, runnerPath);
if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
  throw new Error('Runner must execute from the exact-head harness checkout');
}

// Async children leave the event loop free to serve the real SDK's HTTP requests.
async function run(command, args, env = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: targetDir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) => {
        tail = (tail + chunk.toString()).slice(-6000);
      });
    const timer = setTimeout(() => child.kill('SIGKILL'), 600_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${signal ?? code}: ${tail}`));
    });
  });
}

if (!existsSync(path.join(targetDir, 'node_modules/vitest/vitest.mjs'))) {
  await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
}
await run('npm', ['run', 'build:sdk']);
const probeDir = await mkdtemp(path.join(targetDir, '.dm-proof-'));
const rows = [];
const keyed = new Map();
const requests = [];
let serverError;
const server = http.createServer(async (request, response) => {
  try {
    if (request.method !== 'POST' || request.url !== '/v1/dm')
      throw new Error(`Unexpected route: ${request.method} ${request.url}`);
    let body = '';
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    if ('idempotencyKey' in parsed || 'idempotency_key' in parsed) throw new Error('Key leaked into body');
    const key = request.headers['idempotency-key'];
    let row = key && keyed.get(key);
    if (!row) {
      row = { id: `msg_${rows.length + 1}`, conversation_id: 'dm_chief' };
      rows.push(row);
      if (key) keyed.set(key, row);
    }
    requests.push({ key, id: row.id });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, data: row }));
  } catch (error) {
    serverError = error;
    response.writeHead(500).end();
  }
});
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const probePath = path.join(probeDir, 'probe.test.mts');
  await copyFile(path.join(path.dirname(runnerPath), 'probe.test.mts'), probePath);
  const configPath = path.join(probeDir, 'vitest.config.mts');
  // Preserve the target's workspace source aliases, overriding only test discovery.
  await writeFile(
    configPath,
    `import config from '../vitest.config.ts';\nexport default { ...config, test: { ...config.test, include: [${JSON.stringify(probePath)}], exclude: [], setupFiles: [] } };\n`
  );
  async function attempt(index, key) {
    const receiptPath = path.join(probeDir, `receipt-${index}.json`);
    await run(
      process.execPath,
      [path.join(targetDir, 'node_modules/vitest/vitest.mjs'), 'run', '--config', configPath],
      {
        RELAY_PR_PROOF_TARGET_DIR: targetDir,
        RELAY_ATTEST_SESSION_ID: '11111111-1111-4111-8111-111111111111',
        DM_PROOF_BASE_URL: `http://127.0.0.1:${server.address().port}`,
        DM_PROOF_KEY: key,
        DM_PROOF_RECEIPT: receiptPath,
      }
    );
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    if (!receipt.id || receipt.conversationId !== 'dm_chief')
      throw new Error(`Invalid receipt: ${JSON.stringify(receipt)}`);
    return receipt;
  }
  const first = await attempt(1, 'logical-dm-proof');
  const retry = await attempt(2, 'logical-dm-proof');
  const keyedRows = rows.length;
  const keyedRequests = requests.slice();
  const unkeyedFirst = await attempt(3, '');
  const unkeyedSecond = await attempt(4, '');
  if (serverError) throw serverError;
  if (rows.length !== keyedRows + 2 || unkeyedFirst.id === unkeyedSecond.id || requests.length !== 4) {
    throw new Error(`Unexpected unkeyed observations: ${JSON.stringify({ rows, requests })}`);
  }
  const receiptsMatchRows = first.id === keyedRequests[0]?.id && retry.id === keyedRequests[1]?.id;
  const bug = keyedRows === 2 && first.id !== retry.id;
  const fixed =
    keyedRows === 1 && first.id === retry.id && keyedRequests.every(({ key }) => key === 'logical-dm-proof');
  if (!receiptsMatchRows || (!bug && !fixed))
    throw new Error(`Unexpected keyed observations: ${JSON.stringify({ rows, first, retry, requests })}`);
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    JSON.stringify({
      version: 1,
      caseId,
      arm,
      outcome: fixed ? 'fixed' : 'bug',
      signature: fixed ? 'mcp_retry_reuses_one_direct_message' : 'mcp_retry_creates_two_direct_messages',
      details: `Fresh processes created ${keyedRows} keyed row(s); receipt IDs ${first.id}, ${retry.id}; conversation ${first.conversationId}. Two unkeyed sends created two more rows. Local HTTP service models upstream idempotency; recipient injection is not exercised.`,
    }) + '\n'
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(probeDir, { recursive: true, force: true });
}
