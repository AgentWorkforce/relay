/**
 * Credential Check Middleware
 *
 * Middleware to enforce credential requirements for team members
 * interacting with AI agents in workspaces.
 *
 * This helps ensure ToS compliance by requiring users to have
 * their own AI provider credentials before using AI features.
 */

import type { Request, Response, NextFunction } from 'express';
import { db } from '../../db/index.js';
import {
  routeCredentials,
  hasRequiredCredentials,
  getCredentialPolicy,
  type ResolvedCredentialPolicy,
} from '../../services/credential-router.js';

export interface CredentialCheckOptions {
  /** AI provider to check (e.g., 'anthropic', 'openai') */
  provider?: string;
  /** If true, always require user's own credentials (no fallback) */
  strict?: boolean;
  /** Action being performed (for audit logging) */
  action?: 'agent_message' | 'agent_spawn' | 'tool_call' | 'completion';
}

/**
 * Middleware factory to check credential requirements.
 *
 * Usage:
 * ```typescript
 * router.post('/agents/:name/message',
 *   requireCredentials({ provider: 'anthropic', action: 'agent_message' }),
 *   async (req, res) => { ... }
 * );
 * ```
 */
export function requireCredentials(options: CredentialCheckOptions = {}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Get workspace ID from params or body
    const workspaceId =
      req.params.workspaceId ||
      req.body.workspaceId ||
      (req as any).workspaceId;

    if (!workspaceId) {
      return res.status(400).json({ error: 'Workspace ID required' });
    }

    try {
      const workspace = await db.workspaces.findById(workspaceId);
      if (!workspace) {
        return res.status(404).json({ error: 'Workspace not found' });
      }

      // Workspace owner always has permission
      if (workspace.userId === userId) {
        (req as any).credentialContext = {
          source: 'user',
          credentialOwnerId: userId,
          usedFallback: false,
        };
        return next();
      }

      // Check membership
      const member = await db.workspaceMembers.findMembership(workspaceId, userId);
      if (!member || !member.acceptedAt) {
        return res.status(403).json({ error: 'Access denied to this workspace' });
      }

      // Determine provider to check
      const provider = options.provider || detectProviderFromRequest(req);
      if (!provider) {
        // No specific provider required, continue
        return next();
      }

      const policy = getCredentialPolicy(workspace);

      // Strict mode: always require user's own credentials
      if (options.strict || policy.requirePerUserAuth.includes(provider)) {
        const hasCredentials = await hasRequiredCredentials(userId, workspaceId, provider);

        if (!hasCredentials) {
          return res.status(403).json({
            error: 'Credential required',
            code: 'CREDENTIAL_REQUIRED',
            provider,
            message: `Please connect your ${provider} account to use this feature. Visit Settings > Providers to connect.`,
            connectUrl: `/settings/providers?workspace=${workspaceId}&provider=${provider}`,
          });
        }

        (req as any).credentialContext = {
          source: 'user',
          credentialOwnerId: userId,
          usedFallback: false,
        };
        return next();
      }

      // Non-strict mode: use credential router
      const routeResult = await routeCredentials({
        workspaceId,
        requestingUserId: userId,
        provider,
        action: options.action || 'completion',
      });

      if (!routeResult.credentials) {
        return res.status(403).json({
          error: 'Credential required',
          code: 'CREDENTIAL_REQUIRED',
          provider,
          message: routeResult.warning,
          connectUrl: `/settings/providers?workspace=${workspaceId}&provider=${provider}`,
        });
      }

      // Attach credential context to request for downstream use
      (req as any).credentialContext = {
        source: routeResult.source,
        credentialOwnerId: routeResult.credentialOwnerId,
        usedFallback: routeResult.usedFallback,
        warning: routeResult.warning,
      };

      // If using fallback, add warning header
      if (routeResult.usedFallback && routeResult.warning) {
        res.setHeader('X-Credential-Warning', routeResult.warning);
      }

      next();
    } catch (error) {
      console.error('Credential check error:', error);
      res.status(500).json({ error: 'Failed to verify credentials' });
    }
  };
}

/**
 * Middleware to require ANY provider credential (for general AI features).
 */
export function requireAnyCredential() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const workspaceId =
      req.params.workspaceId ||
      req.body.workspaceId ||
      (req as any).workspaceId;

    if (!workspaceId) {
      return res.status(400).json({ error: 'Workspace ID required' });
    }

    try {
      const workspace = await db.workspaces.findById(workspaceId);
      if (!workspace) {
        return res.status(404).json({ error: 'Workspace not found' });
      }

      // Workspace owner always has permission
      if (workspace.userId === userId) {
        return next();
      }

      // Check if user has any AI provider credentials
      const credentials = await db.credentials.findByUserAndWorkspace(userId, workspaceId);
      const aiProviders = ['anthropic', 'openai', 'google'];
      const hasAnyAiCredential = credentials.some((c) => aiProviders.includes(c.provider));

      if (!hasAnyAiCredential) {
        return res.status(403).json({
          error: 'AI provider credential required',
          code: 'AI_CREDENTIAL_REQUIRED',
          message: 'Please connect at least one AI provider account (Claude, OpenAI, or Gemini) to use AI features.',
          connectUrl: `/settings/providers?workspace=${workspaceId}`,
        });
      }

      next();
    } catch (error) {
      console.error('Credential check error:', error);
      res.status(500).json({ error: 'Failed to verify credentials' });
    }
  };
}

/**
 * Attempt to detect the AI provider from the request.
 */
function detectProviderFromRequest(req: Request): string | null {
  // Check explicit provider in request
  if (req.body.provider) {
    return req.body.provider;
  }

  // Check agent name patterns
  const agentName = req.params.agentName || req.body.agentName || req.body.agent;
  if (agentName) {
    const name = agentName.toLowerCase();
    if (name.includes('claude')) return 'anthropic';
    if (name.includes('gpt') || name.includes('codex')) return 'openai';
    if (name.includes('gemini')) return 'google';
  }

  // Check CLI type
  const cli = req.body.cli || req.query.cli;
  if (cli) {
    const cliStr = String(cli).toLowerCase();
    if (cliStr === 'claude') return 'anthropic';
    if (cliStr === 'codex' || cliStr === 'openai') return 'openai';
    if (cliStr === 'gemini') return 'google';
  }

  return null;
}

/**
 * Helper to get credential context from request (set by middleware).
 */
export function getCredentialContext(req: Request): {
  source: 'user' | 'workspace_owner' | 'organization' | null;
  credentialOwnerId: string | null;
  usedFallback: boolean;
  warning?: string;
} | null {
  return (req as any).credentialContext || null;
}
