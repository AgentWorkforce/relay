/**
 * Consensus API Routes (Read-Only)
 *
 * Provides API endpoints for observing multi-agent consensus decisions.
 * The dashboard is read-only - agents handle all consensus activity via relay messages.
 *
 * Architecture:
 * - Agents create proposals and vote via ->relay:_consensus messages
 * - The daemon processes these and syncs state to cloud via /sync endpoint
 * - Dashboard reads consensus state for display only
 */

import { Router, Request, Response } from 'express';
import { createHash } from 'crypto';
import { requireAuth } from './auth.js';
import type { Proposal } from '../../daemon/consensus.js';

/**
 * Hash an API key for lookup
 */
function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

export const consensusRouter = Router();

// ============================================================================
// In-Memory Consensus State (synced from daemon)
// ============================================================================

// Stores proposals synced from the daemon
// In production, this would be backed by a database
const workspaceProposals = new Map<string, Map<string, Proposal>>();

function getProposalsForWorkspace(workspaceId: string): Map<string, Proposal> {
  let proposals = workspaceProposals.get(workspaceId);
  if (!proposals) {
    proposals = new Map();
    workspaceProposals.set(workspaceId, proposals);
  }
  return proposals;
}

function computeStats(proposals: Map<string, Proposal>) {
  let pending = 0;
  let approved = 0;
  let rejected = 0;
  let expired = 0;
  let cancelled = 0;

  for (const proposal of proposals.values()) {
    switch (proposal.status) {
      case 'pending':
        pending++;
        break;
      case 'approved':
        approved++;
        break;
      case 'rejected':
        rejected++;
        break;
      case 'expired':
        expired++;
        break;
      case 'cancelled':
        cancelled++;
        break;
    }
  }

  return {
    total: proposals.size,
    pending,
    approved,
    rejected,
    expired,
    cancelled,
  };
}

// ============================================================================
// Read-Only Routes (require user authentication)
// ============================================================================

/**
 * GET /api/workspaces/:workspaceId/consensus/proposals
 * List all proposals for a workspace (read-only)
 */
consensusRouter.get(
  '/workspaces/:workspaceId/consensus/proposals',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const workspaceId = req.params.workspaceId as string;
      const { status, agent } = req.query;

      const proposalsMap = getProposalsForWorkspace(workspaceId);
      let proposals = Array.from(proposalsMap.values());

      // Filter by agent if provided
      if (agent && typeof agent === 'string') {
        proposals = proposals.filter(
          p => p.proposer === agent || p.participants.includes(agent)
        );
      }

      // Filter by status if provided
      if (status && typeof status === 'string') {
        proposals = proposals.filter(p => p.status === status);
      }

      // Sort by creation time (most recent first)
      proposals.sort((a, b) => b.createdAt - a.createdAt);

      const stats = computeStats(proposalsMap);

      res.json({
        proposals,
        stats,
      });
    } catch (error) {
      console.error('Error listing proposals:', error);
      res.status(500).json({ error: 'Failed to list proposals' });
    }
  }
);

/**
 * GET /api/workspaces/:workspaceId/consensus/proposals/:proposalId
 * Get a specific proposal (read-only)
 */
consensusRouter.get(
  '/workspaces/:workspaceId/consensus/proposals/:proposalId',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const workspaceId = req.params.workspaceId as string;
      const proposalId = req.params.proposalId as string;

      const proposalsMap = getProposalsForWorkspace(workspaceId);
      const proposal = proposalsMap.get(proposalId);

      if (!proposal) {
        return res.status(404).json({ error: 'Proposal not found' });
      }

      res.json({ proposal });
    } catch (error) {
      console.error('Error getting proposal:', error);
      res.status(500).json({ error: 'Failed to get proposal' });
    }
  }
);

/**
 * GET /api/workspaces/:workspaceId/consensus/agents/:agentName/pending
 * Get pending votes for an agent (read-only)
 */
consensusRouter.get(
  '/workspaces/:workspaceId/consensus/agents/:agentName/pending',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const workspaceId = req.params.workspaceId as string;
      const agentName = req.params.agentName as string;

      const proposalsMap = getProposalsForWorkspace(workspaceId);
      const proposals = Array.from(proposalsMap.values()).filter(p => {
        if (p.status !== 'pending') return false;
        if (!p.participants.includes(agentName)) return false;
        // Check if agent hasn't voted yet
        return !p.votes.some(v => v.agent === agentName);
      });

      res.json({ proposals });
    } catch (error) {
      console.error('Error getting pending votes:', error);
      res.status(500).json({ error: 'Failed to get pending votes' });
    }
  }
);

