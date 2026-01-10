/**
 * Linked Daemons API Routes
 *
 * Allows local agent-relay instances to register and link with cloud.
 * This enables:
 * - Credential sync from cloud to local
 * - Remote monitoring of local agents
 * - Cross-machine agent discovery
 * - Centralized dashboard for all instances
 */

import { Router, Request, Response } from 'express';
import { randomBytes, createHash } from 'crypto';
import { requireAuth } from './auth.js';
import { db } from '../db/index.js';

export const daemonsRouter = Router();

/**
 * Generate a secure API key
 */
function generateApiKey(): string {
  // Format: ar_live_<32 random bytes as hex>
  const random = randomBytes(32).toString('hex');
  return `ar_live_${random}`;
}

/**
 * Hash an API key for storage
 */
function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

/**
 * POST /api/daemons/link
 * Register a local daemon with the cloud (requires browser auth first)
 *
 * Flow:
 * 1. User runs `agent-relay cloud link` in terminal
 * 2. CLI opens browser to /cloud/link?code=<temp_code>
 * 3. User authenticates (or is already logged in)
 * 4. Browser shows confirmation, user clicks "Link"
 * 5. Server generates API key and returns to CLI via the temp code
 */
daemonsRouter.post('/link', requireAuth, async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { name, machineId, metadata, workspaceId } = req.body;

  if (!machineId || typeof machineId !== 'string') {
    return res.status(400).json({ error: 'machineId is required' });
  }

  try {
    // Validate workspace ownership if provided
    if (workspaceId) {
      const workspace = await db.workspaces.findById(workspaceId);
      if (!workspace) {
        return res.status(404).json({ error: 'Workspace not found' });
      }
      if (workspace.userId !== userId) {
        // Check if user is a member of the workspace
        const member = await db.workspaceMembers.findMembership(workspaceId, userId);
        if (!member) {
          return res.status(403).json({ error: 'Not authorized to link to this workspace' });
        }
      }
    }

    // Check if this machine is already linked
    const existing = await db.linkedDaemons.findByMachineId(userId, machineId);

    if (existing) {
      // Regenerate API key for existing link
      const apiKey = generateApiKey();
      const apiKeyHash = hashApiKey(apiKey);

      await db.linkedDaemons.update(existing.id, {
        name: name || existing.name,
        apiKeyHash,
        workspaceId: workspaceId || existing.workspaceId,
        metadata: metadata || existing.metadata,
        status: 'online',
        lastSeenAt: new Date(),
      });

      return res.json({
        success: true,
        daemonId: existing.id,
        workspaceId: workspaceId || existing.workspaceId,
        apiKey, // Only returned once!
        message: 'Daemon re-linked with new API key',
      });
    }

    // Create new linked daemon
    const apiKey = generateApiKey();
    const apiKeyHash = hashApiKey(apiKey);

    const daemon = await db.linkedDaemons.create({
      userId,
      workspaceId: workspaceId || null,
      name: name || `Daemon on ${machineId.substring(0, 8)}`,
      machineId,
      apiKeyHash,
      status: 'online',
      metadata: metadata || {},
    });

    res.status(201).json({
      success: true,
      daemonId: daemon.id,
      workspaceId: workspaceId || null,
      apiKey, // Only returned once - user must save this!
      message: 'Daemon linked successfully. Save your API key - it cannot be retrieved later.',
    });
  } catch (error) {
    console.error('Error linking daemon:', error);
    res.status(500).json({ error: 'Failed to link daemon' });
  }
});

/**
 * GET /api/daemons
 * List user's linked daemons
 */
daemonsRouter.get('/', requireAuth, async (req: Request, res: Response) => {
  const userId = req.session.userId!;

  try {
    const daemons = await db.linkedDaemons.findByUserId(userId);

    res.json({
      daemons: daemons.map((d) => ({
        id: d.id,
        name: d.name,
        machineId: d.machineId,
        status: d.status,
        lastSeenAt: d.lastSeenAt,
        metadata: d.metadata,
        createdAt: d.createdAt,
      })),
    });
  } catch (error) {
    console.error('Error listing daemons:', error);
    res.status(500).json({ error: 'Failed to list daemons' });
  }
});

