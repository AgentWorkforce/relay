import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { SqliteStorageAdapter } from '../storage/sqlite-adapter.js';
import type { StorageAdapter, StoredMessage } from '../storage/adapter.js';
import { RelayClient } from '../wrapper/client.js';
import { computeNeedsAttention } from './needs-attention.js';
import { computeSystemMetrics, formatPrometheusMetrics } from './metrics.js';
import { MultiProjectClient } from '../bridge/multi-project-client.js';
import { AgentSpawner, type CloudPersistenceHandler } from '../bridge/spawner.js';
import type { ProjectConfig, SpawnRequest } from '../bridge/types.js';
import { listTrajectorySteps, getTrajectoryStatus, getTrajectoryHistory } from '../trajectory/integration.js';
import { loadTeamsConfig } from '../bridge/teams-config.js';
import { getMemoryMonitor } from '../resiliency/memory-monitor.js';

/**
 * Initialize cloud persistence for session tracking.
 *
 * Activation modes:
 * 1. Local dev: Set RELAY_CLOUD_ENABLED=true and DATABASE_URL
 * 2. Cloud deployment: Plan-based - user must have Pro+ subscription
 *    (enforced at cloud API level when linking daemon or enabling workspace)
 *
 * Session persistence (Pro+ feature) enables:
 * - [[SUMMARY]] blocks saved to PostgreSQL
 * - [[SESSION_END]] markers for session tracking
 * - Session recovery and agent handoff
 *
 * @see canUseSessionPersistence in services/planLimits.ts
 */
async function initCloudPersistence(workspaceId: string): Promise<CloudPersistenceHandler | null> {
  // Local dev mode: simple env var check
  // Cloud mode: plan check happens at API level (daemon linking, workspace config)
  if (process.env.RELAY_CLOUD_ENABLED !== 'true') {
    return null;
  }

  try {
    // Dynamic import to avoid loading cloud dependencies unless enabled
    const { getDb } = await import('../cloud/db/drizzle.js');
    const { agentSessions, agentSummaries } = await import('../cloud/db/schema.js');
    const { eq } = await import('drizzle-orm');

    const db = getDb();
    console.log('[dashboard] Cloud persistence enabled');

    // Track active sessions per agent with timestamps for TTL cleanup
    const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
    const MAX_SESSIONS = 10000;
    const agentSessionIds = new Map<string, { id: string; lastActivity: number }>();
    // Track pending session creation to prevent race conditions
    const pendingSessionCreation = new Map<string, Promise<string>>();

    // Periodic cleanup of stale sessions (every 5 minutes)
    const cleanupInterval = setInterval(() => {
      const now = Date.now();
      let evicted = 0;
      for (const [name, { lastActivity }] of agentSessionIds.entries()) {
        if (now - lastActivity > SESSION_TTL_MS) {
          agentSessionIds.delete(name);
          evicted++;
        }
      }
      if (evicted > 0) {
        console.log(`[cloud] Evicted ${evicted} stale session entries`);
      }
    }, 5 * 60 * 1000);

    // Don't keep process alive just for cleanup
    cleanupInterval.unref();

    // Helper to get or create session with race protection
    const getOrCreateSession = async (agentName: string): Promise<string> => {
      // Check cache first
      const cached = agentSessionIds.get(agentName);
      if (cached) {
        return cached.id;
      }

      // Check if creation is already in progress
      const pending = pendingSessionCreation.get(agentName);
      if (pending) {
        return pending;
      }

      // Create session with mutex
      const creationPromise = (async () => {
        try {
          // Double-check cache after acquiring "lock"
          const rechecked = agentSessionIds.get(agentName);
          if (rechecked) {
            return rechecked.id;
          }

          // Enforce max size - evict oldest if needed
          if (agentSessionIds.size >= MAX_SESSIONS) {
            let oldest: { name: string; time: number } | null = null;
            for (const [name, { lastActivity }] of agentSessionIds.entries()) {
              if (!oldest || lastActivity < oldest.time) {
                oldest = { name, time: lastActivity };
              }
            }
            if (oldest) {
              agentSessionIds.delete(oldest.name);
              console.log(`[cloud] Evicted oldest session for ${oldest.name} (max sessions reached)`);
            }
          }

          // Create a new session with null safety
          const result = await db.insert(agentSessions).values({
            workspaceId,
            agentName,
            status: 'active',
            startedAt: new Date(),
          }).returning();

          const session = result[0];
          if (!session) {
            throw new Error(`Failed to create session for agent ${agentName}`);
          }

          // Update cache
          agentSessionIds.set(agentName, { id: session.id, lastActivity: Date.now() });
          return session.id;
        } finally {
          pendingSessionCreation.delete(agentName);
        }
      })();

      pendingSessionCreation.set(agentName, creationPromise);
      return creationPromise;
    }

    return {
      onSummary: async (agentName, event) => {
        try {
          // Get or create session with race protection
          const sessionId = await getOrCreateSession(agentName);

          // Update activity timestamp
          agentSessionIds.set(agentName, { id: sessionId, lastActivity: Date.now() });

          // Insert summary
          await db.insert(agentSummaries).values({
            sessionId,
            agentName,
            summary: event.summary,
            createdAt: new Date(),
          });

          console.log(`[cloud] Saved summary for ${agentName}: ${event.summary.currentTask || 'no task'}`);
        } catch (err) {
          console.error(`[cloud] Failed to save summary for ${agentName}:`, err);
        }
      },

      onSessionEnd: async (agentName, event) => {
        try {
          const cached = agentSessionIds.get(agentName);
          if (cached) {
            // Update session as ended
            await db.update(agentSessions)
              .set({
                status: 'ended',
                endedAt: new Date(),
                endMarker: event.marker,
              })
              .where(eq(agentSessions.id, cached.id));

            agentSessionIds.delete(agentName);
            console.log(`[cloud] Session ended for ${agentName}: ${event.marker.summary || 'no summary'}`);
          }
        } catch (err) {
          console.error(`[cloud] Failed to end session for ${agentName}:`, err);
        }
      },

      destroy: () => {
        clearInterval(cleanupInterval);
        agentSessionIds.clear();
        pendingSessionCreation.clear();
        console.log('[cloud] Cloud persistence handler destroyed');
      },
    };
  } catch (err) {
    console.warn('[dashboard] Cloud persistence not available:', err);
    return null;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== File Search Helper =====

interface FileSearchResult {
  path: string;
  name: string;
  isDirectory: boolean;
}

/**
 * Search for files in a directory matching a query pattern.
 * Uses a simple recursive search with common ignore patterns.
 */
async function searchFiles(
  rootDir: string,
  query: string,
  limit: number
): Promise<FileSearchResult[]> {
  const results: FileSearchResult[] = [];
  const queryLower = query.toLowerCase();

  // Directories to ignore
  const ignoreDirs = new Set([
    'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
    '__pycache__', '.venv', 'venv', '.cache', '.turbo', '.vercel',
    '.nuxt', '.output', 'vendor', 'target', '.idea', '.vscode'
  ]);

  // File patterns to ignore
  const ignorePatterns = [
    /\.lock$/,
    /\.log$/,
    /\.min\.(js|css)$/,
    /\.map$/,
    /\.d\.ts$/,
    /\.pyc$/,
  ];

  const shouldIgnore = (name: string, isDir: boolean): boolean => {
    if (isDir) return ignoreDirs.has(name);
    return ignorePatterns.some(pattern => pattern.test(name));
  };

  const matchesQuery = (filePath: string, fileName: string): boolean => {
    if (!query) return true;
    const pathLower = filePath.toLowerCase();
    const nameLower = fileName.toLowerCase();

    // If query contains '/', match against full path
    if (queryLower.includes('/')) {
      return pathLower.includes(queryLower);
    }

    // Otherwise match against file name or path segments
    return nameLower.includes(queryLower) || pathLower.includes(queryLower);
  };

  const searchDir = async (dir: string, relativePath: string = ''): Promise<void> => {
    if (results.length >= limit) return;

    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });

      // Sort: directories first, then alphabetically
      entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) {
          return a.isDirectory() ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

      for (const entry of entries) {
        if (results.length >= limit) break;

        const entryPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        const fullPath = path.join(dir, entry.name);

        if (shouldIgnore(entry.name, entry.isDirectory())) continue;

        if (matchesQuery(entryPath, entry.name)) {
          results.push({
            path: entryPath,
            name: entry.name,
            isDirectory: entry.isDirectory(),
          });
        }

        // Recurse into directories
        if (entry.isDirectory() && results.length < limit) {
          await searchDir(fullPath, entryPath);
        }
      }
    } catch (err) {
      // Ignore permission errors, etc.
      console.warn(`[searchFiles] Error reading ${dir}:`, err);
    }
  };

  await searchDir(rootDir);
  return results;
}

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
  isSpawned?: boolean;
  team?: string;
}

interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  url: string;
  /** Absolute file path for agents to read the file directly */
  filePath?: string;
  width?: number;
  height?: number;
  data?: string;
}

interface Message {
  from: string;
  to: string;
  content: string;
  timestamp: string;
  id: string; // unique-ish id
  thread?: string;
  isBroadcast?: boolean;
  status?: string;
  attachments?: Attachment[];
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

