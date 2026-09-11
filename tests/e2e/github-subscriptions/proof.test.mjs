import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { persistWorkerDiagnostics } from './proof.mjs';
import assert from 'node:assert/strict';
import {
  correlate,
  digest,
  semanticMatches,
  hasContinuousCoverage,
  standaloneControlsAfter,
  collectUnseenMessages,
} from './proof.mjs';

test('no-poke audit catches background Enter after idle and excludes initial submission', () => {
  const before =
    '2026-09-08T20:27:25.677751Z DEBUG relay_pty::startup_input: writing terminal control input control=[13]';
  const after =
    '2026-09-08T20:28:35.404753Z DEBUG relay_pty::startup_input: writing terminal control input control=[13]';
  assert.deepEqual(standaloneControlsAfter(before, '2026-09-08T20:28:29Z'), []);
  assert.deepEqual(standaloneControlsAfter(before + '\n' + after, '2026-09-08T20:28:29Z'), [
    { at: '2026-09-08T20:28:35.404753Z', control: '13' },
  ]);
  assert.throws(() => standaloneControlsAfter(after, undefined), /idle boundary/);
  assert.throws(
    () => standaloneControlsAfter('writing terminal control input unknown format', '2026-09-08T20:28:29Z'),
    /Unrecognized/
  );
});

test('history collector crosses full pages and rejects a stalled cursor', async () => {
  const message = (id) => ({ id, created_at: '2026-09-08T12:00:00Z' });
  const pages = [
    [message('4'), message('3')],
    [message('2'), message('1')],
  ];
  const cursors = [];
  const result = await collectUnseenMessages(
    async (before) => {
      cursors.push(before);
      return pages.shift();
    },
    new Set(['1']),
    0,
    2
  );
  assert.deepEqual(
    result.map((m) => m.id),
    ['4', '3', '2']
  );
  assert.deepEqual(cursors, [undefined, '3']);
  await assert.rejects(
    collectUnseenMessages(async () => [message('4'), message('3')], new Set(), 0, 2),
    /did not advance/
  );
  await assert.rejects(
    collectUnseenMessages(async () => [{ id: '1' }], new Set(), 0),
    /timestamp/
  );
});

const fixture = () => {
  const nonce = '0123456789abcdef0123456789abcdef';
  const stimulus = {
    nonce,
    kind: 'comment',
    createdAt: '2026-09-08T12:00:01Z',
    idleAfter: '2026-09-08T12:00:00Z',
    url: 'https://github.com/fixture',
  };
  return {
    stimulus,
    actor: 'test-hyphen',
    actorId: 'actor-id',
    webhookAgentId: 'webhook-id',
    channel: 'fresh',
    messages: [
      {
        id: 'event-message',
        agent_id: 'webhook-id',
        agent_name: 'github-user',
        channel: 'fresh',
        text: `GHSUB_EVENT_NONCE=${nonce}`,
        created_at: '2026-09-08T12:00:02Z',
        metadata: {
          provider: 'github',
          provider_event_type: 'issue_comment.created',
          relayfile: { eventId: 'provider-event' },
        },
      },
      {
        id: 'action-message',
        agent_id: 'actor-id',
        agent_name: 'test-hyphen',
        channel: 'fresh',
        text: `GHSUB_ACK ${digest(nonce)}`,
        created_at: '2026-09-08T12:00:05Z',
      },
    ],
    events: [
      { kind: 'agent_idle', name: 'test-hyphen', observedAt: '2026-09-08T12:00:00Z' },
      {
        kind: 'delivery_injected',
        name: 'test-hyphen',
        event_id: 'event-message',
        delivery_id: 'delivery',
        observedAt: '2026-09-08T12:00:03Z',
      },
    ],
  };
};
test('correlates the distinct provider, node and actor links', () =>
  assert.equal(correlate(fixture()).pass, true));
