import { describe, expect, it } from 'vitest';

import type { RelayfileChangeEvent } from '@agent-relay/events';
import type { WorkspaceFileLike } from '../types.js';
import { slackProvider } from './slack.js';

const META_PATH = '/slack/channels/C123__ops/messages/1700000000_000100/meta.json';

function changeEvent(overrides: Partial<RelayfileChangeEvent> = {}): RelayfileChangeEvent {
  return {
    id: 'evt-1',
    workspace: 'ws-1',
    type: 'relayfile.changed',
    occurredAt: '2026-05-28T00:00:00.000Z',
    attempt: 1,
    resource: { path: META_PATH, kind: 'slack.message', id: 'm1', provider: 'slack' },
    summary: {},
    expand: (async () => ({})) as unknown as RelayfileChangeEvent['expand'],
    path: META_PATH,
    action: 'created',
    ...overrides,
  } as RelayfileChangeEvent;
}

function file(body: unknown, path = META_PATH): WorkspaceFileLike {
  return { path, body };
}

const ctx = { replyId: 'r-abcd1234' };

describe('slackProvider.resolveInbound', () => {
  it('maps a channel message to an inbound item with a threaded reply path', () => {
    const item = slackProvider().resolveInbound(
      changeEvent(),
      file({ type: 'message', user: 'U1', username: 'alice', text: 'deploy staging please' }),
      ctx
    );

    expect(item).not.toBeNull();
    expect(item?.source).toBe('#ops');
    expect(item?.body).toContain('deploy staging please');
    expect(item?.body).toContain('alice');
    expect(item?.replyPath).toBe(
      '/slack/channels/C123__ops/messages/1700000000_000100/replies/draft-r-abcd1234.json'
    );
  });

  it('serializes a reply as Slack post JSON', () => {
    const item = slackProvider().resolveInbound(changeEvent(), file({ text: 'hi' }), ctx);
    expect(item?.serializeReply('on it')).toEqual({
      content: '{"text":"on it"}',
      contentType: 'application/json',
    });
  });

  it('ignores bot messages to prevent reply loops', () => {
    expect(
      slackProvider().resolveInbound(changeEvent(), file({ text: 'beep', subtype: 'bot_message' }), ctx)
    ).toBeNull();
    expect(
      slackProvider().resolveInbound(changeEvent(), file({ text: 'beep', bot_id: 'B1' }), ctx)
    ).toBeNull();
  });

  it('honors ignoreUserIds', () => {
    const provider = slackProvider({ ignoreUserIds: ['U1'] });
    expect(provider.resolveInbound(changeEvent(), file({ text: 'hey', user: 'U1' }), ctx)).toBeNull();
  });

  it('ignores agent-authored changes (our own writeback)', () => {
    expect(
      slackProvider().resolveInbound(changeEvent({ agentId: 'a1' }), file({ text: 'x' }), ctx)
    ).toBeNull();
  });

  it('ignores deletes and non-message paths', () => {
    expect(slackProvider().resolveInbound(changeEvent({ action: 'deleted' }), file({}), ctx)).toBeNull();

    const replyPath = '/slack/channels/C123__ops/messages/1700000000_000100/replies/draft-x.json';
    expect(
      slackProvider().resolveInbound(changeEvent({ path: replyPath }), file({ text: 'x' }, replyPath), ctx)
    ).toBeNull();
  });
});
