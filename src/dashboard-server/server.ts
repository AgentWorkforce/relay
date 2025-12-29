import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { SqliteStorageAdapter } from '../storage/sqlite-adapter.js';
import type { StorageAdapter, StoredMessage } from '../storage/adapter.js';
import { RelayClient } from '../wrapper/client.js';
import { computeNeedsAttention } from './needs-attention.js';
import { computeSystemMetrics, formatPrometheusMetrics } from './metrics.js';
import { MultiProjectClient } from '../bridge/multi-project-client.js';
import { AgentSpawner } from '../bridge/spawner.js';
import type { ProjectConfig, SpawnRequest } from '../bridge/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface AgentStatus {
  name: string;
  role: string;
  cli: string;
  messageCount: number;
  status?: string;
  lastActive?: string;
  lastSeen?: string;
  needsAttention?: boolean;
  isProcessing?: boolean;
  processingStartedAt?: number;
}

interface Message {
  from: string;
  to: string;
  content: string;
  timestamp: string;
  id: string; // unique-ish id
  thread?: string;
  isBroadcast?: boolean;
}

interface SessionInfo {
  id: string;
  agentName: string;
  cli?: string;
  startedAt: string;
  endedAt?: string;
  duration?: string;
  messageCount: number;
  summary?: string;
  /**
   * true if session is still active (endedAt is not set).
   * Note: This is determined solely by endedAt, regardless of how the session
   * was closed (agent explicit close, disconnect, or error via closedBy field).
   */
  isActive: boolean;
  /** How the session was closed: 'agent' (explicit), 'disconnect', 'error', or undefined */
  closedBy?: 'agent' | 'disconnect' | 'error';
}

interface AgentSummary {
  agentName: string;
  lastUpdated: string;
  currentTask?: string;
  completedTasks?: string[];
  context?: string;
}

export interface DashboardOptions {
  port: number;
  dataDir: string;
  teamDir: string;
  dbPath?: string;
  /** Enable agent spawning API */
  enableSpawner?: boolean;
  /** Project root for spawner (defaults to dataDir) */
  projectRoot?: string;
  /** Tmux session name for workers */
  tmuxSession?: string;
}