for (const [name, mutate] of [
  [
    'self-authored nonce report',
    (f) => {
      f.messages[0].agent_id = 'observer';
    },
  ],
  [
    'spoofed actor display name',
    (f) => {
      f.messages[1].agent_id = 'observer';
    },
  ],
  [
    'generic file.updated receipt',
    (f) => {
      f.messages[0].metadata.provider_event_type = 'file.updated';
    },
  ],
  [
    'delivery for a different event',
    (f) => {
      f.events[1].event_id = 'other';
    },
  ],
  [
    'echo without computed action',
    (f) => {
      f.messages[1].text = f.messages[0].text;
    },
  ],
  [
    'missing second idle boundary',
    (f) => {
      f.stimulus.idleAfter = '2026-09-08T12:00:00.500Z';
    },
  ],
])
  test(`rejects ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.equal(correlate(f).pass, false);
  });
test('semantic matrix rejects unmerged closures, thread replies, and unfinished CI', () => {
  for (const [kind, type, record] of [
    ['merge', 'pull_request.closed', { merged: false }],
    ['thread', 'pull_request_review_comment.created', { id: 1, in_reply_to_id: 2 }],
    ['ci', 'check_run.completed', { conclusion: null }],
  ])
    assert.equal(semanticMatches(kind, { metadata: { provider_event_type: type, record } }), false);
});

test('negative evidence requires continuous observation through its deadline', () => {
  const times = [0, 5000, 10000, 15000, 20000].map((t) => ({
    at: new Date(t).toISOString(),
    channels: ['negative'],
  }));
  assert.equal(hasContinuousCoverage(times, 'negative', 1000, 18000), true);
  assert.equal(hasContinuousCoverage([times[0], times[4]], 'negative', 1000, 18000), false);
  assert.equal(hasContinuousCoverage(times.slice(0, 2), 'negative', 1000, 18000), false);
  assert.equal(hasContinuousCoverage(times, 'unobserved', 1000, 18000), false);
});
test('duplicate actor actions do not pass exactly-once evidence', () => {
  const f = fixture();
  f.messages.push({ ...f.messages[1], id: 'duplicate-action' });
  assert.equal(correlate(f).pass, false);
});

test('captured success requires an observed negative arm', async () => {
  const { capturedStimuliPass } = await import('./proof.mjs');
  assert.equal(capturedStimuliPass([{ pass: true }], []), false);
  assert.equal(capturedStimuliPass([{ pass: true }], [{ pass: false }]), false);
  assert.equal(capturedStimuliPass([{ pass: true }], [{ pass: true }]), true);
});

test('startup failure retains sanitized diagnostics without inventing an idle audit', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ghsub-diagnostic-'));
  try {
    assert.equal(
      persistWorkerDiagnostics(dir, 'owned.log', 'Login failed: rk_live_private', undefined),
      null
    );
    const data = JSON.parse(readFileSync(path.join(dir, 'diagnostics.json'), 'utf8'));
    assert.equal(data[0].tail, 'Login failed: [redacted]');
    persistWorkerDiagnostics(dir, 'owned.log', 'harness startup gate rk_live_private', undefined);
    assert.equal(
      readFileSync(path.join(dir, 'startup-gates.log'), 'utf8'),
      'harness startup gate [redacted]\n'
    );
    assert.throws(
      () => persistWorkerDiagnostics(dir, 'owned.log', 'bad audit boundary', 'invalid'),
      /idle boundary/
    );
    assert.equal(
      JSON.parse(readFileSync(path.join(dir, 'diagnostics.json'), 'utf8'))[0].tail,
      'bad audit boundary'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [name, mutate] of [
  [
    'action before injection',
    (f) => {
      f.messages[1].created_at = '2026-09-08T12:00:02Z';
    },
  ],
  [
    'action after deadline',
    (f) => {
      f.messages[1].created_at = '2026-09-08T13:00:05Z';
    },
  ],
  [
    'unaccepted producer intent',
    (f) => {
      f.stimulus.accepted = false;
    },
  ],
  [
    'receiver exited after idle',
    (f) => {
      f.events.push({ kind: 'agent_exited', name: f.actor, observedAt: '2026-09-08T12:00:00.500Z' });
    },
  ],
  [
    'nonce acknowledged before terminal event',
    (f) => {
      f.messages.push({ ...f.messages[1], id: 'early', created_at: '2026-09-08T11:59:59Z' });
    },
  ],
])
  test(`rejects ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.equal(correlate(f).pass, false);
  });

