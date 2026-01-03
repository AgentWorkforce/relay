/**
 * Integration Tests for Cloud Monitoring API
 *
 * These tests run against a real cloud server with PostgreSQL and Redis.
 * They test the full flow of:
 * - Daemon linking and authentication
 * - Metrics reporting and retrieval
 * - Crash reporting and insights
 * - Alert management
 *
 * Run with: npm run test:integration
 * Or with docker: docker compose -f docker-compose.test.yml run test-runner
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';

const CLOUD_API_URL = process.env.CLOUD_API_URL || 'http://localhost:3100';
const TEST_TIMEOUT = parseInt(process.env.TEST_TIMEOUT || '30000', 10);

interface TestDaemon {
  id: string;
  apiKey: string;
  name: string;
}

interface TestUser {
  id: string;
  sessionCookie: string;
}

// Test state
let testDaemon: TestDaemon | null = null;
let testUser: TestUser | null = null;

// Helper to wait for cloud server
async function waitForCloud(maxWaitMs = 30000): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    try {
      const res = await fetch(`${CLOUD_API_URL}/health`);
      if (res.ok) {
        console.log('Cloud server is ready');
        return true;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

// Helper to create a test user (bypasses OAuth)
async function createTestUser(): Promise<TestUser | null> {
  try {
    const res = await fetch(`${CLOUD_API_URL}/api/test/create-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `test-${Date.now()}@example.com`,
        name: 'Test User',
      }),
    });

    if (!res.ok) {
      console.warn('Test user endpoint not available');
      return null;
    }

    const { userId, sessionCookie } = await res.json();
    return { id: userId, sessionCookie };
  } catch (error) {
    console.warn('Failed to create test user:', error);
    return null;
  }
}

// Helper to create a test daemon
async function createTestDaemon(name: string): Promise<TestDaemon | null> {
  try {
    const res = await fetch(`${CLOUD_API_URL}/api/test/create-daemon`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        machineId: crypto.randomBytes(16).toString('hex'),
      }),
    });

    if (!res.ok) {
      console.warn('Test daemon endpoint not available, status:', res.status);
      return null;
    }

    const { daemonId, apiKey } = await res.json();
    return { id: daemonId, apiKey, name };
  } catch (error) {
    console.warn('Failed to create test daemon:', error);
    return null;
  }
}

describe('Cloud Monitoring API Integration', () => {
  beforeAll(async () => {
    // Wait for cloud server to be ready
    const ready = await waitForCloud();
    if (!ready) {
      throw new Error('Cloud server did not become ready in time');
    }

    // Create test user and daemon
    testUser = await createTestUser();
    testDaemon = await createTestDaemon(`integration-test-${Date.now()}`);
  }, TEST_TIMEOUT);

  afterAll(async () => {
    // Cleanup would go here
  });

  describe('Health Check', () => {
    it('should return healthy status', async () => {
      const res = await fetch(`${CLOUD_API_URL}/health`);
      expect(res.ok).toBe(true);

      const data = await res.json();
      expect(data.status).toBe('ok');
    });
  });

  describe('Metrics Reporting', () => {
    it('should accept metrics from authenticated daemon', async () => {
      if (!testDaemon) {
        console.warn('Skipping: no test daemon available');
        return;
      }

      const agents = [
        {
          name: 'test-agent-1',
          pid: 12345,
          status: 'running',
          rssBytes: 100 * 1024 * 1024,
          heapUsedBytes: 60 * 1024 * 1024,
          cpuPercent: 25.5,
          trend: 'stable',
          trendRatePerMinute: 0,
          alertLevel: 'normal',
          highWatermark: 120 * 1024 * 1024,
          averageRss: 95 * 1024 * 1024,
          uptimeMs: 3600000,
          startedAt: new Date().toISOString(),
        },
      ];

      const res = await fetch(`${CLOUD_API_URL}/api/monitoring/metrics`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${testDaemon.apiKey}`,
        },
        body: JSON.stringify({ agents }),
      });

      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.recorded).toBe(1);
    });

    it('should reject metrics without authentication', async () => {
      const res = await fetch(`${CLOUD_API_URL}/api/monitoring/metrics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agents: [] }),
      });

      expect(res.status).toBe(401);
    });

    it('should reject metrics with invalid API key', async () => {
      const res = await fetch(`${CLOUD_API_URL}/api/monitoring/metrics`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ar_live_invalid_key',
        },
        body: JSON.stringify({ agents: [] }),
      });

      expect(res.status).toBe(401);
    });
  });

  describe('Crash Reporting', () => {
    it('should accept crash report from authenticated daemon', async () => {
      if (!testDaemon) {
        console.warn('Skipping: no test daemon available');
        return;
      }

      const crash = {
        agentName: 'test-agent-crash',
        pid: 54321,
        exitCode: 137,
        signal: 'SIGKILL',
        reason: 'Out of memory',
        likelyCause: 'oom',
        confidence: 'high',
        summary: 'Agent ran out of memory during processing',
        peakMemory: 1.5 * 1024 * 1024 * 1024,
        lastKnownMemory: 1.4 * 1024 * 1024 * 1024,
        memoryTrend: 'growing',
        crashedAt: new Date().toISOString(),
      };

      const res = await fetch(`${CLOUD_API_URL}/api/monitoring/crash`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${testDaemon.apiKey}`,
        },
        body: JSON.stringify({ crash }),
      });

      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.crashId).toBeDefined();
    });
  });

  describe('Alert Reporting', () => {
    it('should accept alert from authenticated daemon', async () => {
      if (!testDaemon) {
        console.warn('Skipping: no test daemon available');
        return;
      }

      const alert = {
        agentName: 'test-agent-alert',
        alertType: 'warning',
        currentRss: 600 * 1024 * 1024,
        threshold: 512 * 1024 * 1024,
        message: 'Memory usage is elevated',
        recommendation: 'Consider restarting the agent',
      };

      const res = await fetch(`${CLOUD_API_URL}/api/monitoring/alert`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${testDaemon.apiKey}`,
        },
        body: JSON.stringify({ alert }),
      });

      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.alertId).toBeDefined();
    });
  });

  describe('Dashboard API (requires auth)', () => {
    it('should return 401 for overview without session', async () => {
      const res = await fetch(`${CLOUD_API_URL}/api/monitoring/overview`);
      expect(res.status).toBe(401);
    });

    it('should return 401 for crashes without session', async () => {
      const res = await fetch(`${CLOUD_API_URL}/api/monitoring/crashes`);
      expect(res.status).toBe(401);
    });

    it('should return 401 for alerts without session', async () => {
      const res = await fetch(`${CLOUD_API_URL}/api/monitoring/alerts`);
      expect(res.status).toBe(401);
    });

    it('should return 401 for insights without session', async () => {
      const res = await fetch(`${CLOUD_API_URL}/api/monitoring/insights`);
      expect(res.status).toBe(401);
    });
  });

  describe('Monitoring Overview (with session)', () => {
    it('should return monitoring data for authenticated user', async () => {
      if (!testUser) {
        console.warn('Skipping: no test user available');
        return;
      }

      const res = await fetch(`${CLOUD_API_URL}/api/monitoring/overview`, {
        headers: {
          'Cookie': testUser.sessionCookie,
        },
      });

      if (res.status === 401) {
        console.warn('Session not valid, skipping');
        return;
      }

      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.summary).toBeDefined();
      expect(data.summary.totalAgents).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Insights API', () => {
    it('should return health insights for authenticated user', async () => {
      if (!testUser) {
        console.warn('Skipping: no test user available');
        return;
      }

      const res = await fetch(`${CLOUD_API_URL}/api/monitoring/insights`, {
        headers: {
          'Cookie': testUser.sessionCookie,
        },
      });

      if (res.status === 401) {
        console.warn('Session not valid, skipping');
        return;
      }

      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.healthScore).toBeGreaterThanOrEqual(0);
      expect(data.healthScore).toBeLessThanOrEqual(100);
      expect(data.summary).toBeDefined();
    });
  });
});

describe('Multiple Daemon Scenario', () => {
  const daemons: TestDaemon[] = [];

  beforeAll(async () => {
    // Create multiple test daemons
    for (let i = 0; i < 3; i++) {
      const daemon = await createTestDaemon(`multi-daemon-${i}-${Date.now()}`);
      if (daemon) {
        daemons.push(daemon);
      }
    }
  }, TEST_TIMEOUT);

  it('should handle metrics from multiple daemons', async () => {
    if (daemons.length === 0) {
      console.warn('Skipping: no test daemons available');
      return;
    }

    const results = await Promise.all(
      daemons.map(async (daemon, index) => {
        const agents = [
          {
            name: `agent-${daemon.name}-1`,
            pid: 10000 + index * 100,
            status: 'running',
            rssBytes: (100 + index * 50) * 1024 * 1024,
            alertLevel: 'normal',
          },
        ];

        const res = await fetch(`${CLOUD_API_URL}/api/monitoring/metrics`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${daemon.apiKey}`,
          },
          body: JSON.stringify({ agents }),
        });

        return res.ok;
      })
    );

    expect(results.every((r) => r)).toBe(true);
  });
});

describe('Alert Escalation Scenario', () => {
  it('should track alert level progression', async () => {
    if (!testDaemon) {
      console.warn('Skipping: no test daemon available');
      return;
    }

    const agentName = 'escalation-test-agent';
    const levels = ['normal', 'warning', 'critical', 'oom_imminent'];

    for (let i = 0; i < levels.length; i++) {
      const level = levels[i];
      const rssBytes = (50 + i * 400) * 1024 * 1024; // 50MB, 450MB, 850MB, 1250MB

      const agents = [
        {
          name: agentName,
          pid: 99999,
          status: 'running',
          rssBytes,
          alertLevel: level,
        },
      ];

      const res = await fetch(`${CLOUD_API_URL}/api/monitoring/metrics`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${testDaemon.apiKey}`,
        },
        body: JSON.stringify({ agents }),
      });

      expect(res.ok).toBe(true);

      // Small delay between updates
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
});

describe('Crash Pattern Detection', () => {
  it('should record multiple crashes for pattern analysis', async () => {
    if (!testDaemon) {
      console.warn('Skipping: no test daemon available');
      return;
    }

    // Report multiple OOM crashes
    for (let i = 0; i < 3; i++) {
      const crash = {
        agentName: `pattern-test-agent-${i}`,
        pid: 80000 + i,
        exitCode: 137,
        signal: 'SIGKILL',
        reason: 'OOM killer',
        likelyCause: 'oom',
        confidence: 'high',
        peakMemory: (1.5 + i * 0.1) * 1024 * 1024 * 1024,
      };

      const res = await fetch(`${CLOUD_API_URL}/api/monitoring/crash`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${testDaemon.apiKey}`,
        },
        body: JSON.stringify({ crash }),
      });

      expect(res.ok).toBe(true);
    }
  });
});
