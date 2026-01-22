/**
 * GitHub Webhook Parser
 *
 * Transforms GitHub webhook payloads into normalized events.
 */

import type { NormalizedEvent, WebhookParser } from '../types.js';

/**
 * Extract @mentions from text
 */
function extractMentions(text: string | null | undefined): string[] {
  if (!text) return [];
  const mentionPattern = /@([a-zA-Z][a-zA-Z0-9_-]*)/g;
  const mentions: string[] = [];
  let match;
  while ((match = mentionPattern.exec(text)) !== null) {
    mentions.push(match[1].toLowerCase());
  }
  return [...new Set(mentions)];
}

/**
 * Map GitHub priority labels to normalized priority
 */
function extractPriority(labels: Array<{ name: string }>): 'critical' | 'high' | 'medium' | 'low' | undefined {
  const labelNames = labels.map(l => l.name.toLowerCase());
  if (labelNames.includes('critical') || labelNames.includes('p0')) return 'critical';
  if (labelNames.includes('high') || labelNames.includes('p1')) return 'high';
  if (labelNames.includes('medium') || labelNames.includes('p2')) return 'medium';
  if (labelNames.includes('low') || labelNames.includes('p3')) return 'low';
  return undefined;
}

export const githubParser: WebhookParser = {
  id: 'github',

  parse(payload: unknown, headers: Record<string, string | string[] | undefined>): NormalizedEvent[] {
    const eventType = headers['x-github-event'] as string;
    const deliveryId = headers['x-github-delivery'] as string;
    const data = payload as Record<string, unknown>;

    const events: NormalizedEvent[] = [];
    const repository = data.repository as Record<string, unknown> | undefined;
    const sender = data.sender as Record<string, unknown> | undefined;

    const baseEvent: Partial<NormalizedEvent> = {
      id: deliveryId || `github-${Date.now()}`,
      source: 'github',
      timestamp: new Date(),
      actor: {
        id: String(sender?.id || 'unknown'),
        name: String(sender?.login || 'unknown'),
      },
      context: {
        name: String(repository?.full_name || 'unknown'),
        url: String(repository?.html_url || ''),
      },
      labels: [],
      mentions: [],
      metadata: {},
      rawPayload: payload,
    };

    switch (eventType) {
      case 'check_run': {
        const checkRun = data.check_run as Record<string, unknown>;
        const action = data.action as string;
        const conclusion = checkRun?.conclusion as string | null;
        const pullRequests = checkRun?.pull_requests as Array<Record<string, unknown>> | undefined;

        if (action === 'completed' && conclusion === 'failure' && pullRequests?.length) {
          const pr = pullRequests[0];
          const output = checkRun.output as Record<string, unknown> | undefined;
          const annotations = output?.annotations as Array<Record<string, unknown>> | undefined;

          events.push({
            ...baseEvent,
            type: 'ci_failure',
            item: {
              type: 'check',
              id: String(checkRun.id),
              number: pr.number as number,
              title: String(checkRun.name),
              body: String(output?.summary || ''),
              url: String(checkRun.html_url || ''),
              state: 'failure',
            },
            metadata: {
              checkName: checkRun.name,
              conclusion,
              branch: (pr.head as Record<string, unknown>)?.ref,
              commitSha: (pr.head as Record<string, unknown>)?.sha,
              failureTitle: output?.title,
              failureSummary: output?.summary,
              failureDetails: output?.text,
              annotations: annotations?.map(a => ({
                path: a.path,
                startLine: a.start_line,
                endLine: a.end_line,
                level: a.annotation_level,
                message: a.message,
              })),
            },
          } as NormalizedEvent);
        }
        break;
      }

      case 'issues': {
        const issue = data.issue as Record<string, unknown>;
        const action = data.action as string;
        const labels = (issue?.labels || []) as Array<{ name: string }>;

        if (action === 'opened' || action === 'labeled') {
          events.push({
            ...baseEvent,
            type: 'issue_created',
            item: {
              type: 'issue',
              id: String(issue.id),
              number: issue.number as number,
              title: String(issue.title),
              body: String(issue.body || ''),
              url: String(issue.html_url),
              state: String(issue.state),
            },
            labels: labels.map(l => l.name),
            priority: extractPriority(labels),
            mentions: extractMentions(issue.body as string),
            metadata: {
              action,
              assignees: (issue.assignees as Array<Record<string, unknown>> || []).map(a => a.login),
            },
          } as NormalizedEvent);
        }
        break;
      }

      case 'issue_comment': {
        const issue = data.issue as Record<string, unknown>;
        const comment = data.comment as Record<string, unknown>;
        const action = data.action as string;
        const isPR = !!(issue?.pull_request);

        if (action === 'created') {
          const mentions = extractMentions(comment.body as string);
          if (mentions.length > 0) {
            events.push({
              ...baseEvent,
              type: 'mention',
              item: {
                type: isPR ? 'pull_request' : 'issue',
                id: String(comment.id),
                number: issue.number as number,
                title: String(issue.title),
                body: String(comment.body),
                url: String(comment.html_url),
              },
              mentions,
              metadata: {
                commentId: comment.id,
                commentUrl: comment.html_url,
                isPR,
              },
            } as NormalizedEvent);
          }
        }
        break;
      }

      case 'pull_request_review_comment': {
        const pr = data.pull_request as Record<string, unknown>;
        const comment = data.comment as Record<string, unknown>;
        const action = data.action as string;

        if (action === 'created') {
          const mentions = extractMentions(comment.body as string);
          if (mentions.length > 0) {
            events.push({
              ...baseEvent,
              type: 'mention',
              item: {
                type: 'pull_request',
                id: String(comment.id),
                number: pr.number as number,
                title: String(pr.title),
                body: String(comment.body),
                url: String(comment.html_url),
              },
              mentions,
              metadata: {
                commentId: comment.id,
                commentUrl: comment.html_url,
                filePath: comment.path,
                line: comment.line,
                isPR: true,
                isReviewComment: true,
              },
            } as NormalizedEvent);
          }
        }
        break;
      }

      case 'pull_request': {
        const pr = data.pull_request as Record<string, unknown>;
        const action = data.action as string;
        const labels = (pr?.labels || []) as Array<{ name: string }>;

        if (action === 'opened') {
          events.push({
            ...baseEvent,
            type: 'pr_opened',
            item: {
              type: 'pull_request',
              id: String(pr.id),
              number: pr.number as number,
              title: String(pr.title),
              body: String(pr.body || ''),
              url: String(pr.html_url),
              state: String(pr.state),
            },
            labels: labels.map(l => l.name),
            priority: extractPriority(labels),
            mentions: extractMentions(pr.body as string),
            metadata: {
              action,
              head: (pr.head as Record<string, unknown>)?.ref,
              base: (pr.base as Record<string, unknown>)?.ref,
              draft: pr.draft,
            },
          } as NormalizedEvent);
        }
        break;
      }

      default:
        // Unknown event type - create a generic event
        events.push({
          ...baseEvent,
          type: `github.${eventType}`,
          metadata: { action: data.action },
        } as NormalizedEvent);
    }

    return events;
  },
};
