#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { correlate, receiverTask, hasContinuousCoverage } from './proof.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const [command, configFile, ...args] = process.argv.slice(2);
if (
  !configFile ||
  !['preflight', 'prepare', 'collect', 'emit', 'assert', 'cleanup', 'receiver-task'].includes(command)
) {
  console.error(
    'Usage: node tests/e2e/github-subscriptions/run.mjs <preflight|prepare|collect|emit|assert|cleanup|receiver-task> config.json [arguments]'
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
        title: `[DISPOSABLE DEMO ${config.runId}] GitHub subscriptions`,
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
      const updatedConfig = JSON.parse(readFileSync(configFile, 'utf8'));
      channels = [
        ...new Set([...Object.values(updatedConfig.actors ?? {}), ...(updatedConfig.negativeChannels ?? [])]),
      ];
      for (const channel of channels) {
        const messages = await cast(`/v1/channels/${encodeURIComponent(channel)}/messages?limit=100`);
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
  const text = `GHSUB_EVENT_NONCE=${nonce}`;
  const stimulus = {
    repo: fixture.repo,
    pr: fixture.pr,
    kind,
    nonce,
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
  }
  stimulus.providerId = response.id ?? response.sha ?? response.commit?.sha;
  stimulus.url = response.html_url ?? response.content?.html_url ?? fixture.url;
  stimulus.accepted = true;
  save();
  console.log(JSON.stringify({ repo: stimulus.repo, kind, url: stimulus.url, at: stimulus.createdAt }));
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
          (config.negativeWindowSeconds ?? 120) * 1000
        ) &&
        !messages.some(
          (m) => m.channel === channel && m.text?.includes(`GHSUB_EVENT_NONCE=${stimulus.nonce}`)
        ),
    }))
  );
  const report = {
    at: new Date().toISOString(),
    runId: config.runId,
    environment: config.environment,
    // This command proves only captured stimuli. Nine-gate signoff requires the entire acceptance matrix.
    ready: false,
    capturedStimuliPass: results.length > 0 && results.every((r) => r.pass) && negatives.every((r) => r.pass),
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
  if (command === 'collect') await collect();
  if (command === 'emit') emit();
  if (command === 'assert') assertProof();
  if (command === 'cleanup') cleanup();
  if (command === 'receiver-task') console.log(receiverTask);
} catch (error) {
  record('failure', { at: new Date().toISOString(), command, message: error.message });
  console.error(error.message);
  process.exitCode = 1;
}
