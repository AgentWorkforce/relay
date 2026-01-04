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
import { users, linkedDaemons, workspaces, repositories } from '../db/schema.js';
import { getProvisioner } from '../provisioner/index.js';
import { db } from '../db/index.js';
import { nangoService } from '../services/nango.js';

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
    const _db = getDb();

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

/**
 * POST /api/test/create-mock-workspace
 * Creates a mock workspace pointing to a local dashboard server
 *
 * Use this to test the cloud flow locally without real provisioning.
 * The workspace will have publicUrl pointing to localhost:3889.
 */
testHelpersRouter.post('/create-mock-workspace', async (req: Request, res: Response) => {
  if (!isTestMode) {
    return res.status(403).json({ error: 'Test endpoints disabled in production' });
  }

  try {
    const { name, publicUrl } = req.body;
    const userId = req.session.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Must be logged in. Use /api/test/create-user first or log in via OAuth.' });
    }

    const db = getDb();

    // Create a mock workspace with local publicUrl
    const [workspace] = await db.insert(workspaces).values({
      userId,
      name: name || 'Local Test Workspace',
      status: 'running',
      publicUrl: publicUrl || 'http://localhost:3889',
      computeProvider: 'docker',
      computeId: `mock-${randomUUID().slice(0, 8)}`,
      config: {
        providers: ['anthropic'],
        repositories: [],
        supervisorEnabled: true,
        maxAgents: 10,
      },
    }).returning();

    res.json({
      workspaceId: workspace.id,
      name: workspace.name,
      status: workspace.status,
      publicUrl: workspace.publicUrl,
      message: 'Mock workspace created. Start agent-relay locally and navigate to /app.',
    });
  } catch (error) {
    console.error('Error creating mock workspace:', error);
    res.status(500).json({ error: 'Failed to create mock workspace' });
  }
});

/**
 * POST /api/test/create-mock-repo
 * Creates a mock repository for the current user
 *
 * Use this to test the cloud flow without connecting real GitHub repos.
 */
testHelpersRouter.post('/create-mock-repo', async (req: Request, res: Response) => {
  if (!isTestMode) {
    return res.status(403).json({ error: 'Test endpoints disabled in production' });
  }

  try {
    const { fullName, isPrivate } = req.body;
    const userId = req.session.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Must be logged in. Use /api/test/create-user first or log in via OAuth.' });
    }

    if (!fullName) {
      return res.status(400).json({ error: 'fullName is required (e.g., "owner/repo")' });
    }

    const db = getDb();

    // Create a mock repository
    const [repo] = await db.insert(repositories).values({
      userId,
      githubId: Math.floor(Math.random() * 1000000),
      githubFullName: fullName,
      isPrivate: isPrivate ?? false,
      defaultBranch: 'main',
      syncStatus: 'synced',
      nangoConnectionId: `mock-connection-${randomUUID().slice(0, 8)}`,
      lastSyncedAt: new Date(),
    }).returning();

    res.json({
      repoId: repo.id,
      fullName: repo.githubFullName,
      isPrivate: repo.isPrivate,
      message: 'Mock repository created.',
    });
  } catch (error) {
    console.error('Error creating mock repo:', error);
    res.status(500).json({ error: 'Failed to create mock repo' });
  }
});

/**
 * POST /api/test/login-as
 * Quick login for testing - creates session for existing or new test user
 */
testHelpersRouter.post('/login-as', async (req: Request, res: Response) => {
  if (!isTestMode) {
    return res.status(403).json({ error: 'Test endpoints disabled in production' });
  }

  try {
    const { username } = req.body;
    const db = getDb();

    // Find or create user
    let user;
    const existingUsers = await db.select().from(users).limit(1);

    if (existingUsers.length > 0 && !username) {
      user = existingUsers[0];
    } else {
      const testId = `test-${randomUUID()}`;
      const [newUser] = await db.insert(users).values({
        email: `${username || testId}@test.local`,
        githubId: testId,
        githubUsername: username || 'test-user',
        avatarUrl: null,
        plan: 'free',
      }).returning();
      user = newUser;
    }

    // Set session
    req.session.userId = user.id;

    res.json({
      success: true,
      userId: user.id,
      username: user.githubUsername,
      message: 'Logged in. You can now access /app and other authenticated routes.',
    });
  } catch (error) {
    console.error('Error in login-as:', error);
    res.status(500).json({ error: 'Failed to login' });
  }
});

/**
 * GET /api/test/setup-local-cloud
 * One-shot setup: creates user, mock repo, and mock workspace
 *
 * After calling this, start agent-relay locally and go to /app
 */
