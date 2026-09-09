import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  realpathSync,
  existsSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const engine = process.env.GHSUB_ENGINE_ROOT;
const cloudRoot = process.env.GHSUB_CLOUD_ROOT;
assert(
  engine && cloudRoot,
  'Set GHSUB_ENGINE_ROOT and GHSUB_CLOUD_ROOT to locally built candidate checkouts'
);
assert(
  existsSync(path.join(root, 'packages/cli/dist/cli/index.js')),
  'Missing candidate CLI build; run npm run build:core before creating live fixtures'
);
const { retryFailedFixtureHook, parseFixtureGitHubResponse, fixtureDeliveryId } =
  await import('./retry-fixture-hook.mjs');
const { observeEnvelopeAdmissions, assertDuplicateAdmission, assertNoStalePrejoinAction } =
  await import('./admission-proof.mjs');
const failedGitHubIngress = new Map();
const { fixturePathGlob, assertProducerWorkspace, findFixtureCommentMessage } =
  await import('./fixture-scope.mjs');
const cloudModule = (m) => m.default ?? m;
const { createGitHubWebhookIngest } = cloudModule(
  await import(cloudRoot + '/packages/web/lib/integrations/github-webhook-ingest.ts')
);
const { normalizeWebhook, computePath, buildGitHubWebhookIngestData, githubWebhookResourceRef } = cloudModule(
  await import(cloudRoot + '/packages/web/lib/integrations/github-relayfile.ts')
);
const { default: dotenv } = await import(cloudRoot + '/node_modules/dotenv/lib/main.js');
const cloudEnv = dotenv.parse(readFileSync(process.env.GHSUB_CLOUD_ENV_FILE));
process.env.RELAYFILE_INTERNAL_HMAC_SECRET = cloudEnv.RELAYFILE_INTERNAL_HMAC_SECRET;
process.env.RELAYFILE_URL = 'https://file.agentrelay.com';
assert(process.env.RELAYFILE_INTERNAL_HMAC_SECRET, 'Missing local Cloud internal ingress signing credential');
const output = process.env.GHSUB_EVIDENCE_DIR;
assert(output, 'Set GHSUB_EVIDENCE_DIR outside the source checkout');
mkdirSync(output, { recursive: true });
const { startServer } = await import(engine + '/packages/engine/dist/entrypoints/node.js');
const { Agent } = await import(root + '/node_modules/undici/index.js');
const publicDispatcher = new Agent({
  connect: {
    lookup(host, opts, cb) {
      const source =
        'import urllib.request,json,sys; req=urllib.request.Request("https://cloudflare-dns.com/dns-query?name="+sys.argv[1]+"&type=A",headers={"accept":"application/dns-json"}); print(json.dumps(json.load(urllib.request.urlopen(req,timeout=8))))';
      execFile('python3', ['-c', source, host], { timeout: 10000 }, (error, stdout) => {
        if (error) {
          cb(error);
          return;
        }
        try {
          const r = JSON.parse(stdout);
          const addresses = (r.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);
          appendFileSync(
            path.join(output, 'dns.jsonl'),
            JSON.stringify({ at: new Date().toISOString(), host, status: r.Status, addresses }) + '\n'
          );
          if (!addresses.length) throw Error('No HTTPS DNS answer for ' + host);
          opts.all
            ? cb(
                null,
                addresses.map((address) => ({ address, family: 4 }))
              )
            : cb(null, addresses[0], 4);
        } catch (e) {
          cb(e);
        }
      });
    },
  },
});
const { HarnessDriverClient } = await import(root + '/packages/harness-driver/dist/index.js');
const { RelayfileControlPlaneClient } = await import(root + '/node_modules/@relayfile/client/dist/index.js');
const { receiverTask, digest, persistWorkerDiagnostics } = await import(
  root + '/tests/e2e/github-subscriptions/proof.mjs'
);
const { codexReceiverArgs, codexMcpArgs, sessionFiles, auditOwnedCodexSession } = await import(
  root + '/tests/e2e/github-subscriptions/codex-proof.mjs'
);
const cp = new RelayfileControlPlaneClient({
  socketPath: process.env.GHSUB_CONTROL_SOCKET ?? path.join(process.env.HOME, '.ghsub-cp.sock'),
  autoStart: false,
  requestTimeoutMs: 45000,
});
const workspace = process.env.GHSUB_RELAYFILE_WORKSPACE;
const appWorkspace = process.env.GHSUB_APP_WORKSPACE;
assert(workspace && appWorkspace, 'Explicit app and runtime workspace IDs are required');
const runId = 'ghsub-selfhost-' + randomBytes(5).toString('hex');
const work = mkdtempSync(path.join(output, 'work-'));
const name = 'ghsub-live-' + randomBytes(4).toString('hex');
const binary = process.env.GHSUB_BROKER_BINARY ?? root + '/target/release/agent-relay-broker';
const report = {
  runId,
  at: new Date().toISOString(),
  environment:
    'local candidate Cloud ingestion and Relaycast/broker; signed real GitHub hooks and hosted Relayfile',
  pass: false,
  intendedChiefPassed: false,
  checks: [],
  subscriptions: [],
  stimuli: [],
  cleanup: [],
  githubRedeliveries: [],
  retryPolicy:
    'At most 3 GitHub redeliveries per failed owned comment, at least 30 seconds apart; only transient Relayfile admission failures',
};
const save = () => writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const note = (status) => {
  report.status = status;
  report.updatedAt = new Date().toISOString();
  save();
  console.log(report.updatedAt + ' ' + status);
};
const redact = (s) =>
  String(s).replace(/(?:rk_live_|at_live_|nt_live_|sk-ant-|sk-)[A-Za-z0-9_-]+/g, '[redacted]');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let server,
  proxy,
  tunnel,
  broker,
  worker,
  key,
  base,
  origin,
  actorId,
  fixtures = [],
  negativeToken;
