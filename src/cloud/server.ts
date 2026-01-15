/**
 * Agent Relay Cloud - Express Server
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import session from 'express-session';
import cors from 'cors';
import helmet from 'helmet';
import crypto from 'crypto';
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createClient, RedisClientType } from 'redis';
import { RedisStore } from 'connect-redis';
import { WebSocketServer, WebSocket } from 'ws';
import { getConfig } from './config.js';
import { runMigrations } from './db/index.js';
import { getScalingOrchestrator, ScalingOrchestrator, getComputeEnforcementService, ComputeEnforcementService, getIntroExpirationService, IntroExpirationService, getWorkspaceKeepaliveService, WorkspaceKeepaliveService } from './services/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

declare module 'express-session' {
  interface SessionData {
    csrfToken?: string;
    userId?: string;
  }
}

// API routers
import { authRouter, requireAuth } from './api/auth.js';
import { providersRouter } from './api/providers.js';
import { workspacesRouter } from './api/workspaces.js';
import { reposRouter } from './api/repos.js';
import { onboardingRouter } from './api/onboarding.js';
import { teamsRouter } from './api/teams.js';
import { billingRouter } from './api/billing.js';
import { usageRouter } from './api/usage.js';
import { coordinatorsRouter } from './api/coordinators.js';
import { daemonsRouter } from './api/daemons.js';
import { monitoringRouter } from './api/monitoring.js';
import { testHelpersRouter } from './api/test-helpers.js';
import { webhooksRouter } from './api/webhooks.js';
import { githubAppRouter } from './api/github-app.js';
import { nangoAuthRouter } from './api/nango-auth.js';
import { gitRouter } from './api/git.js';
import { codexAuthHelperRouter } from './api/codex-auth-helper.js';
import { adminRouter } from './api/admin.js';
import { consensusRouter } from './api/consensus.js';
import { db } from './db/index.js';
import { validateSshSecurityConfig } from './services/ssh-security.js';

/**
 * Proxy a request to the user's primary running workspace
 */
async function proxyToUserWorkspace(
  req: Request,
  res: Response,
  path: string,
  options?: { method?: string; body?: unknown }
): Promise<void> {
  const userId = req.session.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    // Find user's running workspace
    const workspaces = await db.workspaces.findByUserId(userId);
    const runningWorkspace = workspaces.find(w => w.status === 'running' && w.publicUrl);

    if (!runningWorkspace || !runningWorkspace.publicUrl) {
      res.status(404).json({ error: 'No running workspace found', success: false });
      return;
    }

    // Proxy to workspace
    const targetUrl = `${runningWorkspace.publicUrl}${path}`;
    console.log(`[workspace-proxy] ${options?.method || 'GET'} ${targetUrl}`);
    const fetchOptions: RequestInit = {
      method: options?.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
    };
    if (options?.body) {
      fetchOptions.body = JSON.stringify(options.body);
    }
    const proxyRes = await fetch(targetUrl, fetchOptions);
    const contentType = proxyRes.headers.get('content-type') || '';
    console.log(`[workspace-proxy] Response: ${proxyRes.status} ${proxyRes.statusText}, content-type: ${contentType}`);

    // Check if response is JSON
    if (!contentType.includes('application/json')) {
      const text = await proxyRes.text();
      console.error(`[workspace-proxy] Non-JSON response: ${text.substring(0, 200)}`);
      res.status(502).json({ error: 'Workspace returned non-JSON response', success: false });
      return;
    }

    const data = await proxyRes.json();
    res.status(proxyRes.status).json(data);
  } catch (error) {
    console.error('[workspace-proxy] Error:', error);
    res.status(500).json({ error: 'Failed to proxy request to workspace', success: false });
  }
}