export async function startDashboard(port: number, dataDir: string, teamDir: string, dbPath?: string): Promise<number>;
export async function startDashboard(options: DashboardOptions): Promise<number>;
export async function startDashboard(
  portOrOptions: number | DashboardOptions,
  dataDirArg?: string,
  teamDirArg?: string,
  dbPathArg?: string
): Promise<number> {
  // Handle overloaded signatures
  const options: DashboardOptions = typeof portOrOptions === 'number'
    ? { port: portOrOptions, dataDir: dataDirArg!, teamDir: teamDirArg!, dbPath: dbPathArg }
    : portOrOptions;

  const { port, dataDir, teamDir, dbPath, enableSpawner, projectRoot, tmuxSession } = options;

  console.log('Starting dashboard...');

  const storage: StorageAdapter | undefined = dbPath
    ? new SqliteStorageAdapter({ dbPath })
    : undefined;

  // Initialize spawner if enabled
  const spawner: AgentSpawner | undefined = enableSpawner
    ? new AgentSpawner(projectRoot || dataDir, tmuxSession)
    : undefined;

  process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  });

  const app = express();
  const server = http.createServer(app);

  // Use noServer mode to manually route upgrade requests
  // This prevents the bug where multiple WebSocketServers attached to the same
  // HTTP server cause conflicts - each one's upgrade handler fires and the ones
  // that don't match the path call abortHandshake(400), writing raw HTTP to the socket
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    skipUTF8Validation: true,
    maxPayload: 100 * 1024 * 1024 // 100MB
  });
  const wssBridge = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    skipUTF8Validation: true,
    maxPayload: 100 * 1024 * 1024
  });

  // Manually handle upgrade requests and route to correct WebSocketServer
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;

    if (pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else if (pathname === '/ws/bridge') {
      wssBridge.handleUpgrade(request, socket, head, (ws) => {
        wssBridge.emit('connection', ws, request);
      });
    } else {
      // Unknown path - destroy socket
      socket.destroy();
    }
  });

  // Server-level error handlers
  wss.on('error', (err) => {
    console.error('[dashboard] WebSocket server error:', err);
  });

  wssBridge.on('error', (err) => {
    console.error('[dashboard] Bridge WebSocket server error:', err);
  });
  if (storage) {
    await storage.init();
  }

  app.use(express.json());

  // Serve dashboard static files at root (built with `next build` in src/dashboard)
  // __dirname is dist/dashboard-server, dashboard is at ../dashboard/out (relative to dist)
  // But in source it's at ../dashboard/out (relative to src/dashboard-server)
  const dashboardDistDir = path.join(__dirname, '..', 'dashboard', 'out');
  const dashboardSourceDir = path.join(__dirname, '..', '..', 'src', 'dashboard', 'out');

  // Check which path exists (dist or src)
  const dashboardDir = fs.existsSync(dashboardDistDir) ? dashboardDistDir : dashboardSourceDir;
  if (fs.existsSync(dashboardDir)) {
    console.log(`[dashboard] Serving from: ${dashboardDir}`);
    // Serve Next.js static export with .html extension handling
    app.use(express.static(dashboardDir, { extensions: ['html'] }));

    // Fallback for Next.js pages (e.g., /metrics -> /metrics.html)
    app.get('/metrics', (req, res) => {
      res.sendFile(path.join(dashboardDir, 'metrics.html'));
    });
  } else {
    console.error('[dashboard] Dashboard not found at:', dashboardDistDir, 'or', dashboardSourceDir);
  }

  // Relay client for sending messages from dashboard
  const socketPath = path.join(dataDir, 'relay.sock');
  let relayClient: RelayClient | undefined;

  const connectRelayClient = async (): Promise<void> => {
    // Only attempt connection if socket exists (daemon is running)
    if (!fs.existsSync(socketPath)) {
      console.log('[dashboard] Relay socket not found, messaging disabled');
      return;
    }

    relayClient = new RelayClient({
      socketPath,
      agentName: 'Dashboard',
      cli: 'dashboard',
      reconnect: true,
      maxReconnectAttempts: 5,
    });

    relayClient.onError = (err) => {
      console.error('[dashboard] Relay client error:', err.message);
    };

    relayClient.onStateChange = (state) => {
      console.log(`[dashboard] Relay client state: ${state}`);
    };

    try {
      await relayClient.connect();
      console.log('[dashboard] Connected to relay daemon');
    } catch (err) {
      console.error('[dashboard] Failed to connect to relay daemon:', err);
      relayClient = undefined;
    }
  };

  // Start relay client connection (non-blocking)
  connectRelayClient().catch(() => {});

  // Bridge client for cross-project messaging
  let bridgeClient: MultiProjectClient | undefined;
  let bridgeClientConnecting = false;

  const connectBridgeClient = async (): Promise<void> => {
    if (bridgeClient || bridgeClientConnecting) return;

    // Check if bridge-state.json exists and has projects
    const bridgeStatePath = path.join(dataDir, 'bridge-state.json');
    if (!fs.existsSync(bridgeStatePath)) {
      return;
    }

    try {
      const bridgeState = JSON.parse(fs.readFileSync(bridgeStatePath, 'utf-8'));
      if (!bridgeState.connected || !bridgeState.projects?.length) {
        return;
      }

      bridgeClientConnecting = true;

      // Build project configs from bridge state
      const projectConfigs: ProjectConfig[] = bridgeState.projects.map((p: {
        id: string;
        path: string;
        lead?: { name: string };
      }) => {
        // Compute socket path for each project
        const projectHash = crypto.createHash('sha256').update(p.path).digest('hex').slice(0, 12);
        const projectDataDir = path.join(path.dirname(dataDir), projectHash);
        const socketPath = path.join(projectDataDir, 'relay.sock');

        return {
          id: p.id,
          path: p.path,
          socketPath,
          leadName: p.lead?.name || 'Lead',
          cli: 'dashboard-bridge',
        };
      });

      // Filter to projects with existing sockets
      const validConfigs = projectConfigs.filter((p: ProjectConfig) => fs.existsSync(p.socketPath));
      if (validConfigs.length === 0) {
        bridgeClientConnecting = false;
        return;
      }

      bridgeClient = new MultiProjectClient(validConfigs, {
        agentName: '__DashboardBridge__',  // Unique name to avoid conflict with CLI bridge
        reconnect: true,
      });

      bridgeClient.onProjectStateChange = (projectId, connected) => {
        console.log(`[dashboard-bridge] Project ${projectId} ${connected ? 'connected' : 'disconnected'}`);
      };

      await bridgeClient.connect();
      console.log('[dashboard] Bridge client connected to', validConfigs.length, 'project(s)');
      bridgeClientConnecting = false;
    } catch (err) {
      console.error('[dashboard] Failed to connect bridge client:', err);
      bridgeClient = undefined;
      bridgeClientConnecting = false;
    }
  };

  // Start bridge client connection (non-blocking)
  connectBridgeClient().catch(() => {});

  // API endpoint to send messages
  app.post('/api/send', async (req, res) => {
    const { to, message, thread } = req.body;

    if (!to || !message) {
      return res.status(400).json({ error: 'Missing "to" or "message" field' });
    }

    if (!relayClient || relayClient.state !== 'READY') {
      // Try to reconnect
      await connectRelayClient();
      if (!relayClient || relayClient.state !== 'READY') {
        return res.status(503).json({ error: 'Relay daemon not connected' });
      }
    }

    try {
      const sent = relayClient.sendMessage(to, message, 'message', undefined, thread);
      if (sent) {
        res.json({ success: true });
      } else {
        res.status(500).json({ error: 'Failed to send message' });
      }
    } catch (err) {
      console.error('[dashboard] Failed to send message:', err);
      res.status(500).json({ error: 'Failed to send message' });
    }
  });

  // API endpoint to send messages via bridge (cross-project)
  app.post('/api/bridge/send', async (req, res) => {
    const { projectId, to, message } = req.body;

    if (!projectId || !to || !message) {
      return res.status(400).json({ error: 'Missing "projectId", "to", or "message" field' });
    }

    // Try to connect bridge client if not connected
    if (!bridgeClient) {
      await connectBridgeClient();
      if (!bridgeClient) {
        return res.status(503).json({ error: 'Bridge not connected. Is the bridge command running?' });
      }
    }

    try {
      const sent = bridgeClient.sendToProject(projectId, to, message);
      if (sent) {
        res.json({ success: true });
      } else {
        res.status(500).json({ error: `Failed to send message to ${projectId}:${to}` });
      }
    } catch (err) {
      console.error('[dashboard] Failed to send bridge message:', err);
      res.status(500).json({ error: 'Failed to send bridge message' });
    }
  });

  const getTeamData = () => {
    // Try team.json first (file-based team mode)
    const teamPath = path.join(teamDir, 'team.json');
    if (fs.existsSync(teamPath)) {
      try {
        return JSON.parse(fs.readFileSync(teamPath, 'utf-8'));
      } catch (e) {
        console.error('Failed to read team.json', e);
      }
    }

    // Fall back to agents.json (daemon mode - live connected agents)
    const agentsPath = path.join(teamDir, 'agents.json');
    if (fs.existsSync(agentsPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(agentsPath, 'utf-8'));
        // Convert agents.json format to team.json format
        return {
          agents: data.agents.map((a: { name: string; connectedAt?: string; cli?: string; lastSeen?: string }) => ({
            name: a.name,
            role: 'Agent',
            cli: a.cli ?? 'Unknown',
            lastSeen: a.lastSeen ?? a.connectedAt,
            lastActive: a.lastSeen ?? a.connectedAt,
          })),
        };
      } catch (e) {
        console.error('Failed to read agents.json', e);
      }
    }

    return null;
  };

  const parseInbox = (agentName: string): Message[] => {
    const inboxPath = path.join(dataDir, agentName, 'inbox.md');
    if (!fs.existsSync(inboxPath)) return [];
    
    try {
      const content = fs.readFileSync(inboxPath, 'utf-8');
      const messages: Message[] = [];
      
      // Split by "## Message from "
      const parts = content.split('## Message from ');
      
      parts.forEach((part, index) => {
        if (!part.trim()) return;
        
        const firstLineEnd = part.indexOf('\n');
        if (firstLineEnd === -1) return;
        
        const header = part.substring(0, firstLineEnd).trim(); // "Sender | Timestamp" or just "Sender"
        const body = part.substring(firstLineEnd).trim();
        
        // Handle potential " | " in header
        let sender = header;
        let timestamp = new Date().toISOString();
        
        if (header.includes('|')) {
          const split = header.split('|');
          sender = split[0].trim();
          timestamp = split.slice(1).join('|').trim();
        }

        messages.push({
          from: sender,
          to: agentName,
          content: body,
          timestamp: timestamp,
          id: `${agentName}-${index}-${Date.now()}`
        });
      });
      return messages;
    } catch (e) {
      console.error(`Failed to read inbox for ${agentName}`, e);
      return [];
    }
  };

  const mapStoredMessages = (rows: StoredMessage[]): Message[] => rows
    .map((row) => ({
      from: row.from,
      to: row.to,
      content: row.body,
      timestamp: new Date(row.ts).toISOString(),
      id: row.id,
      thread: row.thread,
      isBroadcast: row.is_broadcast,
    }));

  const getMessages = async (agents: any[]): Promise<Message[]> => {
    if (storage) {
      const rows = await storage.getMessages({ limit: 100, order: 'desc' });
      // Dashboard expects oldest first
      return mapStoredMessages(rows).reverse();
    }

    // Fallback to file-based inbox parsing
    let allMessages: Message[] = [];
    agents.forEach((a: any) => {
      const msgs = parseInbox(a.name);
      allMessages = [...allMessages, ...msgs];
    });
    return allMessages;
  };

  const formatDuration = (startMs: number, endMs?: number): string => {
    const end = endMs ?? Date.now();
    const durationMs = end - startMs;
    const minutes = Math.floor(durationMs / 60000);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    }
    return `${minutes}m`;
  };

  const getRecentSessions = async (): Promise<SessionInfo[]> => {
    if (storage && storage instanceof SqliteStorageAdapter) {
      const sessions = await storage.getRecentSessions(20);
      return sessions.map(s => ({
        id: s.id,
        agentName: s.agentName,
        cli: s.cli,
        startedAt: new Date(s.startedAt).toISOString(),
        endedAt: s.endedAt ? new Date(s.endedAt).toISOString() : undefined,
        duration: formatDuration(s.startedAt, s.endedAt),
        messageCount: s.messageCount,
        summary: s.summary,
        isActive: !s.endedAt, // Active if no end time
        closedBy: s.closedBy,
      }));
    }
    return [];
  };

  const getAgentSummaries = async (): Promise<AgentSummary[]> => {
    if (storage && storage instanceof SqliteStorageAdapter) {
      const summaries = await storage.getAllAgentSummaries();
      return summaries.map(s => ({
        agentName: s.agentName,
        lastUpdated: new Date(s.lastUpdated).toISOString(),
        currentTask: s.currentTask,
        completedTasks: s.completedTasks,
        context: s.context,
      }));
    }
    return [];
  };

  const getAllData = async () => {
    const team = getTeamData();
    if (!team) return { agents: [], messages: [], activity: [], sessions: [], summaries: [] };

    const agentsMap = new Map<string, AgentStatus>();
    const allMessages: Message[] = await getMessages(team.agents);

    // Initialize agents from config
    team.agents.forEach((a: any) => {
      agentsMap.set(a.name, {
        name: a.name,
        role: a.role,
        cli: a.cli ?? 'Unknown',
        messageCount: 0,
        status: 'Idle',
        lastSeen: a.lastSeen,
        lastActive: a.lastActive,
        needsAttention: false,
      });
    });

    // Update inbox counts if fallback mode; if storage, count messages addressed to agent
    if (storage) {
      for (const msg of allMessages) {
        const agent = agentsMap.get(msg.to);
        if (agent) {
          agent.messageCount = (agent.messageCount ?? 0) + 1;
        }
      }
    } else {
      // Sort by timestamp
      allMessages.sort((a, b) => {
        return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
      });
    }

    // Derive status from messages sent BY agents
    // We scan all messages; if M is from A, we check if it is a STATUS message
    // Note: lastActive is updated from messages, but lastSeen comes from the registry
    // (heartbeat-based) and should NOT be overwritten by message timestamps
    allMessages.forEach(m => {
      const agent = agentsMap.get(m.from);
      if (agent) {
        agent.lastActive = m.timestamp;
        // Don't overwrite lastSeen - it comes from registry (heartbeat/connection tracking)
        if (m.content.startsWith('STATUS:')) {
          agent.status = m.content.substring(7).trim(); // remove "STATUS:"
        }
      }
    });

    // Detect agents with unanswered inbound messages (needs attention)
    const needsAttentionAgents = computeNeedsAttention(allMessages.map((m) => ({
      from: m.from,
      to: m.to,
      timestamp: m.timestamp,
      thread: m.thread,
      isBroadcast: m.isBroadcast,
    })));

    needsAttentionAgents.forEach((agentName) => {
      const agent = agentsMap.get(agentName);
      if (agent) {
        agent.needsAttention = true;
      }
    });

    // Read processing state from daemon
    const processingStatePath = path.join(dataDir, 'processing-state.json');
    if (fs.existsSync(processingStatePath)) {
      try {
        const processingData = JSON.parse(fs.readFileSync(processingStatePath, 'utf-8'));
        const processingAgents = processingData.processingAgents || {};
        for (const [agentName, state] of Object.entries(processingAgents)) {
          const agent = agentsMap.get(agentName);
          if (agent && state && typeof state === 'object') {
            agent.isProcessing = true;
            agent.processingStartedAt = (state as { startedAt: number }).startedAt;
          }
        }
      } catch (_err) {
        // Ignore errors reading processing state - it's optional
      }
    }

    // Fetch sessions and summaries in parallel
    const [sessions, summaries] = await Promise.all([
      getRecentSessions(),
      getAgentSummaries(),
    ]);

    // Filter agents:
    // 1. Exclude "Dashboard" (internal agent, not a real team member)
    // 2. Exclude offline agents (no lastSeen or lastSeen > 5 minutes ago)
    const now = Date.now();
    const OFFLINE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
    const filteredAgents = Array.from(agentsMap.values()).filter(agent => {
      // Exclude Dashboard
      if (agent.name === 'Dashboard') return false;

      // Exclude agents starting with __ (internal/system agents)
      if (agent.name.startsWith('__')) return false;

      // Exclude offline agents (no lastSeen or too old)
      if (!agent.lastSeen) return false;
      const lastSeenTime = new Date(agent.lastSeen).getTime();
      if (now - lastSeenTime > OFFLINE_THRESHOLD_MS) return false;

      return true;
    });

    return {
      agents: filteredAgents,
      messages: allMessages,
      activity: allMessages, // For now, activity log is just the message log
      sessions,
      summaries,
    };
  };

  // Track clients that are still initializing (haven't received first data yet)
  // This prevents race conditions where broadcastData sends before initial data is sent
  const initializingClients = new WeakSet<WebSocket>();

  const broadcastData = async () => {
    try {
      const data = await getAllData();
      const payload = JSON.stringify(data);

      // Guard against empty/invalid payloads
      if (!payload || payload.length === 0) {
        console.warn('[dashboard] Skipping broadcast - empty payload');
        return;
      }

      wss.clients.forEach(client => {
        // Skip clients that are still being initialized by the connection handler
        if (initializingClients.has(client)) {
          return;
        }
        if (client.readyState === WebSocket.OPEN) {
          try {
            client.send(payload);
          } catch (err) {
            console.error('[dashboard] Failed to send to client:', err);
          }
        }
      });
    } catch (err) {
      console.error('[dashboard] Failed to broadcast data:', err);
    }
  };

  // Bridge data functions - defined before connection handlers
  const getBridgeData = async () => {
    const bridgeStatePath = path.join(dataDir, 'bridge-state.json');
    if (fs.existsSync(bridgeStatePath)) {
      try {
        const bridgeState = JSON.parse(fs.readFileSync(bridgeStatePath, 'utf-8'));

        // Enrich each project with actual agent data from their team directories
        if (bridgeState.projects && Array.isArray(bridgeState.projects)) {
          for (const project of bridgeState.projects) {
            if (project.path) {
              // Get project's data directory
              const crypto = await import('crypto');
              const projectHash = crypto.createHash('sha256').update(project.path).digest('hex').slice(0, 12);
              const projectDataDir = path.join(path.dirname(dataDir), projectHash);
              const projectTeamDir = path.join(projectDataDir, 'team');
              const agentsPath = path.join(projectTeamDir, 'agents.json');

              // Read actual connected agents
              if (fs.existsSync(agentsPath)) {
                try {
                  const agentsData = JSON.parse(fs.readFileSync(agentsPath, 'utf-8'));
                  if (agentsData.agents && Array.isArray(agentsData.agents)) {
                    // Filter to only show online agents (seen in last 5 minutes)
                    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
                    project.agents = agentsData.agents
                      .filter((a: { lastSeen?: string }) => {
                        if (!a.lastSeen) return false;
                        return new Date(a.lastSeen).getTime() > fiveMinutesAgo;
                      })
                      .map((a: { name: string; cli?: string; lastSeen?: string }) => ({
                        name: a.name,
                        status: 'active',
                        cli: a.cli,
                        lastSeen: a.lastSeen,
                      }));

                    // Update lead status based on actual agents
                    if (project.lead) {
                      const leadAgent = project.agents.find((a: { name: string }) =>
                        a.name.toLowerCase() === project.lead.name.toLowerCase()
                      );
                      project.lead.connected = !!leadAgent;
                    }
                  }
                } catch (e) {
                  console.error(`Failed to read agents for ${project.path}:`, e);
                }
              }
            }
          }
        }

        return bridgeState;
      } catch {
        return { projects: [], messages: [], connected: false };
      }
    }
    return { projects: [], messages: [], connected: false };
  };

  const broadcastBridgeData = async () => {
    try {
      const data = await getBridgeData();
      const payload = JSON.stringify(data);

      // Guard against empty/invalid payloads
      if (!payload || payload.length === 0) {
        console.warn('[dashboard] Skipping bridge broadcast - empty payload');
        return;
      }

      wssBridge.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          try {
            client.send(payload);
          } catch (err) {
            console.error('[dashboard] Failed to send to bridge client:', err);
          }
        }
      });
    } catch (err) {
      console.error('[dashboard] Failed to broadcast bridge data:', err);
    }
  };

  // Handle new WebSocket connections - send initial data immediately
  wss.on('connection', async (ws, req) => {
    console.log('[dashboard] WebSocket client connected from:', req.socket.remoteAddress);

    // Mark as initializing to prevent broadcastData from sending before we do
    initializingClients.add(ws);

    try {
      const data = await getAllData();
      const payload = JSON.stringify(data);

      // Guard against empty/invalid payloads
      if (!payload || payload.length === 0) {
        console.warn('[dashboard] Skipping initial send - empty payload');
        return;
      }

      if (ws.readyState === WebSocket.OPEN) {
        console.log('[dashboard] Sending initial data, size:', payload.length, 'first 200 chars:', payload.substring(0, 200));
        ws.send(payload);
        console.log('[dashboard] Initial data sent successfully');
      } else {
        console.warn('[dashboard] WebSocket not open, state:', ws.readyState);
      }
    } catch (err) {
      console.error('[dashboard] Failed to send initial data:', err);
    } finally {
      // Now allow broadcastData to send to this client
      initializingClients.delete(ws);
    }

    ws.on('error', (err) => {
      console.error('[dashboard] WebSocket client error:', err);
    });

    ws.on('close', (code, reason) => {
      console.log('[dashboard] WebSocket client disconnected, code:', code, 'reason:', reason?.toString() || 'none');
    });
  });

  // Handle bridge WebSocket connections
  wssBridge.on('connection', async (ws) => {
    console.log('[dashboard] Bridge WebSocket client connected');

    try {
      const data = await getBridgeData();
      const payload = JSON.stringify(data);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    } catch (err) {
      console.error('[dashboard] Failed to send initial bridge data:', err);
    }

    ws.on('error', (err) => {
      console.error('[dashboard] Bridge WebSocket client error:', err);
    });

    ws.on('close', (code, reason) => {
      console.log('[dashboard] Bridge WebSocket client disconnected, code:', code, 'reason:', reason?.toString() || 'none');
    });
  });

  app.get('/api/data', (req, res) => {
    getAllData().then((data) => res.json(data)).catch((err) => {
      console.error('Failed to fetch dashboard data', err);
      res.status(500).json({ error: 'Failed to load data' });
    });
  });

  // ===== Metrics API =====

  /**
   * GET /api/metrics - JSON format metrics for dashboard
   */
  app.get('/api/metrics', async (req, res) => {
    try {
      // Read agent registry for message counts
      const agentsPath = path.join(teamDir, 'agents.json');
      let agentRecords: Array<{
        name: string;
        messagesSent: number;
        messagesReceived: number;
        firstSeen: string;
        lastSeen: string;
      }> = [];

      if (fs.existsSync(agentsPath)) {
        const data = JSON.parse(fs.readFileSync(agentsPath, 'utf-8'));
        agentRecords = (data.agents || []).map((a: any) => ({
          name: a.name,
          messagesSent: a.messagesSent ?? 0,
          messagesReceived: a.messagesReceived ?? 0,
          firstSeen: a.firstSeen ?? new Date().toISOString(),
          lastSeen: a.lastSeen ?? new Date().toISOString(),
        }));
      }

      // Get messages for throughput calculation
      const team = getTeamData();
      const messages = team ? await getMessages(team.agents) : [];

      // Get session data for lifecycle metrics
      const sessions = storage?.getSessions
        ? await storage.getSessions({ limit: 100 })
        : [];

      const metrics = computeSystemMetrics(agentRecords, messages, sessions);
      res.json(metrics);
    } catch (err) {
      console.error('Failed to compute metrics', err);
      res.status(500).json({ error: 'Failed to compute metrics' });
    }
  });

  /**
   * GET /api/metrics/prometheus - Prometheus exposition format
   */
  app.get('/api/metrics/prometheus', async (req, res) => {
    try {
      // Read agent registry for message counts
      const agentsPath = path.join(teamDir, 'agents.json');
      let agentRecords: Array<{
        name: string;
        messagesSent: number;
        messagesReceived: number;
        firstSeen: string;
        lastSeen: string;
      }> = [];

      if (fs.existsSync(agentsPath)) {
        const data = JSON.parse(fs.readFileSync(agentsPath, 'utf-8'));
        agentRecords = (data.agents || []).map((a: any) => ({
          name: a.name,
          messagesSent: a.messagesSent ?? 0,
          messagesReceived: a.messagesReceived ?? 0,
          firstSeen: a.firstSeen ?? new Date().toISOString(),
          lastSeen: a.lastSeen ?? new Date().toISOString(),
        }));
      }

      // Get messages for throughput calculation
      const team = getTeamData();
      const messages = team ? await getMessages(team.agents) : [];

      // Get session data for lifecycle metrics
      const sessions = storage?.getSessions
        ? await storage.getSessions({ limit: 100 })
        : [];

      const metrics = computeSystemMetrics(agentRecords, messages, sessions);
      const prometheusOutput = formatPrometheusMetrics(metrics);

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send(prometheusOutput);
    } catch (err) {
      console.error('Failed to compute Prometheus metrics', err);
      res.status(500).send('# Error computing metrics\n');
    }
  });

  // Bridge API endpoint - returns multi-project data
  // This is a placeholder that returns empty data when not in bridge mode
  // The actual bridge data comes from MultiProjectClient when running `agent-relay bridge`
  app.get('/api/bridge', async (req, res) => {
    try {
      // Check if bridge state file exists (written by bridge command)
      const bridgeStatePath = path.join(dataDir, 'bridge-state.json');
      if (fs.existsSync(bridgeStatePath)) {
        const bridgeData = JSON.parse(fs.readFileSync(bridgeStatePath, 'utf-8'));
        res.json(bridgeData);
      } else {
        // No bridge running - return empty state
        res.json({
          projects: [],
          messages: [],
          connected: false,
        });
      }
    } catch (err) {
      console.error('Failed to fetch bridge data', err);
      res.status(500).json({ error: 'Failed to load bridge data' });
    }
  });

  // ===== Agent Spawn API =====

  /**
   * POST /api/spawn - Spawn a new agent
   * Body: { name: string, cli?: string, task?: string }
   */
  app.post('/api/spawn', async (req, res) => {
    if (!spawner) {
      return res.status(503).json({
        success: false,
        error: 'Spawner not enabled. Start dashboard with enableSpawner: true',
      });
    }

    const { name, cli = 'claude', task = '' } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: name',
      });
    }

    try {
      const request: SpawnRequest = {
        name,
        cli,
        task,
        requestedBy: 'api',
      };
      const result = await spawner.spawn(request);

      if (result.success) {
        // Broadcast update to WebSocket clients
        broadcastData().catch(() => {});
      }

      res.json(result);
    } catch (err: any) {
      console.error('[api] Spawn error:', err);
      res.status(500).json({
        success: false,
        name,
        error: err.message,
      });
    }
  });

  /**
   * GET /api/spawned - List active spawned agents
   */
  app.get('/api/spawned', (req, res) => {
    if (!spawner) {
      return res.status(503).json({
        success: false,
        error: 'Spawner not enabled',
        agents: [],
      });
    }

    const agents = spawner.getActiveWorkers();
    res.json({
      success: true,
      agents,
    });
  });

  /**
   * DELETE /api/spawned/:name - Release a spawned agent
   */
  app.delete('/api/spawned/:name', async (req, res) => {
    if (!spawner) {
      return res.status(503).json({
        success: false,
        error: 'Spawner not enabled',
      });
    }

    const { name } = req.params;

    try {
      const released = await spawner.release(name);

      if (released) {
        broadcastData().catch(() => {});
      }

      res.json({
        success: released,
        name,
        error: released ? undefined : `Agent ${name} not found`,
      });
    } catch (err: any) {
      console.error('[api] Release error:', err);
      res.status(500).json({
        success: false,
        name,
        error: err.message,
      });
    }
  });

  // Watch for changes
  if (storage) {
    setInterval(() => {
      broadcastData().catch((err) => console.error('Broadcast failed', err));
      broadcastBridgeData().catch((err) => console.error('Bridge broadcast failed', err));
    }, 1000);
  } else {
    let fsWait: NodeJS.Timeout | null = null;
    let bridgeFsWait: NodeJS.Timeout | null = null;
    try {
      if (fs.existsSync(dataDir)) {
          console.log(`Watching ${dataDir} for changes...`);
          fs.watch(dataDir, { recursive: true }, (eventType, filename) => {
              if (filename && (filename.endsWith('inbox.md') || filename.endsWith('team.json') || filename.endsWith('agents.json'))) {
                  // Debounce
                  if (fsWait) return;
                  fsWait = setTimeout(() => {
                      fsWait = null;
                      broadcastData();
                  }, 100);
              }
              // Watch for bridge state changes
              if (filename && filename.endsWith('bridge-state.json')) {
                  if (bridgeFsWait) return;
                  bridgeFsWait = setTimeout(() => {
                      bridgeFsWait = null;
                      broadcastBridgeData();
                  }, 100);
              }
          });
      } else {
          console.warn(`Data directory ${dataDir} does not exist yet.`);
      }
    } catch (e) {
      console.error('Watch failed:', e);
    }
  }

  // Try to find an available port, starting from the requested port
  const findAvailablePort = async (startPort: number, maxAttempts = 10): Promise<number> => {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const portToTry = startPort + attempt;
      const isAvailable = await new Promise<boolean>((resolve) => {
        const testServer = http.createServer();
        testServer.once('error', () => resolve(false));
        testServer.once('listening', () => {
          testServer.close();
          resolve(true);
        });
        testServer.listen(portToTry);
      });

      if (isAvailable) {
        return portToTry;
      }
      console.log(`Port ${portToTry} in use, trying ${portToTry + 1}...`);
    }
    throw new Error(`Could not find available port after trying ${startPort}-${startPort + maxAttempts - 1}`);
  };

  const availablePort = await findAvailablePort(port);
  if (availablePort !== port) {
    console.log(`Requested dashboard port ${port} is busy; switching to ${availablePort}.`);
  }

  return new Promise((resolve, reject) => {
    server.listen(availablePort, () => {
      console.log(`Dashboard running at http://localhost:${availablePort}`);
      console.log(`Monitoring: ${dataDir}`);

      // Set the dashboard port on spawner so spawned agents can use the API for nested spawns
      if (spawner) {
        spawner.setDashboardPort(availablePort);
      }

      resolve(availablePort);
    });

    server.on('error', (err) => {
      console.error('Server error:', err);
      reject(err);
    });
  });
}
