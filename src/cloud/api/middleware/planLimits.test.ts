/**
 * Tests for Plan Limits Middleware
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  checkWorkspaceLimit,
  checkRepoLimit,
  checkAgentLimit,
  checkCoordinatorAccess,
  checkSessionPersistenceAccess,
} from './planLimits.js';

// Mock the plan limits service
vi.mock('../../services/planLimits.js', () => ({
  canCreateWorkspace: vi.fn(),
  canAddRepo: vi.fn(),
  canSpawnAgent: vi.fn(),
  canUseCoordinator: vi.fn(),
  canUseSessionPersistence: vi.fn(),
}));

import {
  canCreateWorkspace,
  canAddRepo,
  canSpawnAgent,
  canUseCoordinator,
  canUseSessionPersistence,
} from '../../services/planLimits.js';

describe('Plan Limits Middleware', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;
  let jsonMock: ReturnType<typeof vi.fn>;
  let statusMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    jsonMock = vi.fn();
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });

    mockReq = {
      session: { userId: 'user-123' } as any,
      body: {},
    };
    mockRes = {
      status: statusMock,
      json: jsonMock,
    };
    mockNext = vi.fn();
  });

  describe('checkSessionPersistenceAccess', () => {
    it('returns 401 when no userId in session', async () => {
      mockReq.session = {} as any;

      await checkSessionPersistenceAccess(
        mockReq as Request,
        mockRes as Response,
        mockNext
      );

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith({ error: 'Authentication required' });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('calls next() when access is allowed', async () => {
      (canUseSessionPersistence as any).mockResolvedValue({ allowed: true });

      await checkSessionPersistenceAccess(
        mockReq as Request,
        mockRes as Response,
        mockNext
      );

      expect(mockNext).toHaveBeenCalled();
      expect(statusMock).not.toHaveBeenCalled();
    });

    it('returns 402 with upgrade info when access denied', async () => {
      (canUseSessionPersistence as any).mockResolvedValue({
        allowed: false,
        reason: 'Cloud session persistence requires a Pro plan or higher',
        requiredPlan: 'pro',
      });

      await checkSessionPersistenceAccess(
        mockReq as Request,
        mockRes as Response,
        mockNext
      );

      expect(statusMock).toHaveBeenCalledWith(402);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Cloud session persistence requires a Pro plan or higher',
          code: 'FEATURE_NOT_AVAILABLE',
          details: expect.objectContaining({
            resource: 'sessionPersistence',
            requiredPlan: 'pro',
          }),
          upgrade: expect.objectContaining({
            message: expect.stringContaining('Pro'),
            url: '/settings/billing',
          }),
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('returns 500 on service error', async () => {
      (canUseSessionPersistence as any).mockRejectedValue(new Error('DB error'));

      await checkSessionPersistenceAccess(
        mockReq as Request,
        mockRes as Response,
        mockNext
      );

      expect(statusMock).toHaveBeenCalledWith(500);
      expect(jsonMock).toHaveBeenCalledWith({
        error: 'Failed to check session persistence access',
      });
    });
  });

  describe('checkWorkspaceLimit', () => {
    it('returns 401 when no userId in session', async () => {
      mockReq.session = {} as any;

      await checkWorkspaceLimit(
        mockReq as Request,
        mockRes as Response,
        mockNext
      );

      expect(statusMock).toHaveBeenCalledWith(401);
    });

    it('calls next() when within limit', async () => {
      (canCreateWorkspace as any).mockResolvedValue({ allowed: true });

      await checkWorkspaceLimit(
        mockReq as Request,
        mockRes as Response,
        mockNext
      );

      expect(mockNext).toHaveBeenCalled();
    });

    it('returns 402 when limit exceeded', async () => {
      (canCreateWorkspace as any).mockResolvedValue({
        allowed: false,
        reason: 'Workspace limit reached for free plan',
        limit: 1,
        current: 1,
      });

      await checkWorkspaceLimit(
        mockReq as Request,
        mockRes as Response,
        mockNext
      );

      expect(statusMock).toHaveBeenCalledWith(402);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'PLAN_LIMIT_EXCEEDED',
          details: expect.objectContaining({
            resource: 'workspaces',
            limit: 1,
            current: 1,
          }),
        })
      );
    });
  });

  describe('checkRepoLimit', () => {
    it('calls next() when within limit', async () => {
      (canAddRepo as any).mockResolvedValue({ allowed: true });

      await checkRepoLimit(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('returns 402 when limit exceeded', async () => {
      (canAddRepo as any).mockResolvedValue({
        allowed: false,
        reason: 'Repository limit reached',
        limit: 3,
        current: 3,
      });

      await checkRepoLimit(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(402);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({
            resource: 'repos',
          }),
        })
      );
    });
  });

  describe('checkAgentLimit', () => {
    it('passes currentRunningAgents from request body', async () => {
      mockReq.body = { currentRunningAgents: 5 };
      (canSpawnAgent as any).mockResolvedValue({ allowed: true });

      await checkAgentLimit(mockReq as Request, mockRes as Response, mockNext);

      expect(canSpawnAgent).toHaveBeenCalledWith('user-123', 5);
      expect(mockNext).toHaveBeenCalled();
    });

    it('returns 402 when concurrent limit exceeded', async () => {
      (canSpawnAgent as any).mockResolvedValue({
        allowed: false,
        reason: 'Concurrent agent limit reached',
        limit: 2,
        current: 2,
      });

      await checkAgentLimit(mockReq as Request, mockRes as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(402);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({
            resource: 'concurrentAgents',
          }),
        })
      );
    });
  });

  describe('checkCoordinatorAccess', () => {
    it('calls next() when access allowed', async () => {
      (canUseCoordinator as any).mockResolvedValue({ allowed: true });

      await checkCoordinatorAccess(
        mockReq as Request,
        mockRes as Response,
        mockNext
      );

      expect(mockNext).toHaveBeenCalled();
    });

    it('returns 402 with required plan when denied', async () => {
      (canUseCoordinator as any).mockResolvedValue({
        allowed: false,
        reason: 'Coordinator agents require a Pro plan',
        requiredPlan: 'pro',
      });

      await checkCoordinatorAccess(
        mockReq as Request,
        mockRes as Response,
        mockNext
      );

      expect(statusMock).toHaveBeenCalledWith(402);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'FEATURE_NOT_AVAILABLE',
          details: expect.objectContaining({
            resource: 'coordinators',
            requiredPlan: 'pro',
          }),
        })
      );
    });
  });
});
