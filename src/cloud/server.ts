/**
 * Agent Relay Cloud - Express Server
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import session from 'express-session';
import cors from 'cors';
import helmet from 'helmet';
import crypto from 'crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, RedisClientType } from 'redis';
import { RedisStore } from 'connect-redis';
import { getConfig } from './config.js';
import { runMigrations } from './db/index.js';
import { getScalingOrchestrator, ScalingOrchestrator } from './services/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

declare module 'express-session' {
  interface SessionData {
    csrfToken?: string;
    userId?: string;
  }
}

// API routers
import { authRouter } from './api/auth.js';
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

export interface CloudServer {
  app: Express;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function createServer(): Promise<CloudServer> {
  const config = getConfig();
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
        imgSrc: ["'self'", "data:", "https:"],
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
  app.use(express.json({
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
  const RATE_LIMIT_MAX = 300;
  const rateLimits = new Map<string, { count: number; resetAt: number }>();

  app.use((req: Request, res: Response, next: NextFunction) => {
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
  // Paths exempt from CSRF (webhooks from external services)
  const CSRF_EXEMPT_PATHS = ['/api/webhooks/', '/api/auth/nango/webhook'];
  app.use((req: Request, res: Response, next: NextFunction) => {
    // Skip CSRF for webhook endpoints
    if (CSRF_EXEMPT_PATHS.some(path => req.path.startsWith(path))) {
      return next();
    }

    if (!req.session) return res.status(500).json({ error: 'Session unavailable' });

    if (!req.session.csrfToken) {
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');
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
  app.use('/api/auth', authRouter);
  app.use('/api/providers', providersRouter);
  app.use('/api/workspaces', workspacesRouter);
  app.use('/api/repos', reposRouter);
  app.use('/api/onboarding', onboardingRouter);
  app.use('/api/teams', teamsRouter);
  app.use('/api/billing', billingRouter);
  app.use('/api/usage', usageRouter);
  app.use('/api/project-groups', coordinatorsRouter);
  app.use('/api/daemons', daemonsRouter);
  app.use('/api/monitoring', monitoringRouter);
  app.use('/api/webhooks', webhooksRouter);
  app.use('/api/github-app', githubAppRouter);
  app.use('/api/auth/nango', nangoAuthRouter);
  app.use('/api/git', gitRouter);

  // Test helper routes (only available in non-production)
  if (process.env.NODE_ENV !== 'production') {
    app.use('/api/test', testHelpersRouter);
    console.log('[cloud] Test helper routes enabled (non-production mode)');
  }

  // Serve static dashboard files (Next.js static export)
  // Path: dist/cloud/server.js -> ../../src/dashboard/out
  const dashboardPath = path.join(__dirname, '../../src/dashboard/out');

  // Serve static files with .html extension fallback for clean URLs
  // e.g., /signup will try /signup.html
  app.use(express.static(dashboardPath, { extensions: ['html'] }));

  // SPA fallback - serve index.html for all non-API routes that don't match static files
  // Express 5 requires named wildcard params instead of bare '*'
  app.get('/{*splat}', (req, res, next) => {
    // Don't serve index.html for API routes
    if (req.path.startsWith('/api/')) {
      return next();
    }
    res.sendFile(path.join(dashboardPath, 'index.html'));
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
  let server: ReturnType<Express['listen']> | null = null;
  let scalingOrchestrator: ScalingOrchestrator | null = null;

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
      }

      return new Promise((resolve) => {
        server = app.listen(config.port, () => {
          console.log(`Agent Relay Cloud running on port ${config.port}`);
          console.log(`Public URL: ${config.publicUrl}`);
          resolve();
        });
      });
    },

    async stop() {
      // Shutdown scaling orchestrator
      if (scalingOrchestrator) {
        await scalingOrchestrator.shutdown();
      }

      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      await redisClient.quit();
    },
  };
}
