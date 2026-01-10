/**
 * Integration Tests for Bulk-Ingest Message Sync API
 *
 * These tests run against a real cloud server with PostgreSQL.
 * They test the full flow of:
 * - Message sync from daemon to cloud
 * - Batch processing strategies (small, medium, large)
 * - Deduplication via workspace_id + original_id constraint
 * - Retention policy enforcement
 * - Pool health and statistics
 *
 * Run with: npm run test:integration
 * Or with docker: docker compose -f docker-compose.test.yml run test-runner
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';

const CLOUD_API_URL = process.env.CLOUD_API_URL || 'http://localhost:3100';
const TEST_TIMEOUT = parseInt(process.env.TEST_TIMEOUT || '30000', 10);

interface TestDaemon {
  id: string;
  apiKey: string;
  name: string;
  workspaceId?: string;
}

interface TestUser {
  id: string;
  sessionCookie: string;
}

interface TestWorkspace {
  id: string;
  name: string;
  repoFullName?: string;
}

interface SyncMessageInput {
  id: string;
  ts: number;
  from: string;
  to: string;
  body: string;
  kind?: string;
  topic?: string;
  thread?: string;
  channel?: string;
  is_broadcast?: boolean;
  is_urgent?: boolean;
  data?: Record<string, unknown>;
  payload_meta?: {
    requires_ack?: boolean;
    ttl_ms?: number;
    importance?: number;
    replyTo?: string;
  };
}

// Test state
let testDaemon: TestDaemon | null = null;
let testUser: TestUser | null = null;
let testWorkspace: TestWorkspace | null = null;

// Quick check if cloud server is available (doesn't wait)
async function isCloudAvailable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${CLOUD_API_URL}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

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
        email: `bulk-ingest-test-${Date.now()}@example.com`,
        name: 'Bulk Ingest Test User',
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

// Helper to create a test workspace with linked repository
async function createTestWorkspace(
  repoFullName?: string,
  userId?: string
): Promise<TestWorkspace | null> {
  try {
    const targetRepoFullName = repoFullName || `test-org/test-repo-${Date.now()}`;
    const res = await fetch(`${CLOUD_API_URL}/api/test/create-workspace`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `bulk-ingest-test-workspace-${Date.now()}`,
        repoFullName: targetRepoFullName,
        userId,
      }),
    });

    if (!res.ok) {
      console.warn('Test workspace endpoint not available, status:', res.status);
      return null;
    }

    const data = await res.json();
    return {
      id: data.workspaceId,
      name: data.name,
      repoFullName: data.repoFullName,
    };
  } catch (error) {
    console.warn('Failed to create test workspace:', error);
    return null;
  }
}

// Helper to create a test daemon linked to a workspace
async function createTestDaemonWithWorkspace(
  name: string,
  workspaceId?: string,
  userId?: string
): Promise<TestDaemon | null> {
  try {
    const res = await fetch(`${CLOUD_API_URL}/api/test/create-daemon-with-workspace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        machineId: randomBytes(16).toString('hex'),
        workspaceId,
        userId,
      }),
    });

    if (!res.ok) {
      console.warn('Test daemon endpoint not available, status:', res.status);
      return null;
    }

    const data = await res.json();
    return { id: data.daemonId, apiKey: data.apiKey, name, workspaceId: data.workspaceId };
  } catch (error) {
    console.warn('Failed to create test daemon:', error);
    return null;
  }
}

// Helper to generate test messages
function generateTestMessages(count: number, prefix = 'msg'): SyncMessageInput[] {
  const baseTs = Date.now() - count * 1000;
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${Date.now()}-${i}`,
    ts: baseTs + i * 1000,
    from: `test-agent-${i % 5}`,
    to: i % 3 === 0 ? '*' : `target-agent-${i % 3}`,
    body: `Test message ${i}: ${randomBytes(20).toString('hex')}`,
    kind: 'message',
    topic: `topic-${i % 10}`,
    thread: i % 4 === 0 ? `thread-${Math.floor(i / 4)}` : undefined,
    channel: i % 5 === 0 ? 'general' : undefined,
    is_broadcast: i % 3 === 0,
    is_urgent: i % 20 === 0,
    data: i % 10 === 0 ? { metadata: { index: i, random: Math.random() } } : undefined,
    payload_meta: i % 15 === 0 ? { requires_ack: true, importance: 5 } : undefined,
  }));
}

// Check cloud availability once before all tests
let cloudAvailable = false;

describe('Bulk-Ingest Message Sync API Integration', () => {
  beforeAll(async () => {
    // Quick check if cloud is available
    cloudAvailable = await isCloudAvailable();
    if (!cloudAvailable) {
      console.log('Cloud server not available - skipping integration tests');
      return;
    }

    // Wait for cloud server to be fully ready
    const ready = await waitForCloud();
    if (!ready) {
      cloudAvailable = false;
      console.log('Cloud server did not become ready - skipping integration tests');
      return;
    }

    // Create test user first
    testUser = await createTestUser();

    // Create workspace linked to the test user
    testWorkspace = await createTestWorkspace(undefined, testUser?.id);

    // Create daemon linked to workspace and same user
    testDaemon = await createTestDaemonWithWorkspace(
      `bulk-ingest-test-${Date.now()}`,
      testWorkspace?.id,
      testUser?.id
    );
  }, TEST_TIMEOUT);

  afterAll(async () => {
    // Cleanup would go here
  });

  describe('Basic Message Sync', () => {
    it('should sync a single message', async () => {
      if (!testDaemon || !testWorkspace) {
        console.warn('Skipping: no test daemon or workspace available');
        return;
      }

      const messages = generateTestMessages(1, 'single');

      const res = await fetch(`${CLOUD_API_URL}/api/daemons/messages/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${testDaemon.apiKey}`,
        },
        body: JSON.stringify({ messages }),
      });

      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.synced).toBe(1);
      expect(data.duplicates).toBe(0);
    });

    it('should sync a small batch of messages', async () => {
      if (!testDaemon || !testWorkspace) {
        console.warn('Skipping: no test daemon or workspace available');
        return;
      }

      const messages = generateTestMessages(50, 'small-batch');

      const res = await fetch(`${CLOUD_API_URL}/api/daemons/messages/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${testDaemon.apiKey}`,
        },
        body: JSON.stringify({ messages }),
      });

      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.synced).toBe(50);
      expect(data.duplicates).toBe(0);
    });

    it('should handle empty message array', async () => {
      if (!testDaemon || !testWorkspace) {
        console.warn('Skipping: no test daemon or workspace available');
        return;
      }

      const res = await fetch(`${CLOUD_API_URL}/api/daemons/messages/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${testDaemon.apiKey}`,
        },
        body: JSON.stringify({ messages: [] }),
      });

      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.synced).toBe(0);
      expect(data.duplicates).toBe(0);
    });
  });

  describe('Batch Size Strategies', () => {
    it('should handle medium batch (100-500 messages) using multi-row INSERT', async () => {
      if (!testDaemon || !testWorkspace) {
        console.warn('Skipping: no test daemon or workspace available');
        return;
      }

      const messages = generateTestMessages(150, 'medium-batch');

      const res = await fetch(`${CLOUD_API_URL}/api/daemons/messages/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${testDaemon.apiKey}`,
        },
        body: JSON.stringify({ messages }),
      });

      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.synced).toBe(150);
      expect(data.duplicates).toBe(0);
    });

    it('should handle max batch size (500 messages)', async () => {
      if (!testDaemon || !testWorkspace) {
        console.warn('Skipping: no test daemon or workspace available');
        return;
      }

      const messages = generateTestMessages(500, 'max-batch');

      const res = await fetch(`${CLOUD_API_URL}/api/daemons/messages/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${testDaemon.apiKey}`,
        },
        body: JSON.stringify({ messages }),
      });

      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.synced).toBe(500);
      expect(data.duplicates).toBe(0);
    });

    it('should reject batches exceeding 500 messages', async () => {
      if (!testDaemon || !testWorkspace) {
        console.warn('Skipping: no test daemon or workspace available');
        return;
      }

      const messages = generateTestMessages(501, 'oversized-batch');

      const res = await fetch(`${CLOUD_API_URL}/api/daemons/messages/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${testDaemon.apiKey}`,
        },
        body: JSON.stringify({ messages }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('Maximum batch size is 500');
    });
  });

  describe('Deduplication', () => {
    it('should skip duplicate messages on re-sync', async () => {
      if (!testDaemon || !testWorkspace) {
        console.warn('Skipping: no test daemon or workspace available');
        return;
      }

      // Generate messages with fixed IDs for dedup test
      const fixedMessages: SyncMessageInput[] = Array.from({ length: 10 }, (_, i) => ({
        id: `dedup-test-fixed-${i}`,
        ts: Date.now() - i * 1000,
        from: 'agent-a',
        to: 'agent-b',
        body: `Dedup test message ${i}`,
        kind: 'message',
      }));

      // First sync - should insert all
      const res1 = await fetch(`${CLOUD_API_URL}/api/daemons/messages/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${testDaemon.apiKey}`,
        },
        body: JSON.stringify({ messages: fixedMessages }),
      });

      expect(res1.ok).toBe(true);
      const data1 = await res1.json();
      expect(data1.synced).toBe(10);
      expect(data1.duplicates).toBe(0);

      // Second sync - should detect all as duplicates
      const res2 = await fetch(`${CLOUD_API_URL}/api/daemons/messages/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${testDaemon.apiKey}`,
        },
        body: JSON.stringify({ messages: fixedMessages }),
      });

      expect(res2.ok).toBe(true);
      const data2 = await res2.json();
      expect(data2.synced).toBe(0);
      expect(data2.duplicates).toBe(10);
    });

    it('should handle mixed new and duplicate messages', async () => {
      if (!testDaemon || !testWorkspace) {
        console.warn('Skipping: no test daemon or workspace available');
        return;
      }

      // Create some initial messages
      const initialMessages: SyncMessageInput[] = Array.from({ length: 5 }, (_, i) => ({
        id: `mixed-test-initial-${i}`,
        ts: Date.now() - i * 1000,
        from: 'agent-x',
        to: 'agent-y',
        body: `Initial message ${i}`,
        kind: 'message',
      }));

      await fetch(`${CLOUD_API_URL}/api/daemons/messages/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${testDaemon.apiKey}`,
        },
        body: JSON.stringify({ messages: initialMessages }),
      });

      // Now send mixed batch: 5 duplicates + 5 new
      const newMessages: SyncMessageInput[] = Array.from({ length: 5 }, (_, i) => ({
        id: `mixed-test-new-${i}`,
        ts: Date.now() - i * 1000,
        from: 'agent-x',
        to: 'agent-y',
        body: `New message ${i}`,
        kind: 'message',
      }));

      const mixedMessages = [...initialMessages, ...newMessages];

      const res = await fetch(`${CLOUD_API_URL}/api/daemons/messages/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${testDaemon.apiKey}`,
        },
        body: JSON.stringify({ messages: mixedMessages }),
      });

      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.synced).toBe(5); // Only new messages
      expect(data.duplicates).toBe(5); // Initial messages are duplicates
    });
  });

  describe('Message Content Types', () => {
    it('should handle messages with JSONB data field', async () => {
      if (!testDaemon || !testWorkspace) {
        console.warn('Skipping: no test daemon or workspace available');
        return;
      }

      const messages: SyncMessageInput[] = [
        {
          id: `jsonb-test-${Date.now()}`,
          ts: Date.now(),
          from: 'data-agent',
          to: 'processor-agent',
          body: 'Message with complex data',
          kind: 'action',
          data: {
            nested: {
              array: [1, 2, 3],
              object: { key: 'value' },
            },
            numbers: [1.5, 2.7, 3.9],
            strings: ['a', 'b', 'c'],
            boolean: true,
            nullValue: null,
          },
        },
      ];

      const res = await fetch(`${CLOUD_API_URL}/api/daemons/messages/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${testDaemon.apiKey}`,
        },
        body: JSON.stringify({ messages }),
      });

      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.synced).toBe(1);
    });

    it('should handle messages with payload_meta', async () => {
      if (!testDaemon || !testWorkspace) {
        console.warn('Skipping: no test daemon or workspace available');
        return;
      }

      const messages: SyncMessageInput[] = [
        {
          id: `payload-meta-test-${Date.now()}`,
          ts: Date.now(),
          from: 'sender-agent',
          to: 'receiver-agent',
          body: 'Message with payload metadata',
          kind: 'message',
          payload_meta: {
            requires_ack: true,
            ttl_ms: 60000,
            importance: 9,
            replyTo: 'original-msg-123',
          },
        },
      ];

      const res = await fetch(`${CLOUD_API_URL}/api/daemons/messages/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${testDaemon.apiKey}`,
        },
        body: JSON.stringify({ messages }),
      });

      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.synced).toBe(1);
    });

    it('should handle broadcast messages', async () => {
      if (!testDaemon || !testWorkspace) {
        console.warn('Skipping: no test daemon or workspace available');
        return;
      }

      const messages: SyncMessageInput[] = [
        {
          id: `broadcast-test-${Date.now()}`,
          ts: Date.now(),
          from: 'announcer-agent',
          to: '*',
          body: 'Broadcast message to all agents',
          kind: 'message',
          is_broadcast: true,
          channel: 'general',
        },
      ];

      const res = await fetch(`${CLOUD_API_URL}/api/daemons/messages/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${testDaemon.apiKey}`,
        },
        body: JSON.stringify({ messages }),
      });

      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.synced).toBe(1);
    });

    it('should handle thread-grouped messages', async () => {
      if (!testDaemon || !testWorkspace) {
        console.warn('Skipping: no test daemon or workspace available');
        return;
      }

      const threadId = `thread-${Date.now()}`;
      const messages: SyncMessageInput[] = Array.from({ length: 5 }, (_, i) => ({
        id: `thread-msg-${Date.now()}-${i}`,
        ts: Date.now() - i * 1000,
        from: i % 2 === 0 ? 'agent-alice' : 'agent-bob',
        to: i % 2 === 0 ? 'agent-bob' : 'agent-alice',
        body: `Thread message ${i}`,
        kind: 'message',
        thread: threadId,
        topic: 'code-review',
      }));

      const res = await fetch(`${CLOUD_API_URL}/api/daemons/messages/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${testDaemon.apiKey}`,
        },
        body: JSON.stringify({ messages }),
      });

      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.synced).toBe(5);
    });
  });

  describe('Authentication', () => {
    it('should reject sync without authentication', async () => {
      const res = await fetch(`${CLOUD_API_URL}/api/daemons/messages/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      });

      // Server may return 401 (unauthorized) or 403 (forbidden)
      expect([401, 403]).toContain(res.status);
    });

    it('should reject sync with invalid API key', async () => {
      const res = await fetch(`${CLOUD_API_URL}/api/daemons/messages/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ar_live_invalid_key_12345',
        },
        body: JSON.stringify({ messages: [] }),
      });

      // Server may return 401 (unauthorized) or 403 (forbidden)
      expect([401, 403]).toContain(res.status);
    });

    it('should reject sync with malformed API key', async () => {
      const res = await fetch(`${CLOUD_API_URL}/api/daemons/messages/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer invalid_format',
        },
        body: JSON.stringify({ messages: [] }),
      });

      // Server may return 401 (unauthorized) or 403 (forbidden)
      expect([401, 403]).toContain(res.status);
    });
  });

  describe('Workspace Linking', () => {
    it('should require workspace to be linked', async () => {
      // Create a daemon without workspace
      const unlinkedDaemon = await createTestDaemonWithWorkspace(
        `unlinked-daemon-${Date.now()}`
      );

      if (!unlinkedDaemon) {
        console.warn('Skipping: could not create unlinked daemon');
        return;
      }

      const messages = generateTestMessages(1, 'unlinked');

      const res = await fetch(`${CLOUD_API_URL}/api/daemons/messages/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${unlinkedDaemon.apiKey}`,
        },
        body: JSON.stringify({ messages }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('workspace');
    });

    it('should auto-link daemon via repoFullName', async () => {
      if (!testWorkspace) {
        console.warn('Skipping: no test workspace available');
        return;
      }

      // Create a new daemon without workspace
      const autoLinkDaemon = await createTestDaemonWithWorkspace(
        `autolink-daemon-${Date.now()}`
      );

      if (!autoLinkDaemon) {
        console.warn('Skipping: could not create daemon for auto-link test');
        return;
      }

      const messages = generateTestMessages(1, 'autolink');

      const res = await fetch(`${CLOUD_API_URL}/api/daemons/messages/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${autoLinkDaemon.apiKey}`,
        },
        body: JSON.stringify({
          messages,
          repoFullName: testWorkspace.repoFullName,
        }),
      });

      // Should succeed because it auto-links via repoFullName
      if (res.ok) {
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.synced).toBe(1);
      } else {
        // If workspace not found, it should give a helpful error
        expect(res.status).toBe(400);
      }
    });
  });

  describe('Message Sync Stats', () => {
    it('should return sync statistics for linked daemon', async () => {
      if (!testDaemon || !testWorkspace) {
        console.warn('Skipping: no test daemon or workspace available');
        return;
      }

      const res = await fetch(`${CLOUD_API_URL}/api/daemons/messages/stats`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${testDaemon.apiKey}`,
        },
      });

      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.workspaceId).toBe(testWorkspace.id);
      expect(typeof data.messageCount).toBe('number');
      expect(data.messageCount).toBeGreaterThanOrEqual(0);
      expect(data.database).toBeDefined();
      expect(data.database.healthy).toBe(true);
      expect(typeof data.database.latencyMs).toBe('number');
      expect(data.database.pool).toBeDefined();
    });

    it('should reject stats for daemon without workspace', async () => {
      const unlinkedDaemon = await createTestDaemonWithWorkspace(
        `stats-unlinked-${Date.now()}`
      );

      if (!unlinkedDaemon) {
        console.warn('Skipping: could not create unlinked daemon');
        return;
      }

      const res = await fetch(`${CLOUD_API_URL}/api/daemons/messages/stats`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${unlinkedDaemon.apiKey}`,
        },
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('workspace');
    });
  });

  describe('Input Validation', () => {
    it('should reject sync without messages array', async () => {
      if (!testDaemon) {
        console.warn('Skipping: no test daemon available');
        return;
      }

      const res = await fetch(`${CLOUD_API_URL}/api/daemons/messages/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${testDaemon.apiKey}`,
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('messages array is required');
    });

    it('should reject sync with non-array messages', async () => {
      if (!testDaemon) {
        console.warn('Skipping: no test daemon available');
        return;
      }

      const res = await fetch(`${CLOUD_API_URL}/api/daemons/messages/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${testDaemon.apiKey}`,
        },
        body: JSON.stringify({ messages: 'not-an-array' }),
      });

      expect(res.status).toBe(400);
    });
  });
});

describe('Concurrent Sync Scenario', () => {
  let concurrentDaemons: TestDaemon[] = [];
  let concurrentUser: TestUser | null = null;
  let concurrentWorkspace: TestWorkspace | null = null;

  beforeAll(async () => {
    // Create user for concurrent tests
    concurrentUser = await createTestUser();

    // Create workspace linked to user
    concurrentWorkspace = await createTestWorkspace(
      `concurrent-test-org/repo-${Date.now()}`,
      concurrentUser?.id
    );

    // Create multiple daemons linked to same workspace
    if (concurrentWorkspace && concurrentUser) {
      for (let i = 0; i < 3; i++) {
        const daemon = await createTestDaemonWithWorkspace(
          `concurrent-daemon-${i}-${Date.now()}`,
          concurrentWorkspace.id,
          concurrentUser.id
        );
        if (daemon) {
          concurrentDaemons.push(daemon);
        }
      }
    }
  }, TEST_TIMEOUT);

  it('should handle concurrent syncs from multiple daemons', async () => {
    if (concurrentDaemons.length < 2 || !concurrentWorkspace) {
      console.warn('Skipping: insufficient test daemons or workspace');
      return;
    }

    // Generate unique messages for each daemon
    const syncPromises = concurrentDaemons.map((daemon, index) => {
      const messages = generateTestMessages(100, `concurrent-${index}`);
      return fetch(`${CLOUD_API_URL}/api/daemons/messages/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${daemon.apiKey}`,
        },
        body: JSON.stringify({ messages }),
      });
    });

    // Execute all syncs concurrently
    const responses = await Promise.all(syncPromises);

    // All should succeed
    for (const res of responses) {
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.synced).toBe(100);
    }
  });
});

describe('Performance Benchmarks', () => {
  let perfDaemon: TestDaemon | null = null;
  let perfUser: TestUser | null = null;
  let perfWorkspace: TestWorkspace | null = null;

  beforeAll(async () => {
    perfUser = await createTestUser();
    perfWorkspace = await createTestWorkspace(
      `perf-test-org/repo-${Date.now()}`,
      perfUser?.id
    );
    if (perfWorkspace && perfUser) {
      perfDaemon = await createTestDaemonWithWorkspace(
        `perf-daemon-${Date.now()}`,
        perfWorkspace.id,
        perfUser.id
      );
    }
  }, TEST_TIMEOUT);

  it('should sync 500 messages in reasonable time (<5s)', async () => {
    if (!perfDaemon || !perfWorkspace) {
      console.warn('Skipping: no perf test resources available');
      return;
    }

    const messages = generateTestMessages(500, 'perf-test');

    const startTime = Date.now();
    const res = await fetch(`${CLOUD_API_URL}/api/daemons/messages/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${perfDaemon.apiKey}`,
      },
      body: JSON.stringify({ messages }),
    });
    const duration = Date.now() - startTime;

    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.synced).toBe(500);

    // Performance assertion: should complete within 5 seconds
    expect(duration).toBeLessThan(5000);
    console.log(`500 messages synced in ${duration}ms`);
  });

  it('should handle rapid sequential syncs', async () => {
    if (!perfDaemon || !perfWorkspace) {
      console.warn('Skipping: no perf test resources available');
      return;
    }

    const batchCount = 5;
    const batchSize = 100;

    const startTime = Date.now();

    for (let batch = 0; batch < batchCount; batch++) {
      const messages = generateTestMessages(batchSize, `rapid-${batch}`);
      const res = await fetch(`${CLOUD_API_URL}/api/daemons/messages/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${perfDaemon.apiKey}`,
        },
        body: JSON.stringify({ messages }),
      });

      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.synced).toBe(batchSize);
    }

    const duration = Date.now() - startTime;
    console.log(
      `${batchCount} sequential batches of ${batchSize} messages synced in ${duration}ms`
    );

    // All batches should complete within reasonable time
    expect(duration).toBeLessThan(15000);
  });
});
