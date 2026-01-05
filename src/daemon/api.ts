/**
 * Daemon API
 * REST and WebSocket API for dashboard communication.
 */

import * as http from 'http';
import WebSocket, { WebSocketServer, WebSocket as WS } from 'ws';
import { EventEmitter } from 'events';
import { createLogger } from '../resiliency/logger.js';
import { metrics } from '../resiliency/metrics.js';
import { getWorkspaceManager, WorkspaceManager } from './workspace-manager.js';
import { getAgentManager, AgentManager } from './agent-manager.js';
import type {
  ApiDaemonConfig,
  DaemonEvent,
  UserSession,
  WorkspacesResponse,
  AgentsResponse,
  AddWorkspaceRequest,
  SpawnAgentRequest,
} from './types.js';
import {
  startCLIAuth,
  getAuthSession,
  cancelAuthSession,
  getSupportedProviders,
} from './cli-auth.js';

const logger = createLogger('daemon-api');

interface ApiRequest {
  method: string;
  path: string;
  body?: unknown;
  params: Record<string, string>;
  query: Record<string, string>;
}

interface ApiResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

type RouteHandler = (req: ApiRequest) => Promise<ApiResponse>;

export class DaemonApi extends EventEmitter {
  private server?: http.Server;
  private wss?: WebSocketServer;
  private workspaceManager: WorkspaceManager;
  private agentManager: AgentManager;
  private sessions = new Map<WS, UserSession>();
  private routes = new Map<string, RouteHandler>();
  private config: ApiDaemonConfig;
  private allowedOrigins: Set<string>;
  private allowAllOrigins: boolean;

  constructor(config: ApiDaemonConfig) {
    super();
    this.config = config;
    this.workspaceManager = getWorkspaceManager(config.dataDir);
    this.agentManager = getAgentManager(config.dataDir);
    const configuredOrigins = this.loadAllowedOrigins(config);
    this.allowAllOrigins = configuredOrigins.includes('*');
    this.allowedOrigins = new Set(
      configuredOrigins
        .map(origin => origin.trim())
        .filter(origin => origin && origin !== '*')
    );

    // Setup routes
    this.setupRoutes();

    // Forward events to WebSocket clients
    this.workspaceManager.on('event', (event: DaemonEvent) => this.broadcastEvent(event));
    this.agentManager.on('event', (event: DaemonEvent) => this.broadcastEvent(event));
  }

  /**
   * Resolve allowed origins from config/env (comma-separated list).
   * Empty list means no cross-origin access is permitted.
   */
  private loadAllowedOrigins(config: ApiDaemonConfig): string[] {
    if (config.allowedOrigins?.length) {
      return config.allowedOrigins;
    }
    const envOrigins = process.env.AGENT_RELAY_API_ALLOWED_ORIGINS;
    if (envOrigins?.trim()) {
      return envOrigins.split(',').map(origin => origin.trim()).filter(Boolean);
    }
    return [];
  }

  /**
   * Return allowed origin for CORS or null if explicitly blocked.
   * Undefined means no CORS header will be set (same-origin/server-to-server).
   */
  private resolveAllowedOrigin(
    originHeader?: string | null,
    requestHost?: string | null
  ): string | null | undefined {
    if (!originHeader) return undefined; // Non-browser or requests without Origin header
    if (this.allowAllOrigins) return originHeader;
    if (this.allowedOrigins.has(originHeader)) return originHeader;
    if (requestHost) {
      try {
        const originHost = new URL(originHeader).host;
        // Allow same-origin requests even if not explicitly configured
        if (originHost === requestHost) {
          return originHeader;
        }
      } catch {
        // Malformed origin; treat as blocked below
      }
    }
    return null;
  }

