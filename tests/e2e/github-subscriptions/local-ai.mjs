// Isolated real Claude or Codex + candidate broker/engine; synthetic signed provider events.
// This cannot satisfy the intended-environment real GitHub or chief gates.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHmac, createHash, randomBytes } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
  openSync,
  closeSync,
  fstatSync,
  constants,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { codexReceiverArgs, codexMcpArgs, sessionFiles, auditOwnedCodexSession } from './codex-proof.mjs';
const receiverCli = process.env.LOCAL_AI_CLI ?? 'claude';
assert(['claude', 'codex'].includes(receiverCli), 'LOCAL_AI_CLI must be claude or codex');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const engineDir = process.env.RELAYCAST_ENGINE_DIR;
const binaryPath = process.env.BROKER_BINARY_PATH;
if (!engineDir || !binaryPath || !process.argv[2])
  throw new Error('Set RELAYCAST_ENGINE_DIR and BROKER_BINARY_PATH, and pass an output directory');
const output = path.resolve(process.argv[2]);
if (existsSync(path.join(output, 'report.json')))
  throw new Error('Use a fresh output directory; prior evidence must remain intact');
mkdirSync(output, { recursive: true });
const { HarnessDriverClient } = await import(root + '/packages/harness-driver/dist/index.js');
const { receiverTask, digest, claudeReceiverArgs } = await import(
  root + '/tests/e2e/github-subscriptions/proof.mjs'
);
const { startServer } = await import(
  path.join(path.resolve(engineDir), 'packages/engine/dist/entrypoints/node.js')
);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = {
  at: new Date().toISOString(),
  environment: `isolated real ${receiverCli}; synthetic signed Relayfile payloads; no GitHub delivery claim`,
  receiverCli,
  ready: false,
  checks: [],
  stimuli: [],
};
let server, client, worker, key, base, aborted;
const name = 'ghsub-local-ai-' + randomBytes(4).toString('hex');
const events = [];
const sockets = new Set();
let nodeConnections = 0;
report.sourceHeads = {};
for (const [name, directory] of [
  ['relay', root],
  ['relaycast', path.resolve(engineDir)],
]) {
  const diff = execFileSync('git', ['diff', 'HEAD'], { cwd: directory });
  writeFileSync(path.join(output, name + '-source.diff'), diff);
  report.sourceHeads[name] = {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim(),
    diffSha256: createHash('sha256').update(diff).digest('hex'),
  };
}
const expectedHead = process.env.LOCAL_AI_EXPECTED_HEAD;
assert(expectedHead, 'Set LOCAL_AI_EXPECTED_HEAD to the committed Relay revision under test');
assert.equal(report.sourceHeads.relay.head, expectedHead, 'Relay HEAD differs from expected revision');
for (const [name, directory] of [
  ['relay', root],
  ['relaycast', path.resolve(engineDir)],
]) {
  assert.equal(
    execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
      cwd: directory,
      encoding: 'utf8',
    }).trim(),
    '',
    `${name} must be clean for reproducible proof`
  );
}
report.scriptSha256 = {};
for (const script of ['local-ai.mjs', 'proof.mjs', 'codex-proof.mjs']) {
  report.scriptSha256[script] = createHash('sha256')
    .update(readFileSync(path.join(root, 'tests/e2e/github-subscriptions', script)))
    .digest('hex');
}
report.expectedHead = expectedHead;
const work = mkdtempSync(path.join(tmpdir(), 'ghsub-local-ai-'));
const codexSessions = path.join(process.env.CODEX_HOME ?? path.join(process.env.HOME, '.codex'), 'sessions');
const codexSessionsBefore = new Set(receiverCli === 'codex' ? sessionFiles(codexSessions) : []);
report.workDir = work;
report.sourceHeads.brokerBinarySha256 = createHash('sha256').update(readFileSync(binaryPath)).digest('hex');
report.runtimeProof = 'candidate broker/CLI and engine builds; synthetic producer only';
report.inputPacingMs = process.env.LOCAL_AI_INJECT_RATE_MS ?? 'default';
report.receiverHistoryTools =
  receiverCli === 'claude'
    ? 'Explicitly disallowed inbox, history, thread/message reads, search, MCP resource reads and WebFetch/WebSearch; actual nonce must arrive via push'
    : 'Relay MCP post_message allowlist; web/apps/multi-agent/code-mode disabled; exact owned-session audit permits only digest shell and post_message calls';