export interface CloudServer {
  app: Express;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function createServer(): Promise<CloudServer> {
  const config = getConfig();

  // Validate security configuration at startup
  validateSshSecurityConfig();

  const app = express();
  app.set('trust proxy', 1);

  // Redis client for sessions
  const redisClient: RedisClientType = createClient({ url: config.redisUrl });
  redisClient.on('error', (err) => {
    console.error('[redis] error', err);
  });
  redisClient.on('reconnecting', () => {
    console.warn('[redis] reconnecting...');
  });
  await redisClient.connect();

  // Middleware
  // Configure helmet to allow Next.js inline scripts and Nango Connect UI
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://connect.nango.dev"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://connect.nango.dev"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        imgSrc: ["'self'", "data:", "https:", "blob:"],
        connectSrc: ["'self'", "wss:", "ws:", "https:", "https://api.nango.dev", "https://connect.nango.dev"],
        frameSrc: ["'self'", "https://connect.nango.dev", "https://github.com"],
        childSrc: ["'self'", "https://connect.nango.dev", "blob:"],
        workerSrc: ["'self'", "blob:"],
      },
    },
  }));
  app.use(
    cors({
      origin: config.publicUrl,
      credentials: true,
    })
  );
  // Custom JSON parser that preserves raw body for webhook signature verification
  // Increase limit to 10mb for base64 image uploads (screenshots)
  app.use(express.json({
    limit: '10mb',
    verify: (req: Request, _res, buf) => {
      // Store raw body for webhook signature verification
      (req as Request & { rawBody?: string }).rawBody = buf.toString();
    },
  }));

  // Session middleware
  app.use(
    session({
      store: new RedisStore({ client: redisClient }),
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: config.publicUrl.startsWith('https'),
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      },
    })
  );

  // Basic audit log (request/response)
  app.use((req: Request, res: Response, next: NextFunction) => {
    const started = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - started;
      const user = req.session?.userId ?? 'anon';
      console.log(
        `[audit] ${req.method} ${req.originalUrl} ${res.statusCode} user=${user} ip=${req.ip} ${duration}ms`
      );
    });
    next();
  });

  // Simple in-memory rate limiting per IP
  const RATE_LIMIT_WINDOW_MS = 60_000;
  // Higher limit in development mode
  const RATE_LIMIT_MAX = process.env.NODE_ENV === 'development' ? 1000 : 300;
  const rateLimits = new Map<string, { count: number; resetAt: number }>();

  app.use((req: Request, res: Response, next: NextFunction) => {
    // Skip rate limiting for localhost in development
    if (process.env.NODE_ENV === 'development') {
      const ip = req.ip || '';
      if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
        return next();
      }
    }

    const now = Date.now();
    const key = req.ip || 'unknown';
    const entry = rateLimits.get(key);
    if (!entry || entry.resetAt <= now) {
      rateLimits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    } else {
      entry.count += 1;
    }
    const current = rateLimits.get(key)!;
    res.setHeader('X-RateLimit-Limit', RATE_LIMIT_MAX.toString());
    res.setHeader('X-RateLimit-Remaining', Math.max(RATE_LIMIT_MAX - current.count, 0).toString());
    res.setHeader('X-RateLimit-Reset', Math.floor(current.resetAt / 1000).toString());
    if (current.count > RATE_LIMIT_MAX) {
      return res.status(429).json({ error: 'Too many requests' });
    }
    // Opportunistic cleanup
    if (rateLimits.size > 5000) {
      for (const [ip, data] of rateLimits) {
        if (data.resetAt <= now) {
          rateLimits.delete(ip);
        }
      }
    }
    next();
  });

  // Lightweight CSRF protection using session token
  const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
  // Paths exempt from CSRF (webhooks from external services, workspace proxy, local auth callbacks, admin API)
  const CSRF_EXEMPT_PATHS = [
    '/api/webhooks/',
    '/api/auth/nango/webhook',
    '/api/auth/codex-helper/callback',
    '/api/admin/',  // Admin API uses X-Admin-Secret header auth
    '/api/channels/',  // Channels API routes to local daemon, not cloud
  ];
  // Additional pattern for workspace proxy routes (contains /proxy/)
  const isWorkspaceProxyRoute = (path: string) => /^\/api\/workspaces\/[^/]+\/proxy\//.test(path);
  app.use((req: Request, res: Response, next: NextFunction) => {
    // Skip CSRF for webhook endpoints and workspace proxy routes
    const isExemptPath = CSRF_EXEMPT_PATHS.some(exemptPath => req.path.startsWith(exemptPath));
    if (isExemptPath || isWorkspaceProxyRoute(req.path)) {
      return next();
    }

    if (!req.session) return res.status(500).json({ error: 'Session unavailable' });

    // Generate CSRF token if not present
    // Use session.save() to ensure the session is persisted even for unauthenticated users
    // This is necessary because saveUninitialized: false won't auto-save new sessions
    if (!req.session.csrfToken) {
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');
      // Explicitly save session to persist the CSRF token
      req.session.save((err) => {
        if (err) {
          console.error('[csrf] Failed to save session:', err);
        }
      });
    }
    res.setHeader('X-CSRF-Token', req.session.csrfToken);

    if (SAFE_METHODS.has(req.method.toUpperCase())) {
      return next();
    }

    // Skip CSRF for Bearer-authenticated endpoints (daemon API, test helpers)
    const authHeader = req.get('authorization');
    if (authHeader?.startsWith('Bearer ')) {
      return next();
    }

    // Skip CSRF for admin API key authenticated requests
    const adminSecret = req.get('x-admin-secret');
    if (adminSecret) {
      return next();
    }

    // Skip CSRF for test endpoints in non-production
    if (process.env.NODE_ENV !== 'production' && req.path.startsWith('/api/test/')) {
      return next();
    }

    const token = req.get('x-csrf-token');
    if (!token || token !== req.session.csrfToken) {
      console.log(`[csrf] Token mismatch: received=${token?.substring(0, 8)}... expected=${req.session.csrfToken?.substring(0, 8)}...`);
      return res.status(403).json({
        error: 'CSRF token invalid or missing',
        code: 'CSRF_MISMATCH',
      });
    }
    return next();
  });

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // API routes
  //
  // IMPORTANT: Route order matters! Routes with non-session auth (webhooks, API keys, tokens)
  // must be mounted BEFORE teamsRouter, which catches all /api/* with requireAuth.
  //

  // --- Routes with alternative auth (must be before teamsRouter) ---
  app.use('/api/auth', authRouter);                    // Login endpoints (public)
  app.use('/api/auth/nango', nangoAuthRouter);         // Nango webhook (signature verification)
  app.use('/api/auth/codex-helper', codexAuthHelperRouter);
  app.use('/api/git', gitRouter);                      // Workspace token auth
  app.use('/api/webhooks', webhooksRouter);            // GitHub webhooks (signature verification)
  app.use('/api/monitoring', monitoringRouter);        // Daemon API key auth endpoints
  app.use('/api/daemons', daemonsRouter);              // Daemon API key auth endpoints
  app.use('/api/admin', adminRouter);                  // Admin API secret auth

  // --- Routes with session auth ---
  app.use('/api/providers', providersRouter);
  app.use('/api/workspaces', workspacesRouter);
  app.use('/api', consensusRouter);                      // Consensus API (nested under /api/workspaces/:id/consensus)
  app.use('/api/repos', reposRouter);
  app.use('/api/onboarding', onboardingRouter);
  app.use('/api/billing', billingRouter);
  app.use('/api/usage', usageRouter);
  app.use('/api/project-groups', coordinatorsRouter);
  app.use('/api/github-app', githubAppRouter);

  // Trajectory proxy routes - auto-detect user's workspace and forward
  // These are convenience routes so the dashboard doesn't need to know the workspace ID
  // MUST be before teamsRouter to avoid being caught by its catch-all
  app.get('/api/trajectory', requireAuth, async (req, res) => {
    await proxyToUserWorkspace(req, res, '/api/trajectory');
  });

  app.get('/api/trajectory/steps', requireAuth, async (req, res) => {
    const queryString = req.query.trajectoryId
      ? `?trajectoryId=${encodeURIComponent(req.query.trajectoryId as string)}`
      : '';
    await proxyToUserWorkspace(req, res, `/api/trajectory/steps${queryString}`);
  });

  app.get('/api/trajectory/history', requireAuth, async (req, res) => {
    await proxyToUserWorkspace(req, res, '/api/trajectory/history');
  });

  // Channel proxy routes - forward to local dashboard-server (not workspace)
  // Channels talk to the local daemon, so they need the local dashboard-server
  // MUST be before teamsRouter to avoid being caught by its catch-all

  // Auto-detect local dashboard URL if not configured
  let localDashboardUrl = config.localDashboardUrl;
  const defaultPorts = [3889, 3888, 3890]; // 3889 first (common alternate port)

  async function detectLocalDashboard(): Promise<string | null> {
    console.log('[channel-proxy] Auto-detecting local dashboard...');
    for (const port of defaultPorts) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);

        const res = await fetch(`http://localhost:${port}/health`, {
          method: 'GET',
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (res.ok) {
          console.log(`[channel-proxy] Detected local dashboard at http://localhost:${port}`);
          return `http://localhost:${port}`;
        }
        console.log(`[channel-proxy] Port ${port}: responded but not OK (${res.status})`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[channel-proxy] Port ${port}: ${msg}`);
      }
    }
    console.log('[channel-proxy] No local dashboard detected, using fallback');
    return null;
  }

  // Detect at startup if not configured - use a promise to ensure detection completes before first use
  let detectionPromise: Promise<void> | null = null;

  if (localDashboardUrl) {
    console.log(`[channel-proxy] Using configured dashboard URL: ${localDashboardUrl}`);
  } else {
    // Start detection immediately
    detectionPromise = detectLocalDashboard().then((detected) => {
      if (detected) {
        localDashboardUrl = detected;
      } else {
        localDashboardUrl = 'http://localhost:3889';
        console.log(`[channel-proxy] Falling back to ${localDashboardUrl}`);
      }
    });
  }

  async function getLocalDashboardUrl(): Promise<string> {
    // Wait for detection to complete if it's in progress
    if (detectionPromise) {
      await detectionPromise;
      detectionPromise = null;
    }
    // If still not set (shouldn't happen), detect now
    if (!localDashboardUrl) {
      const detected = await detectLocalDashboard();
      localDashboardUrl = detected || 'http://localhost:3889';
    }
    return localDashboardUrl;
  }

  async function proxyToLocalDashboard(
    req: Request,
    res: Response,
    path: string,
    options?: { method?: string; body?: unknown }
  ): Promise<void> {
    try {
      const dashboardUrl = await getLocalDashboardUrl();
      const targetUrl = `${dashboardUrl}${path}`;
      console.log(`[channel-proxy] ${options?.method || 'GET'} ${targetUrl}`);

      const fetchOptions: RequestInit = {
        method: options?.method || 'GET',
        headers: { 'Content-Type': 'application/json' },
      };
      if (options?.body) {
        fetchOptions.body = JSON.stringify(options.body);
      }

      const proxyRes = await fetch(targetUrl, fetchOptions);
      const contentType = proxyRes.headers.get('content-type') || '';

      if (!contentType.includes('application/json')) {
        const text = await proxyRes.text();
        console.error(`[channel-proxy] Non-JSON response from ${targetUrl}: ${text.substring(0, 100)}`);
        res.status(502).json({
          error: 'Local dashboard not available or returned non-JSON response',
          hint: 'Make sure the dashboard-server is running (agent-relay start)',
        });
        return;
      }

      const data = await proxyRes.json();
      res.status(proxyRes.status).json(data);
    } catch (error) {
      console.error('[channel-proxy] Error:', error);
      res.status(502).json({
        error: 'Failed to connect to local dashboard',
        hint: 'Make sure the dashboard-server is running (agent-relay start)',
      });
    }
  }

  // =========================================================================
  // Channel metadata endpoints (stored in cloud PostgreSQL)
  // =========================================================================

  /**
   * GET /api/channels - List channels for a workspace
   * Channels are workspace-scoped, not user-scoped
   */
  app.get('/api/channels', requireAuth, async (req, res) => {
    try {
      const workspaceId = req.query.workspaceId as string;
      if (!workspaceId) {
        return res.status(400).json({ error: 'workspaceId query param required' });
      }

      // Verify user has access to this workspace
      const userId = req.session.userId!;
      const workspace = await db.workspaces.findById(workspaceId);
      if (!workspace) {
        return res.status(404).json({ error: 'Workspace not found' });
      }
      if (workspace.userId !== userId) {
        const membership = await db.workspaceMembers.findMembership(workspaceId, userId);
        if (!membership || !membership.acceptedAt) {
          return res.status(403).json({ error: 'Access denied' });
        }
      }

      const allChannels = await db.channels.findByWorkspaceId(workspaceId);
      const activeChannels = allChannels.filter(c => c.status === 'active');
      const archivedChannels = allChannels.filter(c => c.status === 'archived');

      // Get member counts for all channels in one query
      const channelUuids = allChannels.map(c => c.id);
      const memberCounts = await db.channelMembers.countByChannelIds(channelUuids);

      // Transform to API response format
      const mapChannel = (c: typeof allChannels[0]) => ({
        id: c.channelId,
        name: c.name,
        description: c.description,
        visibility: c.visibility,
        status: c.status,
        createdAt: c.createdAt.toISOString(),
        createdBy: c.createdBy || '__system__',
        lastActivityAt: c.lastActivityAt?.toISOString(),
        memberCount: memberCounts.get(c.id) ?? 0,
        unreadCount: 0,
        hasMentions: false,
        isDm: c.channelId.startsWith('dm:'),
      });

      res.json({
        channels: activeChannels.map(mapChannel),
        archivedChannels: archivedChannels.map(mapChannel),
      });
    } catch (error) {
      console.error('[channels] Error listing channels:', error);
      res.status(500).json({ error: 'Failed to list channels' });
    }
  });

  /**
   * POST /api/channels - Create a new channel
   */
  app.post('/api/channels', requireAuth, express.json(), async (req, res) => {
    try {
      const { name, description, isPrivate, workspaceId, invites } = req.body;

      if (!name || !workspaceId) {
        return res.status(400).json({ error: 'name and workspaceId are required' });
      }

      // Verify user has access to this workspace
      const userId = req.session.userId!;
      const workspace = await db.workspaces.findById(workspaceId);
      if (!workspace) {
        return res.status(404).json({ error: 'Workspace not found' });
      }
      if (workspace.userId !== userId) {
        const membership = await db.workspaceMembers.findMembership(workspaceId, userId);
        if (!membership || !membership.acceptedAt) {
          return res.status(403).json({ error: 'Access denied' });
        }
      }

      // Get creator username from session
      const user = await db.users.findById(userId);
      const createdBy = user?.githubUsername || 'unknown';

      // Normalize channel name (remove # prefix if present)
      const channelId = name.startsWith('#') ? name.slice(1) : name;
      const displayName = channelId;

      // Check if channel already exists
      const existing = await db.channels.findByWorkspaceAndChannelId(workspaceId, channelId);
      if (existing) {
        return res.status(409).json({ error: 'Channel already exists' });
      }

      // Create the channel
      const channel = await db.channels.create({
        workspaceId,
        channelId,
        name: displayName,
        description,
        visibility: isPrivate ? 'private' : 'public',
        status: 'active',
        createdBy,
      });

      // Add creator as owner
      await db.channelMembers.addMember({
        channelId: channel.id,
        memberId: createdBy,
        memberType: 'user',
        role: 'owner',
      });

      // Handle invites if provided
      // Supports: comma-separated string, array of strings, or array of {id, type} objects
      const addedMembers: Array<{ id: string; type: 'user' | 'agent'; role: string }> = [
        { id: createdBy, type: 'user', role: 'owner' },
      ];
      const memberWarnings: Array<{ member: string; warning: string }> = [];

      if (invites) {
        let inviteList: Array<{ id: string; type: 'user' | 'agent' }> = [];

        if (typeof invites === 'string') {
          // Comma-separated string: "alice,bob" -> all as users
          inviteList = invites.split(',')
            .map((s: string) => s.trim())
            .filter(Boolean)
            .map(id => ({ id, type: 'user' as const }));
        } else if (Array.isArray(invites)) {
          // Array of strings or objects
          inviteList = invites.map((inv: string | { id: string; type?: string }) => {
            if (typeof inv === 'string') {
              return { id: inv, type: 'user' as const };
            }
            return {
              id: inv.id,
              type: (inv.type === 'agent' ? 'agent' : 'user') as 'user' | 'agent',
            };
          });
        }

        for (const invitee of inviteList) {
          await db.channelMembers.addMember({
            channelId: channel.id,
            memberId: invitee.id,
            memberType: invitee.type,
            role: 'member',
            invitedBy: createdBy,
          });
          addedMembers.push({ id: invitee.id, type: invitee.type, role: 'member' });

          // For agent members, sync to local daemon's in-memory channel membership
          if (invitee.type === 'agent') {
            try {
              const channelName = channelId.startsWith('#') ? channelId : `#${channelId}`;
              // Route to local dashboard where the daemon and channel routing lives
              const dashboardUrl = await getLocalDashboardUrl();
              const joinResponse = await fetch(`${dashboardUrl}/api/channels/admin-join`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ channel: channelName, member: invitee.id, workspaceId }),
              });
              const joinResult = await joinResponse.json() as { success: boolean; warning?: string };
              console.log(`[channels] Synced agent ${invitee.id} to channel ${channelName} via local dashboard`);
              // Check for warning about unconnected agent
              if (joinResult.warning) {
                memberWarnings.push({ member: invitee.id, warning: joinResult.warning });
                console.log(`[channels] Warning for ${invitee.id}: ${joinResult.warning}`);
              }
            } catch (err) {
              // Non-fatal - daemon sync is best-effort
              console.warn(`[channels] Failed to sync agent ${invitee.id} to daemon:`, err);
            }
          }
        }
      }

      res.status(201).json({
        success: true,
        channel: {
          id: channel.channelId,
          name: channel.name,
          description: channel.description,
          visibility: channel.visibility,
          status: channel.status,
          createdAt: channel.createdAt.toISOString(),
          createdBy: channel.createdBy,
          members: addedMembers,
        },
        warnings: memberWarnings.length > 0 ? memberWarnings : undefined,
      });
    } catch (error) {
      console.error('[channels] Error creating channel:', error);
      res.status(500).json({ error: 'Failed to create channel' });
    }
  });

  /**
   * POST /api/channels/join - Join a channel
   */
  app.post('/api/channels/join', requireAuth, express.json(), async (req, res) => {
    try {
      const { channel: rawChannelId, workspaceId, username } = req.body;

      if (!rawChannelId || !workspaceId) {
        return res.status(400).json({ error: 'channel and workspaceId are required' });
      }

      // Normalize channel ID (remove # prefix if present)
      const channelId = rawChannelId.startsWith('#') ? rawChannelId.slice(1) : rawChannelId;

      const userId = req.session.userId!;
      const user = await db.users.findById(userId);
      const memberId = username || user?.githubUsername || 'unknown';

      // Find the channel
      const channel = await db.channels.findByWorkspaceAndChannelId(workspaceId, channelId);
      if (!channel) {
        return res.status(404).json({ error: 'Channel not found' });
      }

      // Check if already a member
      const existing = await db.channelMembers.findMembership(channel.id, memberId);
      if (!existing) {
        await db.channelMembers.addMember({
          channelId: channel.id,
          memberId,
          memberType: 'user',
          role: 'member',
        });
      }

      // Also subscribe the user on the daemon side for real-time messages
      try {
        const dashboardUrl = await getLocalDashboardUrl();
        const channelWithHash = rawChannelId.startsWith('#') ? rawChannelId : `#${rawChannelId}`;
        await fetch(`${dashboardUrl}/api/channels/subscribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: memberId,
            channels: [channelWithHash],
            workspaceId,
          }),
        });
        console.log(`[cloud] Subscribed ${memberId} to ${channelWithHash} on local daemon`);
      } catch (err) {
        // Non-fatal - daemon sync is best-effort
        console.warn(`[cloud] Failed to sync join to daemon:`, err);
      }

      res.json({ success: true, channel: channelId });
    } catch (error) {
      console.error('[channels] Error joining channel:', error);
      res.status(500).json({ error: 'Failed to join channel' });
    }
  });

  /**
   * POST /api/channels/leave - Leave a channel
   */
  app.post('/api/channels/leave', requireAuth, express.json(), async (req, res) => {
    try {
      const { channel: rawChannelId, workspaceId, username } = req.body;

      if (!rawChannelId || !workspaceId) {
        return res.status(400).json({ error: 'channel and workspaceId are required' });
      }

      // Normalize channel ID (remove # prefix if present)
      const channelId = rawChannelId.startsWith('#') ? rawChannelId.slice(1) : rawChannelId;

      const userId = req.session.userId!;
      const user = await db.users.findById(userId);
      const memberId = username || user?.githubUsername || 'unknown';

      const channel = await db.channels.findByWorkspaceAndChannelId(workspaceId, channelId);
      if (!channel) {
        return res.status(404).json({ error: 'Channel not found' });
      }

      await db.channelMembers.removeMember(channel.id, memberId);

      res.json({ success: true, channel: channelId });
    } catch (error) {
      console.error('[channels] Error leaving channel:', error);
      res.status(500).json({ error: 'Failed to leave channel' });
    }
  });

  /**
   * POST /api/channels/invite - Invite users to a channel
   */
  app.post('/api/channels/invite', requireAuth, express.json(), async (req, res) => {
    try {
      const { channel: rawChannelId, workspaceId, invites, invitedBy } = req.body;

      if (!rawChannelId || !workspaceId || !invites) {
        return res.status(400).json({ error: 'channel, workspaceId, and invites are required' });
      }

      // Normalize channel ID (remove # prefix if present)
      const channelId = rawChannelId.startsWith('#') ? rawChannelId.slice(1) : rawChannelId;

      const channel = await db.channels.findByWorkspaceAndChannelId(workspaceId, channelId);
      if (!channel) {
        return res.status(404).json({ error: 'Channel not found' });
      }

      const inviteList = typeof invites === 'string'
        ? invites.split(',').map((s: string) => s.trim()).filter(Boolean)
        : invites;

      const results = [];
      for (const invitee of inviteList) {
        const existing = await db.channelMembers.findMembership(channel.id, invitee);
        if (!existing) {
          await db.channelMembers.addMember({
            channelId: channel.id,
            memberId: invitee,
            memberType: 'user',
            role: 'member',
            invitedBy,
          });
          results.push({ username: invitee, success: true });
        } else {
          results.push({ username: invitee, success: true, reason: 'already_member' });
        }
      }

      res.json({ channel: channelId, invited: results });
    } catch (error) {
      console.error('[channels] Error inviting to channel:', error);
      res.status(500).json({ error: 'Failed to invite to channel' });
    }
  });

  /**
   * POST /api/channels/archive - Archive a channel
   */
  app.post('/api/channels/archive', requireAuth, express.json(), async (req, res) => {
    try {
      const { channel: rawChannelId, workspaceId } = req.body;

      if (!rawChannelId || !workspaceId) {
        return res.status(400).json({ error: 'channel and workspaceId are required' });
      }

      // Normalize channel ID (remove # prefix if present)
      const channelId = rawChannelId.startsWith('#') ? rawChannelId.slice(1) : rawChannelId;

      const channel = await db.channels.findByWorkspaceAndChannelId(workspaceId, channelId);
      if (!channel) {
        return res.status(404).json({ error: 'Channel not found' });
      }

      await db.channels.archive(channel.id);

      res.json({ success: true, channel: channelId, status: 'archived' });
    } catch (error) {
      console.error('[channels] Error archiving channel:', error);
      res.status(500).json({ error: 'Failed to archive channel' });
    }
  });

  /**
   * POST /api/channels/unarchive - Unarchive a channel
   */
  app.post('/api/channels/unarchive', requireAuth, express.json(), async (req, res) => {
    try {
      const { channel: rawChannelId, workspaceId } = req.body;

      if (!rawChannelId || !workspaceId) {
        return res.status(400).json({ error: 'channel and workspaceId are required' });
      }

      // Normalize channel ID (remove # prefix if present)
      const channelId = rawChannelId.startsWith('#') ? rawChannelId.slice(1) : rawChannelId;

      const channel = await db.channels.findByWorkspaceAndChannelId(workspaceId, channelId);
      if (!channel) {
        return res.status(404).json({ error: 'Channel not found' });
      }

      await db.channels.unarchive(channel.id);

      res.json({ success: true, channel: channelId, status: 'active' });
    } catch (error) {
      console.error('[channels] Error unarchiving channel:', error);
      res.status(500).json({ error: 'Failed to unarchive channel' });
    }
  });

  // =========================================================================
  // Channel message endpoints (proxied to workspace container)
  // Messages are stored in the daemon's SQLite for real-time performance
  // =========================================================================

  app.post('/api/channels/message', requireAuth, express.json(), async (req, res) => {
    // Route to local dashboard where relay daemon and channel routing lives
    await proxyToLocalDashboard(req, res, '/api/channels/message', { method: 'POST', body: req.body });
  });

  app.get('/api/channels/:channel/messages', requireAuth, async (req, res) => {
    const channel = encodeURIComponent(req.params.channel);
    const params = new URLSearchParams();
    if (req.query.limit) params.set('limit', req.query.limit as string);
    if (req.query.before) params.set('before', req.query.before as string);
    const queryString = params.toString() ? `?${params.toString()}` : '';
    await proxyToLocalDashboard(req, res, `/api/channels/${channel}/messages${queryString}`);
  });

  /**
   * GET /api/channels/:channel/members - Get members of a channel
   */
  app.get('/api/channels/:channel/members', requireAuth, async (req, res) => {
    const channel = encodeURIComponent(req.params.channel);
    await proxyToLocalDashboard(req, res, `/api/channels/${channel}/members`);
  });

  /**
   * GET /api/channels/available-members - Get available members for channel invites
   * Returns workspace members (humans) and agents from linked daemons
   */
  app.get('/api/channels/available-members', requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const workspaceId = req.query.workspaceId as string | undefined;

      // Get workspace ID - either from query param or user's default workspace
      let targetWorkspaceId = workspaceId;
      if (!targetWorkspaceId) {
        // Find user's default or first workspace
        const memberships = await db.workspaceMembers.findByUserId(userId);
        if (memberships.length > 0) {
          targetWorkspaceId = memberships[0].workspaceId;
        }
      }

      if (!targetWorkspaceId) {
        return res.json({ members: [], agents: [] });
      }

      // Verify user has access to this workspace
      const canView = await db.workspaceMembers.canView(targetWorkspaceId, userId);
      if (!canView) {
        const workspace = await db.workspaces.findById(targetWorkspaceId);
        if (!workspace || workspace.userId !== userId) {
          return res.status(403).json({ error: 'Access denied' });
        }
      }

      // Get workspace members (humans)
      const workspaceMembers = await db.workspaceMembers.findByWorkspaceId(targetWorkspaceId);
      const members = await Promise.all(
        workspaceMembers.map(async (m) => {
          const user = await db.users.findById(m.userId);
          return {
            id: user?.githubUsername || m.userId,
            displayName: user?.githubUsername || 'Unknown',
            type: 'user' as const,
            avatarUrl: user?.avatarUrl ?? undefined,
          };
        })
      );

      // Get agents from linked daemons for this workspace
      const daemons = await db.linkedDaemons.findByWorkspaceId(targetWorkspaceId);
      const agents: Array<{ id: string; displayName: string; type: 'agent'; status?: string }> = [];

      for (const daemon of daemons) {
        const metadata = daemon.metadata as Record<string, unknown> | null;
        const daemonAgents = (metadata?.agents as Array<{ name: string; status: string; isHuman?: boolean }>) || [];

        for (const agent of daemonAgents) {
          // Skip human users from daemon agent list (they're in workspace members)
          if (agent.isHuman) continue;

          // Avoid duplicates
          if (!agents.some((a) => a.id === agent.name)) {
            agents.push({
              id: agent.name,
              displayName: agent.name,
              type: 'agent',
              status: agent.status,
            });
          }
        }
      }

      res.json({ members, agents });
    } catch (error) {
      console.error('[channels] Error getting available members:', error);
      res.status(500).json({ error: 'Failed to get available members' });
    }
  });

  app.get('/api/channels/users', requireAuth, async (req, res) => {
    await proxyToLocalDashboard(req, res, '/api/channels/users');
  });

  // Test helper routes (only available in non-production)
  // MUST be before teamsRouter to avoid auth interception
  if (process.env.NODE_ENV !== 'production') {
    app.use('/api/test', testHelpersRouter);
    console.log('[cloud] Test helper routes enabled (non-production mode)');
  }

  // Teams router - MUST BE LAST among /api routes
  // Handles /workspaces/:id/members and /invites with requireAuth on all routes
  app.use('/api', teamsRouter);

  // Serve static dashboard files (Next.js static export)
  // Path: dist/cloud/server.js -> ../../src/dashboard/out
  const dashboardPath = path.join(__dirname, '../../src/dashboard/out');

  // Serve static files (JS, CSS, images, etc.)
  app.use(express.static(dashboardPath));

  // Handle clean URLs for Next.js static export
  // When a directory exists (e.g., /app/), express.static won't serve app.html
  // So we need to explicitly check for .html files
  app.get('/{*splat}', (req, res, next) => {
    // Don't handle API routes
    if (req.path.startsWith('/api/')) {
      return next();
    }

    // Clean the path (remove trailing slash)
    const cleanPath = req.path.replace(/\/$/, '') || '/';

    // Try to serve the corresponding .html file
    const htmlFile = cleanPath === '/' ? 'index.html' : `${cleanPath}.html`;
    const htmlPath = path.join(dashboardPath, htmlFile);

    // Check if the HTML file exists
    if (fs.existsSync(htmlPath)) {
      res.sendFile(htmlPath);
    } else {
      // Fallback to index.html for SPA-style routing
      res.sendFile(path.join(dashboardPath, 'index.html'));
    }
  });

  // Error handler
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    console.error('Error:', err);
    res.status(500).json({
      error: 'Internal server error',
      message: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  });

  // Server lifecycle
  let server: http.Server | null = null;
  let scalingOrchestrator: ScalingOrchestrator | null = null;
  let computeEnforcement: ComputeEnforcementService | null = null;
  let introExpiration: IntroExpirationService | null = null;
  let workspaceKeepalive: WorkspaceKeepaliveService | null = null;
  let daemonStaleCheckInterval: ReturnType<typeof setInterval> | null = null;

  // Create HTTP server for WebSocket upgrade handling
  const httpServer = http.createServer(app);

  // ===== Presence WebSocket =====
  const wssPresence = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 1024 * 1024, // 1MB - presence messages are small
  });

  // Track online users for presence with multi-tab support
  interface UserPresenceInfo {
    username: string;
    avatarUrl?: string;
    connectedAt: string;
    lastSeen: string;
  }
  interface UserPresenceState {
    info: UserPresenceInfo;
    connections: Set<WebSocket>;
  }
  const onlineUsers = new Map<string, UserPresenceState>();

  // Validation helpers
  const isValidUsername = (username: unknown): username is string => {
    if (typeof username !== 'string') return false;
    return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(username);
  };

  const isValidAvatarUrl = (url: unknown): url is string | undefined => {
    if (url === undefined || url === null) return true;
    if (typeof url !== 'string') return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' &&
        (parsed.hostname === 'avatars.githubusercontent.com' ||
         parsed.hostname === 'github.com' ||
         parsed.hostname.endsWith('.githubusercontent.com'));
    } catch {
      return false;
    }
  };

  // WebSocket server for agent logs (proxied to workspace daemon)
  const wssLogs = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  // WebSocket server for channel messages (proxied to workspace daemon)
  const wssChannels = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  // Handle agent logs WebSocket connections
  wssLogs.on('connection', async (clientWs: WebSocket, workspaceId: string, agentName: string) => {
    console.log(`[ws/logs] Client connected for workspace=${workspaceId} agent=${agentName}`);

    let daemonWs: WebSocket | null = null;

    try {
      // Find the workspace (needed to verify it exists)
      const workspace = await db.workspaces.findById(workspaceId);
      if (!workspace) {
        clientWs.send(JSON.stringify({ type: 'error', message: 'Workspace not found' }));
        clientWs.close();
        return;
      }

      // Connect to local dashboard where the daemon actually runs
      const dashboardUrl = await getLocalDashboardUrl();
      const baseUrl = dashboardUrl.replace(/^http/, 'ws').replace(/\/$/, '');
      const daemonWsUrl = `${baseUrl}/ws/logs/${encodeURIComponent(agentName)}`;
      console.log(`[ws/logs] Connecting to daemon: ${daemonWsUrl}`);

      daemonWs = new WebSocket(daemonWsUrl, { perMessageDeflate: false });

      daemonWs.on('open', () => {
        console.log(`[ws/logs] Connected to daemon for ${agentName}`);
        // Note: No need to send subscribe message - the agent name in the URL path
        // triggers auto-subscription in the dashboard server
      });

      daemonWs.on('message', (data) => {
        // Forward daemon messages to client
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(data.toString());
        }
      });

      daemonWs.on('close', () => {
        console.log(`[ws/logs] Daemon connection closed for ${agentName}`);
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.close();
        }
      });

      daemonWs.on('error', (err) => {
        console.error(`[ws/logs] Daemon WebSocket error:`, err);
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({ type: 'error', message: 'Daemon connection error' }));
          clientWs.close();
        }
      });

      // Forward client messages to daemon (for user input)
      clientWs.on('message', (data) => {
        if (daemonWs && daemonWs.readyState === WebSocket.OPEN) {
          daemonWs.send(data.toString());
        }
      });

      clientWs.on('close', () => {
        console.log(`[ws/logs] Client disconnected for ${agentName}`);
        if (daemonWs && daemonWs.readyState === WebSocket.OPEN) {
          daemonWs.close();
        }
      });

      clientWs.on('error', (err) => {
        console.error(`[ws/logs] Client WebSocket error:`, err);
        if (daemonWs && daemonWs.readyState === WebSocket.OPEN) {
          daemonWs.close();
        }
      });

    } catch (err) {
      console.error(`[ws/logs] Setup error:`, err);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: 'error', message: 'Failed to connect to workspace' }));
        clientWs.close();
      }
    }
  });

  // Handle channel WebSocket connections (proxied to workspace daemon)
  // This allows cloud users to receive real-time channel messages
  wssChannels.on('connection', async (clientWs: WebSocket, workspaceId: string, username: string) => {
    console.log(`[ws/channels] Client connected for workspace=${workspaceId} user=${username}`);

    let daemonWs: WebSocket | null = null;

    try {
      // Find the workspace (needed to verify it exists)
      const workspace = await db.workspaces.findById(workspaceId);
      if (!workspace) {
        clientWs.send(JSON.stringify({ type: 'error', message: 'Workspace not found' }));
        clientWs.close();
        return;
      }

      // Connect to local dashboard where the daemon actually runs
      const dashboardUrl = await getLocalDashboardUrl();
      const baseUrl = dashboardUrl.replace(/^http/, 'ws').replace(/\/$/, '');
      const daemonWsUrl = `${baseUrl}/ws/presence`;
      console.log(`[ws/channels] Connecting to daemon: ${daemonWsUrl}`);

      daemonWs = new WebSocket(daemonWsUrl, { perMessageDeflate: false });

      daemonWs.on('open', () => {
        console.log(`[ws/channels] Connected to daemon for ${username}`);
        // Register with the daemon's presence system
        daemonWs!.send(JSON.stringify({
          type: 'presence',
          action: 'join',
          user: { username },
        }));
      });

      daemonWs.on('message', (data) => {
        // Forward daemon messages to client
        // Only forward channel_message type messages for this user
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'channel_message') {
            // Only forward if this message is for this user
            if (msg.targetUser === username) {
              console.log(`[ws/channels] Forwarding channel message to ${username}: ${msg.from} -> ${msg.channel}`);
              clientWs.send(data.toString());
            }
          }
          // Also forward presence updates so client stays in sync
          if (msg.type === 'presence_join' || msg.type === 'presence_leave' || msg.type === 'presence_list') {
            clientWs.send(data.toString());
          }
        } catch {
          // Non-JSON message, skip
        }
      });

      daemonWs.on('close', () => {
        console.log(`[ws/channels] Daemon connection closed for ${username}`);
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.close();
        }
      });

      daemonWs.on('error', (err) => {
        console.error(`[ws/channels] Daemon WebSocket error:`, err);
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({ type: 'error', message: 'Daemon connection error' }));
          clientWs.close();
        }
      });

      // Forward client messages to daemon (for sending channel messages)
      clientWs.on('message', (data) => {
        if (daemonWs && daemonWs.readyState === WebSocket.OPEN) {
          daemonWs.send(data.toString());
        }
      });

      clientWs.on('close', () => {
        console.log(`[ws/channels] Client disconnected for ${username}`);
        // Send leave message to daemon
        if (daemonWs && daemonWs.readyState === WebSocket.OPEN) {
          daemonWs.send(JSON.stringify({
            type: 'presence',
            action: 'leave',
            username,
          }));
          daemonWs.close();
        }
      });

      clientWs.on('error', (err) => {
        console.error(`[ws/channels] Client WebSocket error:`, err);
        if (daemonWs && daemonWs.readyState === WebSocket.OPEN) {
          daemonWs.close();
        }
      });

    } catch (err) {
      console.error(`[ws/channels] Setup error:`, err);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: 'error', message: 'Failed to connect to workspace' }));
        clientWs.close();
      }
    }
  });

  // Handle HTTP upgrade for WebSocket
  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;

    if (pathname === '/ws/presence') {
      wssPresence.handleUpgrade(request, socket, head, (ws) => {
        wssPresence.emit('connection', ws, request);
      });
    } else if (pathname.startsWith('/ws/logs/')) {
      // Parse /ws/logs/:workspaceId/:agentName
      const parts = pathname.split('/').filter(Boolean);
      if (parts.length >= 4) {
        const workspaceId = decodeURIComponent(parts[2]);
        const agentName = decodeURIComponent(parts[3]);

        wssLogs.handleUpgrade(request, socket, head, (ws) => {
          wssLogs.emit('connection', ws, workspaceId, agentName);
        });
      } else {
        socket.destroy();
      }
    } else if (pathname.startsWith('/ws/channels/')) {
      // Parse /ws/channels/:workspaceId/:username
      const parts = pathname.split('/').filter(Boolean);
      if (parts.length >= 4) {
        const workspaceId = decodeURIComponent(parts[2]);
        const username = decodeURIComponent(parts[3]);

        wssChannels.handleUpgrade(request, socket, head, (ws) => {
          wssChannels.emit('connection', ws, workspaceId, username);
        });
      } else {
        socket.destroy();
      }
    } else {
      // Unknown WebSocket path - destroy socket
      socket.destroy();
    }
  });

  // Broadcast to all presence clients
  const broadcastPresence = (message: object, exclude?: WebSocket) => {
    const payload = JSON.stringify(message);
    wssPresence.clients.forEach((client) => {
      if (client !== exclude && client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    });
  };

  // Get online users list
  const getOnlineUsersList = (): UserPresenceInfo[] => {
    return Array.from(onlineUsers.values()).map((state) => state.info);
  };

  // Heartbeat interval to detect dead connections (30 seconds)
  const PRESENCE_HEARTBEAT_INTERVAL = 30000;
  const _PRESENCE_HEARTBEAT_TIMEOUT = 35000; // Allow 5s grace period (reserved for future use)

  // Track connection health for heartbeat
  const connectionHealth = new WeakMap<WebSocket, { isAlive: boolean; lastPing: number }>();

  // Heartbeat interval to clean up dead connections
  const presenceHeartbeat = setInterval(() => {
    const now = Date.now();
    wssPresence.clients.forEach((ws) => {
      const health = connectionHealth.get(ws);
      if (!health) {
        // New connection without health tracking - initialize it
        connectionHealth.set(ws, { isAlive: true, lastPing: now });
        return;
      }

      if (!health.isAlive) {
        // Connection didn't respond to last ping - terminate it
        ws.terminate();
        return;
      }

      // Mark as not alive until we get a pong
      health.isAlive = false;
      health.lastPing = now;
      ws.ping();
    });
  }, PRESENCE_HEARTBEAT_INTERVAL);

  // Clean up interval on server close
  wssPresence.on('close', () => {
    clearInterval(presenceHeartbeat);
  });

  // Track daemon proxy connections for channel message forwarding
  const daemonProxies = new Map<WebSocket, Map<string, WebSocket>>(); // clientWs -> workspaceId -> daemonWs

  // Set up daemon proxy for channel messages
  async function setupDaemonChannelProxy(clientWs: WebSocket, workspaceId: string, username: string): Promise<void> {
    // Check if already have a proxy for this workspace
    const clientProxies = daemonProxies.get(clientWs) || new Map<string, WebSocket>();
    if (clientProxies.has(workspaceId)) {
      return; // Already connected
    }

    try {
      const workspace = await db.workspaces.findById(workspaceId);
      if (!workspace) {
        console.log(`[cloud] Workspace ${workspaceId} not found`);
        return;
      }

      // Use local dashboard URL where the daemon actually runs
      const dashboardUrl = await getLocalDashboardUrl();
      const daemonWsUrl = dashboardUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws/presence';
      console.log(`[cloud] Connecting channel proxy to daemon: ${daemonWsUrl} for ${username}`);

      // First, register the user for channel messages on the daemon side
      // This creates a relay client for them so they receive channel messages
      try {
        const subscribeRes = await fetch(`${dashboardUrl}/api/channels/subscribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username,
            channels: ['#general'], // Start with general, others can be joined later
            workspaceId,
          }),
        });
        if (subscribeRes.ok) {
          const result = (await subscribeRes.json()) as { channels?: string[] };
          console.log(`[cloud] Subscribed ${username} to channels: ${result.channels?.join(', ')}`);
        } else {
          console.warn(`[cloud] Failed to subscribe ${username} to channels: ${subscribeRes.status}`);
        }
      } catch (err) {
        console.warn(`[cloud] Error subscribing ${username} to channels:`, err);
        // Continue anyway - we can still set up the proxy
      }

      const daemonWs = new WebSocket(daemonWsUrl, { perMessageDeflate: false });

      daemonWs.on('open', () => {
        console.log(`[cloud] Channel proxy connected for ${username} in workspace ${workspaceId}`);
      });

      daemonWs.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          // Forward channel messages targeted at this user
          if (msg.type === 'channel_message' && msg.targetUser === username) {
            console.log(`[cloud] Forwarding channel message to ${username}: ${msg.from} -> ${msg.channel}`);
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(data.toString());
            }
          }
        } catch {
          // Non-JSON, ignore
        }
      });

      daemonWs.on('close', () => {
        console.log(`[cloud] Channel proxy closed for ${username} in workspace ${workspaceId}`);
        clientProxies.delete(workspaceId);
      });

      daemonWs.on('error', (err) => {
        console.error(`[cloud] Channel proxy error for ${username}:`, err);
        clientProxies.delete(workspaceId);
      });

      clientProxies.set(workspaceId, daemonWs);
      daemonProxies.set(clientWs, clientProxies);
    } catch (err) {
      console.error(`[cloud] Failed to setup channel proxy for ${username}:`, err);
    }
  }

  // Clean up daemon proxies for a client
  function cleanupDaemonProxies(clientWs: WebSocket): void {
    const clientProxies = daemonProxies.get(clientWs);
    if (clientProxies) {
      for (const [workspaceId, daemonWs] of clientProxies) {
        console.log(`[cloud] Cleaning up channel proxy for workspace ${workspaceId}`);
        if (daemonWs.readyState === WebSocket.OPEN) {
          daemonWs.close();
        }
      }
      daemonProxies.delete(clientWs);
    }
  }

  // Handle presence connections
  wssPresence.on('connection', (ws) => {
    // Initialize health tracking (no log - too noisy)
    connectionHealth.set(ws, { isAlive: true, lastPing: Date.now() });

    // Handle pong responses (heartbeat)
    ws.on('pong', () => {
      const health = connectionHealth.get(ws);
      if (health) {
        health.isAlive = true;
      }
    });

    let clientUsername: string | undefined;

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'presence') {
          if (msg.action === 'join' && msg.user?.username) {
            const username = msg.user.username;
            const avatarUrl = msg.user.avatarUrl;

            if (!isValidUsername(username)) {
              console.warn(`[cloud] Invalid username rejected: ${username}`);
              return;
            }
            if (!isValidAvatarUrl(avatarUrl)) {
              console.warn(`[cloud] Invalid avatar URL rejected for user ${username}`);
              return;
            }

            clientUsername = username;
            const now = new Date().toISOString();

            const existing = onlineUsers.get(username);
            if (existing) {
              existing.connections.add(ws);
              existing.info.lastSeen = now;
              // Only log at milestones to reduce noise
              const count = existing.connections.size;
              if (count === 2 || count === 5 || count === 10 || count % 50 === 0) {
                console.log(`[cloud] User ${username} has ${count} connections`);
              }
            } else {
              onlineUsers.set(username, {
                info: { username, avatarUrl, connectedAt: now, lastSeen: now },
                connections: new Set([ws]),
              });

              console.log(`[cloud] User ${username} came online`);
              broadcastPresence({
                type: 'presence_join',
                user: { username, avatarUrl, connectedAt: now, lastSeen: now },
              }, ws);
            }

            ws.send(JSON.stringify({
              type: 'presence_list',
              users: getOnlineUsersList(),
            }));

          } else if (msg.action === 'leave') {
            if (!clientUsername || msg.username !== clientUsername) return;

            const userState = onlineUsers.get(clientUsername);
            if (userState) {
              userState.connections.delete(ws);
              if (userState.connections.size === 0) {
                onlineUsers.delete(clientUsername);
                console.log(`[cloud] User ${clientUsername} went offline`);
                broadcastPresence({ type: 'presence_leave', username: clientUsername });
              }
            }
          }
        } else if (msg.type === 'typing') {
          if (!clientUsername || msg.username !== clientUsername) return;

          const userState = onlineUsers.get(clientUsername);
          if (userState) {
            userState.info.lastSeen = new Date().toISOString();
          }

          broadcastPresence({
            type: 'typing',
            username: clientUsername,
            avatarUrl: userState?.info.avatarUrl,
            isTyping: msg.isTyping,
          }, ws);
        } else if (msg.type === 'subscribe_channels') {
          // Subscribe to channel messages for a specific workspace
          if (!clientUsername) {
            console.warn(`[cloud] subscribe_channels from unauthenticated client`);
            return;
          }
          if (!msg.workspaceId || typeof msg.workspaceId !== 'string') {
            console.warn(`[cloud] subscribe_channels missing workspaceId`);
            return;
          }
          console.log(`[cloud] User ${clientUsername} subscribing to channels in workspace ${msg.workspaceId}`);
          setupDaemonChannelProxy(ws, msg.workspaceId, clientUsername).catch((err) => {
            console.error(`[cloud] Failed to setup channel subscription:`, err);
          });
        } else if (msg.type === 'channel_message') {
          // Proxy channel message to daemon via HTTP API
          if (!clientUsername) {
            console.warn(`[cloud] channel_message from unauthenticated client`);
            return;
          }
          if (!msg.channel || !msg.body) {
            console.warn(`[cloud] channel_message missing channel or body`);
            return;
          }
          // Note: This should be handled by the HTTP API, but support WebSocket too
          console.log(`[cloud] Channel message via WebSocket from ${clientUsername} to ${msg.channel}`);
          // The HTTP proxy will handle actual sending - just log for now
        }
      } catch (err) {
        console.error('[cloud] Invalid presence message:', err);
      }
    });

    ws.on('close', () => {
      // Clean up daemon proxies
      cleanupDaemonProxies(ws);

      if (clientUsername) {
        const userState = onlineUsers.get(clientUsername);
        if (userState) {
          userState.connections.delete(ws);
          if (userState.connections.size === 0) {
            onlineUsers.delete(clientUsername);
            console.log(`[cloud] User ${clientUsername} disconnected`);
            broadcastPresence({ type: 'presence_leave', username: clientUsername });
          }
        }
      }
    });

    ws.on('error', (err) => {
      console.error('[cloud] Presence WebSocket error:', err);
    });
  });

  wssPresence.on('error', (err) => {
    console.error('[cloud] Presence WebSocket server error:', err);
  });

  return {
    app,

    async start() {
      // Run database migrations before accepting connections
      console.log('[cloud] Running database migrations...');
      await runMigrations();

      // Initialize scaling orchestrator for auto-scaling
      if (process.env.RELAY_CLOUD_ENABLED === 'true') {
        try {
          scalingOrchestrator = getScalingOrchestrator();
          await scalingOrchestrator.initialize(config.redisUrl);
          console.log('[cloud] Scaling orchestrator initialized');

          // Log scaling events
          scalingOrchestrator.on('scaling_started', (op) => {
            console.log(`[scaling] Started: ${op.action} for user ${op.userId}`);
          });
          scalingOrchestrator.on('scaling_completed', (op) => {
            console.log(`[scaling] Completed: ${op.action} for user ${op.userId}`);
          });
          scalingOrchestrator.on('scaling_error', ({ operation, error }) => {
            console.error(`[scaling] Error: ${operation.action} for ${operation.userId}:`, error);
          });
          scalingOrchestrator.on('workspace_provisioned', (data) => {
            console.log(`[scaling] Provisioned workspace ${data.workspaceId} for user ${data.userId}`);
          });
        } catch (error) {
          console.warn('[cloud] Failed to initialize scaling orchestrator:', error);
          // Non-fatal - server can run without auto-scaling
        }

        // Start compute enforcement service (checks every 15 min)
        try {
          computeEnforcement = getComputeEnforcementService();
          computeEnforcement.start();
          console.log('[cloud] Compute enforcement service started');
        } catch (error) {
          console.warn('[cloud] Failed to start compute enforcement:', error);
        }

        // Start intro expiration service (checks every hour for expired intro periods)
        try {
          introExpiration = getIntroExpirationService();
          introExpiration.start();
          console.log('[cloud] Intro expiration service started');
        } catch (error) {
          console.warn('[cloud] Failed to start intro expiration:', error);
        }

        // Start workspace keepalive service (pings workspaces with active agents)
        // This prevents Fly.io from idling machines that have running Claude agents
        try {
          workspaceKeepalive = getWorkspaceKeepaliveService();
          workspaceKeepalive.start();
          console.log('[cloud] Workspace keepalive service started');
        } catch (error) {
          console.warn('[cloud] Failed to start workspace keepalive:', error);
        }
      }

      // Start daemon stale check (mark daemons offline if no heartbeat for 2+ minutes)
      // Runs every 60 seconds regardless of RELAY_CLOUD_ENABLED
      daemonStaleCheckInterval = setInterval(async () => {
        try {
          const count = await db.linkedDaemons.markStale();
          if (count > 0) {
            console.log(`[cloud] Marked ${count} daemon(s) as offline (stale)`);
          }
        } catch (error) {
          console.error('[cloud] Failed to mark stale daemons:', error);
        }
      }, 60_000); // Every 60 seconds
      console.log('[cloud] Daemon stale check started (60s interval)');

      return new Promise((resolve) => {
        server = httpServer.listen(config.port, () => {
          console.log(`Agent Relay Cloud running on port ${config.port}`);
          console.log(`Public URL: ${config.publicUrl}`);
          console.log(`WebSocket: ws://localhost:${config.port}/ws/presence`);
          resolve();
        });
      });
    },

    async stop() {
      // Shutdown scaling orchestrator
      if (scalingOrchestrator) {
        await scalingOrchestrator.shutdown();
      }

      // Stop compute enforcement service
      if (computeEnforcement) {
        computeEnforcement.stop();
      }

      // Stop intro expiration service
      if (introExpiration) {
        introExpiration.stop();
      }

      // Stop workspace keepalive service
      if (workspaceKeepalive) {
        workspaceKeepalive.stop();
      }

      // Stop daemon stale check
      if (daemonStaleCheckInterval) {
        clearInterval(daemonStaleCheckInterval);
        daemonStaleCheckInterval = null;
      }

      // Close WebSocket server
      wssPresence.close();

      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      await redisClient.quit();
    },
  };
}