test('exact fixture matching rejects another GitHub object and unsafe numeric IDs', () => {
  const f = fixture();
  f.stimulus.expected = {
    path: '/github/repos/owner/repo/comments/9007199254740993.json',
    record: { id: '9007199254740993', user: { login: 'fixture-author' } },
  };
  f.messages[0].metadata.path = f.stimulus.expected.path;
  f.messages[0].metadata.record = structuredClone(f.stimulus.expected.record);
  assert.equal(correlate(f).pass, true);
  f.messages[0].metadata.record.id = 9007199254740993;
  assert.equal(correlate(f).pass, false);
  f.messages[0].metadata.record = structuredClone(f.stimulus.expected.record);
  f.messages[0].metadata.record.user.login = 'other-author';
  assert.equal(correlate(f).pass, false);
  f.messages[0].metadata.record = structuredClone(f.stimulus.expected.record);
  f.messages[0].metadata.path = '/github/repos/owner/other/comments/9007199254740993.json';
  assert.equal(correlate(f).pass, false);
});

test('strict live fixture mode cannot accept an unbound rehearsal trace', () => {
  assert.equal(correlate({ ...fixture(), strictFixture: true }).pass, false);
});

test('strict fixture assertion rejects incomplete external schemas and mismatched stimulus bindings', async () => {
  const { fixtureExpected } = await import('./fixture-scope.mjs');
  for (const kind of ['comment', 'review', 'thread', 'merge', 'ci']) {
    const f = fixture();
    Object.assign(f.stimulus, {
      kind,
      accepted: true,
      repo: 'AgentWorkforce/relay',
      pr: 123,
      providerId: '456',
      headSha: 'a'.repeat(40),
      base: 'owned-base',
      file: 'owned.txt',
      line: 2,
      side: 'RIGHT',
    });
    f.strictFixture = true;
    f.stimulus.expected = fixtureExpected(
      f.stimulus,
      {
        id: '456',
        user: { login: 'owner' },
        submitted_at: '2026-09-11T12:00:00Z',
        pull_request_review_id: '789',
        merge_commit_sha: 'b'.repeat(40),
        name: 'owned-check',
      },
      'test'
    );
    Object.assign(f.messages[0].metadata, {
      path: f.stimulus.expected.path,
      record: structuredClone(f.stimulus.expected.record),
      provider_event_type: {
        comment: 'issue_comment.created',
        review: 'pull_request_review.submitted',
        thread: 'pull_request_review_comment.created',
        merge: 'pull_request.closed',
        ci: 'check_run.completed',
      }[kind],
    });
    assert.equal(correlate(f).pass, true, kind);
    for (const key of Object.keys(f.stimulus.expected.record)) {
      const adverse = structuredClone(f);
      delete adverse.stimulus.expected.record[key];
      assert.equal(correlate(adverse).pass, false, kind + ' missing ' + key);
    }
    for (const patch of [{ providerId: '999' }, { repo: 'AgentWorkforce/other' }, { headSha: 'bad' }]) {
      if (kind === 'comment' && patch.headSha) continue;
      const adverse = structuredClone(f);
      Object.assign(adverse.stimulus, patch);
      assert.equal(correlate(adverse).pass, false, kind + JSON.stringify(patch));
    }
  }
});

for (const kind of ['agent_exited', 'delivery_failed'])
  test(`rejects ${kind} after ACK within response deadline`, () => {
    const f = fixture();
    f.events.push({ kind, name: f.actor, observedAt: '2026-09-08T12:00:06Z' });
    assert.equal(correlate(f).pass, false);
    f.events.at(-1).observedAt = '2026-09-08T12:03:00Z';
    assert.equal(correlate(f).pass, true);
  });
