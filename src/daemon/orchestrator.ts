/**
 * Daemon Orchestrator
 *
 * Manages multiple workspace daemons and provides a unified API for the dashboard.
 * This is the top-level service that runs by default, handling workspace switching
 * and agent management across all connected repositories.
 */

import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import { WebSocketServer, WebSocket } from 'ws';
import { createLogger } from '../resiliency/logger.js';
import { metrics } from '../resiliency/metrics.js';
import { getSupervisor } from '../resiliency/supervisor.js';
import { Daemon } from './server.js';
import { AgentSpawner } from '../bridge/spawner.js';
import { getProjectPaths } from '../utils/project-namespace.js';
import type {
  Workspace,
  Agent,
  DaemonEvent,
  UserSession,
  ProviderType,
  AddWorkspaceRequest,
  SpawnAgentRequest,
} from './types.js';

const logger = createLogger('orchestrator');

function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
}

export interface OrchestratorConfig {
  /** Port for HTTP/WebSocket API */
  port: number;
  /** Host to bind to */
  host: string;
  /** Data directory for persistence */
  dataDir: string;
  /** Auto-start daemons for workspaces */
  autoStartDaemons: boolean;
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  port: 3456,
  host: 'localhost',
  dataDir: path.join(process.env.HOME || '', '.agent-relay', 'orchestrator'),
  autoStartDaemons: true,
};

interface ManagedWorkspace extends Workspace {
  daemon?: Daemon;
  spawner?: AgentSpawner;
}

export class Orchestrator extends EventEmitter {
  private config: OrchestratorConfig;
  private workspaces = new Map<string, ManagedWorkspace>();
  private activeWorkspaceId?: string;
  private server?: http.Server;
  private wss?: WebSocketServer;
  private sessions = new Map<WebSocket, UserSession>();
  private supervisor = getSupervisor({
    autoRestart: true,
    maxRestarts: 5,
    contextPersistence: { enabled: true, autoInjectOnRestart: true },
  });
  private workspacesFile: string;

  // Track alive status for ping/pong keepalive
  private clientAlive = new WeakMap<WebSocket, boolean>();
  private pingInterval?: NodeJS.Timeout;

  constructor(config: Partial<OrchestratorConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.workspacesFile = path.join(this.config.dataDir, 'workspaces.json');

    // Ensure data directory exists
    if (!fs.existsSync(this.config.dataDir)) {
      fs.mkdirSync(this.config.dataDir, { recursive: true });
    }

    // Load existing workspaces
    this.loadWorkspaces();
  }

