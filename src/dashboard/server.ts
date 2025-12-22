import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { SqliteStorageAdapter } from '../storage/sqlite-adapter.js';
import type { StorageAdapter, StoredMessage } from '../storage/adapter.js';
import { RelayClient } from '../wrapper/client.js';

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
}

interface Message {
  from: string;
  to: string;
  content: string;
  timestamp: string;
  id: string; // unique-ish id
  thread?: string;
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

export async function startDashboard(port: number, dataDir: string, teamDir: string, dbPath?: string): Promise<number> {
  console.log('Starting dashboard...');
  console.log('__dirname:', __dirname);
  const publicDir = path.join(__dirname, 'public');
  console.log('Public dir:', publicDir);
  const storage: StorageAdapter | undefined = dbPath
    ? new SqliteStorageAdapter({ dbPath })
    : undefined;

  process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  });

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  if (storage) {
    await storage.init();
  }

  // Serve static files from public directory
  app.use(express.static(publicDir));
  app.use(express.json());

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

  // API endpoint to send messages
  app.post('/api/send', async (req, res) => {
    const { to, message } = req.body;

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
      const sent = relayClient.sendMessage(to, message);
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
    }));

  const getMessages = async (agents: any[]): Promise<Message[]> => {
    if (storage) {
      const rows = await storage.getMessages({ limit: 500, order: 'desc' });
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
    allMessages.forEach(m => {
      const agent = agentsMap.get(m.from);
      if (agent) {
        agent.lastActive = m.timestamp;
        agent.lastSeen = m.timestamp;
        if (m.content.startsWith('STATUS:')) {
          agent.status = m.content.substring(7).trim(); // remove "STATUS:"
        }
      }
    });

    // Fetch sessions and summaries in parallel
    const [sessions, summaries] = await Promise.all([
      getRecentSessions(),
      getAgentSummaries(),
    ]);

    return {
      agents: Array.from(agentsMap.values()),
      messages: allMessages,
      activity: allMessages, // For now, activity log is just the message log
      sessions,
      summaries,
    };
  };

  const broadcastData = async () => {
    const data = await getAllData();
    const payload = JSON.stringify(data);
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    });
  };

  app.get('/api/data', (req, res) => {
    getAllData().then((data) => res.json(data)).catch((err) => {
      console.error('Failed to fetch dashboard data', err);
      res.status(500).json({ error: 'Failed to load data' });
    });
  });

  // Watch for changes
  if (storage) {
    setInterval(() => {
      broadcastData().catch((err) => console.error('Broadcast failed', err));
    }, 1000);
  } else {
    let fsWait: NodeJS.Timeout | null = null;
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
      resolve(availablePort);
    });

    server.on('error', (err) => {
      console.error('Server error:', err);
      reject(err);
    });
  });
}