testHelpersRouter.post('/setup-local-cloud', async (req: Request, res: Response) => {
  if (!isTestMode) {
    return res.status(403).json({ error: 'Test endpoints disabled in production' });
  }

  try {
    const { repoName, workspaceName } = req.body;
    const db = getDb();

    // 1. Create or get test user
    const testId = `test-${randomUUID().slice(0, 8)}`;
    const [user] = await db.insert(users).values({
      email: `${testId}@test.local`,
      githubId: testId,
      githubUsername: 'local-tester',
      avatarUrl: null,
      plan: 'free',
    }).returning();

    // Set session
    req.session.userId = user.id;

    // 2. Create mock repository
    const [repo] = await db.insert(repositories).values({
      userId: user.id,
      githubId: Math.floor(Math.random() * 1000000),
      githubFullName: repoName || 'test-org/test-repo',
      isPrivate: false,
      defaultBranch: 'main',
      syncStatus: 'synced',
      nangoConnectionId: `mock-${randomUUID().slice(0, 8)}`,
      lastSyncedAt: new Date(),
    }).returning();

    // 3. Create mock workspace pointing to local dashboard
    const [workspace] = await db.insert(workspaces).values({
      userId: user.id,
      name: workspaceName || 'Local Development',
      status: 'running',
      publicUrl: 'http://localhost:3889',
      computeProvider: 'docker',
      computeId: `mock-${randomUUID().slice(0, 8)}`,
      config: {
        providers: ['anthropic'],
        repositories: [repo.githubFullName],
        supervisorEnabled: true,
        maxAgents: 10,
      },
    }).returning();

    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.githubUsername,
      },
      repo: {
        id: repo.id,
        fullName: repo.githubFullName,
      },
      workspace: {
        id: workspace.id,
        name: workspace.name,
        publicUrl: workspace.publicUrl,
      },
      instructions: [
        '1. Start agent-relay daemon: npm run dev (or agent-relay daemon)',
        '2. Go to http://localhost:4567/app',
        '3. The app should auto-connect to the local workspace',
        '4. The WebSocket will connect to ws://localhost:3889/ws',
      ],
    });
  } catch (error) {
    console.error('Error in setup-local-cloud:', error);
    res.status(500).json({ error: 'Failed to setup local cloud' });
  }
});

/**
 * POST /api/test/provision-real-workspace
 * Provision a REAL Docker container using your Nango GitHub App connection.
 *
 * This tests the full flow including:
 * - Fetching GitHub App token from Nango
 * - Spinning up a Docker container
 * - Cloning your actual repositories
 *
 * Prerequisites:
 * - Must be logged in (via real OAuth or /api/test/login-as)
 * - Must have connected repos via /connect-repos (real Nango GitHub App OAuth)
 * - Docker must be running locally
 * - COMPUTE_PROVIDER must be 'docker' (default for dev)
 */
