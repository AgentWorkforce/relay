/**
 * Tests for Plan Limits Service
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getPlanLimits,
  canUseSessionPersistence,
  canUseCoordinator,
  canCreateWorkspace,
  canAddRepo,
  canSpawnAgent,
  PLAN_LIMITS,
} from './planLimits.js';

// Mock the database
const mockUser = { id: 'user-123', plan: 'free' };
const mockWorkspaces: any[] = [];
const mockRepos: any[] = [];

vi.mock('../db/index.js', () => ({
  db: {
    users: {
      findById: vi.fn(() => mockUser),
    },
    workspaces: {
      findByUserId: vi.fn(() => mockWorkspaces),
    },
    repositories: {
      findByWorkspaceId: vi.fn(() => mockRepos),
    },
  },
  PlanType: {},
  usageRecordsTable: {},
}));

vi.mock('../db/drizzle.js', () => ({
  getDb: () => ({
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([{ total: 0 }]),
  }),
}));

describe('Plan Limits Configuration', () => {
  describe('getPlanLimits', () => {
    it('returns correct limits for free plan', () => {
      const limits = getPlanLimits('free');

      expect(limits.sessionPersistence).toBe(false);
      expect(limits.coordinatorsEnabled).toBe(false);
      expect(limits.maxWorkspaces).toBe(1);
      expect(limits.maxConcurrentAgents).toBe(2);
    });

    it('returns correct limits for pro plan', () => {
      const limits = getPlanLimits('pro');

      expect(limits.sessionPersistence).toBe(true);
      expect(limits.coordinatorsEnabled).toBe(true);
      expect(limits.maxWorkspaces).toBe(5);
      expect(limits.maxConcurrentAgents).toBe(10);
    });

    it('returns correct limits for team plan', () => {
      const limits = getPlanLimits('team');

      expect(limits.sessionPersistence).toBe(true);
      expect(limits.coordinatorsEnabled).toBe(true);
      expect(limits.maxWorkspaces).toBe(20);
    });

    it('returns correct limits for enterprise plan', () => {
      const limits = getPlanLimits('enterprise');

      expect(limits.sessionPersistence).toBe(true);
      expect(limits.maxWorkspaces).toBe(Infinity);
      expect(limits.maxComputeHoursPerMonth).toBe(Infinity);
    });
  });

  describe('PLAN_LIMITS structure', () => {
    it('has all required plans', () => {
      expect(PLAN_LIMITS).toHaveProperty('free');
      expect(PLAN_LIMITS).toHaveProperty('pro');
      expect(PLAN_LIMITS).toHaveProperty('team');
      expect(PLAN_LIMITS).toHaveProperty('enterprise');
    });

    it('all plans have sessionPersistence field', () => {
      for (const plan of Object.values(PLAN_LIMITS)) {
        expect(plan).toHaveProperty('sessionPersistence');
        expect(typeof plan.sessionPersistence).toBe('boolean');
      }
    });
  });
});

describe('Session Persistence Access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser.plan = 'free';
  });

  describe('canUseSessionPersistence', () => {
    it('denies access for free plan users', async () => {
      mockUser.plan = 'free';

      const result = await canUseSessionPersistence('user-123');

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Pro plan');
      expect(result.requiredPlan).toBe('pro');
    });

    it('allows access for pro plan users', async () => {
      mockUser.plan = 'pro';

      const result = await canUseSessionPersistence('user-123');

      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('allows access for team plan users', async () => {
      mockUser.plan = 'team';

      const result = await canUseSessionPersistence('user-123');

      expect(result.allowed).toBe(true);
    });

    it('allows access for enterprise plan users', async () => {
      mockUser.plan = 'enterprise';

      const result = await canUseSessionPersistence('user-123');

      expect(result.allowed).toBe(true);
    });

    it('returns not found for missing user', async () => {
      const { db } = await import('../db/index.js');
      (db.users.findById as any).mockReturnValueOnce(null);

      const result = await canUseSessionPersistence('unknown-user');

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('User not found');
    });
  });
});

describe('Coordinator Access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser.plan = 'free';
  });

  describe('canUseCoordinator', () => {
    it('denies access for free plan users', async () => {
      mockUser.plan = 'free';

      const result = await canUseCoordinator('user-123');

      expect(result.allowed).toBe(false);
      expect(result.requiredPlan).toBe('pro');
    });

    it('allows access for pro plan users', async () => {
      mockUser.plan = 'pro';

      const result = await canUseCoordinator('user-123');

      expect(result.allowed).toBe(true);
    });
  });
});

describe('Resource Limits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser.plan = 'free';
    mockWorkspaces.length = 0;
    mockRepos.length = 0;
  });

  describe('canCreateWorkspace', () => {
    it('allows when under limit', async () => {
      mockUser.plan = 'free';
      mockWorkspaces.length = 0;

      const result = await canCreateWorkspace('user-123');

      expect(result.allowed).toBe(true);
    });

    it('denies when at limit', async () => {
      mockUser.plan = 'free';
      // Free plan has maxWorkspaces: 1
      mockWorkspaces.push({ id: 'ws-1' });

      const result = await canCreateWorkspace('user-123');

      expect(result.allowed).toBe(false);
      expect(result.limit).toBe(1);
      expect(result.current).toBe(1);
    });
  });

  describe('canAddRepo', () => {
    it('allows when under limit', async () => {
      mockUser.plan = 'free';
      mockWorkspaces.push({ id: 'ws-1' });
      mockRepos.length = 0;

      const result = await canAddRepo('user-123');

      expect(result.allowed).toBe(true);
    });

    it('denies when at limit', async () => {
      mockUser.plan = 'free';
      mockWorkspaces.push({ id: 'ws-1' });
      // Free plan has maxRepos: 3
      mockRepos.push({ id: 'r1' }, { id: 'r2' }, { id: 'r3' });

      const result = await canAddRepo('user-123');

      expect(result.allowed).toBe(false);
    });
  });

  describe('canSpawnAgent', () => {
    it('allows when under concurrent limit', async () => {
      mockUser.plan = 'free';

      const result = await canSpawnAgent('user-123', 1);

      expect(result.allowed).toBe(true);
    });

    it('denies when at concurrent limit', async () => {
      mockUser.plan = 'free';
      // Free plan has maxConcurrentAgents: 2

      const result = await canSpawnAgent('user-123', 2);

      expect(result.allowed).toBe(false);
      expect(result.limit).toBe(2);
      expect(result.current).toBe(2);
    });

    it('allows more agents for pro plan', async () => {
      mockUser.plan = 'pro';
      // Pro plan has maxConcurrentAgents: 10

      const result = await canSpawnAgent('user-123', 5);

      expect(result.allowed).toBe(true);
    });
  });
});