let stopping = false;
process.once('SIGTERM', () => {
  stopping = true;
});
process.once('SIGINT', () => {
  stopping = true;
});
const admissions = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = observeEnvelopeAdmissions(
  originalFetch,
  'https://file.agentrelay.com/v1/internal/webhook-envelopes',
  (row) => {
    admissions.push(row);
    appendFileSync(path.join(output, 'envelope-admissions.jsonl'), JSON.stringify(row) + '\n');
  }
);
const events = [],
  inbound = [],
  allowed = new Set(),
  nodeSockets = new Set();
const githubHookSecret = randomBytes(32).toString('hex');
const ownedHooks = [];
const configFile = path.join(output, 'fixture-config.json');
const sessions = path.join(process.env.CODEX_HOME ?? path.join(process.env.HOME, '.codex'), 'sessions');
const sessionsBefore = new Set(sessionFiles(sessions));
async function until(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (stopping) throw Error('Stop requested');
    const v = await fn();
    if (v) return v;
    await delay(500);
  }
  throw Error('Timed out: ' + label);
}
async function req(route, method = 'GET', body, token = key) {
  const r = await fetch(base + route, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await r.json();
  assert(r.ok, route + ' HTTP ' + r.status + ' ' + JSON.stringify(data.error));
  return data.data;
}
function gh(endpoint, method = 'GET', body) {
  const result = execFileSync(
    'gh',
    ['api', endpoint, '--method', method, ...(body === undefined ? [] : ['--input', '-'])],
    {
      input: body === undefined ? undefined : JSON.stringify(body),
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  return parseFixtureGitHubResponse(result);
}
function ghAsync(endpoint, method = 'GET') {
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      ['api', endpoint, '--method', method],
      { encoding: 'utf8', timeout: 30000 },
      (error, stdout) => {
        if (error) return reject(error);
        try {
          resolve(parseFixtureGitHubResponse(stdout));
        } catch (error) {
          reject(error);
        }
      }
    );
  });
}
const messages = () => req('/v1/channels/local-ai-proof/messages?limit=100');
async function emit(fixture, label) {
  const nonce = randomBytes(16).toString('hex');
  const stimulus = { repo: fixture.repo, pr: fixture.pr, label, nonce, createdAt: new Date().toISOString() };
  report.stimuli.push(stimulus);
  save();
  const comment = gh(`repos/${fixture.repo}/issues/${fixture.pr}/comments`, 'POST', {
    body: `Disposable self-hosted subscription proof ${runId}\nGHSUB_EVENT_NONCE=${nonce}`,
  });
  stimulus.commentId = comment.id;
  stimulus.url = comment.html_url;
  save();
  return stimulus;
}
async function received(stimulus) {
  const m = await until(
    async () => {
      const message = findFixtureCommentMessage(await messages(), stimulus, runId);
      if (message) return message;
      const retried = await retryFailedFixtureHook({
        stimulus,
        failure: failedGitHubIngress.get(stimulus.repo + '#' + stimulus.commentId),
        hooks: ownedHooks,
        attempts: report.githubRedeliveries,
        gh: ghAsync,
      });
      if (retried) save();
      return undefined;
    },
    240000,
    'real GitHub ingress ' + stimulus.label
  );
  const metadata = m.metadata ?? {};
  assert.equal(
    metadata.provider_event_type ?? metadata.relayfile?.provider_event_type,
    'issue_comment.created',
    'authenticated GitHub semantic type'
  );
  const hop = inbound.find((x) => x.responseMessageId === String(m.id) && x.status === 201);
  assert(hop, 'No successful real webhook request correlated to channel message');
  return { message: m, hop };
}
async function acted(stimulus) {
  const { message, hop } = await received(stimulus);
  const action = await until(
    async () => {
      const matches = (await messages()).filter(
        (m) => m.agent_id === actorId && m.text?.trim() === 'GHSUB_ACK ' + digest(stimulus.nonce)
      );
      assert(matches.length <= 1, 'Duplicate action');
      return matches[0];
    },
    240000,
    'real Codex action ' + stimulus.label
  );
  const injected = events.find(
    (e) => e.kind === 'delivery_injected' && String(e.event_id) === String(message.id)
  );
  assert(injected, 'Missing broker injection');
  const proof = {
    label: stimulus.label,
    repo: stimulus.repo,
    github: stimulus.url,
    ingressId: message.id,
    providerEventType: 'issue_comment.created',
    relayfileEventId: hop.eventId,
    brokerAt: injected.observedAt,
    actionId: action.id,
    actorId,
    latencyMs: Date.parse(action.created_at) - Date.parse(stimulus.createdAt),
    pass: true,
  };
  report.checks.push(proof);
  save();
  return action;
}
const idle = (after) =>
  until(
    () => events.find((e) => e.kind === 'agent_idle' && Date.parse(e.observedAt) > after),
    240000,
    'fresh idle boundary'
  );
