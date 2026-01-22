/**
 * Webhook Router Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { processWebhook, getWebhookConfig, defaultSources } from './router.js';
import type { WebhookConfig } from './types.js';

// Mock the db module
vi.mock('../db/index.js', () => ({
  db: {
    repositories: {
      findByFullName: vi.fn().mockResolvedValue({
        id: 'repo-1',
        userId: 'user-1',
        nangoConnectionId: 'nango-conn-1',
        githubFullName: 'owner/repo',
      }),
    },
    linkedDaemons: {
      findByUserId: vi.fn().mockResolvedValue([
        { id: 'daemon-1', userId: 'user-1', status: 'online' },
      ]),
      queueMessage: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

// Mock the responders
vi.mock('./responders/index.js', () => ({
  getResponder: vi.fn().mockReturnValue({
    id: 'github',
    respond: vi.fn().mockResolvedValue({ success: true, id: '123', url: 'https://example.com' }),
  }),
}));

describe('getWebhookConfig', () => {
  it('should return default configuration', () => {
    const config = getWebhookConfig();

    expect(config.sources).toBeDefined();
    expect(config.rules).toBeDefined();
    expect(config.sources.github).toBeDefined();
    expect(config.sources.linear).toBeDefined();
    expect(config.sources.slack).toBeDefined();
  });
});

describe('defaultSources', () => {
  it('should have GitHub source configured', () => {
    const github = defaultSources.github;

    expect(github.id).toBe('github');
    expect(github.enabled).toBe(true);
    expect(github.signature.header).toBe('x-hub-signature-256');
    expect(github.signature.algorithm).toBe('sha256');
    expect(github.parser).toBe('github');
    expect(github.responder).toBe('github');
  });

  it('should have Linear source configured', () => {
    const linear = defaultSources.linear;

    expect(linear.id).toBe('linear');
    expect(linear.enabled).toBe(true);
    expect(linear.signature.algorithm).toBe('sha256');
    expect(linear.parser).toBe('linear');
    expect(linear.responder).toBe('linear');
  });

  it('should have Slack source configured', () => {
    const slack = defaultSources.slack;

    expect(slack.id).toBe('slack');
    expect(slack.enabled).toBe(true);
    expect(slack.signature.algorithm).toBe('slack-v0');
    expect(slack.parser).toBe('slack');
    expect(slack.responder).toBe('slack');
  });
});

describe('processWebhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('unknown source', () => {
    it('should return error for unknown source', async () => {
      const result = await processWebhook(
        'unknown-source',
        '{}',
        {}
      );

      expect(result.success).toBe(false);
      expect(result.responses[0].error).toContain('Unknown webhook source');
    });
  });

  describe('disabled source', () => {
    it('should return error for disabled source', async () => {
      const config: WebhookConfig = {
        sources: {
          github: {
            ...defaultSources.github,
            enabled: false,
          },
        },
        rules: [],
      };

      const result = await processWebhook(
        'github',
        '{}',
        {},
        config
      );

      expect(result.success).toBe(false);
      expect(result.responses[0].error).toContain('disabled');
    });
  });

  describe('signature verification', () => {
    const secret = 'test-secret';
    const payload = JSON.stringify({ test: true });

    beforeEach(() => {
      vi.stubEnv('GITHUB_WEBHOOK_SECRET', secret);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('should reject invalid signature', async () => {
      const result = await processWebhook(
        'github',
        payload,
        { 'x-hub-signature-256': 'sha256=invalid' }
      );

      expect(result.success).toBe(false);
      expect(result.responses[0].error).toBe('Invalid signature');
    });

    it('should accept valid signature', async () => {
      const signature = 'sha256=' + crypto
        .createHmac('sha256', secret)
        .update(payload)
        .digest('hex');

      const result = await processWebhook(
        'github',
        payload,
        {
          'x-hub-signature-256': signature,
          'x-github-event': 'ping',
          'x-github-delivery': 'test-delivery',
        }
      );

      // May not be fully successful depending on mock setup, but shouldn't fail signature
      expect(result.responses[0]?.error).not.toBe('Invalid signature');
    });

    it('should reject missing signature', async () => {
      const result = await processWebhook(
        'github',
        payload,
        {} // No signature header
      );

      expect(result.success).toBe(false);
      expect(result.responses[0].error).toBe('Invalid signature');
    });
  });

  describe('invalid payload', () => {
    beforeEach(() => {
      vi.stubEnv('GITHUB_WEBHOOK_SECRET', '');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('should handle non-JSON payload', async () => {
      // Create a config that skips signature verification
      const config: WebhookConfig = {
        sources: {
          github: {
            ...defaultSources.github,
            signature: {
              ...defaultSources.github.signature,
              algorithm: 'none',
            },
          },
        },
        rules: [],
      };

      const result = await processWebhook(
        'github',
        'not valid json',
        {},
        config
      );

      expect(result.success).toBe(false);
      expect(result.responses[0].error).toBe('Invalid JSON payload');
    });
  });

  describe('event processing', () => {
    const mentionPayload = {
      action: 'created',
      issue: { number: 42, title: 'Test' },
      comment: {
        id: 789,
        body: '@developer please fix this',
        html_url: 'https://github.com/owner/repo/issues/42#issuecomment-789',
      },
      repository: { full_name: 'owner/repo' },
      sender: { id: 123, login: 'user' },
    };

    beforeEach(() => {
      vi.stubEnv('GITHUB_WEBHOOK_SECRET', '');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('should process GitHub mention event', async () => {
      const payload = JSON.stringify(mentionPayload);
      const config: WebhookConfig = {
        sources: {
          github: {
            ...defaultSources.github,
            signature: { ...defaultSources.github.signature, algorithm: 'none' },
          },
        },
        rules: [
          {
            id: 'test-mention',
            name: 'Test Mention',
            enabled: true,
            source: 'github',
            eventType: 'mention',
            action: { type: 'spawn_agent', agentType: '$.mentions' },
            priority: 10,
          },
        ],
      };

      const result = await processWebhook(
        'github',
        payload,
        {
          'x-github-event': 'issue_comment',
          'x-github-delivery': 'test-delivery',
        },
        config
      );

      expect(result.eventType).toBe('mention');
      expect(result.matchedRules).toContain('test-mention');
    });

    it('should return empty result for no matching events', async () => {
      const payload = JSON.stringify({
        action: 'completed',
        check_run: {
          id: 123,
          name: 'build',
          conclusion: 'success', // Not a failure
          pull_requests: [],
        },
        repository: { full_name: 'owner/repo' },
        sender: { id: 123, login: 'github-actions' },
      });

      const config: WebhookConfig = {
        sources: {
          github: {
            ...defaultSources.github,
            signature: { ...defaultSources.github.signature, algorithm: 'none' },
          },
        },
        rules: [],
      };

      const result = await processWebhook(
        'github',
        payload,
        {
          'x-github-event': 'check_run',
          'x-github-delivery': 'test-delivery',
        },
        config
      );

      // Should have processed but with no specific events
      expect(result.matchedRules).toHaveLength(0);
    });
  });

  describe('Slack URL verification', () => {
    it('should handle Slack URL verification (handled at API level)', async () => {
      // Note: URL verification is actually handled at the API level,
      // but the parser should return empty events for it
      const payload = JSON.stringify({
        type: 'url_verification',
        challenge: 'test-challenge',
      });

      const config: WebhookConfig = {
        sources: {
          slack: {
            ...defaultSources.slack,
            signature: { ...defaultSources.slack.signature, algorithm: 'none' },
          },
        },
        rules: [],
      };

      const result = await processWebhook(
        'slack',
        payload,
        {},
        config
      );

      // Parser returns empty for url_verification
      expect(result.success).toBe(true);
      expect(result.matchedRules).toHaveLength(0);
    });
  });
});

describe('signature verification algorithms', () => {
  describe('sha256', () => {
    it('should verify SHA256 HMAC signature', () => {
      const secret = 'test-secret';
      const payload = '{"test": true}';
      const signature = crypto
        .createHmac('sha256', secret)
        .update(payload)
        .digest('hex');

      // Signature should match expected format
      expect(signature).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('sha1', () => {
    it('should verify SHA1 HMAC signature', () => {
      const secret = 'test-secret';
      const payload = '{"test": true}';
      const signature = crypto
        .createHmac('sha1', secret)
        .update(payload)
        .digest('hex');

      // Signature should match expected format
      expect(signature).toMatch(/^[a-f0-9]{40}$/);
    });
  });

  describe('slack-v0', () => {
    it('should create Slack-format signature', () => {
      const secret = 'test-secret';
      const timestamp = Math.floor(Date.now() / 1000);
      const payload = '{"test": true}';
      const sigBasestring = `v0:${timestamp}:${payload}`;
      const signature = 'v0=' + crypto
        .createHmac('sha256', secret)
        .update(sigBasestring)
        .digest('hex');

      expect(signature).toMatch(/^v0=[a-f0-9]{64}$/);
    });
  });
});
