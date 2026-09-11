#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureNangoForwards, nangoLogsCall } from './nango-proof.mjs';
import { fixturePathGlob, fixtureTitle, assertProducerWorkspace, fixtureExpected } from './fixture-scope.mjs';
import {
  correlate,
  releaseOwnedWorker,
  receiverTask,
  claudeReceiverArgs,
  hasContinuousCoverage,
  capturedStimuliPass,
  digest,
  collectUnseenMessages,
} from './proof.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const [command, configFile, ...args] = process.argv.slice(2);
if (
  !configFile ||
  ![
    'preflight',
    'prepare',
    'subscribe',
    'unsubscribe',
    'collect',
    'emit',
    'resolve',
    'capture-nango',
    'assert',
    'cleanup',
    'receiver-task',
  ].includes(command)
) {
  console.error(
    'Usage: node tests/e2e/github-subscriptions/run.mjs <preflight|prepare|subscribe|unsubscribe|collect|emit|resolve|capture-nango|assert|cleanup|receiver-task> config.json [arguments]'
  );
  process.exit(2);
}
const config = JSON.parse(readFileSync(configFile, 'utf8'));
if (!/^[a-z0-9-]{6,48}$/.test(config.runId))
  throw new Error('runId must be 6–48 lowercase letters, digits or hyphens');
const allowed = new Set(['AgentWorkforce/cloud', 'AgentWorkforce/relay', 'AgentWorkforce/software-garden']);
if (
  !Array.isArray(config.repos) ||
  config.repos.length !== 3 ||
  new Set(config.repos).size !== 3 ||
  config.repos.some((r) => !allowed.has(r))
)
  throw new Error('Specify each of the three authorized fixture repositories exactly once');
config.actors ??= {};
config.actorIds ??= {};
const out = path.resolve(config.outputDir);
mkdirSync(out, { recursive: true });
const manifestPath = path.join(out, 'manifest.json');
const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8'))
  : {
      runId: config.runId,
      createdAt: new Date().toISOString(),
      fixtures: [],
      stimuli: [],
      subscriptions: [],
    };
if (manifest.runId !== config.runId) throw new Error('Manifest ownership mismatch');
const save = () => writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
const record = (name, value) =>
  writeFileSync(path.join(out, name + '.json'), JSON.stringify(value, null, 2) + '\n');
