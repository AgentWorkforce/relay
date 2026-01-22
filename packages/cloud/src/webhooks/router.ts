/**
 * Generic Webhook Router
 *
 * Routes incoming webhooks from any source through the configurable pipeline:
 * 1. Verify signature
 * 2. Parse payload into normalized events
 * 3. Match events against rules
 * 4. Execute actions
 * 5. Send responses
 */

import crypto from 'crypto';
import type {
  WebhookConfig,
  WebhookSourceConfig,
  NormalizedEvent,
  WebhookAction,
  WebhookResult,
} from './types.js';
import { getParser } from './parsers/index.js';
import { getResponder } from './responders/index.js';
import { findMatchingRules, resolveActionTemplate, defaultRules } from './rules-engine.js';
import { db } from '../db/index.js';

/**
 * Default webhook source configurations
 */
export const defaultSources: Record<string, WebhookSourceConfig> = {
  github: {
    id: 'github',
    name: 'GitHub',
    enabled: true,
    signature: {
      header: 'x-hub-signature-256',
      algorithm: 'sha256',
      secretEnvVar: 'GITHUB_WEBHOOK_SECRET',
      signaturePrefix: 'sha256=',
    },
    parser: 'github',
    responder: 'github',
  },
  linear: {
    id: 'linear',
    name: 'Linear',
    enabled: true,
    signature: {
      header: 'linear-signature',
      algorithm: 'sha256',
      secretEnvVar: 'LINEAR_WEBHOOK_SECRET',
    },
    parser: 'linear',
    responder: 'linear',
  },
  slack: {
    id: 'slack',
    name: 'Slack',
    enabled: true,
    signature: {
      header: 'x-slack-signature',
      algorithm: 'slack-v0',
      secretEnvVar: 'SLACK_SIGNING_SECRET',
    },
    parser: 'slack',
    responder: 'slack',
  },
};

/**
 * Get webhook configuration
 * In the future, this could load from database per-workspace
 */
export function getWebhookConfig(): WebhookConfig {
  return {
    sources: defaultSources,
    rules: defaultRules,
  };
}

/**
 * Verify webhook signature
 */
function verifySignature(
  payload: string,
  signature: string | undefined,
  config: WebhookSourceConfig,
  headers?: Record<string, string | string[] | undefined>
): boolean {
  if (config.signature.algorithm === 'none') {
    return true;
  }

  if (!signature) {
    return false;
  }

  const secret = process.env[config.signature.secretEnvVar];
  if (!secret) {
    console.warn(`[webhook-router] Secret not configured: ${config.signature.secretEnvVar}`);
    return false;
  }

  try {
    let expectedSignature: string;
    let actualSignature = signature;

    // Remove prefix if configured
    if (config.signature.signaturePrefix && actualSignature.startsWith(config.signature.signaturePrefix)) {
      actualSignature = actualSignature.slice(config.signature.signaturePrefix.length);
    }

    switch (config.signature.algorithm) {
      case 'sha256':
        expectedSignature = crypto
          .createHmac('sha256', secret)
          .update(payload)
          .digest('hex');
        break;

      case 'sha1':
        expectedSignature = crypto
          .createHmac('sha1', secret)
          .update(payload)
          .digest('hex');
        break;

      case 'token':
        // Direct token comparison
        return actualSignature === secret;

      case 'slack-v0': {
        // Slack signature verification
        // Format: v0=<HMAC-SHA256 of v0:timestamp:body>
        const timestamp = headers?.['x-slack-request-timestamp'] as string;
        if (!timestamp) return false;

        // Check timestamp is within 5 minutes
        const now = Math.floor(Date.now() / 1000);
        if (Math.abs(now - parseInt(timestamp, 10)) > 300) {
          console.warn('[webhook-router] Slack request timestamp too old');
          return false;
        }

        const sigBasestring = `v0:${timestamp}:${payload}`;
        expectedSignature = 'v0=' + crypto
          .createHmac('sha256', secret)
          .update(sigBasestring)
          .digest('hex');

        return crypto.timingSafeEqual(
          Buffer.from(signature),
          Buffer.from(expectedSignature)
        );
      }

      default:
        console.warn(`[webhook-router] Unknown signature algorithm: ${config.signature.algorithm}`);
        return false;
    }

    return crypto.timingSafeEqual(
      Buffer.from(actualSignature),
      Buffer.from(expectedSignature)
    );
  } catch (error) {
    console.error('[webhook-router] Signature verification error:', error);
    return false;
  }
}

/**
 * Execute an action for an event
 */
