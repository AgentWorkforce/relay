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
import { getScalingOrchestrator, ScalingOrchestrator, getComputeEnforcementService, ComputeEnforcementService, getIntroExpirationService, IntroExpirationService } from './services/index.js';

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
import { db } from './db/index.js';
import { validateSshSecurityConfig } from './services/ssh-security.js';

/**
 * Proxy a request to the user's primary running workspace
 */
async function proxyToUserWorkspace(req: Request, res: Response, path: string): Promise<void> {
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
    const proxyRes = await fetch(targetUrl);
    const data = await proxyRes.json();
    res.status(proxyRes.status).json(data);
  } catch (error) {
    console.error('[trajectory-proxy] Error:', error);
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
  // Paths exempt from CSRF (webhooks from external services, workspace proxy, local auth callbacks)
  const CSRF_EXEMPT_PATHS = [
    '/api/webhooks/',
    '/api/auth/nango/webhook',
    '/api/auth/codex-helper/callback',
  ];
  // Additional pattern for workspace proxy routes (contains /proxy/)
  const isWorkspaceProxyRoute = (path: string) => /^\/api\/workspaces\/[^/]+\/proxy\//.test(path);
  app.use((req: Request, res: Response, next: NextFunction) => {
    // Skip CSRF for webhook endpoints and workspace proxy routes
    if (CSRF_EXEMPT_PATHS.some(path => req.path.startsWith(path)) || isWorkspaceProxyRoute(req.path)) {
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
  app.use('/api/repos', reposRouter);
  app.use('/api/onboarding', onboardingRouter);
  app.use('/api/billing', billingRouter);
  app.use('/api/usage', usageRouter);
  app.use('/api/project-groups', coordinatorsRouter);
  app.use('/api/github-app', githubAppRouter);

  // Test helper routes (only available in non-production)
  // MUST be before teamsRouter to avoid auth interception
  if (process.env.NODE_ENV !== 'production') {
    app.use('/api/test', testHelpersRouter);
    console.log('[cloud] Test helper routes enabled (non-production mode)');
  }

  // Teams router - MUST BE LAST among /api routes
  // Handles /workspaces/:id/members and /invites with requireAuth on all routes
  app.use('/api', teamsRouter);

  // Trajectory proxy routes - auto-detect user's workspace and forward
  // These are convenience routes so the dashboard doesn't need to know the workspace ID
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

  // Handle agent logs WebSocket connections
  wssLogs.on('connection', async (clientWs: WebSocket, workspaceId: string, agentName: string) => {
    console.log(`[ws/logs] Client connected for workspace=${workspaceId} agent=${agentName}`);

    let daemonWs: WebSocket | null = null;

    try {
      // Find the workspace
      const workspace = await db.workspaces.findById(workspaceId);
      if (!workspace || !workspace.publicUrl) {
        clientWs.send(JSON.stringify({ type: 'error', message: 'Workspace not found or not running' }));
        clientWs.close();
        return;
      }

      // Connect to workspace daemon WebSocket
      // The workspace runs the dashboard server which expects /ws/logs path
      const baseUrl = workspace.publicUrl.replace(/^http/, 'ws').replace(/\/$/, '');
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
        }
      } catch (err) {
        console.error('[cloud] Invalid presence message:', err);
      }
    });

    ws.on('close', () => {
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
      }

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

      // Close WebSocket server
      wssPresence.close();

      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      await redisClient.quit();
    },
  };
}
