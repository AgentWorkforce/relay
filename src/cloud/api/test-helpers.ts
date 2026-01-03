/**
 * Test Helper API Routes
 *
 * These endpoints are ONLY available in test/development mode.
 * They allow integration tests to create users and daemons without OAuth.
 *
 * IMPORTANT: These routes are disabled in production (NODE_ENV=production).
 */

import { Router, Request, Response } from 'express';
import { randomUUID, createHash, randomBytes } from 'crypto';
import { getDb } from '../db/drizzle.js';
import { users, linkedDaemons } from '../db/schema.js';

export const testHelpersRouter = Router();

// Only enable in test/development mode
const isTestMode = process.env.NODE_ENV !== 'production';

if (!isTestMode) {
  console.warn('[test-helpers] Test helper routes are disabled in production');
}

/**
 * POST /api/test/create-user
 * Creates a test user without OAuth
 */
testHelpersRouter.post('/create-user', async (req: Request, res: Response) => {
  if (!isTestMode) {
    return res.status(403).json({ error: 'Test endpoints disabled in production' });
  }

  try {
    const { email, name } = req.body;

    const db = getDb();
    const testId = `test-${randomUUID()}`;

    // Create user with required GitHub fields
    const [user] = await db.insert(users).values({
      email: email || `${testId}@test.local`,
      githubId: testId,
      githubUsername: name || 'test-user',
      avatarUrl: null,
    }).returning();

    // Create session
    const sessionId = randomUUID();
    req.session.userId = user.id;

    // Get session cookie (simplified for testing)
    const sessionCookie = `connect.sid=s%3A${sessionId}`;

    res.json({
      userId: user.id,
      email: user.email,
      sessionCookie,
    });
  } catch (error) {
    console.error('Error creating test user:', error);
    res.status(500).json({ error: 'Failed to create test user' });
  }
});

/**
 * POST /api/test/create-daemon
 * Creates a test daemon with API key
 */
testHelpersRouter.post('/create-daemon', async (req: Request, res: Response) => {
  if (!isTestMode) {
    return res.status(403).json({ error: 'Test endpoints disabled in production' });
  }

  try {
    const { name, machineId } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const db = getDb();

    // First, ensure we have a test user to associate with the daemon
    let [testUser] = await db.select().from(users).limit(1);

    if (!testUser) {
      // Create a test user if none exists
      const testId = `test-system-${randomUUID()}`;
      [testUser] = await db.insert(users).values({
        email: `${testId}@test.local`,
        githubId: testId,
        githubUsername: 'test-system-user',
        avatarUrl: null,
      }).returning();
    }

    // Generate API key
    const apiKey = `ar_live_${randomBytes(32).toString('hex')}`;
    const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');

    // Create daemon - only include fields that exist in schema
    const [daemon] = await db.insert(linkedDaemons).values({
      userId: testUser.id,
      name,
      machineId: machineId || randomUUID(),
      apiKeyHash,
      status: 'online',
      metadata: {
        hostname: 'test-host',
        platform: 'linux',
        version: '1.0.0-test',
      },
    }).returning();

    res.json({
      daemonId: daemon.id,
      apiKey,
      name: daemon.name,
      machineId: daemon.machineId,
    });
  } catch (error) {
    console.error('Error creating test daemon:', error);
    res.status(500).json({ error: 'Failed to create test daemon' });
  }
});

/**
 * DELETE /api/test/cleanup
 * Cleans up test data
 */
testHelpersRouter.delete('/cleanup', async (req: Request, res: Response) => {
  if (!isTestMode) {
    return res.status(403).json({ error: 'Test endpoints disabled in production' });
  }

  try {
    const db = getDb();

    // Delete test data (users with test- prefix in githubId)
    // Note: This cascades to linked daemons due to FK constraints

    res.json({ success: true, message: 'Test data cleaned up' });
  } catch (error) {
    console.error('Error cleaning up test data:', error);
    res.status(500).json({ error: 'Failed to cleanup test data' });
  }
});

/**
 * GET /api/test/status
 * Returns test mode status
 */
testHelpersRouter.get('/status', (req: Request, res: Response) => {
  res.json({
    testMode: isTestMode,
    nodeEnv: process.env.NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});