  // Initialize cloud persistence and memory monitoring if enabled (RELAY_CLOUD_ENABLED=true)
  if (spawner) {
    // Use workspace ID from env or generate from project root
    const workspaceId = process.env.RELAY_WORKSPACE_ID ||
      crypto.createHash('sha256').update(projectRoot || dataDir).digest('hex').slice(0, 36);

    initCloudPersistence(workspaceId).then((cloudHandler) => {
      if (cloudHandler) {
        spawner.setCloudPersistence(cloudHandler);
      }
    }).catch((err) => {
      console.warn('[dashboard] Failed to initialize cloud persistence:', err);
    });

    // Initialize memory monitoring for cloud deployments
    // Memory monitoring is enabled by default when cloud is enabled
    if (process.env.RELAY_CLOUD_ENABLED === 'true' || process.env.RELAY_MEMORY_MONITORING === 'true') {
      try {
        const memoryMonitor = getMemoryMonitor({
          checkIntervalMs: 10000, // Check every 10 seconds
          enableTrendAnalysis: true,
          enableProactiveAlerts: true,
        });
        memoryMonitor.start();
        console.log('[dashboard] Memory monitoring enabled');

        // Register existing workers with memory monitor
        const workers = spawner.getActiveWorkers();
        for (const worker of workers) {
          if (worker.pid) {
            memoryMonitor.register(worker.name, worker.pid);
          }
        }
      } catch (err) {
        console.warn('[dashboard] Failed to initialize memory monitoring:', err);
      }
    }
  }

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
  const wssLogs = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    skipUTF8Validation: true,
    maxPayload: 100 * 1024 * 1024
  });
  const wssPresence = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    skipUTF8Validation: true,
    maxPayload: 1024 * 1024 // 1MB - presence messages are small
  });

  // Track log subscriptions: agentName -> Set of WebSocket clients
  const logSubscriptions = new Map<string, Set<WebSocket>>();

  // Track online users for presence with multi-tab support
  // username -> { connections: Set<WebSocket>, userInfo }
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

  // Validation helpers for presence
  const isValidUsername = (username: unknown): username is string => {
    if (typeof username !== 'string') return false;
    // Username should be 1-39 chars, alphanumeric with hyphens (GitHub username rules)
    return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(username);
  };

  const isValidAvatarUrl = (url: unknown): url is string | undefined => {
    if (url === undefined || url === null) return true;
    if (typeof url !== 'string') return false;
    // Must be a valid HTTPS URL from GitHub or similar known providers
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
    } else if (pathname === '/ws/logs' || pathname.startsWith('/ws/logs/')) {
      wssLogs.handleUpgrade(request, socket, head, (ws) => {
        wssLogs.emit('connection', ws, request);
      });
    } else if (pathname === '/ws/presence') {
      wssPresence.handleUpgrade(request, socket, head, (ws) => {
        wssPresence.emit('connection', ws, request);
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

  wssLogs.on('error', (err) => {
    console.error('[dashboard] Logs WebSocket server error:', err);
  });

  wssPresence.on('error', (err) => {
    console.error('[dashboard] Presence WebSocket server error:', err);
  });

  if (storage) {
    await storage.init();
  }

  // Increase JSON body limit for base64 image uploads (10MB)
  app.use(express.json({ limit: '10mb' }));

  // Create attachments directory in user's home directory (~/.relay/attachments)
  // This keeps attachments out of source control while still accessible to agents
  const attachmentsDir = path.join(os.homedir(), '.relay', 'attachments');
  if (!fs.existsSync(attachmentsDir)) {
    fs.mkdirSync(attachmentsDir, { recursive: true });
  }

  // Also keep uploads dir for backwards compatibility (URL-based serving)
  const uploadsDir = path.join(dataDir, 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  // Auto-evict old attachments (older than 7 days)
  const ATTACHMENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  const evictOldAttachments = async () => {
    try {
      const files = await fs.promises.readdir(attachmentsDir);
      const now = Date.now();
      let evictedCount = 0;

      for (const file of files) {
        const filePath = path.join(attachmentsDir, file);
        try {
          const stat = await fs.promises.stat(filePath);
          if (stat.isFile() && (now - stat.mtimeMs) > ATTACHMENT_MAX_AGE_MS) {
            await fs.promises.unlink(filePath);
            evictedCount++;
          }
        } catch (_err) {
          // Ignore errors for individual files (may have been deleted)
        }
      }

      if (evictedCount > 0) {
        console.log(`[dashboard] Evicted ${evictedCount} old attachment(s)`);
      }
    } catch (err) {
      console.error('[dashboard] Failed to evict old attachments:', err);
    }
  };

  // Run eviction on startup and every hour
  evictOldAttachments();
  const evictionInterval = setInterval(evictOldAttachments, 60 * 60 * 1000); // 1 hour

  // Clean up interval on process exit
  process.on('beforeExit', () => {
    clearInterval(evictionInterval);
  });

  // Serve uploaded files statically
  app.use('/uploads', express.static(uploadsDir));
  // Serve attachments from ~/.relay/attachments
  app.use('/attachments', express.static(attachmentsDir));

  // In-memory attachment registry (for current session)
  // Attachments are also stored on disk, so this is just for quick lookups
  const attachmentRegistry = new Map<string, Attachment>();

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

  // Relay clients for sending messages from dashboard
  // Map of senderName -> RelayClient for per-user connections
  const socketPath = path.join(dataDir, 'relay.sock');
  const relayClients = new Map<string, RelayClient>();
  // Track pending client connections to prevent race conditions
  const pendingConnections = new Map<string, Promise<RelayClient | undefined>>();

  // Get or create a relay client for a specific sender
  const getRelayClient = async (senderName: string = 'Dashboard'): Promise<RelayClient | undefined> => {
    // Check if we already have a connected client for this sender
    const existing = relayClients.get(senderName);
    if (existing && existing.state === 'READY') {
      return existing;
    }

    // Check if there's already a pending connection for this sender
    const pending = pendingConnections.get(senderName);
    if (pending) {
      return pending;
    }

    // Only attempt connection if socket exists (daemon is running)
    if (!fs.existsSync(socketPath)) {
      console.log('[dashboard] Relay socket not found, messaging disabled');
      return undefined;
    }

    // Create connection promise to prevent race conditions
    const connectionPromise = (async (): Promise<RelayClient | undefined> => {
      // Create new client for this sender
      const client = new RelayClient({
        socketPath,
        agentName: senderName,
        cli: 'dashboard',
        reconnect: true,
        maxReconnectAttempts: 5,
      });

      client.onError = (err) => {
        console.error(`[dashboard] Relay client error for ${senderName}:`, err.message);
      };

      client.onStateChange = (state) => {
        console.log(`[dashboard] Relay client for ${senderName} state: ${state}`);
        // Clean up disconnected clients
        if (state === 'DISCONNECTED') {
          relayClients.delete(senderName);
        }
      };

      try {
        await client.connect();
        relayClients.set(senderName, client);
        console.log(`[dashboard] Connected to relay daemon as ${senderName}`);
        return client;
      } catch (err) {
        console.error(`[dashboard] Failed to connect to relay daemon as ${senderName}:`, err);
        return undefined;
      } finally {
        // Clean up pending connection
        pendingConnections.delete(senderName);
      }
    })();

    // Store the pending connection
    pendingConnections.set(senderName, connectionPromise);
    return connectionPromise;
  };

  // Start default relay client connection (non-blocking)
  getRelayClient('Dashboard').catch(() => {});

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

  // Helper to check if an agent is online (seen within heartbeat timeout window)
  // Uses 30 second threshold to align with heartbeat timeout (5s * 6 multiplier)
  const isAgentOnline = (agentName: string): boolean => {
    if (agentName === '*') return true; // Broadcast always allowed

    const agentsPath = path.join(teamDir, 'agents.json');
    if (!fs.existsSync(agentsPath)) return false;

    try {
      const data = JSON.parse(fs.readFileSync(agentsPath, 'utf-8'));
      const agent = data.agents?.find((a: { name: string }) => a.name === agentName);
      if (!agent || !agent.lastSeen) return false;

      const thirtySecondsAgo = Date.now() - 30 * 1000;
      return new Date(agent.lastSeen).getTime() > thirtySecondsAgo;
    } catch {
      return false;
    }
  };

  // Helper to get team members from teams.json, agents.json, and spawner's active workers
  const getTeamMembers = (teamName: string): string[] => {
    const members = new Set<string>();

    // Check teams.json first - this is the source of truth for team definitions
    const teamsConfig = loadTeamsConfig(projectRoot || dataDir);
    if (teamsConfig && teamsConfig.team === teamName) {
      for (const agent of teamsConfig.agents) {
        members.add(agent.name);
      }
    }

    // Check spawner's active workers (they have accurate team info for spawned agents)
    if (spawner) {
      const activeWorkers = spawner.getActiveWorkers();
      for (const worker of activeWorkers) {
        if (worker.team === teamName) {
          members.add(worker.name);
        }
      }
    }

    // Also check agents.json for persisted team info
    const agentsPath = path.join(teamDir, 'agents.json');
    if (fs.existsSync(agentsPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(agentsPath, 'utf-8'));
        for (const agent of (data.agents || [])) {
          if (agent.team === teamName) {
            members.add(agent.name);
          }
        }
      } catch {
        // Ignore parse errors
      }
    }

    return Array.from(members);
  };

  // API endpoint to send messages
  app.post('/api/send', async (req, res) => {
    const { to, message, thread, attachments: attachmentIds, from: senderName } = req.body;

    if (!to || !message) {
      return res.status(400).json({ error: 'Missing "to" or "message" field' });
    }

    // Check if this is a team mention (team:teamName)
    const teamMatch = to.match(/^team:(.+)$/);
    let targets: string[];

    if (teamMatch) {
      const teamName = teamMatch[1];
      const members = getTeamMembers(teamName);
      if (members.length === 0) {
        return res.status(404).json({ error: `No agents found in team "${teamName}"` });
      }
      // Filter to only online members
      targets = members.filter(isAgentOnline);
      if (targets.length === 0) {
        return res.status(404).json({ error: `No online agents in team "${teamName}"` });
      }
    } else {
      // Fail fast if target agent is offline (except broadcasts)
      if (to !== '*' && !isAgentOnline(to)) {
        return res.status(404).json({ error: `Agent "${to}" is not online` });
      }
      targets = [to];
    }

    // Get or create relay client for this sender (defaults to 'Dashboard' for non-cloud mode)
    const relayClient = await getRelayClient(senderName || 'Dashboard');
    if (!relayClient || relayClient.state !== 'READY') {
      return res.status(503).json({ error: 'Relay daemon not connected' });
    }

    try {
      // Resolve attachments if provided
      let attachments: Attachment[] | undefined;
      if (attachmentIds && Array.isArray(attachmentIds) && attachmentIds.length > 0) {
        attachments = [];
        for (const id of attachmentIds) {
          const attachment = attachmentRegistry.get(id);
          if (attachment) {
            attachments.push(attachment);
          }
        }
      }

      // Include attachments and channel context in the message data field
      // For broadcasts (to='*'), include channel: 'general' so replies can be routed back
      const isBroadcast = targets.length === 1 && targets[0] === '*';
      const messageData: Record<string, unknown> = {};

      if (attachments && attachments.length > 0) {
        messageData.attachments = attachments;
      }

      if (isBroadcast) {
        messageData.channel = 'general';
      }

      const hasMessageData = Object.keys(messageData).length > 0;

      // Send to all targets (single agent, team members, or broadcast)
      let allSent = true;
      for (const target of targets) {
        const sent = relayClient.sendMessage(target, message, 'message', hasMessageData ? messageData : undefined, thread);
        if (!sent) {
          allSent = false;
          console.error(`[dashboard] Failed to send message to ${target}`);
        }
      }

      if (allSent) {
        res.json({ success: true, sentTo: targets.length > 1 ? targets : targets[0] });
      } else {
        res.status(500).json({ error: 'Failed to send message to some recipients' });
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

  // API endpoint to upload attachments (images/screenshots)
  app.post('/api/upload', async (req, res) => {
    const { filename, mimeType, data } = req.body;

    // Validate required fields
    if (!filename || !mimeType || !data) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: filename, mimeType, data',
      });
    }

    // Validate mime type (only allow images for now)
    const allowedTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];
    if (!allowedTypes.includes(mimeType)) {
      return res.status(400).json({
        success: false,
        error: `Invalid file type. Allowed types: ${allowedTypes.join(', ')}`,
      });
    }

    try {
      // Decode base64 data
      const base64Data = data.replace(/^data:[^;]+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');

      // Generate unique ID and filename for the attachment
      const attachmentId = crypto.randomUUID();
      const timestamp = Date.now();
      const ext = mimeType.split('/')[1].replace('svg+xml', 'svg');
      // Use format: {messageId}-{timestamp}.{ext} for unique, identifiable filenames
      const safeFilename = `${attachmentId.substring(0, 8)}-${timestamp}.${ext}`;

      // Save to ~/.relay/attachments/ directory for agents to access
      const attachmentFilePath = path.join(attachmentsDir, safeFilename);
      fs.writeFileSync(attachmentFilePath, buffer);

      // Create attachment record with file path for agents
      const attachment: Attachment = {
        id: attachmentId,
        filename: filename,
        mimeType: mimeType,
        size: buffer.length,
        url: `/attachments/${safeFilename}`,
        // Include absolute file path so agents can read the file directly
        filePath: attachmentFilePath,
        // Include base64 data for agents that can't access the file
        data: data,
      };

      // Store in registry for lookup when sending messages
      attachmentRegistry.set(attachmentId, attachment);

      console.log(`[dashboard] Uploaded attachment: ${filename} (${buffer.length} bytes) -> ${attachmentFilePath}`);

      res.json({
        success: true,
        attachment: {
          id: attachment.id,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          size: attachment.size,
          url: attachment.url,
          filePath: attachment.filePath,
        },
      });
    } catch (err) {
      console.error('[dashboard] Upload failed:', err);
      res.status(500).json({
        success: false,
        error: 'Failed to upload file',
      });
    }
  });

  // API endpoint to get attachment by ID
  app.get('/api/attachment/:id', (req, res) => {
    const { id } = req.params;
    const attachment = attachmentRegistry.get(id);

    if (!attachment) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    res.json({
      success: true,
      attachment: {
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.size,
        url: attachment.url,
        filePath: attachment.filePath,
      },
    });
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
          agents: data.agents.map((a: { name: string; connectedAt?: string; cli?: string; lastSeen?: string; team?: string }) => ({
            name: a.name,
            role: 'Agent',
            cli: a.cli ?? 'Unknown',
            lastSeen: a.lastSeen ?? a.connectedAt,
            lastActive: a.lastSeen ?? a.connectedAt,
            team: a.team,
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

  // Helper to check if an agent name is internal/system (should be hidden from UI)
  // Convention: agent names starting with __ are internal (e.g., __spawner__, __DashboardBridge__)
  const isInternalAgent = (name: string): boolean => {
    return name.startsWith('__');
  };

  const mapStoredMessages = (rows: StoredMessage[]): Message[] => rows
    // Filter out messages from/to internal system agents (e.g., __spawner__)
    .filter((row) => !isInternalAgent(row.from) && !isInternalAgent(row.to))
    .map((row) => {
      // Extract attachments and channel from the data field if present
      let attachments: Attachment[] | undefined;
      let channel: string | undefined;
      if (row.data && typeof row.data === 'object') {
        if ('attachments' in row.data) {
          attachments = (row.data as { attachments: Attachment[] }).attachments;
        }
        if ('channel' in row.data) {
          channel = (row.data as { channel: string }).channel;
        }
      }

      return {
        from: row.from,
        to: row.to,
        content: row.body,
        timestamp: new Date(row.ts).toISOString(),
        id: row.id,
        thread: row.thread,
        isBroadcast: row.is_broadcast,
        replyCount: row.replyCount,
        status: row.status,
        attachments,
        channel,
      };
    });

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
        team: a.team,
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
    const processingStatePath = path.join(teamDir, 'processing-state.json');
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

    // Mark spawned agents with isSpawned flag and team
    if (spawner) {
      const activeWorkers = spawner.getActiveWorkers();
      for (const worker of activeWorkers) {
        const agent = agentsMap.get(worker.name);
        if (agent) {
          agent.isSpawned = true;
          if (worker.team) {
            agent.team = worker.team;
          }
        }
      }
    }

    // Set team from teams.json for agents that don't have a team yet
    // This ensures agents defined in teams.json are associated with their team
    // even if they weren't spawned via auto-spawn
    const teamsConfig = loadTeamsConfig(projectRoot || dataDir);
    if (teamsConfig) {
      for (const teamAgent of teamsConfig.agents) {
        const agent = agentsMap.get(teamAgent.name);
        if (agent && !agent.team) {
          agent.team = teamsConfig.team;
        }
      }
    }

    // Fetch sessions and summaries in parallel
    const [sessions, summaries] = await Promise.all([
      getRecentSessions(),
      getAgentSummaries(),
    ]);

    // Filter agents:
    // 1. Exclude "Dashboard" (internal agent, not a real team member)
    // 2. Exclude offline agents (no lastSeen or lastSeen > threshold)
    const now = Date.now();
    // 30 seconds - aligns with heartbeat timeout (5s heartbeat * 6 multiplier = 30s)
    // This ensures agents disappear quickly after they stop responding to heartbeats
    const OFFLINE_THRESHOLD_MS = 30 * 1000;
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
                    // Filter to only show online agents (seen within 30 seconds - aligns with heartbeat timeout)
                    const thirtySecondsAgo = Date.now() - 30 * 1000;
                    project.agents = agentsData.agents
                      .filter((a: { lastSeen?: string }) => {
                        if (!a.lastSeen) return false;
                        return new Date(a.lastSeen).getTime() > thirtySecondsAgo;
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

  // Track alive status for ping/pong keepalive on log connections
  const logClientAlive = new WeakMap<WebSocket, boolean>();

  // Ping interval for log WebSocket connections (30 seconds)
  // This prevents TCP/proxy timeouts from killing idle connections
  const LOG_PING_INTERVAL_MS = 30000;
  const logPingInterval = setInterval(() => {
    wssLogs.clients.forEach((ws) => {
      if (logClientAlive.get(ws) === false) {
        // Client didn't respond to last ping - close gracefully
        console.log('[dashboard] Logs WebSocket client unresponsive, closing gracefully');
        ws.close(1000, 'unresponsive');
        return;
      }
      // Mark as not alive until we get a pong
      logClientAlive.set(ws, false);
      ws.ping();
    });
  }, LOG_PING_INTERVAL_MS);

  // Clean up ping interval on server close
  wssLogs.on('close', () => {
    clearInterval(logPingInterval);
  });

  // Handle logs WebSocket connections for live log streaming
  wssLogs.on('connection', (ws, req) => {
    console.log('[dashboard] Logs WebSocket client connected');
    const clientSubscriptions = new Set<string>();

    // Mark client as alive initially
    logClientAlive.set(ws, true);

    // Handle pong responses (keep connection alive)
    ws.on('pong', () => {
      logClientAlive.set(ws, true);
    });

    // Helper to check if agent is daemon-connected (from agents.json)
    const isDaemonConnected = (agentName: string): boolean => {
      const agentsPath = path.join(teamDir, 'agents.json');
      if (!fs.existsSync(agentsPath)) return false;
      try {
        const data = JSON.parse(fs.readFileSync(agentsPath, 'utf-8'));
        return data.agents?.some((a: { name: string }) => a.name === agentName) ?? false;
      } catch {
        return false;
      }
    };

    // Helper to subscribe to an agent
    const subscribeToAgent = (agentName: string) => {
      const isSpawned = spawner?.hasWorker(agentName) ?? false;
      const isDaemon = isDaemonConnected(agentName);

      // Check if agent exists (either spawned or daemon-connected)
      if (!isSpawned && !isDaemon) {
        ws.send(JSON.stringify({
          type: 'error',
          agent: agentName,
          error: `Agent ${agentName} not found`,
        }));
        // Close with custom code 4404 to signal "agent not found" - client should not reconnect
        ws.close(4404, 'Agent not found');
        return false;
      }

      // Add to subscriptions
      clientSubscriptions.add(agentName);
      if (!logSubscriptions.has(agentName)) {
        logSubscriptions.set(agentName, new Set());
      }
      logSubscriptions.get(agentName)!.add(ws);

      console.log(`[dashboard] Client subscribed to logs for: ${agentName} (spawned: ${isSpawned}, daemon: ${isDaemon})`);

      if (isSpawned && spawner) {
        // Send initial log history for spawned agents (5000 lines to match xterm scrollback capacity)
        const lines = spawner.getWorkerOutput(agentName, 5000);
        ws.send(JSON.stringify({
          type: 'history',
          agent: agentName,
          lines: lines || [],
        }));
      } else {
        // For daemon-connected agents, explain that PTY output isn't available
        ws.send(JSON.stringify({
          type: 'history',
          agent: agentName,
          lines: [`[${agentName} is a daemon-connected agent - PTY output not available. Showing relay messages only.]`],
        }));
      }

      ws.send(JSON.stringify({
        type: 'subscribed',
        agent: agentName,
      }));

      return true;
    };

    // Check if agent name is in URL path: /ws/logs/:agentName
    const pathname = new URL(req.url || '', `http://${req.headers.host}`).pathname;
    const pathMatch = pathname.match(/^\/ws\/logs\/(.+)$/);
    if (pathMatch) {
      const agentName = decodeURIComponent(pathMatch[1]);
      subscribeToAgent(agentName);
    }

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        // Subscribe to agent logs
        if (msg.subscribe && typeof msg.subscribe === 'string') {
          subscribeToAgent(msg.subscribe);
        }

        // Unsubscribe from agent logs
        if (msg.unsubscribe && typeof msg.unsubscribe === 'string') {
          const agentName = msg.unsubscribe;
          clientSubscriptions.delete(agentName);
          logSubscriptions.get(agentName)?.delete(ws);

          console.log(`[dashboard] Client unsubscribed from logs for: ${agentName}`);

          ws.send(JSON.stringify({
            type: 'unsubscribed',
            agent: agentName,
          }));
        }
      } catch (err) {
        console.error('[dashboard] Invalid logs WebSocket message:', err);
      }
    });

    ws.on('error', (err) => {
      console.error('[dashboard] Logs WebSocket client error:', err);
    });

    ws.on('close', (code, reason) => {
      // Clean up subscriptions on disconnect
      for (const agentName of clientSubscriptions) {
        logSubscriptions.get(agentName)?.delete(ws);
      }
      const reasonStr = reason?.toString() || 'no reason';
      console.log(`[dashboard] Logs WebSocket client disconnected (code: ${code}, reason: ${reasonStr})`);
    });
  });

  // Function to broadcast log output to subscribed clients
  const broadcastLogOutput = (agentName: string, output: string) => {
    const clients = logSubscriptions.get(agentName);
    if (!clients || clients.size === 0) return;

    const payload = JSON.stringify({
      type: 'output',
      agent: agentName,
      data: output,
      timestamp: new Date().toISOString(),
    });

    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  };

  // Expose broadcastLogOutput for PTY wrappers to call
  (global as any).__broadcastLogOutput = broadcastLogOutput;

  // ===== Presence WebSocket Handler =====

  // Helper to broadcast to all presence clients
  const broadcastPresence = (message: object, exclude?: WebSocket) => {
    const payload = JSON.stringify(message);
    wssPresence.clients.forEach((client) => {
      if (client !== exclude && client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    });
  };

  // Helper to get online users list (without ws references)
  const getOnlineUsersList = (): UserPresenceInfo[] => {
    return Array.from(onlineUsers.values()).map((state) => state.info);
  };

  wssPresence.on('connection', (ws) => {
    console.log('[dashboard] Presence WebSocket client connected');
    let clientUsername: string | undefined;

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'presence') {
          if (msg.action === 'join' && msg.user?.username) {
            const username = msg.user.username;
            const avatarUrl = msg.user.avatarUrl;

            // Validate inputs
            if (!isValidUsername(username)) {
              console.warn(`[dashboard] Invalid username rejected: ${username}`);
              return;
            }
            if (!isValidAvatarUrl(avatarUrl)) {
              console.warn(`[dashboard] Invalid avatar URL rejected for user ${username}`);
              return;
            }

            clientUsername = username;
            const now = new Date().toISOString();

            // Check if user already has connections (multi-tab support)
            const existing = onlineUsers.get(username);
            if (existing) {
              // Add this connection to existing user
              existing.connections.add(ws);
              existing.info.lastSeen = now;
              console.log(`[dashboard] User ${username} opened new tab (${existing.connections.size} connections)`);
            } else {
              // New user - create presence state
              onlineUsers.set(username, {
                info: {
                  username,
                  avatarUrl,
                  connectedAt: now,
                  lastSeen: now,
                },
                connections: new Set([ws]),
              });

              console.log(`[dashboard] User ${username} came online`);

              // Broadcast join to all other clients (only for truly new users)
              broadcastPresence({
                type: 'presence_join',
                user: {
                  username,
                  avatarUrl,
                  connectedAt: now,
                  lastSeen: now,
                },
              }, ws);
            }

            // Send current online users list to the new client
            ws.send(JSON.stringify({
              type: 'presence_list',
              users: getOnlineUsersList(),
            }));

          } else if (msg.action === 'leave') {
            // Security: Only allow leaving your own username
            // Must have authenticated first
            if (!clientUsername) {
              console.warn(`[dashboard] Security: Unauthenticated leave attempt`);
              return;
            }
            if (msg.username !== clientUsername) {
              console.warn(`[dashboard] Security: User ${clientUsername} tried to remove ${msg.username}`);
              return;
            }

            // Remove this connection from the user's set
            const username = clientUsername; // Narrow type for TypeScript
            const userState = onlineUsers.get(username);
            if (userState) {
              userState.connections.delete(ws);

              // Only broadcast leave if no more connections
              if (userState.connections.size === 0) {
                onlineUsers.delete(username);
                console.log(`[dashboard] User ${username} went offline`);

                broadcastPresence({
                  type: 'presence_leave',
                  username,
                });
              } else {
                console.log(`[dashboard] User ${username} closed tab (${userState.connections.size} remaining)`);
              }
            }
          }
        } else if (msg.type === 'typing') {
          // Must have authenticated first
          if (!clientUsername) {
            console.warn(`[dashboard] Security: Unauthenticated typing attempt`);
            return;
          }
          // Validate typing message comes from authenticated user
          if (msg.username !== clientUsername) {
            console.warn(`[dashboard] Security: Typing message username mismatch`);
            return;
          }

          // Update last seen
          const username = clientUsername; // Narrow type for TypeScript
          const userState = onlineUsers.get(username);
          if (userState) {
            userState.info.lastSeen = new Date().toISOString();
          }

          // Broadcast typing indicator to all other clients
          broadcastPresence({
            type: 'typing',
            username,
            avatarUrl: userState?.info.avatarUrl,
            isTyping: msg.isTyping,
          }, ws);
        }
      } catch (err) {
        console.error('[dashboard] Invalid presence message:', err);
      }
    });

    ws.on('error', (err) => {
      console.error('[dashboard] Presence WebSocket client error:', err);
    });

    ws.on('close', () => {
      // Clean up on disconnect with multi-tab support
      if (clientUsername) {
        const userState = onlineUsers.get(clientUsername);
        if (userState) {
          userState.connections.delete(ws);

          // Only broadcast leave if no more connections
          if (userState.connections.size === 0) {
            onlineUsers.delete(clientUsername);
            console.log(`[dashboard] User ${clientUsername} disconnected`);

            broadcastPresence({
              type: 'presence_leave',
              username: clientUsername,
            });
          } else {
            console.log(`[dashboard] User ${clientUsername} closed connection (${userState.connections.size} remaining)`);
          }
        }
      }
    });
  });

  app.get('/api/data', (req, res) => {
    getAllData().then((data) => res.json(data)).catch((err) => {
      console.error('Failed to fetch dashboard data', err);
      res.status(500).json({ error: 'Failed to load data' });
    });
  });

  // ===== Health Check API =====
  /**
   * GET /health - Health check endpoint for monitoring
   * Returns 200 if the daemon is healthy
   */
  app.get('/health', async (req, res) => {
    const uptime = process.uptime();
    const memUsage = process.memoryUsage();
    const socketExists = fs.existsSync(socketPath);

    // Check relay client connectivity (check if default Dashboard client is connected)
    const defaultClient = relayClients.get('Dashboard');
    const relayConnected = defaultClient?.state === 'READY';

    // If socket doesn't exist, daemon may not be running properly
    if (!socketExists) {
      return res.status(503).json({
        status: 'unhealthy',
        reason: 'Relay socket not found',
        uptime,
        memoryMB: Math.round(memUsage.heapUsed / 1024 / 1024),
      });
    }

    res.json({
      status: 'healthy',
      uptime,
      memoryMB: Math.round(memUsage.heapUsed / 1024 / 1024),
      relayConnected,
      websocketClients: wss.clients.size,
    });
  });

  /**
   * GET /api/health - Alternative health endpoint (same as /health)
   */
  app.get('/api/health', async (req, res) => {
    const uptime = process.uptime();
    const memUsage = process.memoryUsage();
    const socketExists = fs.existsSync(socketPath);
    const defaultClient = relayClients.get('Dashboard');
    const relayConnected = defaultClient?.state === 'READY';

    if (!socketExists) {
      return res.status(503).json({
        status: 'unhealthy',
        reason: 'Relay socket not found',
        uptime,
        memoryMB: Math.round(memUsage.heapUsed / 1024 / 1024),
      });
    }

    res.json({
      status: 'healthy',
      uptime,
      memoryMB: Math.round(memUsage.heapUsed / 1024 / 1024),
      relayConnected,
      websocketClients: wss.clients.size,
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

  // ===== Agent Memory Metrics API =====

  /**
   * GET /api/metrics/agents - Detailed agent memory and resource metrics
   */
  app.get('/api/metrics/agents', async (req, res) => {
    try {
      const agents: Array<{
        name: string;
        pid?: number;
        status: string;
        rssBytes?: number;
        heapUsedBytes?: number;
        cpuPercent?: number;
        trend?: string;
        trendRatePerMinute?: number;
        alertLevel?: string;
        highWatermark?: number;
        averageRss?: number;
        uptimeMs?: number;
        startedAt?: string;
      }> = [];

      // Get metrics from spawner's active workers
      if (spawner) {
        const activeWorkers = spawner.getActiveWorkers();
        for (const worker of activeWorkers) {
          // Get memory usage via ps command
          let rssBytes = 0;
          let cpuPercent = 0;

          if (worker.pid) {
            try {
              const { execSync } = await import('child_process');
              const output = execSync(`ps -o rss=,pcpu= -p ${worker.pid}`, {
                encoding: 'utf8',
                timeout: 3000,
              }).trim();
              const parts = output.split(/\s+/);
              rssBytes = parseInt(parts[0] || '0', 10) * 1024;
              cpuPercent = parseFloat(parts[1] || '0');
            } catch {
              // Process may have exited
            }
          }

          agents.push({
            name: worker.name,
            pid: worker.pid,
            status: worker.pid ? 'running' : 'unknown',
            rssBytes,
            cpuPercent,
            trend: 'unknown',
            alertLevel: rssBytes > 1024 * 1024 * 1024 ? 'critical' :
                       rssBytes > 512 * 1024 * 1024 ? 'warning' : 'normal',
            highWatermark: rssBytes,
            uptimeMs: worker.spawnedAt ? Date.now() - worker.spawnedAt : 0,
            startedAt: worker.spawnedAt ? new Date(worker.spawnedAt).toISOString() : undefined,
          });
        }
      }

      // Also check agents.json for registered agents that may not be spawned
      const agentsPath = path.join(teamDir, 'agents.json');
      if (fs.existsSync(agentsPath)) {
        const data = JSON.parse(fs.readFileSync(agentsPath, 'utf-8'));
        const registeredAgents = data.agents || [];
        for (const agent of registeredAgents) {
          if (!agents.find(a => a.name === agent.name)) {
            // Check if recently active (within 30 seconds)
            const lastSeen = agent.lastSeen ? new Date(agent.lastSeen).getTime() : 0;
            const isActive = Date.now() - lastSeen < 30000;
            if (isActive) {
              agents.push({
                name: agent.name,
                status: 'active',
                alertLevel: 'normal',
              });
            }
          }
        }
      }

      res.json({
        agents,
        system: {
          totalMemory: os.totalmem(),
          freeMemory: os.freemem(),
          heapUsed: process.memoryUsage().heapUsed,
        },
      });
    } catch (err) {
      console.error('Failed to get agent metrics', err);
      res.status(500).json({ error: 'Failed to get agent metrics' });
    }
  });

  /**
   * GET /api/metrics/health - System health and crash insights
   */
  app.get('/api/metrics/health', async (req, res) => {
    try {
      // Calculate health score based on available data
      let healthScore = 100;
      const issues: Array<{ severity: string; message: string }> = [];
      const recommendations: string[] = [];
      const crashes: Array<{
        id: string;
        agentName: string;
        crashedAt: string;
        likelyCause: string;
        summary: string;
      }> = [];
      const alerts: Array<{
        id: string;
        agentName: string;
        alertType: string;
        message: string;
        createdAt: string;
      }> = [];

      let agentCount = 0;
      const totalCrashes24h = 0;
      let totalAlerts24h = 0;

      // Get spawned agent count
      if (spawner) {
        const workers = spawner.getActiveWorkers();
        agentCount = workers.length;

        // Check for high memory usage
        for (const worker of workers) {
          if (worker.pid) {
            try {
              const { execSync } = await import('child_process');
              const output = execSync(`ps -o rss= -p ${worker.pid}`, {
                encoding: 'utf8',
                timeout: 3000,
              }).trim();
              const rssBytes = parseInt(output, 10) * 1024;

              if (rssBytes > 1.5 * 1024 * 1024 * 1024) {
                // > 1.5GB
                healthScore -= 20;
                issues.push({
                  severity: 'critical',
                  message: `Agent "${worker.name}" is using ${Math.round(rssBytes / 1024 / 1024)}MB of memory`,
                });
                totalAlerts24h++;
                alerts.push({
                  id: `alert-${Date.now()}-${worker.name}`,
                  agentName: worker.name,
                  alertType: 'oom_imminent',
                  message: `Memory usage critical: ${Math.round(rssBytes / 1024 / 1024)}MB`,
                  createdAt: new Date().toISOString(),
                });
              } else if (rssBytes > 1024 * 1024 * 1024) {
                // > 1GB
                healthScore -= 10;
                issues.push({
                  severity: 'high',
                  message: `Agent "${worker.name}" memory usage is elevated (${Math.round(rssBytes / 1024 / 1024)}MB)`,
                });
              }
            } catch {
              // Process may have exited
            }
          }
        }
      }

      // Check registered agents
      const agentsPath = path.join(teamDir, 'agents.json');
      if (fs.existsSync(agentsPath)) {
        const data = JSON.parse(fs.readFileSync(agentsPath, 'utf-8'));
        const registeredAgents = data.agents || [];
        const activeAgents = registeredAgents.filter((a: any) => {
          const lastSeen = a.lastSeen ? new Date(a.lastSeen).getTime() : 0;
          return Date.now() - lastSeen < 30000;
        });
        agentCount = Math.max(agentCount, activeAgents.length);
      }

      // Generate recommendations based on issues
      if (issues.some(i => i.severity === 'critical')) {
        recommendations.push('Consider restarting agents with high memory usage');
        recommendations.push('Monitor system resources closely');
      }
      if (agentCount === 0) {
        recommendations.push('No active agents detected - start agents to begin monitoring');
      }

      // Clamp health score
      healthScore = Math.max(0, Math.min(100, healthScore));

      // Generate summary
      let summary: string;
      if (healthScore >= 90) {
        summary = 'System is healthy. All agents operating normally.';
      } else if (healthScore >= 70) {
        summary = 'Some issues detected. Review warnings and recommendations.';
      } else if (healthScore >= 50) {
        summary = 'Multiple issues detected. Action recommended.';
      } else {
        summary = 'Critical issues detected. Immediate action required.';
      }

      res.json({
        healthScore,
        summary,
        issues,
        recommendations,
        crashes,
        alerts,
        stats: {
          totalCrashes24h,
          totalAlerts24h,
          agentCount,
        },
      });
    } catch (err) {
      console.error('Failed to compute health metrics', err);
      res.status(500).json({ error: 'Failed to compute health metrics' });
    }
  });

  // ===== File Search API =====

  /**
   * GET /api/files - Search for files in the repository
   * Query params:
   *   - q: Search query (file path pattern)
   *   - limit: Max number of results (default 15)
   *
   * This endpoint searches for files in the project root directory
   * to support @-file autocomplete in the message composer.
   */
  app.get('/api/files', async (req, res) => {
    const query = (req.query.q as string) || '';
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 15, 50);

    // Get project root (parent of dataDir, or use projectRoot if available)
    const searchRoot = options.projectRoot || path.dirname(dataDir);

    try {
      const results = await searchFiles(searchRoot, query, limit);
      res.json({ files: results, query, searchRoot: path.basename(searchRoot) });
    } catch (err) {
      console.error('[api] File search error:', err);
      res.status(500).json({ error: 'Failed to search files', files: [] });
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

  // ===== Conversation History API =====

  /**
   * GET /api/history/sessions - List all sessions with filters
   * Query params:
   *   - agent: Filter by agent name
   *   - since: Filter sessions started after this timestamp (ms)
   *   - limit: Max number of sessions (default 50)
   */
  app.get('/api/history/sessions', async (req, res) => {
    if (!storage) {
      return res.status(503).json({ error: 'Storage not configured' });
    }

    try {
      const query: {
        agentName?: string;
        since?: number;
        limit?: number;
      } = {};

      if (req.query.agent && typeof req.query.agent === 'string') {
        query.agentName = req.query.agent;
      }
      if (req.query.since) {
        query.since = parseInt(req.query.since as string, 10);
      }
      query.limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;

      const sessions = storage.getSessions
        ? await storage.getSessions(query)
        : [];

      const result = sessions.map(s => ({
        id: s.id,
        agentName: s.agentName,
        cli: s.cli,
        startedAt: new Date(s.startedAt).toISOString(),
        endedAt: s.endedAt ? new Date(s.endedAt).toISOString() : undefined,
        duration: formatDuration(s.startedAt, s.endedAt),
        messageCount: s.messageCount,
        summary: s.summary,
        isActive: !s.endedAt,
        closedBy: s.closedBy,
      }));

      res.json({ sessions: result });
    } catch (err) {
      console.error('Failed to fetch sessions', err);
      res.status(500).json({ error: 'Failed to fetch sessions' });
    }
  });

  /**
   * GET /api/history/messages - Get messages with filters
   * Query params:
   *   - from: Filter by sender
   *   - to: Filter by recipient
   *   - thread: Filter by thread ID
   *   - since: Filter messages after this timestamp (ms)
   *   - limit: Max number of messages (default 100)
   *   - order: 'asc' or 'desc' (default 'desc')
   *   - search: Search in message body (basic substring match)
   */
  app.get('/api/history/messages', async (req, res) => {
    if (!storage) {
      return res.status(503).json({ error: 'Storage not configured' });
    }

    try {
      const query: {
        from?: string;
        to?: string;
        thread?: string;
        sinceTs?: number;
        limit?: number;
        order?: 'asc' | 'desc';
      } = {};

      if (req.query.from && typeof req.query.from === 'string') {
        query.from = req.query.from;
      }
      if (req.query.to && typeof req.query.to === 'string') {
        query.to = req.query.to;
      }
      if (req.query.thread && typeof req.query.thread === 'string') {
        query.thread = req.query.thread;
      }
      if (req.query.since) {
        query.sinceTs = parseInt(req.query.since as string, 10);
      }
      query.limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
      query.order = (req.query.order as 'asc' | 'desc') || 'desc';

      let messages = await storage.getMessages(query);

      // Filter out messages from/to internal system agents (e.g., __spawner__)
      messages = messages.filter(m => !isInternalAgent(m.from) && !isInternalAgent(m.to));

      // Client-side search filter (basic substring match)
      const searchTerm = req.query.search as string | undefined;
      if (searchTerm && searchTerm.trim()) {
        const lowerSearch = searchTerm.toLowerCase();
        messages = messages.filter(m =>
          m.body.toLowerCase().includes(lowerSearch) ||
          m.from.toLowerCase().includes(lowerSearch) ||
          m.to.toLowerCase().includes(lowerSearch)
        );
      }

      const result = messages.map(m => ({
        id: m.id,
        from: m.from,
        to: m.to,
        content: m.body,
        timestamp: new Date(m.ts).toISOString(),
        thread: m.thread,
        isBroadcast: m.is_broadcast,
        isUrgent: m.is_urgent,
        status: m.status,
      }));

      res.json({ messages: result });
    } catch (err) {
      console.error('Failed to fetch messages', err);
      res.status(500).json({ error: 'Failed to fetch messages' });
    }
  });

  /**
   * GET /api/history/conversations - Get unique conversations (agent pairs)
   * Returns list of agent pairs that have exchanged messages
   */
  app.get('/api/history/conversations', async (req, res) => {
    if (!storage) {
      return res.status(503).json({ error: 'Storage not configured' });
    }

    try {
      // Get all messages to build conversation list
      const messages = await storage.getMessages({ limit: 1000, order: 'desc' });

      // Build unique conversation pairs
      const conversationMap = new Map<string, {
        participants: string[];
        lastMessage: string;
        lastTimestamp: string;
        messageCount: number;
      }>();

      for (const msg of messages) {
        // Skip broadcasts for conversation pairing
        if (msg.to === '*' || msg.is_broadcast) continue;

        // Skip messages from/to internal system agents (e.g., __spawner__)
        if (isInternalAgent(msg.from) || isInternalAgent(msg.to)) continue;

        // Create normalized key (sorted participants)
        const participants = [msg.from, msg.to].sort();
        const key = participants.join(':');

        const existing = conversationMap.get(key);
        if (existing) {
          existing.messageCount++;
        } else {
          conversationMap.set(key, {
            participants,
            lastMessage: msg.body.substring(0, 100),
            lastTimestamp: new Date(msg.ts).toISOString(),
            messageCount: 1,
          });
        }
      }

      // Convert to array sorted by last timestamp
      const conversations = Array.from(conversationMap.values())
        .sort((a, b) => new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime());

      res.json({ conversations });
    } catch (err) {
      console.error('Failed to fetch conversations', err);
      res.status(500).json({ error: 'Failed to fetch conversations' });
    }
  });

  /**
   * GET /api/history/message/:id - Get a single message by ID
   */
  app.get('/api/history/message/:id', async (req, res) => {
    if (!storage) {
      return res.status(503).json({ error: 'Storage not configured' });
    }

    try {
      const { id } = req.params;
      const message = storage.getMessageById
        ? await storage.getMessageById(id)
        : null;

      if (!message) {
        return res.status(404).json({ error: 'Message not found' });
      }

      res.json({
        id: message.id,
        from: message.from,
        to: message.to,
        content: message.body,
        timestamp: new Date(message.ts).toISOString(),
        thread: message.thread,
        isBroadcast: message.is_broadcast,
        isUrgent: message.is_urgent,
        status: message.status,
        data: message.data,
      });
    } catch (err) {
      console.error('Failed to fetch message', err);
      res.status(500).json({ error: 'Failed to fetch message' });
    }
  });

  /**
   * GET /api/history/stats - Get storage statistics
   */
  app.get('/api/history/stats', async (req, res) => {
    if (!storage) {
      return res.status(503).json({ error: 'Storage not configured' });
    }

    try {
      // Get stats from SQLite adapter if available
      if (storage instanceof SqliteStorageAdapter) {
        const stats = await storage.getStats();
        const sessions = await storage.getSessions({ limit: 1000 });

        // Calculate additional stats
        const activeSessions = sessions.filter(s => !s.endedAt).length;
        const uniqueAgents = new Set(sessions.map(s => s.agentName)).size;

        res.json({
          messageCount: stats.messageCount,
          sessionCount: stats.sessionCount,
          activeSessions,
          uniqueAgents,
          oldestMessageDate: stats.oldestMessageTs
            ? new Date(stats.oldestMessageTs).toISOString()
            : null,
        });
      } else {
        // Basic stats for other adapters
        const messages = await storage.getMessages({ limit: 1 });
        res.json({
          messageCount: messages.length > 0 ? 'unknown' : 0,
          sessionCount: 'unknown',
          activeSessions: 'unknown',
          uniqueAgents: 'unknown',
        });
      }
    } catch (err) {
      console.error('Failed to fetch stats', err);
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  });

  // ===== Agent Logs API =====

  /**
   * GET /api/logs/:name - Get historical logs for a spawned agent
   * Query params:
   *   - limit: Max lines to return (default 500)
   *   - raw: If 'true', return raw output instead of cleaned lines
   */
  app.get('/api/logs/:name', (req, res) => {
    if (!spawner) {
      return res.status(503).json({ error: 'Spawner not enabled' });
    }

    const { name } = req.params;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 500;
    const raw = req.query.raw === 'true';

    // Check if worker exists
    if (!spawner.hasWorker(name)) {
      return res.status(404).json({ error: `Agent ${name} not found` });
    }

    try {
      if (raw) {
        const output = spawner.getWorkerRawOutput(name);
        res.json({
          name,
          raw: true,
          output: output || '',
          timestamp: new Date().toISOString(),
        });
      } else {
        const lines = spawner.getWorkerOutput(name, limit);
        res.json({
          name,
          raw: false,
          lines: lines || [],
          lineCount: lines?.length || 0,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.error(`Failed to get logs for ${name}:`, err);
      res.status(500).json({ error: 'Failed to get logs' });
    }
  });

  /**
   * GET /api/logs - List all agents with available logs
   */
  app.get('/api/logs', (req, res) => {
    if (!spawner) {
      return res.status(503).json({ error: 'Spawner not enabled' });
    }

    try {
      const workers = spawner.getActiveWorkers();
      const agents = workers.map(w => ({
        name: w.name,
        cli: w.cli,
        pid: w.pid,
        spawnedAt: new Date(w.spawnedAt).toISOString(),
        hasLogs: true,
      }));
      res.json({ agents });
    } catch (err) {
      console.error('Failed to list agents with logs:', err);
      res.status(500).json({ error: 'Failed to list agents' });
    }
  });

  // ===== Agent Spawn API =====

  /**
   * POST /api/spawn - Spawn a new agent
   * Body: { name: string, cli?: string, task?: string, team?: string, shadowMode?, shadowAgent?, shadowOf?, shadowTriggers?, shadowSpeakOn? }
   */
  app.post('/api/spawn', async (req, res) => {
    if (!spawner) {
      return res.status(503).json({
        success: false,
        error: 'Spawner not enabled. Start dashboard with enableSpawner: true',
      });
    }

    const {
      name,
      cli = 'claude',
      task = '',
      team,
      shadowMode,
      shadowAgent,
      shadowOf,
      shadowTriggers,
      shadowSpeakOn,
    } = req.body;

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
        team: team || undefined, // Optional team name
        shadowMode,
        shadowAgent,
        shadowOf,
        shadowTriggers,
        shadowSpeakOn,
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
   * POST /api/spawn/architect - Spawn an Architect agent for bridge mode
   * Body: { cli?: string }
   */
  app.post('/api/spawn/architect', async (req, res) => {
    if (!spawner) {
      return res.status(503).json({
        success: false,
        error: 'Spawner not enabled. Start dashboard with enableSpawner: true',
      });
    }

    const { cli = 'claude' } = req.body;

    // Check if Architect already exists
    const activeWorkers = spawner.getActiveWorkers();
    if (activeWorkers.some(w => w.name.toLowerCase() === 'architect')) {
      return res.status(409).json({
        success: false,
        error: 'Architect agent already running',
      });
    }

    // Get bridge state for project context
    const bridgeStatePath = path.join(dataDir, 'bridge-state.json');
    let projectContext = 'No bridge projects connected.';

    if (fs.existsSync(bridgeStatePath)) {
      try {
        const bridgeState = JSON.parse(fs.readFileSync(bridgeStatePath, 'utf-8'));
        if (bridgeState.projects && bridgeState.projects.length > 0) {
          projectContext = bridgeState.projects
            .map((p: { id: string; path: string; name?: string; lead?: { name: string } }) =>
              `- ${p.id}: ${p.path} (Lead: ${p.lead?.name || 'none'})`
            )
            .join('\n');
        }
      } catch (e) {
        console.error('[api] Failed to read bridge state:', e);
      }
    }

    // Build the architect prompt
    const architectPrompt = `You are the Architect, a cross-project coordinator overseeing multiple codebases.

## Connected Projects
${projectContext}

## Your Role
- Coordinate high-level work across all projects
- Assign tasks to project leads
- Ensure consistency and resolve cross-project dependencies
- Review overall architecture decisions

## Cross-Project Messaging

Use this syntax to message agents in specific projects:

\`\`\`
->relay:project-id:AgentName <<<
Your message to this agent>>>

->relay:project-id:* <<<
Broadcast to all agents in a project>>>

->relay:*:* <<<
Broadcast to ALL agents in ALL projects>>>
\`\`\`

## Getting Started
1. Check in with each project lead to understand current status
2. Identify cross-project dependencies
3. Coordinate work across teams

Start by greeting the project leads and asking for status updates.`;

    try {
      const result = await spawner.spawn({
        name: 'Architect',
        cli,
        task: architectPrompt,
      });

      if (result.success) {
        broadcastData().catch(() => {});
      }

      res.json(result);
    } catch (err: any) {
      console.error('[api] Architect spawn error:', err);
      res.status(500).json({
        success: false,
        name: 'Architect',
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

  /**
   * GET /api/trajectory - Get current trajectory status
   */
  app.get('/api/trajectory', async (_req, res) => {
    try {
      const status = await getTrajectoryStatus();
      res.json({
        success: true,
        ...status,
      });
    } catch (err: any) {
      console.error('[api] Trajectory status error:', err);
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  });

  /**
   * GET /api/trajectory/steps - List trajectory steps
   */
  app.get('/api/trajectory/steps', async (req, res) => {
    try {
      const trajectoryId = req.query.trajectoryId as string | undefined;
      const result = await listTrajectorySteps(trajectoryId);

      if (result.success) {
        res.json({
          success: true,
          steps: result.steps,
        });
      } else {
        res.status(500).json({
          success: false,
          steps: [],
          error: result.error,
        });
      }
    } catch (err: any) {
      console.error('[api] Trajectory steps error:', err);
      res.status(500).json({
        success: false,
        steps: [],
        error: err.message,
      });
    }
  });

  /**
   * GET /api/trajectory/history - List all trajectories (completed and active)
   */
  app.get('/api/trajectory/history', async (_req, res) => {
    try {
      const result = await getTrajectoryHistory();

      if (result.success) {
        res.json({
          success: true,
          trajectories: result.trajectories,
        });
      } else {
        res.status(500).json({
          success: false,
          trajectories: [],
          error: result.error,
        });
      }
    } catch (err: any) {
      console.error('[api] Trajectory history error:', err);
      res.status(500).json({
        success: false,
        trajectories: [],
        error: err.message,
      });
    }
  });

  // ===== Settings API =====

  /**
   * GET /api/settings - Get all workspace settings with documentation
   */
  app.get('/api/settings', async (_req, res) => {
    try {
      const { readRelayConfig, shouldStoreInRepo, getTrajectoriesStorageDescription } = await import('../trajectory/config.js');
      const config = readRelayConfig();

      res.json({
        success: true,
        settings: {
          trajectories: {
            storeInRepo: shouldStoreInRepo(),
            storageLocation: getTrajectoriesStorageDescription(),
            description: 'Trajectories record the journey of agent work using the PDERO paradigm (Plan, Design, Execute, Review, Observe). They capture decisions, phase transitions, and retrospectives.',
            benefits: [
              'Track why decisions were made, not just what was built',
              'Enable session recovery when agents crash or context is lost',
              'Provide learning data for future agents working on similar tasks',
              'Create an audit trail of agent work for review',
            ],
            learnMore: 'https://pdero.com',
            optInReason: 'Enable "Store in repo" to version-control your trajectories alongside your code. This is useful for teams who want to review agent decision-making processes.',
          },
        },
        config,
      });
    } catch (err: any) {
      console.error('[api] Settings error:', err);
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  });

  /**
   * GET /api/settings/trajectory - Get trajectory storage settings
   */
  app.get('/api/settings/trajectory', async (_req, res) => {
    try {
      const { readRelayConfig, shouldStoreInRepo, getTrajectoriesStorageDescription } = await import('../trajectory/config.js');
      const config = readRelayConfig();

      res.json({
        success: true,
        settings: {
          storeInRepo: shouldStoreInRepo(),
          storageLocation: getTrajectoriesStorageDescription(),
        },
        config: config.trajectories || {},
        // Documentation for the UI
        documentation: {
          title: 'Trajectory Storage',
          description: 'Trajectories record the journey of agent work using the PDERO paradigm (Plan, Design, Execute, Review, Observe).',
          whatIsIt: 'A trajectory captures not just what an agent built, but WHY it made specific decisions. This includes phase transitions, key decisions with reasoning, and retrospective summaries.',
          benefits: [
            'Understand agent decision-making for code review',
            'Enable session recovery if agents crash',
            'Train future agents on your codebase patterns',
            'Create audit trails of AI work',
          ],
          storeInRepoExplanation: 'When enabled, trajectories are stored in .trajectories/ in your repo and can be committed to source control. When disabled (default), they are stored in your user directory (~/.config/agent-relay/trajectories/).',
          learnMore: 'https://pdero.com',
        },
      });
    } catch (err: any) {
      console.error('[api] Settings trajectory error:', err);
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  });

  /**
   * PUT /api/settings/trajectory - Update trajectory storage settings
   *
   * Body: { storeInRepo: boolean }
   *
   * This writes to .relay/config.json in the project root
   */
  app.put('/api/settings/trajectory', async (req, res) => {
    try {
      const { storeInRepo } = req.body;

      if (typeof storeInRepo !== 'boolean') {
        return res.status(400).json({
          success: false,
          error: 'storeInRepo must be a boolean',
        });
      }

      const { getRelayConfigPath, readRelayConfig } = await import('../trajectory/config.js');
      const { getProjectPaths } = await import('../utils/project-namespace.js');
      const { projectRoot: _projectRoot } = getProjectPaths();

      // Read existing config
      const config = readRelayConfig();

      // Update trajectory settings
      config.trajectories = {
        ...config.trajectories,
        storeInRepo,
      };

      // Ensure .relay directory exists
      const configPath = getRelayConfigPath();
      const configDir = path.dirname(configPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      // Write updated config
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      res.json({
        success: true,
        settings: {
          storeInRepo,
          storageLocation: storeInRepo ? 'repo (.trajectories/)' : 'user (~/.config/agent-relay/trajectories/)',
        },
      });
    } catch (err: any) {
      console.error('[api] Settings trajectory update error:', err);
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  });

  // ===== Decision Queue API =====

  interface Decision {
    id: string;
    agentName: string;
    title: string;
    description: string;
    options?: { id: string; label: string; description?: string }[];
    urgency: 'low' | 'medium' | 'high' | 'critical';
    category: 'approval' | 'choice' | 'input' | 'confirmation';
    createdAt: string;
    expiresAt?: string;
    context?: Record<string, unknown>;
  }

  const decisions = new Map<string, Decision>();

  /**
   * GET /api/decisions - List all pending decisions
   */
  app.get('/api/decisions', (_req, res) => {
    const allDecisions = Array.from(decisions.values())
      .sort((a, b) => {
        const urgencyOrder = { critical: 0, high: 1, medium: 2, low: 3 };
        return urgencyOrder[a.urgency] - urgencyOrder[b.urgency];
      });
    res.json({ success: true, decisions: allDecisions });
  });

  /**
   * POST /api/decisions - Create a new decision request
   * Body: { agentName, title, description, options?, urgency, category, expiresAt?, context? }
   */
  app.post('/api/decisions', (req, res) => {
    const { agentName, title, description, options, urgency, category, expiresAt, context } = req.body;

    if (!agentName || !title || !urgency || !category) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: agentName, title, urgency, category',
      });
    }

    const decision: Decision = {
      id: `decision-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agentName,
      title,
      description: description || '',
      options,
      urgency,
      category,
      createdAt: new Date().toISOString(),
      expiresAt,
      context,
    };

    decisions.set(decision.id, decision);

    // Broadcast to WebSocket clients
    broadcastData().catch(() => {});

    res.json({ success: true, decision });
  });

  /**
   * POST /api/decisions/:id/approve - Approve/resolve a decision
   * Body: { optionId?: string, response?: string }
   */
  app.post('/api/decisions/:id/approve', async (req, res) => {
    const { id } = req.params;
    const { optionId, response } = req.body;

    const decision = decisions.get(id);
    if (!decision) {
      return res.status(404).json({ success: false, error: 'Decision not found' });
    }

    // Send response to the agent via relay
    const agentName = decision.agentName;
    let responseMessage = `DECISION APPROVED: ${decision.title}`;
    if (optionId && decision.options) {
      const option = decision.options.find(o => o.id === optionId);
      if (option) {
        responseMessage += `\nSelected: ${option.label}`;
      }
    }
    if (response) {
      responseMessage += `\nResponse: ${response}`;
    }

    // Try to send message to agent
    try {
      const client = await getRelayClient('Dashboard');
      if (client) {
        await client.sendMessage(agentName, responseMessage, 'message');
      }
    } catch (err) {
      console.warn('[api] Could not send decision response to agent:', err);
    }

    decisions.delete(id);
    broadcastData().catch(() => {});

    res.json({ success: true, message: 'Decision approved' });
  });

  /**
   * POST /api/decisions/:id/reject - Reject a decision
   * Body: { reason?: string }
   */
  app.post('/api/decisions/:id/reject', async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    const decision = decisions.get(id);
    if (!decision) {
      return res.status(404).json({ success: false, error: 'Decision not found' });
    }

    // Send rejection to the agent
    const agentName = decision.agentName;
    let responseMessage = `DECISION REJECTED: ${decision.title}`;
    if (reason) {
      responseMessage += `\nReason: ${reason}`;
    }

    try {
      const client = await getRelayClient('Dashboard');
      if (client) {
        await client.sendMessage(agentName, responseMessage, 'message');
      }
    } catch (err) {
      console.warn('[api] Could not send decision rejection to agent:', err);
    }

    decisions.delete(id);
    broadcastData().catch(() => {});

    res.json({ success: true, message: 'Decision rejected' });
  });

  /**
   * DELETE /api/decisions/:id - Delete/dismiss a decision
   */
  app.delete('/api/decisions/:id', (_req, res) => {
    const { id } = _req.params;

    if (!decisions.has(id)) {
      return res.status(404).json({ success: false, error: 'Decision not found' });
    }

    decisions.delete(id);
    broadcastData().catch(() => {});

    res.json({ success: true, message: 'Decision dismissed' });
  });

  // ===== Fleet Overview API =====

  interface FleetServer {
    id: string;
    name: string;
    status: 'healthy' | 'degraded' | 'offline';
    agents: { name: string; status: string }[];
    cpuUsage: number;
    memoryUsage: number;
    activeConnections: number;
    uptime: number;
    lastHeartbeat: string;
  }

  /**
   * GET /api/fleet/servers - Get fleet server overview
   * Returns local daemon info + any connected bridge servers
   * Note: When bridge is active, local agents are already included in bridge project agents,
   * so we don't add a separate "Local Daemon" entry to avoid double-counting.
   */
  app.get('/api/fleet/servers', async (_req, res) => {
    const servers: FleetServer[] = [];
    const localAgents = spawner?.getActiveWorkers() || [];
    const agentStatuses = await loadAgentStatuses();
    let hasBridgeProjects = false;

    // Check for bridge connections first
    const bridgeStatePath = path.join(dataDir, 'bridge-state.json');
    if (fs.existsSync(bridgeStatePath)) {
      try {
        const bridgeState = JSON.parse(fs.readFileSync(bridgeStatePath, 'utf-8'));
        if (bridgeState.projects && bridgeState.projects.length > 0) {
          hasBridgeProjects = true;

          for (const project of bridgeState.projects) {
            // Enrich with actual online agents from agents.json (same logic as getBridgeData)
            // This fixes the bug where stale agents were counted
            let projectAgents: { name: string; status: string }[] = [];

            if (project.path) {
              const projectHash = crypto.createHash('sha256').update(project.path).digest('hex').slice(0, 12);
              const projectDataDir = path.join(path.dirname(dataDir), projectHash);
              const projectTeamDir = path.join(projectDataDir, 'team');
              const agentsPath = path.join(projectTeamDir, 'agents.json');

              if (fs.existsSync(agentsPath)) {
                try {
                  const agentsData = JSON.parse(fs.readFileSync(agentsPath, 'utf-8'));
                  if (agentsData.agents && Array.isArray(agentsData.agents)) {
                    // Filter to only show online agents (seen within 30 seconds)
                    const thirtySecondsAgo = Date.now() - 30 * 1000;
                    projectAgents = agentsData.agents
                      .filter((a: { lastSeen?: string }) => {
                        if (!a.lastSeen) return false;
                        return new Date(a.lastSeen).getTime() > thirtySecondsAgo;
                      })
                      .map((a: { name: string; cli?: string }) => ({
                        name: a.name,
                        status: 'online',
                      }));
                  }
                } catch (e) {
                  console.warn(`[api] Failed to read agents for ${project.path}:`, e);
                }
              }
            }

            servers.push({
              id: project.id,
              name: project.name || project.path.split('/').pop() || project.id,
              status: project.connected ? 'healthy' : 'offline',
              agents: projectAgents,
              cpuUsage: 0,
              memoryUsage: 0,
              activeConnections: project.connected ? 1 : 0,
              uptime: 0,
              lastHeartbeat: project.lastSeen || new Date().toISOString(),
            });
          }
        }
      } catch (err) {
        console.warn('[api] Failed to read bridge state:', err);
      }
    }

    // Only add local daemon entry if we don't have bridge projects
    // (otherwise local agents are already counted in the bridge project)
    if (!hasBridgeProjects) {
      servers.push({
        id: 'local',
        name: 'Local Daemon',
        status: 'healthy',
        agents: localAgents.map(a => ({
          name: a.name,
          status: agentStatuses[a.name]?.status || 'unknown',
        })),
        cpuUsage: Math.random() * 30, // Mock - would come from actual metrics
        memoryUsage: Math.random() * 50,
        activeConnections: wss.clients.size,
        uptime: process.uptime(),
        lastHeartbeat: new Date().toISOString(),
      });
    }

    res.json({ success: true, servers });
  });

  /**
   * GET /api/fleet/stats - Get aggregate fleet statistics
   */
  app.get('/api/fleet/stats', async (_req, res) => {
    const localAgents = spawner?.getActiveWorkers() || [];
    const agentStatuses = await loadAgentStatuses();

    const totalAgents = localAgents.length;
    let onlineAgents = 0;
    let busyAgents = 0;

    for (const agent of localAgents) {
      const status = agentStatuses[agent.name]?.status;
      if (status === 'online') onlineAgents++;
      if (status === 'busy') busyAgents++;
    }

    res.json({
      success: true,
      stats: {
        totalAgents,
        onlineAgents,
        busyAgents,
        pendingDecisions: decisions.size,
        activeTasks: Array.from(tasks.values()).filter(t =>
          t.status === 'assigned' || t.status === 'in_progress'
        ).length,
      },
    });
  });

  // ===== Task Assignment API =====

  interface TaskAssignment {
    id: string;
    agentName: string;
    title: string;
    description: string;
    priority: 'low' | 'medium' | 'high' | 'critical';
    status: 'pending' | 'assigned' | 'in_progress' | 'completed' | 'failed';
    createdAt: string;
    assignedAt?: string;
    completedAt?: string;
    result?: string;
  }

  const tasks = new Map<string, TaskAssignment>();

  /**
   * GET /api/tasks - List all tasks
   */
  app.get('/api/tasks', (req, res) => {
    const status = req.query.status as string | undefined;
    const agentName = req.query.agent as string | undefined;

    let allTasks = Array.from(tasks.values());

    if (status) {
      allTasks = allTasks.filter(t => t.status === status);
    }
    if (agentName) {
      allTasks = allTasks.filter(t => t.agentName === agentName);
    }

    // Sort by priority and creation time
    allTasks.sort((a, b) => {
      const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    res.json({ success: true, tasks: allTasks });
  });

  /**
   * POST /api/tasks - Create and assign a task
   * Body: { agentName, title, description, priority }
   */
  app.post('/api/tasks', async (req, res) => {
    const { agentName, title, description, priority } = req.body;

    if (!agentName || !title || !priority) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: agentName, title, priority',
      });
    }

    const task: TaskAssignment = {
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agentName,
      title,
      description: description || '',
      priority,
      status: 'assigned',
      createdAt: new Date().toISOString(),
      assignedAt: new Date().toISOString(),
    };

    tasks.set(task.id, task);

    // Send task to agent via relay
    try {
      const client = await getRelayClient('Dashboard');
      if (client) {
        const taskMessage = `TASK ASSIGNED [${priority.toUpperCase()}]: ${title}\n\n${description || 'No additional details.'}`;
        await client.sendMessage(agentName, taskMessage, 'message');
      }
    } catch (err) {
      console.warn('[api] Could not send task to agent:', err);
    }

    broadcastData().catch(() => {});

    res.json({ success: true, task });
  });

  /**
   * PATCH /api/tasks/:id - Update task status
   * Body: { status, result? }
   */
  app.patch('/api/tasks/:id', (req, res) => {
    const { id } = req.params;
    const { status, result } = req.body;

    const task = tasks.get(id);
    if (!task) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }

    if (status) {
      task.status = status;
      if (status === 'completed' || status === 'failed') {
        task.completedAt = new Date().toISOString();
      }
    }
    if (result !== undefined) {
      task.result = result;
    }

    tasks.set(id, task);
    broadcastData().catch(() => {});

    res.json({ success: true, task });
  });

  /**
   * DELETE /api/tasks/:id - Cancel/delete a task
   */
  app.delete('/api/tasks/:id', async (req, res) => {
    const { id } = req.params;

    const task = tasks.get(id);
    if (!task) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }

    // Notify agent of cancellation if task is still active
    if (task.status === 'pending' || task.status === 'assigned' || task.status === 'in_progress') {
      try {
        const client = await getRelayClient('Dashboard');
        if (client) {
          await client.sendMessage(task.agentName, `TASK CANCELLED: ${task.title}`, 'message');
        }
      } catch (err) {
        console.warn('[api] Could not send task cancellation to agent:', err);
      }
    }

    tasks.delete(id);
    broadcastData().catch(() => {});

    res.json({ success: true, message: 'Task cancelled' });
  });

  // ===== Beads Integration API =====

  /**
   * POST /api/beads - Create a bead (task/issue) via the bd CLI
   */
  app.post('/api/beads', async (req, res) => {
    const { title, assignee, priority, type, description: _description } = req.body;

    if (!title || typeof title !== 'string') {
      return res.status(400).json({ success: false, error: 'Title is required' });
    }

    // Build bd create command
    const args: string[] = ['create', `--title="${title.replace(/"/g, '\\"')}"`];

    if (assignee) {
      args.push(`--assignee=${assignee}`);
    }
    if (priority !== undefined && priority !== null) {
      args.push(`--priority=${priority}`);
    }
    if (type && ['task', 'bug', 'feature'].includes(type)) {
      args.push(`--type=${type}`);
    }

    const cmd = `bd ${args.join(' ')}`;
    console.log('[api/beads] Creating bead:', cmd);

    // Execute bd create command
    exec(cmd, { cwd: dataDir }, (error, stdout, stderr) => {
      if (error) {
        console.error('[api/beads] bd create failed:', stderr || error.message);
        return res.status(500).json({
          success: false,
          error: stderr || error.message || 'Failed to create bead',
        });
      }

      // Parse bead ID from output (bd create outputs the ID)
      const output = stdout.trim();
      // bd create typically outputs: "Created beads-xxx: title"
      const idMatch = output.match(/Created\s+(beads-\w+)/i) || output.match(/(beads-\w+)/);
      const beadId = idMatch ? idMatch[1] : `beads-${Date.now()}`;

      console.log('[api/beads] Created bead:', beadId);
      res.json({
        success: true,
        bead: {
          id: beadId,
          title,
          assignee,
          priority,
          type: type || 'task',
        },
      });
    });
  });

  /**
   * POST /api/relay/send - Send a relay message to an agent
   */
  app.post('/api/relay/send', async (req, res) => {
    const { to, content, thread } = req.body;

    if (!to || typeof to !== 'string') {
      return res.status(400).json({ success: false, error: 'Recipient (to) is required' });
    }
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ success: false, error: 'Message content is required' });
    }

    try {
      const client = await getRelayClient('Dashboard');
      if (!client) {
        return res.status(503).json({
          success: false,
          error: 'Relay client not available',
        });
      }

      const messageId = await client.sendMessage(to, content, thread ? 'message' : 'message');
      console.log('[api/relay/send] Sent message to', to, ':', messageId);

      res.json({
        success: true,
        messageId: messageId || `msg-${Date.now()}`,
      });
    } catch (err) {
      console.error('[api/relay/send] Failed to send message:', err);
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : 'Failed to send message',
      });
    }
  });

  // Helper to load agent statuses
  async function loadAgentStatuses(): Promise<Record<string, { status: string }>> {
    const agentsFile = path.join(dataDir, 'agents.json');
    try {
      if (fs.existsSync(agentsFile)) {
        const data = JSON.parse(fs.readFileSync(agentsFile, 'utf-8'));
        const result: Record<string, { status: string }> = {};
        for (const agent of data.agents || []) {
          result[agent.name] = { status: agent.status || 'offline' };
        }
        return result;
      }
    } catch (err) {
      console.warn('[api] Failed to load agent statuses:', err);
    }
    return {};
  }

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
              if (filename && (filename.endsWith('inbox.md') || filename.endsWith('team.json') || filename.endsWith('agents.json') || filename.endsWith('processing-state.json'))) {
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
