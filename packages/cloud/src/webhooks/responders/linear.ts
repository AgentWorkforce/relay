/**
 * Linear Responder
 *
 * Sends responses back to Linear via their GraphQL API.
 * https://developers.linear.app/docs/graphql/working-with-the-graphql-api
 */

import type { NormalizedEvent, WebhookResponder, WebhookResponse } from '../types.js';

/**
 * Execute a Linear GraphQL mutation
 */
async function linearGraphQL(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>
): Promise<{ data?: Record<string, unknown>; errors?: Array<{ message: string }> }> {
  const response = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });

  return response.json() as Promise<{ data?: Record<string, unknown>; errors?: Array<{ message: string }> }>;
}

export const linearResponder: WebhookResponder = {
  id: 'linear',

  async respond(
    event: NormalizedEvent,
    response: WebhookResponse,
    config?: Record<string, unknown>
  ): Promise<{ success: boolean; id?: string; url?: string; error?: string }> {
    const apiKey = config?.apiKey as string || process.env.LINEAR_API_KEY;

    if (!apiKey) {
      return {
        success: false,
        error: 'Linear API key not configured',
      };
    }

    try {
      switch (response.type) {
        case 'comment': {
          // Create a comment on an issue
          const issueId = String(response.target);

          const mutation = `
            mutation CreateComment($issueId: String!, $body: String!) {
              commentCreate(input: { issueId: $issueId, body: $body }) {
                success
                comment {
                  id
                  url
                }
              }
            }
          `;

          const result = await linearGraphQL(apiKey, mutation, {
            issueId,
            body: response.body,
          });

          if (result.errors?.length) {
            return {
              success: false,
              error: result.errors.map(e => e.message).join(', '),
            };
          }

          const commentCreate = result.data?.commentCreate as Record<string, unknown>;
          const comment = commentCreate?.comment as Record<string, unknown>;

          return {
            success: !!commentCreate?.success,
            id: comment?.id as string,
            url: comment?.url as string,
          };
        }

        case 'reaction': {
          // Add a reaction/emoji to a comment
          const commentId = String(response.target);
          const emoji = response.metadata?.emoji as string || '👍';

          const mutation = `
            mutation CreateReaction($commentId: String!, $emoji: String!) {
              reactionCreate(input: { commentId: $commentId, emoji: $emoji }) {
                success
                reaction {
                  id
                }
              }
            }
          `;

          const result = await linearGraphQL(apiKey, mutation, {
            commentId,
            emoji,
          });

          if (result.errors?.length) {
            return {
              success: false,
              error: result.errors.map(e => e.message).join(', '),
            };
          }

          const reactionCreate = result.data?.reactionCreate as Record<string, unknown>;
          return {
            success: !!reactionCreate?.success,
            id: (reactionCreate?.reaction as Record<string, unknown>)?.id as string,
          };
        }

        case 'status': {
          // Update issue state
          const issueId = String(response.target);
          const stateId = response.metadata?.stateId as string;

          if (!stateId) {
            return {
              success: false,
              error: 'State ID required for status update',
            };
          }

          const mutation = `
            mutation UpdateIssue($issueId: String!, $stateId: String!) {
              issueUpdate(id: $issueId, input: { stateId: $stateId }) {
                success
                issue {
                  id
                  url
                }
              }
            }
          `;

          const result = await linearGraphQL(apiKey, mutation, {
            issueId,
            stateId,
          });

          if (result.errors?.length) {
            return {
              success: false,
              error: result.errors.map(e => e.message).join(', '),
            };
          }

          const issueUpdate = result.data?.issueUpdate as Record<string, unknown>;
          const issue = issueUpdate?.issue as Record<string, unknown>;

          return {
            success: !!issueUpdate?.success,
            id: issue?.id as string,
            url: issue?.url as string,
          };
        }

        default:
          return {
            success: false,
            error: `Unknown response type: ${response.type}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  },
};