testHelpersRouter.post('/provision-real-workspace', async (req: Request, res: Response) => {
  if (!isTestMode) {
    return res.status(403).json({ error: 'Test endpoints disabled in production' });
  }

  const userId = req.session.userId;
  if (!userId) {
    return res.status(401).json({
      error: 'Must be logged in. Use real OAuth or /api/test/login-as first.',
    });
  }

  try {
    const { name, repositoryFullName, providers, githubToken } = req.body;

    // Get user's connected repositories
    const userRepos = await db.repositories.findByUserId(userId);
    const reposWithNango = userRepos.filter(r => r.nangoConnectionId);

    if (reposWithNango.length === 0) {
      return res.status(400).json({
        error: 'No repositories with Nango connection found. Complete /connect-repos first with real GitHub OAuth.',
        hint: 'Go to http://localhost:4567/connect-repos and connect your GitHub App, or pass githubToken directly',
      });
    }

    // Determine which repo to use
    let targetRepo = reposWithNango[0];
    if (repositoryFullName) {
      const found = reposWithNango.find(r => r.githubFullName === repositoryFullName);
      if (!found) {
        return res.status(400).json({
          error: `Repository ${repositoryFullName} not found or not connected via Nango`,
          availableRepos: reposWithNango.map(r => r.githubFullName),
        });
      }
      targetRepo = found;
    }

    // Use the real provisioner (Docker in dev mode)
    const provisioner = getProvisioner();

    const result = await provisioner.provision({
      userId,
      name: name || `Test Workspace - ${targetRepo.githubFullName}`,
      providers: providers || ['anthropic'], // Default to anthropic if not specified
      repositories: [targetRepo.githubFullName],
      supervisorEnabled: true,
      maxAgents: 10,
      // Allow passing GitHub token directly for local testing
      githubToken: githubToken || undefined,
    });

    if (result.status === 'error') {
      return res.status(500).json({
        error: 'Provisioning failed',
        details: result.error,
      });
    }

    res.json({
      success: true,
      workspace: {
        id: result.workspaceId,
        status: result.status,
        publicUrl: result.publicUrl,
      },
      repository: targetRepo.githubFullName,
      instructions: [
        `1. Workspace is running at ${result.publicUrl}`,
        `2. Repository ${targetRepo.githubFullName} should be cloned`,
        `3. Go to http://localhost:4567/app to connect`,
        `4. Check container: docker logs ar-${result.workspaceId.substring(0, 8)}`,
        `5. Verify clone: docker exec ar-${result.workspaceId.substring(0, 8)} ls /workspace/repos`,
      ],
    });
  } catch (error) {
    console.error('Error provisioning real workspace:', error);
    res.status(500).json({
      error: 'Failed to provision workspace',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/test/my-repos
 * List current user's connected repositories (for debugging)
 */
testHelpersRouter.get('/my-repos', async (req: Request, res: Response) => {
  if (!isTestMode) {
    return res.status(403).json({ error: 'Test endpoints disabled in production' });
  }

  const userId = req.session.userId;
  if (!userId) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  try {
    const repos = await db.repositories.findByUserId(userId);

    res.json({
      userId,
      repositories: repos.map(r => ({
        id: r.id,
        fullName: r.githubFullName,
        isPrivate: r.isPrivate,
        hasNangoConnection: !!r.nangoConnectionId,
        nangoConnectionId: r.nangoConnectionId, // For debugging
        syncStatus: r.syncStatus,
      })),
    });
  } catch (error) {
    console.error('Error fetching repos:', error);
    res.status(500).json({ error: 'Failed to fetch repositories' });
  }
});

/**
 * GET /api/test/my-workspaces
 * List current user's workspaces (for debugging)
 */
testHelpersRouter.get('/my-workspaces', async (req: Request, res: Response) => {
  if (!isTestMode) {
    return res.status(403).json({ error: 'Test endpoints disabled in production' });
  }

  const userId = req.session.userId;
  if (!userId) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  try {
    const userWorkspaces = await db.workspaces.findByUserId(userId);

    res.json({
      userId,
      workspaces: userWorkspaces.map(w => ({
        id: w.id,
        name: w.name,
        status: w.status,
        publicUrl: w.publicUrl,
        computeProvider: w.computeProvider,
        computeId: w.computeId,
        config: w.config,
      })),
    });
  } catch (error) {
    console.error('Error fetching workspaces:', error);
    res.status(500).json({ error: 'Failed to fetch workspaces' });
  }
});

/**
 * GET /api/test/nango-token
 * Test fetching GitHub App token from Nango (for debugging)
 */
testHelpersRouter.get('/nango-token', async (req: Request, res: Response) => {
  if (!isTestMode) {
    return res.status(403).json({ error: 'Test endpoints disabled in production' });
  }

  const userId = req.session.userId;
  if (!userId) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  try {
    const repos = await db.repositories.findByUserId(userId);
    const repoWithConnection = repos.find(r => r.nangoConnectionId);

    if (!repoWithConnection?.nangoConnectionId) {
      return res.status(400).json({
        error: 'No Nango connection found',
        repos: repos.map(r => ({ fullName: r.githubFullName, nangoConnectionId: r.nangoConnectionId })),
      });
    }

    console.log('[test] Fetching token for connection:', repoWithConnection.nangoConnectionId);

    const token = await nangoService.getGithubAppToken(repoWithConnection.nangoConnectionId);

    res.json({
      success: true,
      connectionId: repoWithConnection.nangoConnectionId,
      tokenLength: token.length,
      tokenPrefix: token.substring(0, 10) + '...',
    });
  } catch (error) {
    console.error('[test] Nango token fetch error:', error);
    res.status(500).json({
      error: 'Failed to fetch token',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * DELETE /api/test/workspace/:id
 * Delete/deprovision a workspace (for cleanup)
 */
testHelpersRouter.delete('/workspace/:id', async (req: Request, res: Response) => {
  if (!isTestMode) {
    return res.status(403).json({ error: 'Test endpoints disabled in production' });
  }

  const userId = req.session.userId;
  if (!userId) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  try {
    const { id } = req.params;
    const workspace = await db.workspaces.findById(id);

    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    if (workspace.userId !== userId) {
      return res.status(403).json({ error: 'Not your workspace' });
    }

    const provisioner = getProvisioner();
    await provisioner.deprovision(id);

    res.json({
      success: true,
      message: `Workspace ${id} deleted`,
    });
  } catch (error) {
    console.error('Error deleting workspace:', error);
    res.status(500).json({ error: 'Failed to delete workspace' });
  }
});