/**
 * GET /api/daemons/workspace/:workspaceId/agents
 * Get local agents for a specific workspace
 */
daemonsRouter.get('/workspace/:workspaceId/agents', requireAuth, async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { workspaceId } = req.params;

  try {
    // Verify user has access to this workspace
    const workspace = await db.workspaces.findById(workspaceId);
    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    // Check if user owns the workspace or is a member
    if (workspace.userId !== userId) {
      const member = await db.workspaceMembers.findMembership(workspaceId, userId);
      if (!member) {
        return res.status(403).json({ error: 'Not authorized to access this workspace' });
      }
    }

    // Get all linked daemons for this workspace
    const daemons = await db.linkedDaemons.findByWorkspaceId(workspaceId);

    // Extract agents from each daemon's metadata
    const localAgents = daemons.flatMap((daemon) => {
      const metadata = daemon.metadata as Record<string, unknown> | null;
      const agents = (metadata?.agents as Array<{ name: string; status: string }>) || [];
      return agents.map((agent) => ({
        name: agent.name,
        status: agent.status,
        isLocal: true,
        daemonId: daemon.id,
        daemonName: daemon.name,
        daemonStatus: daemon.status,
        machineId: daemon.machineId,
        lastSeenAt: daemon.lastSeenAt,
      }));
    });

    res.json({
      agents: localAgents,
      daemons: daemons.map((d) => ({
        id: d.id,
        name: d.name,
        machineId: d.machineId,
        status: d.status,
        lastSeenAt: d.lastSeenAt,
      })),
    });
  } catch (error) {
    console.error('Error fetching local agents:', error);
    res.status(500).json({ error: 'Failed to fetch local agents' });
  }
});

/**
 * DELETE /api/daemons/:id
 * Unlink a daemon
 */
daemonsRouter.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { id } = req.params;

  try {
    const daemon = await db.linkedDaemons.findById(id);

    if (!daemon) {
      return res.status(404).json({ error: 'Daemon not found' });
    }

    if (daemon.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    await db.linkedDaemons.delete(id);

    res.json({ success: true, message: 'Daemon unlinked' });
  } catch (error) {
    console.error('Error unlinking daemon:', error);
    res.status(500).json({ error: 'Failed to unlink daemon' });
  }
});

// ============================================================================
// Daemon API (authenticated with API key, not session)
// These endpoints are called by local daemons, not browsers
// ============================================================================

/**
 * Middleware to authenticate daemon by API key
 */
