/**
 * Generic Webhooks API Routes
 *
 * Provides endpoints for receiving webhooks from any configured source.
 * Routes: POST /api/webhooks/:source
 */

import { Router, Request, Response } from 'express';
import { processWebhook, getWebhookConfig } from '../webhooks/index.js';

export const genericWebhooksRouter = Router();

/**
 * POST /api/webhooks/:source
 * Receive a webhook from any configured source
 */
genericWebhooksRouter.post('/:source', async (req: Request, res: Response) => {
  const source = req.params.source as string;

  // For Slack URL verification challenge
  if (source === 'slack' && req.body?.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }

  try {
    // Get raw body for signature verification
    // Note: This requires express.raw() middleware or similar
    const rawBody = typeof req.body === 'string'
      ? req.body
      : JSON.stringify(req.body);

    const result = await processWebhook(
      source,
      rawBody,
      req.headers as Record<string, string | string[] | undefined>
    );

    if (!result.success && result.responses[0]?.error === 'Invalid signature') {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    if (!result.success && result.responses[0]?.error?.includes('Unknown webhook source')) {
      return res.status(404).json({ error: `Unknown webhook source: ${source}` });
    }

    console.log(`[webhooks] Processed ${source} webhook: ${result.eventType} (${result.matchedRules.length} rules matched)`);

    res.json({
      success: result.success,
      eventId: result.eventId,
      eventType: result.eventType,
      matchedRules: result.matchedRules,
      actionsExecuted: result.actions.length,
    });
  } catch (error) {
    console.error(`[webhooks] Error processing ${source} webhook:`, error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/webhooks/config
 * Get the current webhook configuration (for debugging)
 */
genericWebhooksRouter.get('/config', (_req: Request, res: Response) => {
  const config = getWebhookConfig();

  res.json({
    sources: Object.entries(config.sources).map(([id, source]) => ({
      id,
      name: source.name,
      enabled: source.enabled,
      parser: source.parser,
      responder: source.responder,
    })),
    rules: config.rules.map(rule => ({
      id: rule.id,
      name: rule.name,
      enabled: rule.enabled,
      source: rule.source,
      eventType: rule.eventType,
      condition: rule.condition,
      actionType: rule.action.type,
      priority: rule.priority,
    })),
  });
});

/**
 * GET /api/webhooks/sources
 * List available webhook sources with their setup instructions
 */
genericWebhooksRouter.get('/sources', (_req: Request, res: Response) => {
  const baseUrl = process.env.PUBLIC_URL || 'https://your-domain.com';

  res.json({
    sources: [
      {
        id: 'github',
        name: 'GitHub',
        webhookUrl: `${baseUrl}/api/webhooks/github`,
        setupInstructions: [
          '1. Go to your repository Settings > Webhooks > Add webhook',
          `2. Set Payload URL to: ${baseUrl}/api/webhooks/github`,
          '3. Set Content type to: application/json',
          '4. Set Secret to your GITHUB_WEBHOOK_SECRET value',
          '5. Select events: Check runs, Issues, Issue comments, Pull request review comments',
        ],
        requiredEnvVars: ['GITHUB_WEBHOOK_SECRET'],
        events: ['check_run', 'issues', 'issue_comment', 'pull_request_review_comment'],
      },
      {
        id: 'linear',
        name: 'Linear',
        webhookUrl: `${baseUrl}/api/webhooks/linear`,
        setupInstructions: [
          '1. Go to Linear Settings > API > Webhooks',
          '2. Create a new webhook',
          `3. Set URL to: ${baseUrl}/api/webhooks/linear`,
          '4. Copy the signing secret to LINEAR_WEBHOOK_SECRET',
          '5. Select events: Issues, Comments',
        ],
        requiredEnvVars: ['LINEAR_WEBHOOK_SECRET', 'LINEAR_API_KEY'],
        events: ['Issue', 'Comment', 'IssueLabel'],
      },
      {
        id: 'slack',
        name: 'Slack',
        webhookUrl: `${baseUrl}/api/webhooks/slack`,
        setupInstructions: [
          '1. Create a Slack App at api.slack.com/apps',
          '2. Enable Event Subscriptions',
          `3. Set Request URL to: ${baseUrl}/api/webhooks/slack`,
          '4. Subscribe to bot events: app_mention, message.channels',
          '5. Copy Signing Secret to SLACK_SIGNING_SECRET',
          '6. Install the app to your workspace',
        ],
        requiredEnvVars: ['SLACK_SIGNING_SECRET', 'SLACK_BOT_TOKEN'],
        events: ['app_mention', 'message', 'reaction_added'],
      },
    ],
  });
});
