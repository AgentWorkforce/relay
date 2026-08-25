import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CASE_ID = '1603-raw-spawn-readiness';
const arm = process.env.RELAY_PR_PROOF_ARM;
const targetDir = process.env.RELAY_PR_PROOF_TARGET_DIR;
const resultPath = process.env.RELAY_PR_PROOF_RESULT_PATH;
const childEnv = { ...process.env };
delete childEnv.CODEX_MANAGED_BY_NPM;

assert.ok(arm === 'base' || arm === 'head', 'RELAY_PR_PROOF_ARM must be base or head');
assert.ok(targetDir, 'RELAY_PR_PROOF_TARGET_DIR is required');
assert.ok(resultPath, 'RELAY_PR_PROOF_RESULT_PATH is required');

async function run(command, args, env = childEnv) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: targetDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const append = (chunk) => {
      output = `${output}${chunk}`.slice(-16_000);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed (${code ?? signal}):\n${output}`));
    });
  });
}

await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional'], {
  ...childEnv,
  NODE_OPTIONS: '--max-old-space-size=256',
});
await run('npm', ['run', 'build:core']);

const requests = [];
let invocationReads = 0;
const server = http.createServer(async (request, response) => {
  const bodyChunks = [];
  for await (const chunk of request) bodyChunks.push(chunk);
  const bodyText = Buffer.concat(bodyChunks).toString('utf8');
  const body = bodyText ? JSON.parse(bodyText) : undefined;
  requests.push({ method: request.method, url: request.url, body });

  let data;
  if (request.method === 'POST' && request.url === '/v1/actions/spawn/invoke') {
    data = {
      invocation_id: 'inv_raw_readiness_proof',
      action_name: 'spawn',
      status: 'dispatched',
      input: body?.input,
    };
  } else if (
    request.method === 'GET' &&
    request.url === '/v1/actions/spawn/invocations/inv_raw_readiness_proof'
  ) {
    invocationReads += 1;
    data =
      invocationReads === 1
        ? {
            invocation_id: 'inv_raw_readiness_proof',
            action_name: 'spawn',
            status: 'running',
          }
        : {
            invocation_id: 'inv_raw_readiness_proof',
            action_name: 'spawn',
            status: 'completed',
            output: { spawned: true, ready: true },
          };
  } else {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: request.url } }));
    return;
  }

  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ ok: true, data }));
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

let client;
try {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const clientModule = await import(
    pathToFileURL(path.join(targetDir, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'))
      .href
  );
  const transportModule = await import(
    pathToFileURL(path.join(targetDir, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'))
      .href
  );
  client = new clientModule.Client({ name: 'relayflow-raw-spawn-readiness', version: '1.0.0' });
  const transport = new transportModule.StdioClientTransport({
    command: process.execPath,
    args: [path.join(targetDir, 'packages/cli/dist/cli/index.js'), 'mcp'],
    cwd: targetDir,
    stderr: 'inherit',
    env: {
      ...childEnv,
      RELAY_BASE_URL: `http://127.0.0.1:${address.port}`,
      RELAY_WORKSPACE_KEY: 'rk_live_relayflow_proof',
      RELAY_AGENT_TOKEN: 'at_live_relayflow_proof',
      RELAY_AGENT_NAME: 'relayflow-orchestrator',
      RELAY_SKIP_BOOTSTRAP: '1',
      AGENT_RELAY_TELEMETRY_DISABLED: '1',
    },
  });
  await client.connect(transport);
  const result = await client.callTool({
    name: 'spawn',
    arguments: { name: 'RelayflowRawWorker', cli: 'codex', target_node: 'proof-node' },
  });
  assert.equal(result.isError, undefined, `spawn returned an MCP error: ${JSON.stringify(result)}`);

  const invokeRequests = requests.filter(
    (entry) => entry.method === 'POST' && entry.url === '/v1/actions/spawn/invoke'
  );
  const readRequests = requests.filter(
    (entry) => entry.method === 'GET' && entry.url === '/v1/actions/spawn/invocations/inv_raw_readiness_proof'
  );
  assert.equal(invokeRequests.length, 1, 'spawn must invoke the production actions HTTP path exactly once');
  const actionInput = invokeRequests[0].body?.input;
  assert.equal(actionInput?.cli, 'codex');
  assert.equal(actionInput?.name, 'RelayflowRawWorker');

  if (arm === 'base') {
    assert.equal(actionInput.verify_ready, undefined, 'base unexpectedly requested verified readiness');
    assert.equal(readRequests.length, 0, 'base unexpectedly read the action invocation');
    assert.equal(result.structuredContent?.invocation?.status, 'dispatched');
    await writeFile(
      resultPath,
      `${JSON.stringify({
        version: 1,
        caseId: CASE_ID,
        arm,
        outcome: 'bug',
        signature: 'raw_cli_spawn_returns_dispatch_ack_without_readiness',
        details:
          'The public MCP spawn tool returned the dispatch acknowledgement and never read the action invocation for readiness.',
      })}\n`
    );
  } else {
    assert.equal(actionInput.verify_ready, true, 'head did not request the broker readiness contract');
    assert.equal(readRequests.length, 2, 'head must poll through running to completed readiness');
    assert.equal(result.structuredContent?.invocation?.status, 'completed');
    assert.deepEqual(result.structuredContent?.invocation?.output, { spawned: true, ready: true });
    await writeFile(
      resultPath,
      `${JSON.stringify({
        version: 1,
        caseId: CASE_ID,
        arm,
        outcome: 'fixed',
        signature: 'raw_cli_spawn_waits_for_verified_readiness',
        details:
          'The public MCP spawn tool sent verify_ready, polled the production action invocation path, and returned only the spawned-and-ready completion.',
      })}\n`
    );
  }
} finally {
  await client?.close().catch(() => undefined);
  await new Promise((resolve) => server.close(resolve));
}