try {
  for (const [repo, dir] of [
    ['relay', root],
    ['engine', engine],
    ['cloud', cloudRoot],
  ]) {
    assert.equal(
      execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim(),
      '',
      'Candidate checkout must be clean before live proof: ' + repo
    );
    report[repo + 'Head'] = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    report[repo + 'DiffSha256'] = digest(
      execFileSync('git', ['diff', 'HEAD'], { cwd: dir, encoding: 'utf8' })
    );
  }
  const auth = JSON.parse(readFileSync(path.join(process.env.HOME, '.agentworkforce/relay/cloud-auth.json')));
  const mapped = await fetch(
    auth.apiUrl.replace(/\/$/, '') +
      '/api/v1/workspaces/' +
      encodeURIComponent(appWorkspace) +
      '/relayfile/delegated-token',
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + auth.accessToken,
        'content-type': 'application/json',
        'user-agent': 'agent-relay-cli',
      },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ agentName: 'github-subscriptions-proof', scopes: ['fs:read'] }),
    }
  );
  assert(mapped.ok, 'Cloud workspace binding preflight HTTP ' + mapped.status);
  const mappedData = await mapped.json();
  assertProducerWorkspace(workspace, mappedData.relayfileWorkspaceId);
  report.boundWorkspaceVerified = true;
  const harnessSource = readFileSync(new URL(import.meta.url));
  writeFileSync(path.join(output, 'run-source.mjs'), harnessSource);
  report.harnessSha256 = createHash('sha256').update(harnessSource).digest('hex');
  report.binarySha256 = createHash('sha256').update(readFileSync(binary)).digest('hex');
  report.workDir = work;
  const inventory = await cp.listWebhookSubscriptions(workspace);
  report.producerWorkspace = inventory.workspaceId;
  report.priorSubscriptionIds = inventory.subscriptions.map((s) => s.subscriptionId);
  note('Pinned Relayfile workspace inventory verified; starting isolated engine');
  server = startServer({
    port: 0,
    dbPath: path.join(work, 'relaycast.db'),
    fileDir: path.join(work, 'files'),
    config: { environment: 'test', relayfileInboundSecret: randomBytes(32).toString('hex') },
  });
  if (!server.server.listening) await once(server.server, 'listening');
  base = 'http://127.0.0.1:' + server.server.address().port;
  server.server.on('upgrade', (r, s) => {
    if (r.url.startsWith('/v1/node/ws')) {
      nodeSockets.add(s);
      s.on('close', () => nodeSockets.delete(s));
    }
  });
  key = (await req('/v1/workspaces', 'POST', { name: runId }, null)).api_key;
  proxy = http.createServer(async (r, res) => {
    if (r.method !== 'POST' || (!allowed.has(r.url) && r.url !== '/github-fixture-hook')) {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks = [];
    let size = 0;
    for await (const c of r) {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        res.writeHead(413);
        res.end();
        return;
      }
      chunks.push(c);
    }
    const body = Buffer.concat(chunks);
    let event;
    try {
      event = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    if (r.url === '/github-fixture-hook') {
      const signature = r.headers['x-hub-signature-256'];
      const expected = 'sha256=' + createHmac('sha256', githubHookSecret).update(body).digest('hex');
      if (
        typeof signature !== 'string' ||
        signature.length !== expected.length ||
        !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
      ) {
        res.writeHead(401);
        res.end();
        return;
      }
      const fixture = fixtures.find(
        (f) =>
          f.repo === event.repository?.full_name &&
          f.pr === (event.issue?.number ?? event.pull_request?.number)
      );
      if (
        !fixture ||
        r.headers['x-github-event'] !== 'issue_comment' ||
        event.action !== 'created' ||
        !String(event.comment?.body ?? '').startsWith(
          `Disposable self-hosted subscription proof ${runId}\nGHSUB_EVENT_NONCE=`
        )
      ) {
        res.writeHead(202);
        res.end();
        return;
      }
      try {
        const normalized = normalizeWebhook({
          headers: { 'x-github-event': 'issue_comment' },
          payload: event,
          connectionId: 'local-fixture-ingress',
        });
        const mutation = buildGitHubWebhookIngestData(normalized);
        const deliveryId = String(r.headers['x-github-delivery']);
        const producer = createGitHubWebhookIngest({
          client: {
            writeFile: async () => {
              throw Error('unexpected file write');
            },
            deleteFile: async () => {
              throw Error('unexpected deletion');
            },
          },
          workspaceId: workspace,
          path: computePath(normalized),
          providerEventType: normalized.eventType,
          resourceRef: githubWebhookResourceRef(normalized),
          deliveryId,
          correlationId: deliveryId,
          timestamp: new Date().toISOString(),
        });
        await producer.send(mutation.eventType, mutation.data);
        failedGitHubIngress.delete(fixture.repo + '#' + event.comment.id);
        appendFileSync(
          path.join(output, 'github-ingress.jsonl'),
          JSON.stringify({
            at: new Date().toISOString(),
            repo: fixture.repo,
            pr: fixture.pr,
            commentId: event.comment?.id,
            deliveryId,
            workspace,
            path: computePath(normalized),
            providerEventType: normalized.eventType,
          }) + '\n'
        );
        res.writeHead(202);
        res.end();
      } catch (e) {
        const failure = {
          at: new Date().toISOString(),
          repo: fixture.repo,
          pr: fixture.pr,
          commentId: event.comment?.id,
          deliveryId: String(r.headers['x-github-delivery']),
          error: redact(e.message),
        };
        failedGitHubIngress.set(fixture.repo + '#' + event.comment?.id, failure);
        appendFileSync(path.join(output, 'github-ingress.jsonl'), JSON.stringify(failure) + '\n');
        res.writeHead(502);
        res.end();
      }
      return;
    }
    const record = {
      at: new Date().toISOString(),
      eventId: event.eventId,
      path: event.path,
      providerEventType: event.providerEventType,
      bodySha256: createHash('sha256').update(body).digest('hex'),
    };
    try {
      const upstream = await fetch(base + r.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...Object.fromEntries(Object.entries(r.headers).filter(([k]) => k.startsWith('x-relay-'))),
        },
        body,
        signal: AbortSignal.timeout(20000),
      });
      const response = await upstream.text();
      record.status = upstream.status;
      try {
        record.responseMessageId = String(JSON.parse(response).data?.message_id);
      } catch {}
      inbound.push(record);
      appendFileSync(path.join(output, 'inbound.jsonl'), JSON.stringify(record) + '\n');
      res.writeHead(upstream.status, {
        'content-type': 'application/json',
        ...(upstream.headers.get('retry-after')
          ? { 'retry-after': upstream.headers.get('retry-after') }
          : {}),
      });
      res.end(response);
    } catch (e) {
      res.writeHead(502);
      res.end();
    }
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  tunnel = spawn(
    '/opt/homebrew/bin/cloudflared',
    ['tunnel', '--url', 'http://127.0.0.1:' + proxy.address().port, '--no-autoupdate', '--protocol', 'http2'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  report.tunnelPid = tunnel.pid;
  let tunnelLog = '';
  for (const stream of [tunnel.stdout, tunnel.stderr])
    stream.on('data', (chunk) => {
      tunnelLog += chunk;
      appendFileSync(path.join(output, 'tunnel.log'), chunk);
      const match = tunnelLog.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) origin = match[0];
    });
  await until(() => origin, 45000, 'public tunnel');
  report.publicOrigin = origin;
  await until(
    async () => {
      try {
        const denied = await fetch(origin + '/v1/workspaces', {
          dispatcher: publicDispatcher,
          signal: AbortSignal.timeout(5000),
        });
        report.tunnelPreflightStatus = denied.status;
        await denied.arrayBuffer();
        save();
        return denied.status === 404;
      } catch (e) {
        report.tunnelPreflightError = redact(e.cause?.message ?? e.message);
        save();
        return false;
      }
    },
    300000,
    'tunnel registration and public reachability'
  );
  report.checks.push({ label: 'public-management-api-blocked', pass: true });
  writeFileSync(
    configFile,
    JSON.stringify({
      runId,
      environment: 'self-hosted-live',
      outputDir: output,
      repos: ['AgentWorkforce/cloud', 'AgentWorkforce/relay', 'AgentWorkforce/software-garden'],
    })
  );
  execFileSync(process.execPath, [root + '/tests/e2e/github-subscriptions/run.mjs', 'prepare', configFile], {
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  fixtures = JSON.parse(readFileSync(path.join(output, 'manifest.json'), 'utf8')).fixtures;
  report.fixtures = fixtures.map((f) => ({ repo: f.repo, pr: f.pr, url: f.url }));
  save();
  const creator = await req('/v1/agents', 'POST', { name: 'fixture-creator', auto_join_general: false });
  await req('/v1/channels', 'POST', { name: 'local-ai-proof' }, creator.token);
  negativeToken = (await req('/v1/agents', 'POST', { name: 'negative-recipient', auto_join_general: false }))
    .token;
  for (const f of fixtures) {
    const glob = fixturePathGlob(f, 'issue', runId);
    assert(!inventory.subscriptions.some((s) => s.pathGlobs.includes(glob)), 'Unowned scope collision');
    const target = await req('/v1/integrations/relayfile/inbound-target', 'POST', {
      channel: 'local-ai-proof',
      provider: 'github',
      path_glob: glob,
    });
    const targetUrl = new URL(target.url);
    allowed.add(targetUrl.pathname + targetUrl.search);
    const publicUrl = origin + targetUrl.pathname + targetUrl.search;
    report.pendingSubscription = { workspace, url: publicUrl, pathGlobs: [glob] };
    save();
    const sub = await cp.createWebhookSubscription({
      workspace,
      url: publicUrl,
      pathGlobs: [glob],
      secret: target.secret,
    });
    assert.equal(sub.workspaceId, workspace);
    report.subscriptions.push({ id: sub.subscriptionId, workspace, pathGlob: glob });
    delete report.pendingSubscription;
    save();
  }
  note('Three owned GitHub fixture subscriptions point through tunnel to local engine');
  for (const f of fixtures) {
    report.pendingGitHubHook = { repo: f.repo, url: origin + '/github-fixture-hook' };
    save();
    const hook = gh(`repos/${f.repo}/hooks`, 'POST', {
      name: 'web',
      active: true,
      events: ['issue_comment'],
      config: {
        url: origin + '/github-fixture-hook',
        content_type: 'json',
        secret: githubHookSecret,
        insecure_ssl: '0',
      },
    });
    ownedHooks.push({ repo: f.repo, id: hook.id });
    report.ownedGitHubHooks = ownedHooks;
    delete report.pendingGitHubHook;
    save();
  }
  const probe = await emit(fixtures[1], 'prejoin-real-ingress');
  const originalProbe = await received(probe);
  // Verify redelivery permission and lossless GitHub ID handling BEFORE a real
  // worker is started. This repeats only the owned prejoin event, never input.
  const probeRows = () =>
    readFileSync(path.join(output, 'github-ingress.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((row) => row.repo === probe.repo && row.commentId === probe.commentId && !row.error);
  const originalDelivery = probeRows()[0];
  assert(originalDelivery, 'Missing authenticated prejoin GitHub delivery');
  const probeHook = ownedHooks.find((hook) => hook.repo === probe.repo);
  const deliveryEndpoint = `repos/${probe.repo}/hooks/${probeHook.id}/deliveries`;
  const probeDelivery = await until(
    async () => {
      const rows = await ghAsync(`${deliveryEndpoint}?per_page=100`);
      assert(Array.isArray(rows), 'Invalid GitHub preflight delivery list');
      return rows.find((row) => row.guid === originalDelivery.deliveryId);
    },
    45000,
    'GitHub preflight delivery inventory'
  );
  report.preflightRedelivery = {
    repo: probe.repo,
    commentId: probe.commentId,
    githubDeliveryId: fixtureDeliveryId(probeDelivery.id),
    guid: originalDelivery.deliveryId,
    at: new Date().toISOString(),
    completed: false,
  };
  save();
  await ghAsync(`${deliveryEndpoint}/${report.preflightRedelivery.githubDeliveryId}/attempts`, 'POST');
  await until(
    () => probeRows().filter((row) => row.deliveryId === originalDelivery.deliveryId).length >= 2,
    90000,
    'real GitHub prejoin redelivery'
  );
  report.preflightRedelivery.duplicateAdmission = assertDuplicateAdmission(
    admissions,
    originalDelivery.deliveryId
  );
  const afterRedelivery = await received(probe);
  assert.equal(
    afterRedelivery.message.id,
    originalProbe.message.id,
    'Redelivery changed prejoin message identity'
  );
  report.preflightRedelivery.completed = true;
  report.checks.push({ label: 'real-github-redelivery-preflight', pass: true });
  report.checks.push({ label: 'real-github-relayfile-selfhost-ingress', pass: true });
  save();
  const preflightOnly = process.env.GHSUB_PREFLIGHT_ONLY === '1';
  report.validationScope = preflightOnly
    ? 'preflight-only; no AI acceptance'
    : 'full local real-GitHub rehearsal';
  if (preflightOnly) {
    report.preflightPass = true;
    note('Preflight-only verification passed; no AI worker started');
  } else {
    const isolatedEnv = Object.fromEntries(
      Object.keys(process.env)
        .filter((k) => k.startsWith('RELAY_') || k.startsWith('AGENT_RELAY_'))
        .map((k) => [k, ''])
    );
    broker = await HarnessDriverClient.spawn({
      binaryPath: binary,
      cwd: work,
      workspaceKey: key,
      brokerName: runId,
      binaryArgs: { persist: true, apiPort: 0 },
      channels: [],
      startupTimeoutMs: 30000,
      onStderr: (line) => appendFileSync(path.join(output, 'broker-stderr.log'), redact(line) + '\n'),
      env: {
        ...isolatedEnv,
        RELAYFILE_INTERNAL_HMAC_SECRET: '',
        GHSUB_CLOUD_ENV_FILE: '',
        RELAY_INJECT_RATE_MS: '0',
        RELAY_AGENT_TYPE: 'system',
        RELAY_AGENT_NAME: runId,
        RELAY_BASE_URL: base,
        RELAYCAST_BASE_URL: base,
        CLAUDECODE: '',
        AGENT_RELAY_BROKER_LOG: 'stderr',
        RUST_LOG:
          'relay_broker::wrap=info,relay_broker::pty_worker=info,agent_relay::worker::pty=info,relay_pty::startup_input=debug,relay_broker::startup_gate=debug',
        AGENT_RELAY_MCP_COMMAND: process.execPath + ' ' + root + '/packages/cli/dist/cli/index.js mcp',
      },
    });
    broker.onEvent((e) => {
      if (e.name !== name) return;
      const row = Object.fromEntries(
        ['kind', 'name', 'generation', 'event_id', 'delivery_id', 'verification', 'reason', 'pid', 'seq']
          .filter((k) => e[k] !== undefined)
          .map((k) => [k, e[k]])
      );
      row.observedAt = new Date().toISOString();
      events.push(row);
      appendFileSync(path.join(output, 'events.jsonl'), JSON.stringify(row) + '\n');
    });
    broker.connectEvents();
    const start = Date.now();
    worker = await broker.spawnCli({
      name,
      cli: process.env.GHSUB_CODEX_BINARY ?? 'codex',
      channels: ['local-ai-proof'],
      cwd: work,
      idleThresholdSecs: 5,
      args: [
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
      task:
        receiverTask +
        ' This is an isolated self-hosted rehearsal with real GitHub events. Do not ACK this initial task; wait for pushed events. Use functions.exec twice per event, with EXACTLY one expression each time. First: text(await tools.exec_command({cmd:"printf \'%s\' \'<nonce>\' | shasum -a 256",login:false})); substitute only the 32 hex digits. Then: text(await tools.mcp__agent_relay__post_message({channel:"local-ai-proof",text:"GHSUB_ACK <digest>"})); substitute the digest output. No variable declarations, ALL_TOOLS lookup, extra expressions, other tools, sleep, inbox, resource reads, or polling.',
    });
    report.actor = { name, pid: worker.pid, generation: worker.generation };
    save();
    const ready = await worker.waitForReady(90000);
    report.readyResult = ready;
    report.actor.pid = ready.pid;
    assert.equal(ready.reason, 'ready');
    process.kill(ready.pid, 0);
    const identity = await req('/v1/agents/' + name);
    actorId = identity.id;
    report.actor.id = actorId;
    assert.deepEqual(
      identity.channels.map((c) => c.name),
      ['local-ai-proof']
    );
    note('Real Codex ready on local build; waiting for first idle');
    report.firstIdleAt = (await idle(Date.now())).observedAt;
    assertNoStalePrejoinAction(await messages(), actorId, digest(probe.nonce));
    for (const [i, f] of fixtures.entries()) {
      const action = await acted(await emit(f, 'successive-idle-' + (i + 1)));
      await idle(Date.parse(action.created_at));
      note('Real GitHub event acted on: ' + f.repo);
    }
    const idleStart = Date.now();
    note('Beginning 600-second no-input idle interval');
    while (Date.now() - idleStart < 600000) {
      assert(!stopping);
      await delay(1000);
    }
    report.longIdleMs = Date.now() - idleStart;
    const long = await acted(await emit(fixtures[1], 'long-idle'));
    await idle(Date.parse(long.created_at));
    const burst = [];
    for (let i = 0; i < 10; i++) burst.push(await emit(fixtures[i % 3], 'burst-' + i));
    for (const s of burst) await acted(s);
    await idle(Date.now());
    const oldPid = ready.pid;
    for (const s of nodeSockets) s.destroy();
    await delay(5000);
    const connected = await req('/v1/agents/' + name);
    assert.equal(connected.id, actorId);
    process.kill(oldPid, 0);
    await acted(await emit(fixtures[1], 'after-node-reconnect'));
    const negative = await req('/v1/deliveries', 'GET', undefined, negativeToken);
    assert.equal(negative.length, 0);
    report.checks.push({ label: 'nonmember-received-zero-deliveries', pass: true });
    assertNoStalePrejoinAction(await messages(), actorId, digest(probe.nonce));
    report.checks.push({ label: 'no-stale-prejoin-action-through-run-end', pass: true });
    report.pass = true;
    note('Real GitHub -> Relayfile -> self-hosted engine -> idle Codex proof passed');
  }
} catch (e) {
  report.error = redact(e.message);
  note('Proof failed: ' + report.error);
  process.exitCode = 1;
} finally {
  if (report.pendingGitHubHook) {
    try {
      const pending = report.pendingGitHubHook;
      for (const hook of gh(`repos/${pending.repo}/hooks?per_page=100`).filter(
        (h) => h.config?.url === pending.url
      ))
        ownedHooks.push({ repo: pending.repo, id: hook.id });
      report.ownedGitHubHooks = ownedHooks;
      delete report.pendingGitHubHook;
    } catch (e) {
      report.cleanup.push({ resource: 'pending-github-hook', pass: false, error: redact(e.message) });
    }
  }
  for (const hook of ownedHooks) {
    try {
      const deliveries = gh(`repos/${hook.repo}/hooks/${hook.id}/deliveries?per_page=100`);
      appendFileSync(
        path.join(output, 'github-deliveries.jsonl'),
        JSON.stringify({
          repo: hook.repo,
          hookId: hook.id,
          deliveries: deliveries.map(
            ({ id, guid, delivered_at, status_code, event, action, redelivery }) => ({
              id,
              guid,
              delivered_at,
              status_code,
              event,
              action,
              redelivery,
            })
          ),
        }) + '\n'
      );
    } catch (e) {
      report.githubDeliveryDiagnosticError = redact(e.message);
    }
    try {
      execFileSync('gh', ['api', `repos/${hook.repo}/hooks/${hook.id}`, '--method', 'DELETE'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000,
      });
      report.cleanup.push({ resource: 'github-hook-' + hook.id, pass: true });
    } catch (e) {
      report.cleanup.push({ resource: 'github-hook-' + hook.id, pass: false, error: redact(e.message) });
    }
  }
  if (server && key) {
    try {
      writeFileSync(path.join(output, 'messages.json'), JSON.stringify(await messages(), null, 2) + '\n');
    } catch {}
  }
  if (worker) {
    try {
      await worker.release('owned real-GitHub proof cleanup', { deleteIdentity: true });
      report.cleanup.push({ resource: 'worker', pass: true });
    } catch (e) {
      report.cleanup.push({ resource: 'worker', pass: false, error: redact(e.message) });
      report.pass = false;
    }
  }
  if (broker) {
    try {
      await broker.shutdown();
    } catch {}
    broker.disconnect();
  }
  if (worker) {
    try {
      report.codexToolAudit = await auditOwnedCodexSession({
        directory: sessions,
        before: sessionsBefore,
        cwd: work,
        startedAt: report.at,
      });
      assert(report.codexToolAudit.pass, 'Forbidden receiver tool use');
      const log = readFileSync(
        path.join(work, '.agentworkforce', 'relay', 'team', 'worker-logs', name + '.log'),
        'utf8'
      );
      report.idleControlWrites = persistWorkerDiagnostics(output, name + '.log', log, report.firstIdleAt);
      assert.deepEqual(report.idleControlWrites, []);
    } catch (e) {
      report.auditError = redact(e.message);
      report.pass = false;
    }
  }
  // Reconcile a create whose response may have been lost before deleting only owned URLs.
  if (report.pendingSubscription) {
    try {
      const list = await cp.listWebhookSubscriptions(workspace);
      for (const s of list.subscriptions.filter(
        (s) =>
          s.url === report.pendingSubscription.url && !report.priorSubscriptionIds.includes(s.subscriptionId)
      ))
        report.subscriptions.push({
          id: s.subscriptionId,
          workspace,
          pathGlob: report.pendingSubscription.pathGlobs[0],
        });
      delete report.pendingSubscription;
    } catch (e) {
      report.cleanup.push({ resource: 'pending-subscription', pass: false, error: redact(e.message) });
    }
  }
  for (const sub of report.subscriptions) {
    try {
      await cp.deleteWebhookSubscription(sub.id, workspace);
      sub.deleted = true;
    } catch (e) {
      report.cleanup.push({ resource: sub.id, pass: false, error: redact(e.message) });
    }
  }
  if (report.subscriptions.length) {
    try {
      const after = await cp.listWebhookSubscriptions(workspace);
      assert(!after.subscriptions.some((s) => report.subscriptions.some((o) => o.id === s.subscriptionId)));
      assert(
        report.priorSubscriptionIds.every((id) => after.subscriptions.some((s) => s.subscriptionId === id)),
        'An original subscription is missing'
      );
      report.cleanup.push({ resource: 'producer-subscriptions', pass: true });
    } catch (e) {
      report.cleanup.push({ resource: 'producer-subscriptions', pass: false, error: redact(e.message) });
    }
  }
  if (existsSync(path.join(output, 'manifest.json'))) {
    try {
      execFileSync(
        process.execPath,
        [root + '/tests/e2e/github-subscriptions/run.mjs', 'cleanup', configFile],
        { timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      report.cleanup.push({ resource: 'github-fixtures', pass: true });
    } catch (e) {
      report.cleanup.push({ resource: 'github-fixtures', pass: false, error: redact(e.message) });
    }
  }
  if (tunnel) {
    tunnel.kill('SIGTERM');
    await Promise.race([once(tunnel, 'exit'), delay(5000)]);
    if (tunnel.exitCode === null) tunnel.kill('SIGKILL');
  }
  if (proxy) await new Promise((r) => proxy.close(r));
  if (server) await server.stop();
  await publicDispatcher.close();
  globalThis.fetch = originalFetch;
  if (report.cleanup.some((c) => !c.pass)) {
    report.pass = false;
    report.preflightPass = false;
  }
  if (!report.pass && !report.preflightPass) process.exitCode = 1;
  // Preserve the owned SQLite database for diagnosis on failure; contains only fixtures.
  if (report.pass) rmSync(work, { recursive: true, force: true });
  save();
  console.log(
    JSON.stringify({
      pass: report.pass,
      preflightPass: report.preflightPass,
      validationScope: report.validationScope,
      status: report.status,
      error: report.error,
      checks: report.checks.length,
      cleanup: report.cleanup,
    })
  );
}