const gh = (endpoint, method = 'GET', body) => {
  const argv = ['api', endpoint, '--method', method];
  if (body !== undefined) argv.push('--input', '-');
  const result = execFileSync('gh', argv, {
    input: body === undefined ? undefined : JSON.stringify(body),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return result.trim() ? JSON.parse(result) : null;
};
const cast = async (endpoint) => {
  if (!process.env.RELAY_WORKSPACE_KEY) throw new Error('RELAY_WORKSPACE_KEY is required');
  const res = await fetch(new URL(endpoint, config.castUrl), {
    headers: {
      authorization: `Bearer ${process.env.RELAY_WORKSPACE_KEY}`,
      'user-agent': 'agent-relay/11.10.4',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Relaycast ${endpoint}: HTTP ${res.status}`);
  return (await res.json()).data;
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const fixtureName = (repo) => repo.split('/')[1];
const readLines = (name) =>
  existsSync(path.join(out, name))
    ? readFileSync(path.join(out, name), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

async function preflight() {
  const result = { at: new Date().toISOString(), runId: config.runId, ready: false, checks: [] };
  const check = async (name, fn) => {
    try {
      result.checks.push({ name, pass: true, evidence: await fn() });
    } catch (e) {
      result.checks.push({ name, pass: false, error: e.message });
    }
  };
  await check('GitHub fixture permissions', () =>
    config.repos.map((repo) => {
      const r = gh(`repos/${repo}`);
      if (!r.permissions?.push) throw new Error(`No push permission: ${repo}`);
      return { repo, defaultBranch: r.default_branch, push: r.permissions.push };
    })
  );
  await check('exact deployed versions', async () => {
    if (
      !config.deployedVersions ||
      ['relay', 'relaycast', 'relayfile'].some(
        (k) => !/^([a-f0-9]{7,40}|[a-f0-9-]{36})$/.test(config.deployedVersions[k]?.revision ?? '')
      )
    )
      throw new Error(
        'Record independently observed deployed revision for Relay, Relaycast and Relayfile in deployedVersions'
      );
    return config.deployedVersions;
  });
  await check('real recipient and exact channel membership', async () => {
    const agents = await cast('/v1/agents');
    if (!config.webhookAgentId || !config.actorIds)
      throw new Error('Pin independently read actor IDs and the trusted webhook system agent ID');
    const results = [];
    for (const [actor, channel] of Object.entries(config.actors ?? {})) {
      const identity = agents.find((a) => a.name === actor);
      if (!identity || identity.id !== config.actorIds[actor] || identity.status === 'released')
        throw new Error(`Missing recipient: ${actor}`);
      const ch = await cast(`/v1/channels/${encodeURIComponent(channel)}`);
      if (!ch.members?.some((m) => m.agent_name === actor))
        throw new Error(`Missing membership: ${actor} in ${channel}`);
      results.push({ actor, id: identity.id, channel, members: ch.members.map((m) => m.agent_name) });
    }
    if (!results.length) throw new Error('Configure actual receiver(s), including chief for gate 9');
    return results;
  });
  await check('local broker and ready worker process', async () => {
    const { HarnessDriverClient } = await import(path.join(root, 'packages/harness-driver/dist/index.js'));
    const client = HarnessDriverClient.connect({ connectionPath: config.brokerConnectionPath });
    try {
      const session = await client.getSession();
      if (session.workspace_key !== process.env.RELAY_WORKSPACE_KEY)
        throw new Error('Broker workspace differs from explicit workspace credential');
      const workers = await client.listAgents();
      const worker = workers.find((w) => w.name === config.receiver);
      if (!worker?.ready || !worker.pid) throw new Error('Receiver has no confirmed harness readiness/PID');
      process.kill(worker.pid, 0);
      return {
        brokerVersion: session.broker_version,
        node: session.node_name,
        worker: { name: worker.name, pid: worker.pid, generation: worker.generation, ready: worker.ready },
      };
    } finally {
      client.disconnect();
    }
  });
  result.ready = result.checks.every((c) => c.pass);
  record('preflight', result);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 1;
}

function prepare() {
  for (const repo of config.repos) {
    let fixture = manifest.fixtures.find((f) => f.repo === repo);
    if (!fixture) {
      const metadata = gh(`repos/${repo}`);
      const base = gh(`repos/${repo}/git/ref/heads/${metadata.default_branch}`).object.sha;
      fixture = {
        repo,
        base: `ghsub-demo/${config.runId}/base`,
        head: `ghsub-demo/${config.runId}/head`,
        startSha: base,
        file: `ghsub-demo-fixtures/${config.runId}.txt`,
        branches: [],
        comments: [],
        reviews: [],
      };
      manifest.fixtures.push(fixture);
      save();
    }
    for (const branch of [fixture.base, fixture.head]) {
      if (fixture.branches.includes(branch)) continue;
      // Never adopt a pre-existing branch: only a creation acknowledged in this manifest is owned.
      gh(`repos/${repo}/git/refs`, 'POST', { ref: `refs/heads/${branch}`, sha: fixture.startSha });
      fixture.branches.push(branch);
      save();
    }
    if (!fixture.headSha) {
      const change = gh(`repos/${repo}/contents/${fixture.file}`, 'PUT', {
        message: `test: disposable GitHub subscription fixture ${config.runId}`,
        content: Buffer.from(
          `Disposable subscription demo fixture ${config.runId}\nReview this line for a real thread event.\n`
        ).toString('base64'),
        branch: fixture.head,
      });
      fixture.headSha = change.commit.sha;
      fixture.fileSha = change.content.sha;
      save();
    }
    if (!fixture.pr) {
      const pr = gh(`repos/${repo}/pulls`, 'POST', {
        title: fixtureTitle(config.runId),
        head: fixture.head,
        base: fixture.base,
        body: `Owned fixture for GitHub subscription validation. Only a disposable base branch may receive a fixture merge. No product changes or main merge. Run: ${config.runId}.`,
      });
      fixture.pr = pr.number;
      fixture.url = pr.html_url;
      save();
    }
    console.log(JSON.stringify({ repo, pr: fixture.url, head: fixture.head, base: fixture.base }));
  }
}

const publicBinding = (b) =>
  Object.fromEntries(
    [
      'provider',
      'pathGlob',
      'channel',
      'webhookId',
      'subscriptionId',
      'webhookSubscriptionId',
      'webhookSubscriptionWorkspaceId',
    ]
      .filter((k) => b[k] !== undefined)
      .map((k) => [k, b[k]])
  );
const sameBinding = (a, b) =>
  [
    'provider',
    'pathGlob',
    'channel',
    'webhookId',
    'subscriptionId',
    'webhookSubscriptionId',
    'webhookSubscriptionWorkspaceId',
  ].every((k) => a[k] === b[k]);
async function subscriptions(remove = false) {
  const { RelayfileControlPlaneClient } = await import('@relayfile/client');
  const { HarnessDriverClient } = await import(path.join(root, 'packages/harness-driver/dist/index.js'));
  if (!config.brokerProjectRoot || !config.receiverCwd)
    throw new Error('Configure brokerProjectRoot and receiverCwd explicitly');
  if (config.receiver === 'chief' && config.spawnReceiver !== false)
    throw new Error('Chief must already exist; never spawn a substitute chief');
  const cp = new RelayfileControlPlaneClient({ autoStart: false, requestTimeoutMs: 15000 });
  const broker = HarnessDriverClient.connect({ connectionPath: config.brokerConnectionPath });
  try {
    const session = await broker.getSession();
    if (session.workspace_key !== process.env.RELAY_WORKSPACE_KEY)
      throw new Error('Explicit workspace differs from broker workspace');
    const before = (await cp.listBindings()).map(publicBinding);
    const activeProducer = await cp.listWebhookSubscriptions();
    assertProducerWorkspace(config.relayfileWorkspaceId, activeProducer.workspaceId);
    const remote = await cp.listWebhookSubscriptions(config.relayfileWorkspaceId);
    const remoteSubscriptions = remote.subscriptions ?? [];
    const hooksBefore = (await cast('/v1/webhooks')).map((h) => ({ id: h.webhook_id ?? h.id }));
    const subscriptionsBefore = (await cast('/v1/subscriptions')).map((x) => ({ id: x.id }));
    // No resources or workers are created before all inventories succeed.
    const inventory = {
      at: new Date().toISOString(),
      bindings: before,
      hooks: hooksBefore,
      relaySubscriptions: subscriptionsBefore,
      subscriptions: remoteSubscriptions.map((x) => ({ id: x.subscriptionId, pathGlobs: x.pathGlobs })),
    };
    if (!existsSync(path.join(out, 'subscription-inventory-before.json')))
      record('subscription-inventory-before', inventory);
    appendFileSync(path.join(out, 'subscription-inventory-journal.jsonl'), JSON.stringify(inventory) + '\n');
    const cli = path.join(root, 'packages/cli/dist/cli/index.js');
    const invoke = (argv) =>
      execFileSync(process.execPath, [cli, 'integration', ...argv, '--base-url', config.castUrl], {
        cwd: config.brokerProjectRoot,
        env: { ...process.env, RELAY_AGENT_TOKEN: '', RELAY_BASE_URL: config.castUrl },
        encoding: 'utf8',
        timeout: 180000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    if (remove) {
      for (const owned of manifest.subscriptions.filter((s) => !s.removed)) {
        const current = (await cp.listBindings())
          .map(publicBinding)
          .find((b) => b.provider === 'github' && b.pathGlob === owned.pathGlob);
        if (!current || !sameBinding(current, owned.binding))
          throw new Error(
            `Binding changed outside this run: ${owned.pathGlob}; reconcile ownership before cleanup`
          );
        invoke(['unsubscribe', '--provider', 'github', '--resource', owned.pathGlob]);
        const remaining = await cp.listBindings();
        if (remaining.some((b) => b.provider === 'github' && b.pathGlob === owned.pathGlob))
          throw new Error('Owned binding survived unsubscribe');
        const remoteAfter = await cp.listWebhookSubscriptions(config.relayfileWorkspaceId);
        if (
          (remoteAfter.subscriptions ?? []).some(
            (s) => s.subscriptionId === owned.binding.webhookSubscriptionId
          )
        )
          throw new Error('Owned webhook subscription survived unsubscribe');
        if (
          (await cast('/v1/webhooks')).some((h) => (h.webhook_id ?? h.id) === owned.binding.webhookId) ||
          (await cast('/v1/subscriptions')).some((s) => s.id === owned.binding.subscriptionId)
        )
          throw new Error('Owned Relaycast hook/subscription survived unsubscribe');
        owned.removed = true;
        save();
      }
      if (manifest.worker && !manifest.worker.released) {
        await releaseOwnedWorker(broker, manifest.worker);
        manifest.worker.released = true;
        save();
      }
      return;
    }
    for (const fixture of manifest.fixtures) {
      if (!fixture.pr) throw new Error('Prepare the fixture PRs before subscribing');
      const scope = config.subscriptionScope ?? 'issue';
      if (!['issue', 'pr', 'repo'].includes(scope))
        throw new Error('subscriptionScope must be issue, pr or repo');
      const pathGlob = fixturePathGlob(fixture, scope, config.runId);
      const owned = manifest.subscriptions.find((s) => s.pathGlob === pathGlob && !s.removed);
      const current = (await cp.listBindings())
        .map(publicBinding)
        .find((b) => b.provider === 'github' && b.pathGlob === pathGlob);
      if (current && (!owned || !sameBinding(current, owned.binding)))
        throw new Error(`Refusing to replace an unowned binding: ${pathGlob}`);
      if (!owned && remoteSubscriptions.some((s) => s.pathGlobs?.includes(pathGlob)))
        throw new Error(`An unowned remote subscription already uses ${pathGlob}`);
      const existingWorker = (await broker.listAgents()).find((w) => w.name === config.receiver);
      if (!existingWorker && config.spawnReceiver === false)
        throw new Error(`Required existing actor ${config.receiver} is missing`);
      const argv = ['subscribe', 'github', '--resource', pathGlob, '--to', `@${config.receiver}`];
      if (config.spawnReceiver !== false)
        argv.push(
          '--spawn',
          config.receiverCli ?? 'claude',
          '--broker-connection',
          config.brokerConnectionPath,
          '--cwd',
          config.receiverCwd,
          '--task',
          receiverTask
        );
      if (config.spawnReceiver !== false) {
        const receiverArgs =
          config.receiverArgs ?? ((config.receiverCli ?? 'claude') === 'claude' ? claudeReceiverArgs : []);
        if (!Array.isArray(receiverArgs) || receiverArgs.some((a) => typeof a !== 'string'))
          throw new Error('receiverArgs must be an array of literal harness arguments');
        argv.push(...receiverArgs.map((a) => '--spawn-arg=' + a));
        manifest.receiverArgs = receiverArgs;
      }
      manifest.subscriptionIntent = { pathGlob, actor: config.receiver, at: new Date().toISOString() };
      save();
      invoke(argv);
      const binding = (await cp.listBindings())
        .map(publicBinding)
        .find((b) => b.provider === 'github' && b.pathGlob === pathGlob);
      if (!binding?.webhookSubscriptionId)
        throw new Error('Subscribe returned without a verifiable binding and webhook subscription');
      if (owned) {
        owned.previousBindings ??= [];
        owned.previousBindings.push(owned.binding);
        owned.binding = binding;
      } else manifest.subscriptions.push({ pathGlob, binding, createdAt: new Date().toISOString() });
      delete manifest.subscriptionIntent;
      save();
      const worker = (await broker.listAgents()).find((w) => w.name === config.receiver);
      if (!worker?.ready || !worker.pid || !worker.generation)
        throw new Error('Subscribed worker is not confirmed ready with PID and generation');
      process.kill(worker.pid, 0);
      if (!existingWorker) {
        manifest.worker = { name: worker.name, generation: worker.generation, pid: worker.pid };
        save();
      }
      const remoteAfter = await cp.listWebhookSubscriptions(config.relayfileWorkspaceId);
      if (!(remoteAfter.subscriptions ?? []).some((s) => s.subscriptionId === binding.webhookSubscriptionId))
        throw new Error('New producer subscription is absent from inventory');
      for (const previous of owned?.previousBindings ?? []) {
        if (
          (remoteAfter.subscriptions ?? []).some(
            (s) => s.subscriptionId === previous.webhookSubscriptionId
          ) ||
          (await cast('/v1/webhooks')).some((h) => (h.webhook_id ?? h.id) === previous.webhookId) ||
          (await cast('/v1/subscriptions')).some((s) => s.id === previous.subscriptionId)
        )
          throw new Error('Superseded resources remain; retry recorded CLI cleanup before lifecycle signoff');
      }
      const actor = await cast(`/v1/agents/${encodeURIComponent(config.receiver)}`);
      const channel = await cast(`/v1/channels/${encodeURIComponent(binding.channel)}`);
      if (
        manifest.worker?.name === config.receiver &&
        (!Array.isArray(actor.channels) ||
          actor.channels.length !== 1 ||
          actor.channels[0].name !== binding.channel)
      )
        throw new Error('Owned recipient live membership contains unintended channels');
      if (channel.members.length !== 1 || channel.members[0].agent_id !== actor.id)
        throw new Error('Exact recipient channel membership did not verify');
      config.actors[config.receiver] = binding.channel;
      config.actorIds[config.receiver] = actor.id;
      writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
      console.log(
        JSON.stringify({
          repo: fixture.repo,
          pathGlob,
          actor: worker.name,
          channel: binding.channel,
          pid: worker.pid,
          generation: worker.generation,
          subscriptionId: binding.webhookSubscriptionId,
        })
      );
    }
  } finally {
    broker.disconnect();
  }
}

async function collect() {
  const { HarnessDriverClient } = await import(path.join(root, 'packages/harness-driver/dist/index.js'));
  const client = HarnessDriverClient.connect({ connectionPath: config.brokerConnectionPath });
  const actorNames = new Set([config.receiver, ...Object.keys(config.actors)]);
  let channels = [...new Set([...Object.values(config.actors), ...(config.negativeChannels ?? [])])];
  const seen = new Set(readLines('messages.jsonl').map((m) => m.id));
  let stop = false;
  process.once('SIGINT', () => {
    stop = true;
  });
  process.once('SIGTERM', () => {
    stop = true;
  });
  const end = Date.now() + (config.collectionSeconds ?? 1800) * 1000;
  client.onEvent((event) => {
    if (!actorNames.has(event.name)) return;
    if (
      ![
        'agent_idle',
        'worker_ready',
        'agent_exited',
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
    appendFileSync(
      path.join(out, 'events.jsonl'),
      JSON.stringify({ ...safe, observedAt: new Date().toISOString() }) + '\n'
    );
  });
  client.connectEvents();
  console.log(
    `Collecting receiver evidence until ${new Date(end).toISOString()}; this observer polls history, receivers must not.`
  );
  try {
    while (!stop && Date.now() < end) {
      try {
        const updatedConfig = JSON.parse(readFileSync(configFile, 'utf8'));
        channels = [
          ...new Set([
            ...Object.values(updatedConfig.actors ?? {}),
            ...(updatedConfig.negativeChannels ?? []),
          ]),
        ];
      } catch {
        // Preserve continuous observation during a concurrent config rewrite.
      }
      for (const channel of channels) {
        const messages = await collectUnseenMessages(
          (before, limit) =>
            cast(
              `/v1/channels/${encodeURIComponent(channel)}/messages?limit=${limit}` +
                (before ? `&before=${encodeURIComponent(before)}` : '')
            ),
          seen,
          Date.parse(manifest.createdAt)
        );
        for (const m of messages)
          if (!seen.has(m.id)) {
            seen.add(m.id);
            if (!/GHSUB_EVENT_NONCE=[a-f0-9]{32}|GHSUB_ACK [a-f0-9]{64}/.test(m.text ?? '')) continue;
            appendFileSync(
              path.join(out, 'messages.jsonl'),
              JSON.stringify({ ...m, channel, observedAt: new Date().toISOString() }) + '\n'
            );
          }
      }
      appendFileSync(
        path.join(out, 'coverage.jsonl'),
        JSON.stringify({ at: new Date().toISOString(), channels }) + '\n'
      );
      await pause(2000);
    }
  } finally {
    client.disconnect();
  }
}

function emit() {
  const [repoShort, kind = 'comment'] = args;
  const fixture = manifest.fixtures.find((f) => fixtureName(f.repo) === repoShort);
  if (!fixture?.pr) throw new Error('Prepare the owned repository fixture first');
  if (!['comment', 'review', 'thread', 'merge', 'ci'].includes(kind))
    throw new Error('Unknown semantic stimulus');
  const events = readLines('events.jsonl');
  const lastStimulus = manifest.stimuli.at(-1);
  const idleAfter = lastStimulus?.createdAt ?? manifest.createdAt;
  const idle = events.findLast(
    (e) => e.kind === 'agent_idle' && e.name === config.receiver && e.observedAt > idleAfter
  );
  if (!idle && !args.includes('--busy'))
    throw new Error('No new observed idle boundary; collect first and wait for the receiver');
  const nonce = randomBytes(16).toString('hex');
  const text = `GHSUB_EVENT_NONCE=${nonce} GHSUB_EXPECT_KIND=${kind}`;
  const stimulus = {
    repo: fixture.repo,
    pr: fixture.pr,
    kind,
    nonce,
    headSha: fixture.headSha,
    file: fixture.file,
    createdAt: new Date().toISOString(),
    idleAfter,
    busy: args.includes('--busy'),
  };
  // Write intent before the provider mutation. Failed/uncertain mutations are retained for reconciliation.
  manifest.stimuli.push(stimulus);
  save();
  let response;
  if (kind === 'comment') {
    response = gh(`repos/${fixture.repo}/issues/${fixture.pr}/comments`, 'POST', { body: text });
    fixture.comments.push({ id: response.id, endpoint: `issues/comments/${response.id}` });
  } else if (kind === 'review') {
    response = gh(`repos/${fixture.repo}/pulls/${fixture.pr}/reviews`, 'POST', {
      event: 'COMMENT',
      body: text,
    });
    fixture.reviews.push(response.id);
  } else if (kind === 'thread') {
    response = gh(`repos/${fixture.repo}/pulls/${fixture.pr}/comments`, 'POST', {
      body: text,
      commit_id: fixture.headSha,
      path: fixture.file,
      side: 'RIGHT',
      line: 2,
    });
    fixture.comments.push({ id: response.id, endpoint: `pulls/comments/${response.id}` });
    if (response.in_reply_to_id != null) throw new Error('Expected a new review thread root');
  } else if (kind === 'merge') {
    const pr = gh(`repos/${fixture.repo}/pulls/${fixture.pr}`);
    if (
      pr.base.ref !== fixture.base ||
      pr.head.ref !== fixture.head ||
      !fixture.branches.includes(pr.base.ref)
    )
      throw new Error('Refusing merge outside owned fixture branches');
    gh(`repos/${fixture.repo}/pulls/${fixture.pr}`, 'PATCH', { body: text });
    response = gh(`repos/${fixture.repo}/pulls/${fixture.pr}/merge`, 'PUT', {
      sha: pr.head.sha,
      merge_method: 'merge',
      commit_title: `Fixture only ${config.runId}`,
      commit_message: text,
    });
    if (!response.merged) throw new Error('Fixture merge did not complete');
    fixture.merged = true;
    fixture.baseSha = response.sha;
    response = gh(`repos/${fixture.repo}/pulls/${fixture.pr}`);
  } else {
    // A genuine GitHub Actions check_run.completed; no synthetic check completion or product merge.
    const workflow = `name: ${text}\non:\n  push:\n    branches: ['${fixture.head}']\npermissions:\n  contents: read\njobs:\n  fixture:\n    name: ${text}\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo subscription-fixture\n`;
    const workflowPath = `.github/workflows/ghsub-${config.runId}.yml`;
    response = gh(`repos/${fixture.repo}/contents/${workflowPath}`, 'PUT', {
      branch: fixture.head,
      message: text,
      content: Buffer.from(workflow).toString('base64'),
      ...(fixture.workflowSha ? { sha: fixture.workflowSha } : {}),
    });
    fixture.workflowSha = response.content.sha;
    fixture.headSha = response.commit.sha;
    stimulus.headSha = fixture.headSha;
  }
  stimulus.providerId = response.id ?? response.sha ?? response.commit?.sha;
  stimulus.url = response.html_url ?? response.content?.html_url ?? fixture.url;
  stimulus.accepted = true;
  if (kind !== 'ci') stimulus.expected = fixtureExpected(stimulus, response, config.runId);
  save();
  console.log(JSON.stringify({ repo: stimulus.repo, kind, url: stimulus.url, at: stimulus.createdAt }));
}

function resolveStimuli() {
  for (const stimulus of manifest.stimuli.filter((s) => s.kind === 'ci' && s.accepted && !s.expected)) {
    const data = gh(`repos/${stimulus.repo}/commits/${stimulus.headSha}/check-runs?per_page=100`);
    if (data.total_count > data.check_runs.length) throw new Error('Check-run inventory requires pagination');
    const runs = data.check_runs.filter(
      (r) =>
        r.name === `GHSUB_EVENT_NONCE=${stimulus.nonce} GHSUB_EXPECT_KIND=ci` &&
        r.app?.slug === 'github-actions' &&
        r.head_sha === stimulus.headSha
    );
    if (runs.length !== 1 || runs[0].status !== 'completed' || runs[0].conclusion !== 'success')
      throw new Error('Expected one successful completed real fixture Actions check');
    stimulus.providerId = String(runs[0].id);
    stimulus.url = runs[0].html_url;
    stimulus.expected = fixtureExpected(stimulus, runs[0], config.runId);
    save();
  }
}

async function captureNango() {
  if (!config.nango?.destination || !config.nango?.connectionId || !config.nango?.providerConfigKey)
    throw new Error('Pin the normal Cloud Nango destination, connection, and integration in config.nango');
  const captures = [];
  for (const stimulus of manifest.stimuli.filter((s) => s.accepted)) {
    const from = Date.parse(stimulus.createdAt);
    const capture = await captureNangoForwards(
      (name, args) => nangoLogsCall(name, args, process.env.NANGO_SECRET_KEY),
      { ...config.nango, repo: stimulus.repo, nonce: stimulus.nonce },
      { from: new Date(from).toISOString(), to: new Date(Math.min(Date.now(), from + 120000)).toISOString() }
    );
    captures.push({ repo: stimulus.repo, kind: stimulus.kind, ...capture });
    record('nango-forward-evidence', { at: new Date().toISOString(), captures });
  }
  // Receipts alone do not establish application or agent action.
  console.log(
    JSON.stringify({
      capturedStimuli: captures.length,
      matchingForwards: captures.reduce((n, c) => n + c.receipts.length, 0),
    })
  );
}

function assertProof() {
  const messages = readLines('messages.jsonl'),
    events = readLines('events.jsonl');
  const results = manifest.stimuli.map((stimulus) => ({
    repo: stimulus.repo,
    kind: stimulus.kind,
    ...correlate({
      stimulus,
      messages,
      events,
      actor: config.receiver,
      actorId: config.actorIds?.[config.receiver],
      webhookAgentId: config.webhookAgentId,
      channel: config.actors[config.receiver],
      requireIdle: !stimulus.busy,
      strictFixture: true,
    }),
  }));
  const coverage = readLines('coverage.jsonl');
  const negatives = manifest.stimuli.flatMap((stimulus) =>
    (config.negativeChannels ?? []).map((channel) => ({
      channel,
      pass:
        hasContinuousCoverage(
          coverage,
          channel,
          Date.parse(stimulus.createdAt),
          Math.max(120, config.negativeWindowSeconds ?? 120) * 1000
        ) &&
        !messages.some(
          (m) =>
            m.channel === channel &&
            (m.text?.includes(`GHSUB_EVENT_NONCE=${stimulus.nonce}`) ||
              m.text?.includes(`GHSUB_ACK ${digest(stimulus.nonce)}`))
        ),
    }))
  );
  const report = {
    at: new Date().toISOString(),
    runId: config.runId,
    environment: config.environment,
    // This command proves only captured stimuli. Nine-gate signoff requires the entire acceptance matrix.
    ready: false,
    capturedStimuliPass: capturedStimuliPass(results, negatives),
    results,
    negatives,
  };
  record('proof', report);
  console.log(JSON.stringify(report, null, 2));
  if (!report.capturedStimuliPass) process.exitCode = 1;
}

function cleanup() {
  for (const fixture of manifest.fixtures) {
    if (!allowed.has(fixture.repo)) throw new Error('Unexpected manifest repository');
    if (fixture.pr && !fixture.closed) {
      const pr = gh(`repos/${fixture.repo}/pulls/${fixture.pr}`);
      if (pr.head.ref !== fixture.head || pr.base.ref !== fixture.base || !pr.title.includes(config.runId))
        throw new Error('Fixture ownership changed; reconcile manually');
      if (pr.state === 'open') gh(`repos/${fixture.repo}/pulls/${fixture.pr}`, 'PATCH', { state: 'closed' });
      fixture.closed = true;
      save();
    }
    for (const branch of [...fixture.branches]) {
      if (!branch.startsWith(`ghsub-demo/${config.runId}/`))
        throw new Error('Refusing unowned branch deletion');
      const expectedSha = branch === fixture.head ? fixture.headSha : (fixture.baseSha ?? fixture.startSha);
      if (gh(`repos/${fixture.repo}/git/ref/heads/${branch}`).object.sha !== expectedSha)
        throw new Error('Owned branch advanced outside the manifest; refusing deletion');
      gh(`repos/${fixture.repo}/git/refs/heads/${branch}`, 'DELETE');
      fixture.branches = fixture.branches.filter((b) => b !== branch);
      save();
    }
  }
  console.log(
    'Owned fixture PRs closed and branches deleted. Comments/reviews remain as evidence on closed disposable PRs. Restore only inventoried subscription bindings separately.'
  );
}

try {
  if (command === 'preflight') await preflight();
  if (command === 'prepare') prepare();
  if (command === 'subscribe') await subscriptions();
  if (command === 'unsubscribe') await subscriptions(true);
  if (command === 'collect') await collect();
  if (command === 'emit') emit();
  if (command === 'resolve') resolveStimuli();
  if (command === 'capture-nango') await captureNango();
  if (command === 'assert') assertProof();
  if (command === 'cleanup') cleanup();
  if (command === 'receiver-task') console.log(receiverTask);
} catch (error) {
  record('failure', { at: new Date().toISOString(), command, message: error.message });
  console.error(error.message);
  process.exitCode = 1;
}
