/**
 * Slack Parser Tests
 */

import { describe, it, expect } from 'vitest';
import { slackParser } from './slack.js';

describe('slackParser', () => {
  describe('URL verification', () => {
    it('should return empty array for url_verification', () => {
      const payload = {
        type: 'url_verification',
        challenge: 'test-challenge-token',
      };

      const events = slackParser.parse(payload, {});

      expect(events).toHaveLength(0);
    });
  });

  describe('Non-event payloads', () => {
    it('should return empty array for non-event_callback type', () => {
      const payload = {
        type: 'interactive_message',
        callback_id: 'some-callback',
      };

      const events = slackParser.parse(payload, {});

      expect(events).toHaveLength(0);
    });
  });

  describe('app_mention events', () => {
    it('should parse app mention event', () => {
      const payload = {
        type: 'event_callback',
        team_id: 'T12345',
        event_id: 'Ev12345',
        event_time: 1705320000,
        event: {
          type: 'app_mention',
          user: 'U12345',
          text: '<@U_BOT_ID> can you help me with this?',
          ts: '1705320000.000100',
          channel: 'C12345',
          channel_type: 'channel',
        },
      };

      const events = slackParser.parse(payload, {});

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('mention');
      expect(events[0].source).toBe('slack');
      expect(events[0].actor.id).toBe('U12345');
      expect(events[0].item?.type).toBe('message');
      // Should default to 'lead' when no specific agent mentioned
      expect(events[0].mentions).toContain('lead');
      expect(events[0].metadata?.channelId).toBe('C12345');
    });

    it('should extract agent mentions from message', () => {
      const payload = {
        type: 'event_callback',
        team_id: 'T12345',
        event_id: 'Ev12346',
        event_time: 1705320000,
        event: {
          type: 'app_mention',
          user: 'U12345',
          text: '<@U_BOT_ID> @developer please help with this bug',
          ts: '1705320000.000200',
          channel: 'C12345',
        },
      };

      const events = slackParser.parse(payload, {});

      expect(events).toHaveLength(1);
      expect(events[0].mentions).toContain('developer');
    });

    it('should clean Slack user mentions from text', () => {
      const payload = {
        type: 'event_callback',
        team_id: 'T12345',
        event_id: 'Ev12347',
        event_time: 1705320000,
        event: {
          type: 'app_mention',
          user: 'U12345',
          text: '<@U_BOT_ID> hey <@U67890|john> check this',
          ts: '1705320000.000300',
          channel: 'C12345',
        },
      };

      const events = slackParser.parse(payload, {});

      // Body should have cleaned text
      expect(events[0].item?.body).toContain('@john');
      expect(events[0].item?.body).not.toContain('<@');
    });

    it('should capture thread context', () => {
      const payload = {
        type: 'event_callback',
        team_id: 'T12345',
        event_id: 'Ev12348',
        event_time: 1705320000,
        event: {
          type: 'app_mention',
          user: 'U12345',
          text: '<@U_BOT_ID> replying in thread',
          ts: '1705320000.000400',
          thread_ts: '1705310000.000100',
          channel: 'C12345',
        },
      };

      const events = slackParser.parse(payload, {});

      expect(events[0].metadata?.threadTs).toBe('1705310000.000100');
    });
  });

  describe('message events', () => {
    it('should parse message with agent mention', () => {
      const payload = {
        type: 'event_callback',
        team_id: 'T12345',
        event_id: 'Ev12349',
        event_time: 1705320000,
        event: {
          type: 'message',
          user: 'U12345',
          text: '@reviewer can you check this PR?',
          ts: '1705320000.000500',
          channel: 'C12345',
          channel_type: 'channel',
        },
      };

      const events = slackParser.parse(payload, {});

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('mention');
      expect(events[0].mentions).toContain('reviewer');
    });

    it('should not create event for regular message without agent mention', () => {
      const payload = {
        type: 'event_callback',
        team_id: 'T12345',
        event_id: 'Ev12350',
        event_time: 1705320000,
        event: {
          type: 'message',
          user: 'U12345',
          text: 'Just a regular message',
          ts: '1705320000.000600',
          channel: 'C12345',
        },
      };

      const events = slackParser.parse(payload, {});

      expect(events).toHaveLength(0);
    });

    it('should ignore bot messages', () => {
      const payload = {
        type: 'event_callback',
        team_id: 'T12345',
        event_id: 'Ev12351',
        event_time: 1705320000,
        event: {
          type: 'message',
          subtype: 'bot_message',
          user: 'U_BOT',
          text: '@developer check this',
          ts: '1705320000.000700',
          channel: 'C12345',
        },
      };

      const events = slackParser.parse(payload, {});

      expect(events).toHaveLength(0);
    });

    it('should ignore message_changed subtypes', () => {
      const payload = {
        type: 'event_callback',
        team_id: 'T12345',
        event_id: 'Ev12352',
        event_time: 1705320000,
        event: {
          type: 'message',
          subtype: 'message_changed',
          user: 'U12345',
          text: '@developer check this',
          ts: '1705320000.000800',
          channel: 'C12345',
        },
      };

      const events = slackParser.parse(payload, {});

      expect(events).toHaveLength(0);
    });

    it('should allow thread_broadcast subtype', () => {
      const payload = {
        type: 'event_callback',
        team_id: 'T12345',
        event_id: 'Ev12353',
        event_time: 1705320000,
        event: {
          type: 'message',
          subtype: 'thread_broadcast',
          user: 'U12345',
          text: '@lead important update',
          ts: '1705320000.000900',
          channel: 'C12345',
        },
      };

      const events = slackParser.parse(payload, {});

      expect(events).toHaveLength(1);
      expect(events[0].mentions).toContain('lead');
    });
  });

  describe('reaction_added events', () => {
    it('should parse reaction added event', () => {
      const payload = {
        type: 'event_callback',
        team_id: 'T12345',
        event_id: 'Ev12354',
        event_time: 1705320000,
        event: {
          type: 'reaction_added',
          user: 'U12345',
          reaction: 'thumbsup',
          item: {
            type: 'message',
            channel: 'C12345',
            ts: '1705310000.000100',
          },
        },
      };

      const events = slackParser.parse(payload, {});

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('reaction_added');
      expect(events[0].labels).toContain('thumbsup');
      expect(events[0].metadata?.reaction).toBe('thumbsup');
    });
  });

  describe('channel_created events', () => {
    it('should parse channel created event', () => {
      const payload = {
        type: 'event_callback',
        team_id: 'T12345',
        event_id: 'Ev12355',
        event_time: 1705320000,
        event: {
          type: 'channel_created',
          channel: {
            id: 'C_NEW',
            name: 'project-alpha',
            creator: 'U12345',
          },
        },
      };

      const events = slackParser.parse(payload, {});

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('channel_created');
      expect(events[0].context.name).toBe('project-alpha');
    });
  });

  describe('member_joined_channel events', () => {
    it('should parse member joined event', () => {
      const payload = {
        type: 'event_callback',
        team_id: 'T12345',
        event_id: 'Ev12356',
        event_time: 1705320000,
        event: {
          type: 'member_joined_channel',
          user: 'U_NEW',
          channel: 'C12345',
          inviter: 'U12345',
        },
      };

      const events = slackParser.parse(payload, {});

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('member_joined');
      expect(events[0].actor.id).toBe('U_NEW');
      expect(events[0].metadata?.inviter).toBe('U12345');
    });
  });

  describe('Unknown events', () => {
    it('should create generic event for unknown types', () => {
      const payload = {
        type: 'event_callback',
        team_id: 'T12345',
        event_id: 'Ev12357',
        event_time: 1705320000,
        event: {
          type: 'file_shared',
          user: 'U12345',
          file_id: 'F12345',
        },
      };

      const events = slackParser.parse(payload, {});

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('slack.file_shared');
    });
  });

  describe('Text cleaning', () => {
    it('should clean URLs from text', () => {
      const payload = {
        type: 'event_callback',
        team_id: 'T12345',
        event_id: 'Ev12358',
        event_time: 1705320000,
        event: {
          type: 'app_mention',
          user: 'U12345',
          text: '<@U_BOT> check <https://example.com|this link> and <https://other.com>',
          ts: '1705320000.001000',
          channel: 'C12345',
        },
      };

      const events = slackParser.parse(payload, {});

      expect(events[0].item?.body).toContain('this link');
      expect(events[0].item?.body).toContain('https://other.com');
      expect(events[0].item?.body).not.toContain('<https://');
    });
  });

  describe('Multiple agent mentions', () => {
    it('should extract all mentioned agents', () => {
      const payload = {
        type: 'event_callback',
        team_id: 'T12345',
        event_id: 'Ev12359',
        event_time: 1705320000,
        event: {
          type: 'app_mention',
          user: 'U12345',
          text: '<@U_BOT> @lead please assign @developer to review this with @reviewer',
          ts: '1705320000.001100',
          channel: 'C12345',
        },
      };

      const events = slackParser.parse(payload, {});

      expect(events[0].mentions).toContain('lead');
      expect(events[0].mentions).toContain('developer');
      expect(events[0].mentions).toContain('reviewer');
    });
  });
});