  /**
   * Start the API server
   */
  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));

      // Setup WebSocket server
      this.wss = new WebSocketServer({ server: this.server });
      this.wss.on('connection', (ws, req) => this.handleWebSocketConnection(ws, req));

      this.server.listen(this.config.port, this.config.host, () => {
        logger.info('Daemon API started', { port: this.config.port, host: this.config.host });
        resolve();
      });
    });
  }

  /**
   * Stop the API server
   */
  async stop(): Promise<void> {
    // Close all WebSocket connections
    if (this.wss) {
      for (const ws of this.wss.clients) {
        ws.close();
      }
      this.wss.close();
    }

    // Stop agent manager
    await this.agentManager.shutdown();

    // Close HTTP server
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          logger.info('Daemon API stopped');
          resolve();
        });
      });
    }
  }

  /**
   * Setup API routes
   */
  private setupRoutes(): void {
    // Health check
    this.routes.set('GET /', async () => ({
      status: 200,
      body: { status: 'ok', version: '1.0.0' },
    }));

    // Metrics endpoint
    this.routes.set('GET /metrics', async () => ({
      status: 200,
      body: metrics.toPrometheus(),
      headers: { 'Content-Type': 'text/plain' },
    }));

    // === Workspaces ===

    // List workspaces
    this.routes.set('GET /workspaces', async (): Promise<ApiResponse> => {
      const workspaces = this.workspaceManager.getAll();
      const active = this.workspaceManager.getActive();
      const response: WorkspacesResponse = {
        workspaces,
        activeWorkspaceId: active?.id,
      };
      return { status: 200, body: response };
    });

    // Add workspace
    this.routes.set('POST /workspaces', async (req): Promise<ApiResponse> => {
      const body = req.body as AddWorkspaceRequest;
      if (!body?.path) {
        return { status: 400, body: { error: 'path is required' } };
      }
      try {
        const workspace = this.workspaceManager.add(body);
        return { status: 201, body: workspace };
      } catch (err) {
        return { status: 400, body: { error: String(err) } };
      }
    });

    // Get workspace
    this.routes.set('GET /workspaces/:id', async (req): Promise<ApiResponse> => {
      const workspace = this.workspaceManager.get(req.params.id);
      if (!workspace) {
        return { status: 404, body: { error: 'Workspace not found' } };
      }
      return { status: 200, body: workspace };
    });

    // Delete workspace
    this.routes.set('DELETE /workspaces/:id', async (req): Promise<ApiResponse> => {
      const removed = this.workspaceManager.remove(req.params.id);
      if (!removed) {
        return { status: 404, body: { error: 'Workspace not found' } };
      }
      return { status: 204, body: null };
    });

    // Switch workspace
    this.routes.set('POST /workspaces/:id/switch', async (req): Promise<ApiResponse> => {
      try {
        const workspace = this.workspaceManager.switchTo(req.params.id);
        return { status: 200, body: workspace };
      } catch (err) {
        return { status: 404, body: { error: String(err) } };
      }
    });

    // === Agents ===

    // List agents in workspace
    this.routes.set('GET /workspaces/:id/agents', async (req): Promise<ApiResponse> => {
      const workspace = this.workspaceManager.get(req.params.id);
      if (!workspace) {
        return { status: 404, body: { error: 'Workspace not found' } };
      }
      const agents = this.agentManager.getByWorkspace(req.params.id);
      const response: AgentsResponse = {
        agents,
        workspaceId: req.params.id,
      };
      return { status: 200, body: response };
    });

    // Spawn agent in workspace
    this.routes.set('POST /workspaces/:id/agents', async (req): Promise<ApiResponse> => {
      const workspace = this.workspaceManager.get(req.params.id);
      if (!workspace) {
        return { status: 404, body: { error: 'Workspace not found' } };
      }
      const body = req.body as SpawnAgentRequest;
      if (!body?.name) {
        return { status: 400, body: { error: 'name is required' } };
      }
      try {
        const agent = await this.agentManager.spawn(req.params.id, workspace.path, body);
        return { status: 201, body: agent };
      } catch (err) {
        return { status: 400, body: { error: String(err) } };
      }
    });

    // Get agent
    this.routes.set('GET /agents/:id', async (req): Promise<ApiResponse> => {
      const agent = this.agentManager.get(req.params.id);
      if (!agent) {
        return { status: 404, body: { error: 'Agent not found' } };
      }
      return { status: 200, body: agent };
    });

    // Stop agent
    this.routes.set('DELETE /agents/:id', async (req): Promise<ApiResponse> => {
      const stopped = await this.agentManager.stop(req.params.id);
      if (!stopped) {
        return { status: 404, body: { error: 'Agent not found' } };
      }
      return { status: 204, body: null };
    });

    // Get agent output
    this.routes.set('GET /agents/:id/output', async (req): Promise<ApiResponse> => {
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;
      const output = this.agentManager.getOutput(req.params.id, limit);
      if (output === null) {
        return { status: 404, body: { error: 'Agent not found' } };
      }
      return { status: 200, body: { output } };
    });

    // Send input to agent
    this.routes.set('POST /agents/:id/input', async (req): Promise<ApiResponse> => {
      const body = req.body as { input: string };
      if (!body?.input) {
        return { status: 400, body: { error: 'input is required' } };
      }
      const sent = this.agentManager.sendInput(req.params.id, body.input);
      if (!sent) {
        return { status: 404, body: { error: 'Agent not found' } };
      }
      return { status: 200, body: { success: true } };
    });

    // === All Agents ===

    // List all agents
    this.routes.set('GET /agents', async (): Promise<ApiResponse> => {
      const agents = this.agentManager.getAll();
      return { status: 200, body: { agents } };
    });

    // === CLI Auth (for cloud server to call) ===

    // List supported providers
    this.routes.set('GET /auth/providers', async (): Promise<ApiResponse> => {
      return { status: 200, body: { providers: getSupportedProviders() } };
    });

    // Start CLI auth flow
    this.routes.set('POST /auth/cli/:provider/start', async (req): Promise<ApiResponse> => {
      const { provider } = req.params;
      try {
        const session = await startCLIAuth(provider);
        return {
          status: 200,
          body: {
            sessionId: session.id,
            status: session.status,
            authUrl: session.authUrl,
          },
        };
      } catch (err) {
        return {
          status: 400,
          body: { error: err instanceof Error ? err.message : 'Failed to start auth' },
        };
      }
    });

    // Get auth session status
    this.routes.set('GET /auth/cli/:provider/status/:sessionId', async (req): Promise<ApiResponse> => {
      const { sessionId } = req.params;
      const session = getAuthSession(sessionId);
      if (!session) {
        return { status: 404, body: { error: 'Session not found' } };
      }
      return {
        status: 200,
        body: {
          sessionId: session.id,
          status: session.status,
          authUrl: session.authUrl,
          error: session.error,
          promptsHandled: session.promptsHandled,
        },
      };
    });

    // Get credentials from completed auth
    this.routes.set('GET /auth/cli/:provider/creds/:sessionId', async (req): Promise<ApiResponse> => {
      const { sessionId } = req.params;
      const session = getAuthSession(sessionId);
      if (!session) {
        return { status: 404, body: { error: 'Session not found' } };
      }
      if (session.status !== 'success') {
        return { status: 400, body: { error: 'Auth not complete', status: session.status } };
      }
      return {
        status: 200,
        body: {
          token: session.token,
          provider: session.provider,
        },
      };
    });

    // Cancel auth session
    this.routes.set('POST /auth/cli/:provider/cancel/:sessionId', async (req): Promise<ApiResponse> => {
      const { sessionId } = req.params;
      const cancelled = cancelAuthSession(sessionId);
      if (!cancelled) {
        return { status: 404, body: { error: 'Session not found' } };
      }
      return { status: 200, body: { success: true } };
    });
  }

  /**
   * Handle HTTP request
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const allowedOrigin = this.resolveAllowedOrigin(originHeader, req.headers.host);

    // CORS headers (default denies cross-origin unless explicitly allowed)
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Vary', 'Origin');

    if (allowedOrigin === null) {
      logger.warn('CORS origin blocked', { origin: originHeader });
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'CORS origin not allowed' }));
      return;
    }

    if (allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const apiReq = await this.parseRequest(req, url);

      // Find matching route
      const response = await this.routeRequest(apiReq);

      // Send response
      res.writeHead(response.status, {
        'Content-Type': 'application/json',
        ...response.headers,
      });

      if (response.body !== null) {
        const body =
          typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
        res.end(body);
      } else {
        res.end();
      }
    } catch (err) {
      logger.error('Request error', { error: String(err) });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  /**
   * Parse incoming request
   */
  private async parseRequest(req: http.IncomingMessage, url: URL): Promise<ApiRequest> {
    // Parse query params
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });

    // Parse body for POST/PUT
    let body: unknown;
    if (req.method === 'POST' || req.method === 'PUT') {
      body = await this.parseBody(req);
    }

    return {
      method: req.method || 'GET',
      path: url.pathname,
      body,
      params: {},
      query,
    };
  }

  /**
   * Parse request body
   */
  private parseBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
      });
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : undefined);
        } catch {
          reject(new Error('Invalid JSON body'));
        }
      });
      req.on('error', reject);
    });
  }

  /**
   * Route request to handler
   */
  private async routeRequest(req: ApiRequest): Promise<ApiResponse> {
    for (const [pattern, handler] of this.routes) {
      const match = this.matchRoute(pattern, req.method, req.path);
      if (match) {
        req.params = match.params;
        return handler(req);
      }
    }

    return { status: 404, body: { error: 'Not found' } };
  }

  /**
   * Match route pattern against request
   */
  private matchRoute(
    pattern: string,
    method: string,
    path: string
  ): { params: Record<string, string> } | null {
    const [patternMethod, patternPath] = pattern.split(' ');

    if (patternMethod !== method) {
      return null;
    }

    const patternParts = patternPath.split('/');
    const pathParts = path.split('/');

    if (patternParts.length !== pathParts.length) {
      return null;
    }

    const params: Record<string, string> = {};

    for (let i = 0; i < patternParts.length; i++) {
      const patternPart = patternParts[i];
      const pathPart = pathParts[i];

      if (patternPart.startsWith(':')) {
        params[patternPart.slice(1)] = pathPart;
      } else if (patternPart !== pathPart) {
        return null;
      }
    }

    return { params };
  }

  /**
   * Handle WebSocket connection
   */
  private handleWebSocketConnection(ws: WS, req: http.IncomingMessage): void {
    logger.info('WebSocket client connected', { url: req.url });

    // Create session
    const session: UserSession = {
      userId: 'anonymous', // Would be set from auth
      githubUsername: 'anonymous',
      connectedAt: new Date(),
    };
    this.sessions.set(ws, session);

    // Send initial state
    this.sendInitialState(ws);

    // Handle messages
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleWebSocketMessage(ws, session, message);
      } catch (err) {
        logger.error('WebSocket message error', { error: String(err) });
      }
    });

    ws.on('close', () => {
      logger.info('WebSocket client disconnected');
      this.sessions.delete(ws);
    });

    ws.on('error', (err) => {
      logger.error('WebSocket error', { error: String(err) });
    });
  }

  /**
   * Send initial state to WebSocket client
   */
  private sendInitialState(ws: WS): void {
    const workspaces = this.workspaceManager.getAll();
    const active = this.workspaceManager.getActive();
    const agents = this.agentManager.getAll();

    this.sendToClient(ws, {
      type: 'init',
      data: {
        workspaces,
        activeWorkspaceId: active?.id,
        agents,
      },
    });
  }

  /**
   * Handle WebSocket message from client
   */
  private handleWebSocketMessage(
    ws: WS,
    session: UserSession,
    message: { type: string; data?: unknown }
  ): void {
    switch (message.type) {
      case 'switch_workspace':
        if (typeof message.data === 'string') {
          try {
            this.workspaceManager.switchTo(message.data);
            session.activeWorkspaceId = message.data;
          } catch (err) {
            this.sendToClient(ws, { type: 'error', data: String(err) });
          }
        }
        break;

      case 'subscribe_output':
        // Subscribe to agent output stream
        // TODO: Implement output streaming
        break;

      case 'ping':
        this.sendToClient(ws, { type: 'pong' });
        break;
    }
  }

  /**
   * Send message to WebSocket client
   */
  private sendToClient(ws: WS, message: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Broadcast event to all WebSocket clients
   */
  private broadcastEvent(event: DaemonEvent): void {
    if (!this.wss) return;

    const message = JSON.stringify({ type: 'event', data: event });

    for (const ws of this.wss.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }
  }
}