  /**
   * Start the orchestrator
   */
  async start(): Promise<void> {
    logger.info('Starting orchestrator', {
      port: this.config.port,
      host: this.config.host,
    });

    // Start supervisor
    this.supervisor.start();

    // Auto-start daemons for workspaces
    if (this.config.autoStartDaemons) {
      for (const [id, workspace] of this.workspaces) {
        if (fs.existsSync(workspace.path)) {
          await this.startWorkspaceDaemon(id);
        }
      }
    }

    // Start HTTP server
    this.server = http.createServer((req, res) => this.handleRequest(req, res));

    // Setup WebSocket
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws, req) => this.handleWebSocket(ws, req));

    // Setup ping/pong keepalive (30 second interval)
    this.pingInterval = setInterval(() => {
      this.wss?.clients.forEach((ws) => {
        if (this.clientAlive.get(ws) === false) {
          logger.info('WebSocket client unresponsive, closing');
          ws.terminate();
          return;
        }
        this.clientAlive.set(ws, false);
        ws.ping();
      });
    }, 30000);

    return new Promise((resolve) => {
      this.server!.listen(this.config.port, this.config.host, () => {
        logger.info('Orchestrator started', {
          url: `http://${this.config.host}:${this.config.port}`,
        });
        resolve();
      });
    });
  }

  /**
   * Stop the orchestrator
   */
  async stop(): Promise<void> {
    logger.info('Stopping orchestrator');

    // Clear ping interval
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = undefined;
    }

    // Stop all workspace daemons
    for (const [id] of this.workspaces) {
      await this.stopWorkspaceDaemon(id);
    }

    // Stop supervisor
    this.supervisor.stop();

    // Close WebSocket connections
    if (this.wss) {
      for (const ws of this.wss.clients) {
        ws.close();
      }
      this.wss.close();
    }

    // Close HTTP server
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          logger.info('Orchestrator stopped');
          resolve();
        });
      });
    }
  }

  // === Workspace Management ===

  /**
   * Add a workspace
   */
  addWorkspace(request: AddWorkspaceRequest): Workspace {
    const resolvedPath = this.resolvePath(request.path);

    // Check if already exists
    const existing = this.findWorkspaceByPath(resolvedPath);
    if (existing) {
      return existing;
    }

    // Validate path exists
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Path does not exist: ${resolvedPath}`);
    }

    const workspace: ManagedWorkspace = {
      id: generateId(),
      name: request.name || path.basename(resolvedPath),
      path: resolvedPath,
      status: 'inactive',
      provider: request.provider || this.detectProvider(resolvedPath),
      createdAt: new Date(),
      lastActiveAt: new Date(),
      ...this.getGitInfo(resolvedPath),
    };

    this.workspaces.set(workspace.id, workspace);
    this.saveWorkspaces();

    logger.info('Workspace added', { id: workspace.id, name: workspace.name });

    this.broadcastEvent({
      type: 'workspace:added',
      workspaceId: workspace.id,
      data: this.toPublicWorkspace(workspace),
      timestamp: new Date(),
    });

    // Auto-start daemon
    if (this.config.autoStartDaemons) {
      this.startWorkspaceDaemon(workspace.id).catch((err) => {
        logger.error('Failed to start workspace daemon', { id: workspace.id, error: String(err) });
      });
    }

    return this.toPublicWorkspace(workspace);
  }

  /**
   * Remove a workspace
   */
  async removeWorkspace(workspaceId: string): Promise<boolean> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return false;

    // Stop daemon if running
    await this.stopWorkspaceDaemon(workspaceId);

    // Clear active if this was active
    if (this.activeWorkspaceId === workspaceId) {
      this.activeWorkspaceId = undefined;
    }

    this.workspaces.delete(workspaceId);
    this.saveWorkspaces();

    logger.info('Workspace removed', { id: workspaceId });

    this.broadcastEvent({
      type: 'workspace:removed',
      workspaceId,
      data: { id: workspaceId },
      timestamp: new Date(),
    });

    return true;
  }

  /**
   * Switch to a workspace
   */
  async switchWorkspace(workspaceId: string): Promise<Workspace> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    const previousId = this.activeWorkspaceId;

    // Update status
    if (previousId && previousId !== workspaceId) {
      const prev = this.workspaces.get(previousId);
      if (prev) {
        prev.status = 'inactive';
      }
    }

    workspace.status = 'active';
    workspace.lastActiveAt = new Date();
    this.activeWorkspaceId = workspaceId;

    // Ensure daemon is running
    if (!workspace.daemon?.isRunning) {
      await this.startWorkspaceDaemon(workspaceId);
    }

    this.saveWorkspaces();

    logger.info('Switched workspace', { id: workspaceId, name: workspace.name });

    this.broadcastEvent({
      type: 'workspace:switched',
      workspaceId,
      data: { previousId, currentId: workspaceId },
      timestamp: new Date(),
    });

    return this.toPublicWorkspace(workspace);
  }

  /**
   * Get all workspaces
   */
  getWorkspaces(): Workspace[] {
    return Array.from(this.workspaces.values()).map((w) => this.toPublicWorkspace(w));
  }

  /**
   * Get workspace by ID
   */
  getWorkspace(workspaceId: string): Workspace | undefined {
    const workspace = this.workspaces.get(workspaceId);
    return workspace ? this.toPublicWorkspace(workspace) : undefined;
  }

  /**
   * Get active workspace
   */
  getActiveWorkspace(): Workspace | undefined {
    if (!this.activeWorkspaceId) return undefined;
    return this.getWorkspace(this.activeWorkspaceId);
  }

  // === Agent Management ===

  /**
   * Spawn an agent in a workspace
   */
  async spawnAgent(workspaceId: string, request: SpawnAgentRequest): Promise<Agent> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    // Ensure daemon is running
    if (!workspace.daemon?.isRunning) {
      await this.startWorkspaceDaemon(workspaceId);
    }

    // Ensure spawner exists
    if (!workspace.spawner) {
      workspace.spawner = new AgentSpawner({
        projectRoot: workspace.path,
        onMarkSpawning: (name) => workspace.daemon?.markSpawning(name),
        onClearSpawning: (name) => workspace.daemon?.clearSpawning(name),
      });
    }

    const result = await workspace.spawner.spawn({
      name: request.name,
      cli: this.getCliForProvider(request.provider || workspace.provider),
      task: request.task || '',
    });

    if (!result.success) {
      throw new Error(result.error || 'Failed to spawn agent');
    }

    const agent: Agent = {
      id: generateId(),
      name: request.name,
      workspaceId,
      provider: request.provider || workspace.provider,
      status: 'running',
      pid: result.pid,
      task: request.task,
      spawnedAt: new Date(),
      restartCount: 0,
    };

    logger.info('Agent spawned', { id: agent.id, name: agent.name, workspaceId });

    this.broadcastEvent({
      type: 'agent:spawned',
      workspaceId,
      agentId: agent.id,
      data: agent,
      timestamp: new Date(),
    });

    return agent;
  }

  /**
   * Stop an agent
   */
  async stopAgent(workspaceId: string, agentName: string): Promise<boolean> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace?.spawner) return false;

    const released = await workspace.spawner.release(agentName);

    if (released) {
      this.broadcastEvent({
        type: 'agent:stopped',
        workspaceId,
        data: { name: agentName },
        timestamp: new Date(),
      });
    }

    return released;
  }

  /**
   * Get agents in a workspace
   */
  getAgents(workspaceId: string): Agent[] {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace?.spawner) return [];

    return workspace.spawner.getActiveWorkers().map((w) => ({
      id: w.name,
      name: w.name,
      workspaceId,
      provider: this.detectProviderFromCli(w.cli),
      status: 'running' as const,
      pid: w.pid,
      task: w.task,
      spawnedAt: new Date(w.spawnedAt),
      restartCount: 0,
    }));
  }

  // === Private Methods ===

  /**
   * Start daemon for a workspace
   */
  private async startWorkspaceDaemon(workspaceId: string): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return;

    if (workspace.daemon?.isRunning) return;

    try {
      const paths = getProjectPaths(workspace.path);

      workspace.daemon = new Daemon({
        socketPath: paths.socketPath,
        teamDir: paths.teamDir,
      });

      await workspace.daemon.start();
      workspace.status = 'active';

      // Create spawner
      workspace.spawner = new AgentSpawner({
        projectRoot: workspace.path,
        onMarkSpawning: (name) => workspace.daemon?.markSpawning(name),
        onClearSpawning: (name) => workspace.daemon?.clearSpawning(name),
      });

      // Set up agent death notifications
      workspace.spawner.setOnAgentDeath((info) => {
        // Broadcast to dashboard via WebSocket
        this.broadcastEvent({
          type: 'agent:crashed',
          workspaceId,
          data: {
            name: info.name,
            exitCode: info.exitCode,
            continuityAgentId: info.agentId,
            resumeInstructions: info.resumeInstructions,
          },
          timestamp: new Date(),
        });

        // Broadcast to all connected agents via relay
        const message = info.agentId
          ? `AGENT DIED: "${info.name}" has crashed (exit code: ${info.exitCode}). Agent ID: ${info.agentId}. ${info.resumeInstructions}`
          : `AGENT DIED: "${info.name}" has crashed (exit code: ${info.exitCode}).`;

        workspace.daemon?.broadcastSystemMessage(message, {
          agentName: info.name,
          exitCode: info.exitCode,
          agentId: info.agentId,
          resumeInstructions: info.resumeInstructions,
        });

        logger.warn('Agent died', {
          name: info.name,
          exitCode: info.exitCode,
          agentId: info.agentId,
        });
      });

      logger.info('Workspace daemon started', { id: workspaceId, socket: paths.socketPath });
    } catch (err) {
      workspace.status = 'error';
      logger.error('Failed to start workspace daemon', { id: workspaceId, error: String(err) });
      throw err;
    }
  }

  /**
   * Stop daemon for a workspace
   */
  private async stopWorkspaceDaemon(workspaceId: string): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return;

    // Release all agents first
    if (workspace.spawner) {
      await workspace.spawner.releaseAll();
    }

    // Stop daemon
    if (workspace.daemon) {
      await workspace.daemon.stop();
      workspace.daemon = undefined;
    }

    workspace.spawner = undefined;
    workspace.status = 'inactive';

    logger.info('Workspace daemon stopped', { id: workspaceId });
  }

  /**
   * Handle HTTP request
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method || 'GET';

    try {
      let response: { status: number; body: unknown };

      // Health check
      if (pathname === '/' && method === 'GET') {
        response = { status: 200, body: { status: 'ok', version: '1.0.0' } };
      }
      // Metrics
      else if (pathname === '/metrics' && method === 'GET') {
        res.setHeader('Content-Type', 'text/plain');
        res.writeHead(200);
        res.end(metrics.toPrometheus());
        return;
      }
      // List workspaces
      else if (pathname === '/workspaces' && method === 'GET') {
        response = {
          status: 200,
          body: {
            workspaces: this.getWorkspaces(),
            activeWorkspaceId: this.activeWorkspaceId,
          },
        };
      }
      // Add workspace
      else if (pathname === '/workspaces' && method === 'POST') {
        const body = await this.parseBody(req);
        const workspace = this.addWorkspace(body as AddWorkspaceRequest);
        response = { status: 201, body: workspace };
      }
      // Get workspace
      else if (pathname.match(/^\/workspaces\/[^/]+$/) && method === 'GET') {
        const id = pathname.split('/')[2];
        const workspace = this.getWorkspace(id);
        response = workspace
          ? { status: 200, body: workspace }
          : { status: 404, body: { error: 'Not found' } };
      }
      // Delete workspace
      else if (pathname.match(/^\/workspaces\/[^/]+$/) && method === 'DELETE') {
        const id = pathname.split('/')[2];
        const removed = await this.removeWorkspace(id);
        response = removed
          ? { status: 204, body: null }
          : { status: 404, body: { error: 'Not found' } };
      }
      // Switch workspace
      else if (pathname.match(/^\/workspaces\/[^/]+\/switch$/) && method === 'POST') {
        const id = pathname.split('/')[2];
        const workspace = await this.switchWorkspace(id);
        response = { status: 200, body: workspace };
      }
      // List agents in workspace
      else if (pathname.match(/^\/workspaces\/[^/]+\/agents$/) && method === 'GET') {
        const id = pathname.split('/')[2];
        const agents = this.getAgents(id);
        response = { status: 200, body: { agents, workspaceId: id } };
      }
      // Spawn agent
      else if (pathname.match(/^\/workspaces\/[^/]+\/agents$/) && method === 'POST') {
        const id = pathname.split('/')[2];
        const body = await this.parseBody(req);
        const agent = await this.spawnAgent(id, body as SpawnAgentRequest);
        response = { status: 201, body: agent };
      }
      // Stop agent
      else if (pathname.match(/^\/workspaces\/[^/]+\/agents\/[^/]+$/) && method === 'DELETE') {
        const parts = pathname.split('/');
        const workspaceId = parts[2];
        const agentName = parts[4];
        const stopped = await this.stopAgent(workspaceId, agentName);
        response = stopped
          ? { status: 204, body: null }
          : { status: 404, body: { error: 'Not found' } };
      }
      // Not found
      else {
        response = { status: 404, body: { error: 'Not found' } };
      }

      res.setHeader('Content-Type', 'application/json');
      res.writeHead(response.status);
      res.end(response.body ? JSON.stringify(response.body) : '');
    } catch (err) {
      logger.error('Request error', { error: String(err) });
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(err) }));
    }
  }

  /**
   * Handle WebSocket connection
   */
  private handleWebSocket(ws: WebSocket, _req: http.IncomingMessage): void {
    logger.info('WebSocket client connected');

    // Mark client as alive for ping/pong keepalive
    this.clientAlive.set(ws, true);

    // Handle pong responses
    ws.on('pong', () => {
      this.clientAlive.set(ws, true);
    });

    const session: UserSession = {
      userId: 'anonymous',
      githubUsername: 'anonymous',
      connectedAt: new Date(),
      activeWorkspaceId: this.activeWorkspaceId,
    };
    this.sessions.set(ws, session);

    // Send initial state
    this.sendToClient(ws, {
      type: 'init',
      data: {
        workspaces: this.getWorkspaces(),
        activeWorkspaceId: this.activeWorkspaceId,
        agents: this.activeWorkspaceId ? this.getAgents(this.activeWorkspaceId) : [],
      },
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleWebSocketMessage(ws, session, msg);
      } catch (err) {
        logger.error('WebSocket message error', { error: String(err) });
      }
    });

    ws.on('close', () => {
      this.sessions.delete(ws);
      logger.info('WebSocket client disconnected');
    });
  }

  /**
   * Handle WebSocket message
   */
  private handleWebSocketMessage(
    ws: WebSocket,
    session: UserSession,
    msg: { type: string; data?: unknown }
  ): void {
    switch (msg.type) {
      case 'switch_workspace':
        if (typeof msg.data === 'string') {
          this.switchWorkspace(msg.data)
            .then((workspace) => {
              session.activeWorkspaceId = workspace.id;
            })
            .catch((err) => {
              this.sendToClient(ws, { type: 'error', data: String(err) });
            });
        }
        break;
      case 'ping':
        this.sendToClient(ws, { type: 'pong' });
        break;
    }
  }

  /**
   * Send to WebSocket client
   */
  private sendToClient(ws: WebSocket, msg: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Broadcast event to all clients
   */
  private broadcastEvent(event: DaemonEvent): void {
    if (!this.wss) return;
    const msg = JSON.stringify({ type: 'event', data: event });
    for (const ws of this.wss.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }

  /**
   * Parse request body
   */
  private parseBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          reject(new Error('Invalid JSON'));
        }
      });
    });
  }

  /**
   * Load workspaces from disk
   */
  private loadWorkspaces(): void {
    if (!fs.existsSync(this.workspacesFile)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.workspacesFile, 'utf8'));
      for (const w of data.workspaces || []) {
        this.workspaces.set(w.id, {
          ...w,
          createdAt: new Date(w.createdAt),
          lastActiveAt: new Date(w.lastActiveAt),
          status: 'inactive',
        });
      }
      this.activeWorkspaceId = data.activeWorkspaceId;
      logger.info('Loaded workspaces', { count: this.workspaces.size });
    } catch (err) {
      logger.error('Failed to load workspaces', { error: String(err) });
    }
  }

  /**
   * Save workspaces to disk
   */
  private saveWorkspaces(): void {
    try {
      const data = {
        workspaces: Array.from(this.workspaces.values()).map((w) => this.toPublicWorkspace(w)),
        activeWorkspaceId: this.activeWorkspaceId,
      };
      fs.writeFileSync(this.workspacesFile, JSON.stringify(data, null, 2));
    } catch (err) {
      logger.error('Failed to save workspaces', { error: String(err) });
    }
  }

  /**
   * Find workspace by path
   */
  private findWorkspaceByPath(path: string): Workspace | undefined {
    const resolved = this.resolvePath(path);
    const workspace = Array.from(this.workspaces.values()).find((w) => w.path === resolved);
    return workspace ? this.toPublicWorkspace(workspace) : undefined;
  }

  /**
   * Resolve path
   */
  private resolvePath(p: string): string {
    if (p.startsWith('~')) {
      p = path.join(process.env.HOME || '', p.slice(1));
    }
    return path.resolve(p);
  }

  /**
   * Detect provider from workspace
   */
  private detectProvider(workspacePath: string): ProviderType {
    if (
      fs.existsSync(path.join(workspacePath, 'CLAUDE.md')) ||
      fs.existsSync(path.join(workspacePath, '.claude'))
    ) {
      return 'claude';
    }
    if (fs.existsSync(path.join(workspacePath, '.codex'))) {
      return 'codex';
    }
    if (fs.existsSync(path.join(workspacePath, '.gemini'))) {
      return 'gemini';
    }
    return 'generic';
  }

  /**
   * Detect provider from CLI command
   */
  private detectProviderFromCli(cli: string): ProviderType {
    if (cli.includes('claude')) return 'claude';
    if (cli.includes('codex')) return 'codex';
    if (cli.includes('gemini')) return 'gemini';
    return 'generic';
  }

  /**
   * Get CLI command for provider
   */
  private getCliForProvider(provider: ProviderType): string {
    switch (provider) {
      case 'claude':
        return 'claude';
      case 'codex':
        return 'codex';
      case 'gemini':
        return 'gemini';
      default:
        return 'claude';
    }
  }

  /**
   * Get git info
   */
  private getGitInfo(workspacePath: string): { gitRemote?: string; gitBranch?: string } {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { execSync } = require('child_process');
      const branch = execSync('git branch --show-current', {
        cwd: workspacePath,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      let remote: string | undefined;
      try {
        remote = execSync('git remote get-url origin', {
          cwd: workspacePath,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
      } catch {
        // No remote
      }
      return { gitRemote: remote, gitBranch: branch };
    } catch {
      return {};
    }
  }

  /**
   * Convert to public workspace (without internal references)
   */
  private toPublicWorkspace(w: ManagedWorkspace): Workspace {
    return {
      id: w.id,
      name: w.name,
      path: w.path,
      status: w.status,
      provider: w.provider,
      createdAt: w.createdAt,
      lastActiveAt: w.lastActiveAt,
      cloudId: w.cloudId,
      customDomain: w.customDomain,
      gitRemote: w.gitRemote,
      gitBranch: w.gitBranch,
    };
  }
}

let orchestratorInstance: Orchestrator | undefined;

/**
 * Start the orchestrator
 */
export async function startOrchestrator(
  config: Partial<OrchestratorConfig> = {}
): Promise<Orchestrator> {
  if (orchestratorInstance) {
    return orchestratorInstance;
  }

  orchestratorInstance = new Orchestrator(config);
  await orchestratorInstance.start();
  return orchestratorInstance;
}

/**
 * Stop the orchestrator
 */
export async function stopOrchestrator(): Promise<void> {
  if (orchestratorInstance) {
    await orchestratorInstance.stop();
    orchestratorInstance = undefined;
  }
}

/**
 * Get orchestrator instance
 */
export function getOrchestrator(): Orchestrator | undefined {
  return orchestratorInstance;
}
