/**
 * Plan Limits Middleware
 *
 * Express middleware to enforce plan-based resource limits.
 */

import { Request, Response, NextFunction } from 'express';
import {
  canCreateWorkspace,
  canAddRepo,
  canSpawnAgent,
  canUseCoordinator,
  canUseSessionPersistence,
} from '../../services/planLimits.js';

/**
 * Error response for plan limit violations
 */
interface PlanLimitError {
  error: string;
  code: 'PLAN_LIMIT_EXCEEDED' | 'FEATURE_NOT_AVAILABLE';
  details: {
    plan: string;
    resource: string;
    limit?: number;
    current?: number;
    requiredPlan?: string;
  };
  upgrade: {
    message: string;
    url: string;
  };
}

/**
 * Middleware to check workspace creation limit
 *
 * Use this middleware on workspace creation endpoints.
 * Requires userId in session (use after requireAuth).
 */
export async function checkWorkspaceLimit(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const userId = req.session.userId;

  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const check = await canCreateWorkspace(userId);

    if (!check.allowed) {
      const response: PlanLimitError = {
        error: check.reason || 'Workspace limit exceeded',
        code: 'PLAN_LIMIT_EXCEEDED',
        details: {
          plan: 'current',
          resource: 'workspaces',
          limit: check.limit || 0,
          current: check.current || 0,
        },
        upgrade: {
          message: 'Upgrade your plan to create more workspaces',
          url: '/settings/billing',
        },
      };

      res.status(402).json(response);
      return;
    }

    next();
  } catch (error) {
    console.error('Error checking workspace limit:', error);
    res.status(500).json({ error: 'Failed to check workspace limit' });
  }
}

/**
 * Middleware to check repository limit
 *
 * Use this middleware on repo connection endpoints.
 * Requires userId in session (use after requireAuth).
 */
export async function checkRepoLimit(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const userId = req.session.userId;

  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const check = await canAddRepo(userId);

    if (!check.allowed) {
      const response: PlanLimitError = {
        error: check.reason || 'Repository limit exceeded',
        code: 'PLAN_LIMIT_EXCEEDED',
        details: {
          plan: 'current',
          resource: 'repos',
          limit: check.limit || 0,
          current: check.current || 0,
        },
        upgrade: {
          message: 'Upgrade your plan to connect more repositories',
          url: '/settings/billing',
        },
      };

      res.status(402).json(response);
      return;
    }

    next();
  } catch (error) {
    console.error('Error checking repo limit:', error);
    res.status(500).json({ error: 'Failed to check repository limit' });
  }
}

/**
 * Middleware to check concurrent agent limit
 *
 * Use this middleware on agent spawn endpoints.
 * Requires userId in session (use after requireAuth).
 * Optionally pass currentRunningAgents in request body for accurate count.
 */
export async function checkAgentLimit(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const userId = req.session.userId;
  const currentRunningAgents = req.body.currentRunningAgents;

  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const check = await canSpawnAgent(userId, currentRunningAgents);

    if (!check.allowed) {
      const response: PlanLimitError = {
        error: check.reason || 'Concurrent agent limit exceeded',
        code: 'PLAN_LIMIT_EXCEEDED',
        details: {
          plan: 'current',
          resource: 'concurrentAgents',
          limit: check.limit || 0,
          current: check.current || 0,
        },
        upgrade: {
          message: 'Upgrade your plan to run more concurrent agents',
          url: '/settings/billing',
        },
      };

      res.status(402).json(response);
      return;
    }

    next();
  } catch (error) {
    console.error('Error checking agent limit:', error);
    res.status(500).json({ error: 'Failed to check agent limit' });
  }
}

/**
 * Middleware to check coordinator access
 *
 * Use this middleware on coordinator-related endpoints.
 * Coordinators are only available on Pro plan and above.
 */
export async function checkCoordinatorAccess(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const userId = req.session.userId;

  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const check = await canUseCoordinator(userId);

    if (!check.allowed) {
      const response: PlanLimitError = {
        error: check.reason || 'Coordinator agents not available',
        code: 'FEATURE_NOT_AVAILABLE',
        details: {
          plan: 'current',
          resource: 'coordinators',
          requiredPlan: check.requiredPlan,
        },
        upgrade: {
          message: 'Upgrade to Pro to use coordinator agents',
          url: '/settings/billing',
        },
      };

      res.status(402).json(response);
      return;
    }

    next();
  } catch (error) {
    console.error('Error checking coordinator access:', error);
    res.status(500).json({ error: 'Failed to check coordinator access' });
  }
}

/**
 * Middleware to check session persistence access
 *
 * Use this middleware on endpoints that enable cloud session persistence.
 * Session persistence is only available on Pro plan and above.
 */
export async function checkSessionPersistenceAccess(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const userId = req.session.userId;

  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const check = await canUseSessionPersistence(userId);

    if (!check.allowed) {
      const response: PlanLimitError = {
        error: check.reason || 'Session persistence not available',
        code: 'FEATURE_NOT_AVAILABLE',
        details: {
          plan: 'current',
          resource: 'sessionPersistence',
          requiredPlan: check.requiredPlan,
        },
        upgrade: {
          message: 'Upgrade to Pro to enable cloud session persistence',
          url: '/settings/billing',
        },
      };

      res.status(402).json(response);
      return;
    }

    next();
  } catch (error) {
    console.error('Error checking session persistence access:', error);
    res.status(500).json({ error: 'Failed to check session persistence access' });
  }
}
