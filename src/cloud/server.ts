/**
 * Agent Relay Cloud - Express Server
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import session from 'express-session';
import cors from 'cors';
import helmet from 'helmet';
import { createClient } from 'redis';
import RedisStore from 'connect-redis';
import { getConfig } from './config';

// API routers
import { authRouter } from './api/auth';
import { providersRouter } from './api/providers';
import { workspacesRouter } from './api/workspaces';
import { reposRouter } from './api/repos';
import { onboardingRouter } from './api/onboarding';
import { teamsRouter } from './api/teams';
import { billingRouter } from './api/billing';

export interface CloudServer {
  app: Express;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function createServer(): Promise<CloudServer> {
  const config = getConfig();
  const app = express();

  // Redis client for sessions
  const redisClient = createClient({ url: config.redisUrl });
  await redisClient.connect();

  // Middleware
  app.use(helmet());
  app.use(
    cors({
      origin: config.publicUrl,
      credentials: true,
    })
  );
  app.use(express.json());

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
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      },
    })
  );

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

  return {
    app,

    async start() {
      return new Promise((resolve) => {
        server = app.listen(config.port, () => {
          console.log(`Agent Relay Cloud running on port ${config.port}`);
          console.log(`Public URL: ${config.publicUrl}`);
          resolve();
        });
      });
    },

    async stop() {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      await redisClient.quit();
    },
  };
}
