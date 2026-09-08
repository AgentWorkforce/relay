import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correlate, digest, semanticMatches, hasContinuousCoverage } from './proof.mjs';

const fixture = () => {
  const nonce = '0123456789abcdef0123456789abcdef';
  const stimulus = { nonce, kind: 'comment', createdAt: '2026-09-08T12:00:01Z', idleAfter: '2026-09-08T12:00:00Z', url: 'https://github.com/fixture' };
  return { stimulus, actor: 'test-hyphen', actorId: 'actor-id', webhookAgentId: 'webhook-id', channel: 'fresh',
    messages: [
      { id: 'event-message', agent_id: 'webhook-id', agent_name: 'github-user', channel: 'fresh', text: `GHSUB_EVENT_NONCE=${nonce}`, created_at: '2026-09-08T12:00:02Z', metadata: { provider: 'github', provider_event_type: 'issue_comment.created', relayfile: { eventId: 'provider-event' } } },
      { id: 'action-message', agent_id: 'actor-id', agent_name: 'test-hyphen', channel: 'fresh', text: `GHSUB_ACK ${digest(nonce)}`, created_at: '2026-09-08T12:00:05Z' },
    ], events: [
      { kind: 'agent_idle', name: 'test-hyphen', observedAt: '2026-09-08T12:00:00Z' },
      { kind: 'delivery_injected', name: 'test-hyphen', event_id: 'event-message', delivery_id: 'delivery', observedAt: '2026-09-08T12:00:03Z' },
    ] };
};
test('correlates the distinct provider, node and actor links', () => assert.equal(correlate(fixture()).pass, true));
for (const [name, mutate] of [
  ['self-authored nonce report', f => { f.messages[0].agent_id = 'observer'; }],
  ['spoofed actor display name', f => { f.messages[1].agent_id = 'observer'; }],
  ['generic file.updated receipt', f => { f.messages[0].metadata.provider_event_type = 'file.updated'; }],
  ['delivery for a different event', f => { f.events[1].event_id = 'other'; }],
  ['echo without computed action', f => { f.messages[1].text = f.messages[0].text; }],
  ['missing second idle boundary', f => { f.stimulus.idleAfter = '2026-09-08T12:00:00.500Z'; }],
]) test(`rejects ${name}`, () => { const f = fixture(); mutate(f); assert.equal(correlate(f).pass, false); });
test('semantic matrix rejects unmerged closures, thread replies, and unfinished CI', () => {
  for (const [kind, type, record] of [['merge', 'pull_request.closed', { merged: false }], ['thread', 'pull_request_review_comment.created', { id: 1, in_reply_to_id: 2 }], ['ci', 'check_run.completed', { conclusion: null }]])
    assert.equal(semanticMatches(kind, { metadata: { provider_event_type: type, record } }), false);
});

test('negative evidence requires continuous observation through its deadline', () => {
  const times = [0, 5000, 10000, 15000, 20000].map(t => ({at: new Date(t).toISOString(), channels: ['negative']}));
  assert.equal(hasContinuousCoverage(times, 'negative', 1000, 18000), true);
  assert.equal(hasContinuousCoverage([times[0], times[4]], 'negative', 1000, 18000), false);
  assert.equal(hasContinuousCoverage(times.slice(0, 2), 'negative', 1000, 18000), false);
  assert.equal(hasContinuousCoverage(times, 'unobserved', 1000, 18000), false);
});
test('duplicate actor actions do not pass exactly-once evidence', () => {
  const f = fixture(); f.messages.push({...f.messages[1], id: 'duplicate-action'});
  assert.equal(correlate(f).pass, false);
});
