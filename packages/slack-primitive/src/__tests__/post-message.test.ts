import { describe, expect, it } from 'vitest';

import { postMessage } from '../actions/post-message.js';
import { resolveChannel } from '../actions/resolve-channel.js';
import { SlackWebApiClient } from '../local-runtime.js';
import { SlackPostBackError, type SlackWebApiLike } from '../types.js';
import { renderSlackTemplates } from '../workflow-step.js';

describe('Slack primitive', () => {
  it('throws auth_token_missing when SLACK_BOT_TOKEN is absent', () => {
    expect(() => new SlackWebApiClient({ env: {} })).toThrow(SlackPostBackError);
    expect(() => new SlackWebApiClient({ env: {} })).toThrow('auth_token_missing');
  });

  it('resolves #channel names through conversations.list', async () => {
    const slack = createRecordingSlack();

    await expect(resolveChannel(slack, '#engineering')).resolves.toEqual({
      id: 'CENGINEERING',
      name: 'engineering',
    });
    expect(slack.calls.conversationsList).toBe(1);
  });

  it('resolves email and handle mentions before posting', async () => {
    const slack = createRecordingSlack();

    const result = await postMessage(slack, {
      channel: '#engineering',
      text: 'PR opened',
      mentions: ['@dev@example.com', '@khaliq'],
    });

    expect(result.resolvedMentions).toEqual([
      { input: '@dev@example.com', userId: 'UEMAIL' },
      { input: '@khaliq', userId: 'UHANDLE' },
    ]);
    expect(result.unresolvedMentions).toEqual([]);
    expect(slack.lastPost?.text).toBe('<@UEMAIL> <@UHANDLE> PR opened');
  });

  it('soft-fails unresolved mentions and still posts the message', async () => {
    const slack = createRecordingSlack();

    const result = await postMessage(slack, {
      channel: 'CENGINEERING',
      text: 'PR opened',
      mentions: ['@missing'],
    });

    expect(result.unresolvedMentions).toEqual(['@missing']);
    expect(result.warnings).toEqual([
      {
        type: 'mention_unresolved',
        input: '@missing',
        message: 'Slack user not found for handle: @missing',
      },
    ]);
    expect(slack.lastPost?.channel).toBe('CENGINEERING');
    expect(slack.lastPost?.text).toBe('PR opened');
  });

  it('substitutes {{steps.X.output}} templates by nested path', () => {
    const text = renderSlackTemplates('Opened {{steps.create-pr.output.htmlUrl}}', {
      steps: {
        'create-pr': {
          output: {
            htmlUrl: 'https://github.test/octo/repo/pull/7',
          },
        },
      },
    });

    expect(text).toBe('Opened https://github.test/octo/repo/pull/7');
  });
});

interface RecordingSlack extends SlackWebApiLike {
  calls: {
    conversationsList: number;
    usersList: number;
    lookupByEmail: number;
    postMessage: number;
  };
  lastPost?: {
    channel: string;
    text: string;
  };
}

function createRecordingSlack(): RecordingSlack {
  const slack: RecordingSlack = {
    calls: {
      conversationsList: 0,
      usersList: 0,
      lookupByEmail: 0,
      postMessage: 0,
    },
    conversations: {
      async list() {
        slack.calls.conversationsList += 1;
        return {
          ok: true,
          channels: [
            {
              id: 'CENGINEERING',
              name: 'engineering',
            },
          ],
        };
      },
    },
    users: {
      async lookupByEmail({ email }) {
        slack.calls.lookupByEmail += 1;
        if (email === 'dev@example.com') {
          return {
            ok: true,
            user: {
              id: 'UEMAIL',
              name: 'dev',
              profile: {
                email,
              },
            },
          };
        }
        return { ok: false, error: 'users_not_found' };
      },
      async list() {
        slack.calls.usersList += 1;
        return {
          ok: true,
          members: [
            {
              id: 'UHANDLE',
              name: 'khaliq',
              profile: {
                displayName: 'khaliq',
              },
            },
          ],
        };
      },
    },
    chat: {
      async postMessage(params) {
        slack.calls.postMessage += 1;
        slack.lastPost = {
          channel: params.channel,
          text: params.text,
        };
        return {
          ok: true,
          channel: params.channel,
          ts: '1710000000.000001',
          message: {
            text: params.text,
          },
        };
      },
    },
  };

  return slack;
}