/**
 * GET /api/workspaces/:workspaceId/consensus/stats
 * Get consensus statistics for a workspace (read-only)
 */
consensusRouter.get(
  '/workspaces/:workspaceId/consensus/stats',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const workspaceId = req.params.workspaceId as string;

      const proposalsMap = getProposalsForWorkspace(workspaceId);
      const stats = computeStats(proposalsMap);

      res.json({ stats });
    } catch (error) {
      console.error('Error getting consensus stats:', error);
      res.status(500).json({ error: 'Failed to get consensus stats' });
    }
  }
);

// ============================================================================
// Sync Endpoint (daemon -> cloud)
// ============================================================================

/**
 * POST /api/daemons/consensus/sync
 * Sync consensus state from daemon (called by daemon on proposal events)
 *
 * This endpoint receives state updates from the daemon and stores them
 * so the dashboard can display agent consensus activity.
 *
 * Authentication options (in order of precedence):
 * 1. Daemon API key (Authorization: Bearer ar_live_xxx) - workspace from daemon record
 * 2. Workspace ID in request body - for self-hosted setups
 * 3. Default workspace "local" - for simple local development
 */
consensusRouter.post(
  '/daemons/consensus/sync',
  async (req: Request, res: Response) => {
    try {
      const { proposal, event, workspaceId: bodyWorkspaceId } = req.body as {
        proposal: Proposal;
        event: 'created' | 'voted' | 'resolved' | 'expired' | 'cancelled';
        workspaceId?: string;
      };

      if (!proposal || !event) {
        return res.status(400).json({ error: 'Missing proposal or event' });
      }

      let workspaceId: string;

      // Try to authenticate via API key first
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ar_live_')) {
        const apiKey = authHeader.replace('Bearer ', '');
        const apiKeyHash = hashApiKey(apiKey);
        const { db } = await import('../db/index.js');
        const daemon = await db.linkedDaemons.findByApiKeyHash(apiKeyHash);

        if (daemon?.workspaceId) {
          workspaceId = daemon.workspaceId;
        } else if (bodyWorkspaceId) {
          workspaceId = bodyWorkspaceId;
        } else {
          return res.status(400).json({ error: 'Daemon not associated with a workspace' });
        }
      } else if (bodyWorkspaceId) {
        // Self-hosted: workspace specified in body
        workspaceId = bodyWorkspaceId;
      } else {
        // Default for simple local setups
        workspaceId = 'local';
      }

      // Store/update the proposal
      const proposalsMap = getProposalsForWorkspace(workspaceId);
      proposalsMap.set(proposal.id, proposal);

      console.log(
        `[consensus] Synced ${event} for proposal "${proposal.title}" (${proposal.id}) in workspace ${workspaceId}`
      );

      res.json({ success: true, workspaceId });
    } catch (error) {
      console.error('Error syncing consensus:', error);
      res.status(500).json({ error: 'Failed to sync consensus' });
    }
  }
);

/**
 * DELETE /api/daemons/consensus/proposals/:proposalId
 * Remove a proposal from the sync cache (daemon cleanup)
 *
 * Authentication: Uses daemon API key (Authorization: Bearer ar_live_xxx)
 * Workspace is derived from the linked daemon's record.
 */
consensusRouter.delete(
  '/daemons/consensus/proposals/:proposalId',
  async (req: Request, res: Response) => {
    try {
      // Check for daemon API key (Bearer token)
      const authHeader = req.headers.authorization;

      if (!authHeader?.startsWith('Bearer ar_live_')) {
        return res.status(401).json({ error: 'Unauthorized - daemon API key required' });
      }

      // Validate the API key
      const apiKey = authHeader.replace('Bearer ', '');
      const apiKeyHash = hashApiKey(apiKey);
      const { db } = await import('../db/index.js');
      const daemon = await db.linkedDaemons.findByApiKeyHash(apiKeyHash);

      if (!daemon) {
        return res.status(401).json({ error: 'Invalid API key' });
      }

      if (!daemon.workspaceId) {
        return res.status(400).json({ error: 'Daemon not associated with a workspace' });
      }

      const proposalId = req.params.proposalId as string;

      const proposalsMap = getProposalsForWorkspace(daemon.workspaceId);
      const deleted = proposalsMap.delete(proposalId);

      if (!deleted) {
        return res.status(404).json({ error: 'Proposal not found' });
      }

      console.log(`[consensus] Removed proposal ${proposalId} from workspace ${daemon.workspaceId}`);

      res.json({ success: true });
    } catch (error) {
      console.error('Error removing proposal:', error);
      res.status(500).json({ error: 'Failed to remove proposal' });
    }
  }
);