async function executeAction(
  action: WebhookAction,
  event: NormalizedEvent,
  responder: ReturnType<typeof getResponder>,
  responderConfig?: Record<string, unknown>
): Promise<{ success: boolean; error?: string }> {
  const resolvedAction = resolveActionTemplate(action, event);

  switch (resolvedAction.type) {
    case 'spawn_agent': {
      const agentType = resolvedAction.agentType || 'lead';
      const prompt = buildPrompt(resolvedAction.prompt || 'default', event);

      // Find the repository and queue spawn command
      const repository = await db.repositories.findByFullName(event.context.name);
      if (!repository?.userId) {
        return { success: false, error: 'Repository not found or not linked' };
      }

      // Find an available daemon
      const daemons = await db.linkedDaemons.findByUserId(repository.userId);
      const onlineDaemon = daemons.find(d => d.status === 'online');

      if (!onlineDaemon) {
        // Post a response indicating no daemon available
        if (responder && event.item?.number) {
          await responder.respond(event, {
            type: 'comment',
            target: event.item.number,
            body: `⚠️ No Agent Relay daemon is available to handle this request. Please ensure you have a linked daemon running.`,
          }, responderConfig);
        }
        return { success: false, error: 'No available daemon' };
      }

      // Post acknowledgment
      if (responder && event.item?.number) {
        await responder.respond(event, {
          type: 'comment',
          target: event.item.number,
          body: `👋 Routing to **@${agentType}** agent. The agent will respond shortly.`,
        }, responderConfig);
      }

      // Queue spawn command
      const agentName = `${agentType}-${event.id.slice(0, 8)}`;
      await db.linkedDaemons.queueMessage(onlineDaemon.id, {
        from: { daemonId: 'cloud', daemonName: 'Agent Relay Cloud', agent: 'system' },
        to: '__spawner__',
        content: JSON.stringify({
          type: 'spawn_agent',
          agentName,
          cli: 'claude',
          task: prompt,
          metadata: {
            eventId: event.id,
            source: event.source,
            eventType: event.type,
            repository: event.context.name,
            itemNumber: event.item?.number,
          },
        }),
        metadata: { type: 'spawn_command' },
        timestamp: new Date().toISOString(),
      });

      console.log(`[webhook-router] Queued spawn command for ${agentName}`);
      return { success: true };
    }

    case 'message_agent': {
      // Send message to existing agent
      return { success: false, error: 'message_agent not yet implemented' };
    }

    case 'post_comment': {
      if (!responder) {
        return { success: false, error: 'No responder available' };
      }

      const body = resolvedAction.config?.body as string || 'Action received.';
      const target = event.item?.number || event.item?.id || '';

      const result = await responder.respond(event, {
        type: 'comment',
        target,
        body,
      }, responderConfig);

      return { success: result.success, error: result.error };
    }

    case 'create_issue': {
      return { success: false, error: 'create_issue not yet implemented' };
    }

    case 'custom': {
      // Custom action handler
      const handler = resolvedAction.config?.handler as ((event: NormalizedEvent) => Promise<void>) | undefined;
      if (handler) {
        await handler(event);
        return { success: true };
      }
      return { success: false, error: 'No custom handler defined' };
    }

    default:
      return { success: false, error: `Unknown action type: ${resolvedAction.type}` };
  }
}

/**
 * Build a prompt from a template name and event
 */
