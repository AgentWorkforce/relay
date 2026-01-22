/**
 * Linear Webhook Parser
 *
 * Transforms Linear webhook payloads into normalized events.
 * Linear webhooks: https://developers.linear.app/docs/graphql/webhooks
 */

import type { NormalizedEvent, WebhookParser } from '../types.js';

/**
 * Extract @mentions from text (Linear uses @username format)
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
 * Map Linear priority to normalized priority
 * Linear: 0 = No priority, 1 = Urgent, 2 = High, 3 = Normal, 4 = Low
 */
function mapPriority(priority: number | undefined): 'critical' | 'high' | 'medium' | 'low' | undefined {
  switch (priority) {
    case 1: return 'critical';
    case 2: return 'high';
    case 3: return 'medium';
    case 4: return 'low';
    default: return undefined;
  }
}

export const linearParser: WebhookParser = {
  id: 'linear',

  parse(payload: unknown): NormalizedEvent[] {
    const data = payload as Record<string, unknown>;
    const events: NormalizedEvent[] = [];

    const action = data.action as string; // create, update, remove
    const type = data.type as string; // Issue, Comment, Project, etc.
    const webhookData = data.data as Record<string, unknown> | undefined;
    const webhookId = data.webhookId as string | undefined;
    const createdAt = data.createdAt as string | undefined;

    if (!webhookData) return events;

    const baseEvent: Partial<NormalizedEvent> = {
      id: webhookId || `linear-${Date.now()}`,
      source: 'linear',
      timestamp: createdAt ? new Date(createdAt) : new Date(),
      actor: {
        id: 'unknown',
        name: 'unknown',
      },
      context: {
        name: 'unknown',
      },
      labels: [],
      mentions: [],
      metadata: {},
      rawPayload: payload,
    };

    // Extract actor from various fields
    const creator = webhookData.creator as Record<string, unknown> | undefined;
    const user = webhookData.user as Record<string, unknown> | undefined;
    const actor = creator || user;
    if (actor) {
      baseEvent.actor = {
        id: String(actor.id || 'unknown'),
        name: String(actor.name || actor.email || 'unknown'),
        email: actor.email as string | undefined,
      };
    }

    // Extract team/project context
    const team = webhookData.team as Record<string, unknown> | undefined;
    const project = webhookData.project as Record<string, unknown> | undefined;
    if (team) {
      baseEvent.context = {
        name: String(team.key || team.name || 'unknown'),
        url: `https://linear.app/team/${team.key}`,
      };
    } else if (project) {
      baseEvent.context = {
        name: String(project.name || 'unknown'),
        url: project.url as string | undefined,
      };
    }

    switch (type) {
      case 'Issue': {
        const issue = webhookData;
        const labels = (issue.labels as Array<Record<string, unknown>> || []);
        const labelNames = labels.map(l => String(l.name));
        const assignee = issue.assignee as Record<string, unknown> | undefined;

        if (action === 'create') {
          events.push({
            ...baseEvent,
            type: 'issue_created',
            item: {
              type: 'ticket',
              id: String(issue.id),
              number: issue.number as number | undefined,
              title: String(issue.title || ''),
              body: String(issue.description || ''),
              url: String(issue.url || ''),
              state: String((issue.state as Record<string, unknown>)?.name || issue.state || 'unknown'),
            },
            labels: labelNames,
            priority: mapPriority(issue.priority as number | undefined),
            mentions: extractMentions(issue.description as string),
            metadata: {
              action,
              identifier: issue.identifier, // e.g., "ENG-123"
              estimate: issue.estimate,
              dueDate: issue.dueDate,
              assignee: assignee?.name,
              assigneeEmail: assignee?.email,
              cycle: (issue.cycle as Record<string, unknown>)?.name,
            },
          } as NormalizedEvent);
        } else if (action === 'update') {
          // Check for assignment changes
          const updatedFrom = data.updatedFrom as Record<string, unknown> | undefined;
          const wasAssigned = updatedFrom?.assigneeId !== undefined &&
                              !updatedFrom?.assigneeId &&
                              assignee?.id;

          // Check if assigned to an agent (name matches agent pattern)
          const assigneeName = String(assignee?.name || '').toLowerCase();
          // Order matters: more specific patterns first, generic 'agent' and 'bot' last
          const agentPatterns = ['developer', 'reviewer', 'debugger', 'ci-fix', 'refactor', 'lead', 'test', 'docs', 'agent', 'bot'];
          const isAgentAssignment = wasAssigned && agentPatterns.some(p => assigneeName.includes(p));

          if (isAgentAssignment) {
            // Extract the agent type from the assignee name (finds first/most-specific match)
            const matchedAgent = agentPatterns.find(p => assigneeName.includes(p)) || 'developer';

            events.push({
              ...baseEvent,
              type: 'issue_assigned',
              item: {
                type: 'ticket',
                id: String(issue.id),
                number: issue.number as number | undefined,
                title: String(issue.title || ''),
                body: String(issue.description || ''),
                url: String(issue.url || ''),
                state: String((issue.state as Record<string, unknown>)?.name || issue.state || 'unknown'),
              },
              labels: labelNames,
              priority: mapPriority(issue.priority as number | undefined),
              mentions: [matchedAgent], // The assigned agent type
              metadata: {
                action: 'assigned',
                identifier: issue.identifier,
                assignee: assignee?.name,
                assigneeEmail: assignee?.email,
                previousAssignee: updatedFrom?.assigneeId,
              },
            } as NormalizedEvent);
          } else {
            // Regular update event
            events.push({
              ...baseEvent,
              type: 'issue_updated',
              item: {
                type: 'ticket',
                id: String(issue.id),
                number: issue.number as number | undefined,
                title: String(issue.title || ''),
                body: String(issue.description || ''),
                url: String(issue.url || ''),
                state: String((issue.state as Record<string, unknown>)?.name || issue.state || 'unknown'),
              },
              labels: labelNames,
              priority: mapPriority(issue.priority as number | undefined),
              metadata: {
                action,
                identifier: issue.identifier,
                updatedFrom,
              },
            } as NormalizedEvent);
          }
        }
        break;
      }

      case 'Comment': {
        const comment = webhookData;
        const issue = comment.issue as Record<string, unknown> | undefined;

        if (action === 'create' && issue) {
          const mentions = extractMentions(comment.body as string);

          events.push({
            ...baseEvent,
            type: mentions.length > 0 ? 'mention' : 'comment_created',
            item: {
              type: 'comment',
              id: String(comment.id),
              number: issue.number as number | undefined,
              title: String(issue.title || ''),
              body: String(comment.body || ''),
              url: String(comment.url || issue.url || ''),
            },
            mentions,
            metadata: {
              action,
              issueId: issue.id,
              issueIdentifier: issue.identifier,
              parentCommentId: (comment.parent as Record<string, unknown>)?.id,
            },
          } as NormalizedEvent);
        }
        break;
      }

      case 'Project': {
        const project = webhookData;

        if (action === 'create') {
          events.push({
            ...baseEvent,
            type: 'project_created',
            context: {
              name: String(project.name || 'unknown'),
              url: String(project.url || ''),
            },
            metadata: {
              action,
              projectId: project.id,
              description: project.description,
              targetDate: project.targetDate,
            },
          } as NormalizedEvent);
        }
        break;
      }

      case 'IssueLabel': {
        // Label added/removed from issue
        const label = webhookData;
        events.push({
          ...baseEvent,
          type: 'label_change',
          labels: [String(label.name || '')],
          metadata: {
            action,
            labelId: label.id,
            color: label.color,
          },
        } as NormalizedEvent);
        break;
      }

      default:
        // Unknown type - create generic event
        events.push({
          ...baseEvent,
          type: `linear.${type?.toLowerCase() || 'unknown'}.${action || 'unknown'}`,
          metadata: { action, type },
        } as NormalizedEvent);
    }

    return events;
  },
};