async function requireDaemonAuth(
  req: Request,
  res: Response,
  next: () => void
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ar_live_')) {
    res.status(401).json({ error: 'Invalid API key format' });
    return;
  }

  const apiKey = authHeader.replace('Bearer ', '');
  const apiKeyHash = hashApiKey(apiKey);

  try {
    const daemon = await db.linkedDaemons.findByApiKeyHash(apiKeyHash);

    if (!daemon) {
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }

    // Update last seen
    await db.linkedDaemons.updateLastSeen(daemon.id);

    // Attach daemon info to request
    (req as any).daemon = daemon;
    next();
  } catch (error) {
    console.error('Daemon auth error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

/**
 * POST /api/daemons/heartbeat
 * Daemon heartbeat - reports status and gets any pending commands
 */
daemonsRouter.post('/heartbeat', requireDaemonAuth as any, async (req: Request, res: Response) => {
  const daemon = (req as any).daemon;
  const { agents, metrics } = req.body;

  try {
    // Update daemon status with agent info
    await db.linkedDaemons.update(daemon.id, {
      status: 'online',
      metadata: {
        ...daemon.metadata,
        agents: agents || [],
        metrics: metrics || {},
        lastHeartbeat: new Date().toISOString(),
      },
    });

    // Check for any pending commands (credential updates, etc.)
    const pendingUpdates = await db.linkedDaemons.getPendingUpdates(daemon.id);

    res.json({
      success: true,
      commands: pendingUpdates,
    });
  } catch (error) {
    console.error('Error processing heartbeat:', error);
    res.status(500).json({ error: 'Failed to process heartbeat' });
  }
});

/**
 * GET /api/daemons/credentials
 * Get credentials for the daemon's user
 *
 * Note: Tokens are no longer stored centrally. CLI tools authenticate directly
 * on workspace/local instances. This endpoint returns connected provider info only.
 */
daemonsRouter.get('/credentials', requireDaemonAuth as any, async (req: Request, res: Response) => {
  const daemon = (req as any).daemon;

  try {
    // Get connected providers for this user (no tokens stored centrally)
    const credentials = await db.credentials.findByUserId(daemon.userId);

    // Return provider info without tokens
    const providers = credentials.map((cred) => ({
      provider: cred.provider,
      providerAccountEmail: cred.providerAccountEmail,
      connectedAt: cred.createdAt,
    }));

    res.json({
      providers,
      note: 'Tokens are authenticated locally on workspace instances via CLI.',
    });
  } catch (error) {
    console.error('Error fetching credentials:', error);
    res.status(500).json({ error: 'Failed to fetch credentials' });
  }
});

/**
 * POST /api/daemons/agents
 * Report agent list to cloud (for cross-machine discovery)
 */
daemonsRouter.post('/agents', requireDaemonAuth as any, async (req: Request, res: Response) => {
  const daemon = (req as any).daemon;
  const { agents } = req.body;

  if (!agents || !Array.isArray(agents)) {
    return res.status(400).json({ error: 'agents array is required' });
  }

  try {
    // Store agent list in daemon metadata
    await db.linkedDaemons.update(daemon.id, {
      metadata: {
        ...daemon.metadata,
        agents,
        lastAgentSync: new Date().toISOString(),
      },
    });

    // Get agents from all linked daemons for this user (cross-machine discovery)
    const allDaemons = await db.linkedDaemons.findByUserId(daemon.userId);
    const allAgents = allDaemons.flatMap((d) => {
      const metadata = d.metadata as Record<string, unknown> | null;
      const dAgents = (metadata?.agents as Array<{ name: string; status: string }>) || [];
      return dAgents.map((a) => ({
        ...a,
        daemonId: d.id,
        daemonName: d.name,
        machineId: d.machineId,
      }));
    });

    res.json({
      success: true,
      allAgents, // Return all agents across all linked daemons
    });
  } catch (error) {
    console.error('Error syncing agents:', error);
    res.status(500).json({ error: 'Failed to sync agents' });
  }
});

/**
 * POST /api/daemons/message
 * Send message to an agent on another machine (cross-machine relay)
 */
daemonsRouter.post('/message', requireDaemonAuth as any, async (req: Request, res: Response) => {
  const daemon = (req as any).daemon;
  const { targetDaemonId, targetAgent, message } = req.body;

  if (!targetDaemonId || !targetAgent || !message) {
    return res.status(400).json({ error: 'targetDaemonId, targetAgent, and message are required' });
  }

  try {
    // Verify target daemon belongs to same user
    const targetDaemon = await db.linkedDaemons.findById(targetDaemonId);

    if (!targetDaemon || targetDaemon.userId !== daemon.userId) {
      return res.status(404).json({ error: 'Target daemon not found' });
    }

    // Queue message for delivery
    await db.linkedDaemons.queueMessage(targetDaemonId, {
      from: {
        daemonId: daemon.id,
        daemonName: daemon.name,
        agent: message.from,
      },
      to: targetAgent,
      content: message.content,
      metadata: message.metadata,
      timestamp: new Date().toISOString(),
    });

    res.json({ success: true, message: 'Message queued for delivery' });
  } catch (error) {
    console.error('Error sending cross-machine message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

/**
 * GET /api/daemons/messages
 * Get pending messages for this daemon (cross-machine messages)
 */
daemonsRouter.get('/messages', requireDaemonAuth as any, async (req: Request, res: Response) => {
  const daemon = (req as any).daemon;

  try {
    const messages = await db.linkedDaemons.getQueuedMessages(daemon.id);

    // Clear the queue after fetching
    if (messages.length > 0) {
      await db.linkedDaemons.clearMessageQueue(daemon.id);
    }

    res.json({ messages });
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// ============================================================================
// Message Sync API (sync daemon SQLite messages to cloud PostgreSQL)
// ============================================================================

/**
 * Sync message input from daemon
 */
interface SyncMessageInput {
  id: string;           // Original message ID from daemon SQLite
  ts: number;           // Timestamp in ms
  from: string;         // From agent name
  to: string;           // To agent name or '*' for broadcast
  body: string;         // Message body
  kind?: string;        // message, action, state, thinking
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

/**
 * POST /api/daemons/messages/sync
 * Sync messages from daemon to cloud storage
 *
 * Accepts batches of messages and stores them in agent_messages table.
 * Uses upsert logic to handle duplicates (based on workspace_id + original_id).
 *
 * Request body:
 * {
 *   messages: SyncMessageInput[]
 * }
 *
 * Response:
 * {
 *   success: true,
 *   synced: number,    // Count of messages synced
 *   duplicates: number // Count of messages skipped (already existed)
 * }
 */
daemonsRouter.post('/messages/sync', requireDaemonAuth as any, async (req: Request, res: Response) => {
  const daemon = (req as any).daemon;
  const { messages } = req.body as { messages: SyncMessageInput[] };

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  if (messages.length === 0) {
    return res.json({ success: true, synced: 0, duplicates: 0 });
  }

  // Limit batch size to prevent abuse
  if (messages.length > 500) {
    return res.status(400).json({ error: 'Maximum batch size is 500 messages' });
  }

  // Require workspace to be linked
  if (!daemon.workspaceId) {
    return res.status(400).json({
      error: 'Daemon must be linked to a workspace to sync messages. Re-link with a workspace ID.',
    });
  }

  try {
    // Get user plan to determine retention policy
    const user = await db.users.findById(daemon.userId);
    const plan = user?.plan || 'free';

    // Calculate expires_at based on plan
    let expiresAt: Date | null = null;
    if (plan === 'free') {
      expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
    } else if (plan === 'pro') {
      expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000); // 90 days
    }
    // Enterprise: null (never expires)

    // Transform to NewAgentMessage format
    const dbMessages = messages.map((msg) => ({
      workspaceId: daemon.workspaceId,
      daemonId: daemon.id,
      originalId: msg.id,
      fromAgent: msg.from,
      toAgent: msg.to,
      body: msg.body,
      kind: msg.kind || 'message',
      topic: msg.topic || null,
      thread: msg.thread || null,
      channel: msg.channel || null,
      isBroadcast: msg.is_broadcast || msg.to === '*',
      isUrgent: msg.is_urgent || false,
      data: msg.data || null,
      payloadMeta: msg.payload_meta || null,
      messageTs: new Date(msg.ts),
      expiresAt,
    }));

    // Insert with onConflictDoNothing for deduplication
    const inserted = await db.agentMessages.createMany(dbMessages);

    const synced = inserted.length;
    const duplicates = messages.length - synced;

    console.log(`[message-sync] Synced ${synced} messages for daemon ${daemon.id}, ${duplicates} duplicates skipped`);

    res.json({
      success: true,
      synced,
      duplicates,
    });
  } catch (error) {
    console.error('Error syncing messages:', error);
    res.status(500).json({ error: 'Failed to sync messages' });
  }
});

/**
 * GET /api/daemons/messages/stats
 * Get message sync statistics for this daemon's workspace
 */
daemonsRouter.get('/messages/stats', requireDaemonAuth as any, async (req: Request, res: Response) => {
  const daemon = (req as any).daemon;

  if (!daemon.workspaceId) {
    return res.status(400).json({ error: 'Daemon must be linked to a workspace' });
  }

  try {
    const count = await db.agentMessages.countByWorkspace(daemon.workspaceId);

    res.json({
      workspaceId: daemon.workspaceId,
      messageCount: count,
    });
  } catch (error) {
    console.error('Error fetching message stats:', error);
    res.status(500).json({ error: 'Failed to fetch message stats' });
  }
});