function buildPrompt(templateName: string, event: NormalizedEvent): string {
  const templates: Record<string, (e: NormalizedEvent) => string> = {
    'ci-failure': (e) => `
# CI Failure Fix Task

A CI check has failed in ${e.context.name}.

## Failure Details

**Check Name:** ${e.item?.title || 'Unknown'}
**Branch:** ${e.metadata?.branch || 'unknown'}
**Commit:** ${e.metadata?.commitSha || 'unknown'}

${e.metadata?.failureSummary ? `**Summary:**\n${e.metadata.failureSummary}` : ''}

${e.metadata?.annotations ? `## Annotations\n\n${formatAnnotations(e.metadata.annotations as Array<Record<string, unknown>>)}` : ''}

## Your Task

1. Analyze the failure
2. Fix the issues
3. Push your changes
4. Report back with a summary
`.trim(),

    'mention': (e) => `
# Agent Mention Task

You were mentioned in ${e.source} in ${e.context.name}.

## Context

**Item:** ${e.item?.title || 'N/A'} (#${e.item?.number || e.item?.id || 'N/A'})
**Author:** @${e.actor.name}

## Message

${e.item?.body || 'No message content'}

## Your Task

Respond helpfully to the mention. If code changes are needed, make them and push.
`.trim(),

    'issue': (e) => `
# Issue Assignment

You've been assigned to work on an issue in ${e.context.name}.

## Issue Details

**Title:** ${e.item?.title}
**Priority:** ${e.priority || 'normal'}
**Labels:** ${e.labels.join(', ') || 'none'}

## Description

${e.item?.body || 'No description provided.'}

## Your Task

1. Analyze the issue
2. Implement a solution
3. Create a PR
`.trim(),

    'linear-issue': (e) => `
# Linear Issue

A new issue was created in ${e.context.name}.

## Issue Details

**Identifier:** ${e.metadata?.identifier || 'N/A'}
**Title:** ${e.item?.title}
**Priority:** ${e.priority || 'normal'}
**State:** ${e.item?.state || 'unknown'}

## Description

${e.item?.body || 'No description provided.'}

## Your Task

Analyze and work on this issue if appropriate.
`.trim(),

    'slack-request': (e) => `
# Slack Request

Someone mentioned you in Slack.

## Message

${e.item?.body || 'No message content'}

## Your Task

Respond to the request. Use the Slack API to post your response.
`.trim(),

    'default': (e) => `
# Webhook Event

A webhook event was received from ${e.source}.

## Event Details

**Type:** ${e.type}
**Context:** ${e.context.name}
**Actor:** ${e.actor.name}

## Item

${e.item ? `**${e.item.type}:** ${e.item.title || e.item.id}` : 'No item'}

## Body

${e.item?.body || 'No content'}
`.trim(),
  };

  const template = templates[templateName] || templates['default'];
  return template(event);
}

/**
 * Format annotations for prompt
 */
function formatAnnotations(annotations: Array<Record<string, unknown>>): string {
  return annotations
    .slice(0, 20)
    .map(a => `- ${a.path}:${a.startLine} - ${a.message}`)
    .join('\n');
}

/**
 * Process a webhook from any source
 */
export async function processWebhook(
  source: string,
  payload: string,
  headers: Record<string, string | string[] | undefined>,
  config?: WebhookConfig
): Promise<WebhookResult> {
  const webhookConfig = config || getWebhookConfig();
  const sourceConfig = webhookConfig.sources[source];

  if (!sourceConfig) {
    return {
      success: false,
      eventId: 'unknown',
      source,
      eventType: 'unknown',
      matchedRules: [],
      actions: [],
      responses: [{
        type: 'error',
        success: false,
        error: `Unknown webhook source: ${source}`,
      }],
    };
  }

  if (!sourceConfig.enabled) {
    return {
      success: false,
      eventId: 'unknown',
      source,
      eventType: 'unknown',
      matchedRules: [],
      actions: [],
      responses: [{
        type: 'error',
        success: false,
        error: `Webhook source disabled: ${source}`,
      }],
    };
  }

  // Verify signature
  const signature = headers[sourceConfig.signature.header] as string | undefined;
  if (!verifySignature(payload, signature, sourceConfig, headers)) {
    console.error(`[webhook-router] Invalid signature for source: ${source}`);
    return {
      success: false,
      eventId: 'unknown',
      source,
      eventType: 'unknown',
      matchedRules: [],
      actions: [],
      responses: [{
        type: 'error',
        success: false,
        error: 'Invalid signature',
      }],
    };
  }

  // Parse payload
  const parser = getParser(sourceConfig.parser);
  if (!parser) {
    return {
      success: false,
      eventId: 'unknown',
      source,
      eventType: 'unknown',
      matchedRules: [],
      actions: [],
      responses: [{
        type: 'error',
        success: false,
        error: `Parser not found: ${sourceConfig.parser}`,
      }],
    };
  }

  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(payload);
  } catch {
    return {
      success: false,
      eventId: 'unknown',
      source,
      eventType: 'unknown',
      matchedRules: [],
      actions: [],
      responses: [{
        type: 'error',
        success: false,
        error: 'Invalid JSON payload',
      }],
    };
  }

  const events = parser.parse(parsedPayload, headers, sourceConfig.parserConfig);

  if (events.length === 0) {
    return {
      success: true,
      eventId: 'none',
      source,
      eventType: 'none',
      matchedRules: [],
      actions: [],
      responses: [],
    };
  }

  // Get responder
  const responder = getResponder(sourceConfig.responder);

  // Process each event
  const results: WebhookResult[] = [];

  for (const event of events) {
    const matchedRules = findMatchingRules(webhookConfig.rules, event);
    const actionResults: WebhookResult['actions'] = [];
    const responseResults: WebhookResult['responses'] = [];

    console.log(`[webhook-router] Event ${event.id}: type=${event.type}, matched ${matchedRules.length} rules`);

    for (const rule of matchedRules) {
      const result = await executeAction(
        rule.action,
        event,
        responder,
        sourceConfig.responderConfig
      );

      actionResults.push({
        ruleId: rule.id,
        action: rule.action,
        success: result.success,
        error: result.error,
      });
    }

    results.push({
      success: actionResults.every(a => a.success),
      eventId: event.id,
      source: event.source,
      eventType: event.type,
      matchedRules: matchedRules.map(r => r.id),
      actions: actionResults,
      responses: responseResults,
    });
  }

  // Return combined result
  if (results.length === 1) {
    return results[0];
  }

  return {
    success: results.every(r => r.success),
    eventId: events[0].id,
    source,
    eventType: events.map(e => e.type).join(','),
    matchedRules: results.flatMap(r => r.matchedRules),
    actions: results.flatMap(r => r.actions),
    responses: results.flatMap(r => r.responses),
  };
}
