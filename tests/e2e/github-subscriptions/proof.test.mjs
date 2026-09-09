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