const save = () => writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const note = (text) => {
  report.status = text;
  report.updatedAt = new Date().toISOString();
  save();
  console.log(report.updatedAt + ' ' + text);
};
async function req(route, method = 'GET', body, token = key) {
  const response = await fetch(base + route, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  assert(response.ok, `${method} ${route.split('?')[0]}: HTTP ${response.status}`);
  return (await response.json()).data;
}
async function until(predicate, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (aborted) throw new Error(aborted);
    const value = await predicate();
    if (value) return value;
    await delay(500);
  }
  throw new Error('Timed out: ' + label);
}
async function idle(after) {
  return until(
    () => events.find((e) => e.kind === 'agent_idle' && Date.parse(e.observedAt) > after),
    300000,
    'new harness idle boundary'
  );
}
const messages = () => req('/v1/channels/local-ai-proof/messages?limit=100');
let target, actorId;
async function emit(label) {
  const nonce = randomBytes(16).toString('hex');
  const eventId = 'local-synthetic-' + randomBytes(10).toString('hex');
  const body = JSON.stringify({
    eventId,
    type: 'file.updated',
    provider: 'github',
    providerEventType: 'issue_comment.created',
    resourceRef: 'github:local/fixture#PR1',
    path: '/github/repos/local/fixture/pulls/1/meta.json',
    revision: eventId,
    timestamp: new Date().toISOString(),
    snapshot: {
      content: JSON.stringify({
        title: 'LOCAL SYNTHETIC FIXTURE',
        body: `GHSUB_EVENT_NONCE=${nonce}`,
        id: 1,
      }),
    },
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', target.secret).update(`${timestamp}.`).update(body).digest('hex');
  const url = new URL(target.url);
  const send = async () => {
    const response = await fetch(base + url.pathname + url.search, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-relay-timestamp': String(timestamp),
        'x-relay-signature': signature,
        'x-relay-event-id': eventId,
      },
      body,
      signal: AbortSignal.timeout(15000),
    });
    const result = (await response.json()).data;
    assert.equal(response.status, 201, 'synthetic signed ingress: ' + JSON.stringify(result));
    return result;
  };
  const stimulus = { label, nonce, eventId, createdAt: new Date().toISOString(), synthetic: true };
  const received = await send();
  stimulus.messageId = String(received.message_id);
  report.stimuli.push(stimulus);
  save();
  return { stimulus, send };
}
async function acted(stimulus) {
  const action = await until(
    async () => {
      const found = (await messages()).filter(
        (m) => m.agent_id === actorId && m.text?.trim() === 'GHSUB_ACK ' + digest(stimulus.nonce)
      );
      assert(found.length <= 1, 'duplicate action for unique nonce');
      return found[0];
    },
    300000,
    'real actor digest response for ' + stimulus.label
  );
  const injected = events.find(
    (e) => e.kind === 'delivery_injected' && String(e.event_id) === stimulus.messageId
  );
  assert(injected, 'missing correlated broker injection for ' + stimulus.label);
  const record = {
    label: stimulus.label,
    ingestId: stimulus.messageId,
    injectedAt: injected.observedAt,
    actionId: action.id,
    actorId,
    actionAt: action.created_at,
    latencyMs: Date.parse(action.created_at) - Date.parse(stimulus.createdAt),
  };
  report.checks.push({ ...record, pass: true });
  save();
  return action;
}
let guard;
try {
  // Run only while the assignment's single disposable AI worker slot is free.
  report.workerLimit = 'One actor; operator must keep independent reviewers stopped during this process';
  server = startServer({
    port: 0,
    dbPath: ':memory:',
    fileDir: path.join(work, 'files'),
    config: { environment: 'test', relayfileInboundSecret: 'isolated-local-fixture-only' },
  });
  if (!server.server.listening) await once(server.server, 'listening');
  base = `http://127.0.0.1:${server.server.address().port}`;
  server.server.on('upgrade', (request, socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    if (new URL(request.url, base).pathname === '/v1/node/ws') nodeConnections++;
  });
  key = (
    await req('/v1/workspaces', 'POST', { name: 'isolated-ghsub-ai-' + randomBytes(4).toString('hex') }, null)
  ).api_key;
  const isolatedEnv = Object.fromEntries(
    Object.keys(process.env)
      .filter((k) => k.startsWith('RELAY_') || k.startsWith('AGENT_RELAY_'))
      .map((k) => [k, ''])
  );
  client = await HarnessDriverClient.spawn({
    binaryPath,
    cwd: work,
    workspaceKey: key,
    brokerName: 'isolated-ghsub-ai',
    binaryArgs: { persist: true, apiPort: 0 },
    onStderr: (line) =>
      appendFileSync(
        path.join(output, 'broker-stderr.log'),
        line.replace(/(?:rk_live_|at_live_|sk-ant-|sk-)[A-Za-z0-9_-]+/g, '[redacted]') + '\n'
      ),
    channels: [],
    env: {
      ...isolatedEnv,
      ...(process.env.LOCAL_AI_INJECT_RATE_MS === undefined
        ? {}
        : { RELAY_INJECT_RATE_MS: process.env.LOCAL_AI_INJECT_RATE_MS }),
      RELAY_AGENT_TYPE: 'system',
      RELAY_AGENT_NAME: 'isolated-ghsub-ai',
      RELAY_BASE_URL: base,
      RELAYCAST_BASE_URL: base,
      CLAUDECODE: '',
      AGENT_RELAY_BROKER_LOG: 'stderr',
      RUST_LOG:
        'relay_broker::wrap=info,relay_broker::pty_worker=info,agent_relay::worker::pty=info,relay_pty::startup_input=debug',
      AGENT_RELAY_MCP_COMMAND: process.execPath + ' ' + root + '/packages/cli/dist/cli/index.js mcp',
    },
    startupTimeoutMs: 30000,
  });
  client.onEvent((event) => {
    if (event.name !== name) return;
    if (
      ![
        'agent_idle',
        'worker_ready',
        'agent_exited',
        'agent_permanently_dead',
        'agent_restarting',
        'delivery_injected',
        'delivery_verified',
        'delivery_failed',
      ].includes(event.kind)
    )
      return;
    const safe = Object.fromEntries(
      ['kind', 'name', 'generation', 'event_id', 'delivery_id', 'verification', 'reason', 'pid', 'seq']
        .filter((k) => event[k] !== undefined)
        .map((k) => [k, event[k]])
    );
    const row = { ...safe, observedAt: new Date().toISOString() };
    events.push(row);
    appendFileSync(path.join(output, 'events.jsonl'), JSON.stringify(row) + '\n');
  });
  client.connectEvents();
  const creator = await req('/v1/agents', 'POST', { name: 'fixture-creator' });
  await req('/v1/channels', 'POST', { name: 'local-ai-proof' }, creator.token);
  target = await req('/v1/integrations/relayfile/inbound-target', 'POST', {
    channel: 'local-ai-proof',
    provider: 'github',
    path_glob: '/github/repos/local/fixture/pulls/1/**',
  });
  const stale = await emit('prejoin-stale');
  const start = Date.now();
  worker = await client.spawnCli({
    name,
    cli: receiverCli,
    channels: ['local-ai-proof'],
    cwd: work,
    args:
      receiverCli === 'claude'
        ? claudeReceiverArgs
        : [
            ...codexReceiverArgs,
            ...codexMcpArgs({
              node: process.execPath,
              cli: root + '/packages/cli/dist/cli/index.js',
              base,
              home: path.join(work, 'mcp-home'),
            }),
            '-c',
            `projects.${JSON.stringify(work)}.trust_level="trusted"`,
            '-c',
            `projects.${JSON.stringify(realpathSync(work))}.trust_level="trusted"`,
          ],
    idleThresholdSecs: 5,
    task:
      receiverTask +
      ' This is an isolated synthetic-event rehearsal. Your only output action is the requested digest message to its incoming channel. Do not read environment/configuration files or change code. Do not ACK this initial task on Relay; wait for pushed events.' +
      (receiverCli === 'codex'
        ? " For each nonce use exec_command with exactly: printf '%s' '<nonce>' | shasum -a 256 (substitute only the 32 hex digits). Use mcp__agent-relay__post_message for the reply. Do not use any other tool, including sleep, inbox, resource reads, or tool orchestration."
        : ''),
  });
  assert.deepEqual(worker.channels, ['local-ai-proof']);
  report.spawnedWorker = { name: worker.name, pid: worker.pid, generation: worker.generation };
  save();
  const ready = await worker.waitForReady(90000);
  report.readyResult = ready;
  save();
  assert.equal(ready.reason, 'ready');
  process.kill(ready.pid, 0);
  const identity = await req('/v1/agents/' + name);
  assert.deepEqual(
    identity.channels.map((c) => c.name),
    ['local-ai-proof']
  );
  actorId = identity.id;
  report.actor = { name, id: actorId, pid: ready.pid, generation: worker.generation };
  note(`Real ${receiverCli} started; awaiting initial idle`);
  await idle(Date.now());
  assert(
    !(await messages()).some((m) => m.agent_id === actorId && m.text?.includes(digest(stale.stimulus.nonce))),
    'replayed stale prejoin event'
  );
  report.checks.push({ label: 'prejoin-stale-not-acted', pass: true });
  for (let index = 1; index <= 2; index++) {
    const sent = await emit('successive-idle-' + index);
    const action = await acted(sent.stimulus);
    const duplicate = await sent.send();
    assert.equal(duplicate.replayed, true);
    assert.equal(String(duplicate.message_id), sent.stimulus.messageId);
    await idle(Date.parse(action.created_at));
    note('Acted on idle event ' + index + ' and returned to idle');
  }
  const longIdleMs = Number(process.env.LOCAL_AI_LONG_IDLE_MS || 600000);
  const longStart = Date.now();
  note('Beginning longer idle interval: ' + longIdleMs + 'ms');
  while (Date.now() - longStart < longIdleMs) {
    await delay(Math.min(30000, longIdleMs - (Date.now() - longStart)));
    note('Long idle elapsed ' + Math.round((Date.now() - longStart) / 1000) + 's');
  }
  const longer = await emit('long-idle');
  const longAction = await acted(longer.stimulus);
  await idle(Date.parse(longAction.created_at));
  report.longIdleMs = Date.now() - longStart;
  note('Long-idle action confirmed; sending unique burst');
  const burst = [];
  for (let i = 0; i < 10; i++) burst.push((await emit('burst-' + i)).stimulus);
  for (const stimulus of burst) await acted(stimulus);
  await idle(Date.parse(report.checks.at(-1).actionAt));
  const history = await messages();
  for (const stimulus of report.stimuli.filter((s) => s.label !== 'prejoin-stale'))
    assert.equal(
      history.filter(
        (m) => m.agent_id === actorId && m.text?.trim() === 'GHSUB_ACK ' + digest(stimulus.nonce)
      ).length,
      1,
      'exactly one action per unique event'
    );
  assert(
    !history.some(
      (m) => m.agent_id === actorId && m.text?.trim() === 'GHSUB_ACK ' + digest(stale.stimulus.nonce)
    )
  );
  // Force only this fixture's actual engine WebSocket connections closed.
  const previousNodeConnections = nodeConnections;
  const disconnectedAt = new Date().toISOString();
  assert(previousNodeConnections > 0, 'no observed real node-control connection');
  for (const socket of [...sockets]) socket.destroy();
  await until(() => nodeConnections > previousNodeConnections, 30000, 'actual broker node-control reconnect');
  const current = await req('/v1/agents/' + name);
  assert.equal(current.id, actorId);
  assert.deepEqual(
    current.channels.map((c) => c.name),
    ['local-ai-proof']
  );
  process.kill(ready.pid, 0);
  const reconnected = await emit('after-node-reconnect');
  await acted(reconnected.stimulus);
  await idle(Date.parse(report.checks.at(-1).actionAt));
  report.reconnect = {
    disconnectedAt,
    nodeConnectionsBefore: previousNodeConnections,
    nodeConnectionsAfter: nodeConnections,
    sameActorId: current.id,
    samePid: ready.pid,
  };
  report.pass = true;
  note('Isolated real-AI synthetic-ingress proof passed; no real GitHub or chief gate claimed');
} catch (error) {
  report.pass = false;
  report.error = String(error.message).replace(/(?:rk_live_|at_live_)[A-Za-z0-9_-]+/g, '[redacted]');
  note('Isolated AI proof failed: ' + report.error);
  process.exitCode = 1;
} finally {
  clearInterval(guard);
  if (server && key) {
    try {
      writeFileSync(path.join(output, 'messages.json'), JSON.stringify(await messages(), null, 2) + '\n');
    } catch {}
  }
  // Inspect only this disposable provider session's tool names, not credential files.
  const projectName = path.resolve(work).replace(/[^A-Za-z0-9]/g, '-');
  const canonicalName = realpathSync(work).replace(/[^A-Za-z0-9]/g, '-');
  const calls = [];
  for (const name of receiverCli === 'claude' ? new Set([projectName, canonicalName]) : []) {
    const dir = path.join(process.env.HOME, '.claude', 'projects', name);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
      for (const line of readFileSync(path.join(dir, f), 'utf8').split('\n')) {
        try {
          const r = JSON.parse(line);
          for (const item of r.message?.content ?? []) {
            if (item.type === 'tool_use') {
              const command = item.name === 'Bash' ? String(item.input?.command ?? '') : undefined;
              calls.push({
                at: r.timestamp,
                name: item.name,
                ...(command
                  ? {
                      commandSha256: createHash('sha256').update(command).digest('hex'),
                      digestComputation: /shasum|sha256sum|hashlib|createHash/.test(command),
                      networkCommand: /\b(curl|wget|fetch|urllib|httpx|requests)\b|https?:\/\//.test(command),
                    }
                  : {}),
              });
            }
          }
        } catch {}
      }
    }
  }
  if (receiverCli === 'codex') {
    try {
      report.codexToolAudit = await auditOwnedCodexSession({
        directory: codexSessions,
        before: codexSessionsBefore,
        cwd: work,
        startedAt: report.at,
      });
      calls.push(...report.codexToolAudit.calls);
      if (!report.codexToolAudit.pass)
        throw new Error('Codex tool audit rejected missing or unexpected tool use');
    } catch (error) {
      report.receiverToolAuditError = error.message;
      report.pass = false;
      process.exitCode = 1;
    }
  }
  report.receiverToolCalls = calls;
  if (
    !calls.length ||
    calls.some(
      (c) =>
        /check_inbox|list_messages|get_message|get_thread|search_messages|McpResource|WebFetch|WebSearch/.test(
          c.name
        ) ||
        c.networkCommand ||
        (c.name === 'Bash' && !c.digestComputation)
    )
  ) {
    report.receiverToolAuditError =
      'Missing tool-call evidence or receiver performed an inadmissible read/network/non-digest command';
    report.pass = false;
    process.exitCode = 1;
  }
  writeFileSync(path.join(output, 'receiver-tool-calls.json'), JSON.stringify(calls, null, 2) + '\n');
  if (worker)
    await worker.release('owned local AI fixture cleanup', { deleteIdentity: true }).catch((error) => {
      report.cleanupError = error.message;
      report.pass = false;
      process.exitCode = 1;
    });
  if (client)
    await client.shutdown().catch((error) => {
      report.brokerCleanupError = error.message;
      report.pass = false;
      process.exitCode = 1;
    });
  if (server) await server.stop();
  // Retain only sanitized evidence; the temporary broker/MCP configuration carries local test credentials.
  const diagnostic = [];
  try {
    // Read only this owned actor's log. Open without following a final symlink,
    // then inspect and read the same descriptor, avoiding a stat/path-read race.
    const full = path.join(work, '.agentworkforce', 'relay', 'team', 'worker-logs', `${name}.log`);
    const descriptor = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      assert(fstatSync(descriptor).isFile(), 'Owned actor diagnostic must be a regular file');
      diagnostic.push({
        file: path.relative(work, full),
        tail: readFileSync(descriptor, 'utf8')
          .slice(-12000)
          .replace(/(?:rk_live_|at_live_|nt_live_|sk-ant-|sk-)[A-Za-z0-9_-]+/g, '[redacted]'),
      });
    } finally {
      closeSync(descriptor);
    }
    writeFileSync(path.join(output, 'diagnostics.json'), JSON.stringify(diagnostic, null, 2) + '\n');
  } catch (error) {
    report.diagnosticError = error.message;
  }
  rmSync(work, { recursive: true, force: true });
  save();
}
