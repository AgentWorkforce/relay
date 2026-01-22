/**
 * GitHub Responder
 *
 * Sends responses back to GitHub via the GitHub App API.
 */

import type { NormalizedEvent, WebhookResponder, WebhookResponse } from '../types.js';
import { nangoService } from '../../services/nango.js';
import { db } from '../../db/index.js';

export const githubResponder: WebhookResponder = {
  id: 'github',

  async respond(
    event: NormalizedEvent,
    response: WebhookResponse,
    _config?: Record<string, unknown>
  ): Promise<{ success: boolean; id?: string; url?: string; error?: string }> {
    try {
      // Get repository info from event context
      const repoFullName = event.context.name;
      const [owner, repo] = repoFullName.split('/');

      if (!owner || !repo) {
        return { success: false, error: `Invalid repository name: ${repoFullName}` };
      }

      // Find the repository in our database to get the Nango connection
      const repository = await db.repositories.findByFullName(repoFullName);
      if (!repository?.nangoConnectionId) {
        return {
          success: false,
          error: `Repository ${repoFullName} not found or has no Nango connection`,
        };
      }

      switch (response.type) {
        case 'comment': {
          // Post a comment on an issue or PR
          const issueNumber = typeof response.target === 'number'
            ? response.target
            : parseInt(String(response.target), 10);

          if (isNaN(issueNumber)) {
            return { success: false, error: `Invalid issue number: ${response.target}` };
          }

          const result = await nangoService.addGithubIssueComment(
            repository.nangoConnectionId,
            owner,
            repo,
            issueNumber,
            response.body
          );

          return {
            success: true,
            id: String(result.id),
            url: result.html_url,
          };
        }

        case 'reaction': {
          // Add a reaction to a comment or issue
          // Note: This would need to be added to NangoService
          return {
            success: false,
            error: 'Reactions not yet implemented for GitHub',
          };
        }

        case 'status': {
          // Update a check run status
          // Note: This would need to be added to NangoService
          return {
            success: false,
            error: 'Status updates not yet implemented for GitHub',
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
