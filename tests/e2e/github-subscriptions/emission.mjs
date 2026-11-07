import { randomBytes } from 'node:crypto';
import { fixtureExpected } from './fixture-scope.mjs';
const fixtureName = (repo) => repo.split('/')[1];

export function emitStimulus({
  args,
  manifest,
  config,
  readLines,
  save,
  gh,
  log = console.log,
  now = () => new Date().toISOString(),
}) {
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
    base: fixture.base,
    line: 2,
    side: 'RIGHT',
    createdAt: now(),
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
    if (response.merged !== true || !/^[a-f0-9]{40}$/.test(response.sha ?? ''))
      throw new Error('Fixture merge did not return a valid acknowledgement');
    fixture.merged = true;
    fixture.baseSha = response.sha;
    stimulus.accepted = true;
    stimulus.mergeSha = response.sha;
    save(); // Persist acknowledged ownership before the fallible provider readback.
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
  save(); // Preserve acknowledged ownership even if provider-shape validation fails below.
  if (kind !== 'ci') stimulus.expected = fixtureExpected(stimulus, response, config.runId);
  save();
  log(JSON.stringify({ repo: stimulus.repo, kind, url: stimulus.url, at: stimulus.createdAt }));
}
