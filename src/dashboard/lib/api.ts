/**
 * Dashboard API Client
 *
 * Provides a clean interface to the dashboard REST and WebSocket APIs.
 * Can be used by both the current dashboard and the v2 React dashboard.
 */

import type {
  Agent,
  Message,
  Session,
  AgentSummary,
  FleetData,
  SendMessageRequest,
  SpawnAgentRequest,
  SpawnAgentResponse,
  ApiResponse,
  Attachment,
} from '../types';

// API base URL - relative in browser, can be configured for SSR
const API_BASE = '';

// Workspace ID for cloud mode proxying
let activeWorkspaceId: string | null = null;

/**
 * Set the active workspace ID for API proxying in cloud mode
 */
export function setActiveWorkspaceId(workspaceId: string | null): void {
  activeWorkspaceId = workspaceId;
}

/**
 * Get the API URL, accounting for cloud mode proxying
 * @param path - API path like '/api/spawn' or '/api/send'
 */
function getApiUrl(path: string): string {
  if (activeWorkspaceId) {
    // In cloud mode, proxy through the cloud server
    // Strip /api/ prefix since the proxy endpoint adds it back
    const proxyPath = path.startsWith('/api/') ? path.substring(5) : path.replace(/^\//, '');
    return `/api/workspaces/${activeWorkspaceId}/proxy/${proxyPath}`;
  }
  return `${API_BASE}${path}`;
}

/**
 * Dashboard data received from WebSocket
 */
export interface DashboardData {
  agents: Agent[];
  messages: Message[];
  sessions?: Session[];
  summaries?: AgentSummary[];
  fleet?: FleetData;
}

/**
 * WebSocket connection manager
 */
export class DashboardWebSocket {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;
  private listeners: Set<(data: DashboardData) => void> = new Set();
  private statusListeners: Set<(connected: boolean) => void> = new Set();

  constructor(private url?: string) {}

  /**
   * Connect to the WebSocket server
   */
  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    const wsUrl = this.url || this.getDefaultUrl();
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.reconnectDelay = 1000;
      this.notifyStatus(true);
    };

    this.ws.onclose = () => {
      this.notifyStatus(false);
      this.scheduleReconnect();
    };

    this.ws.onerror = (error) => {
      console.error('[ws] WebSocket error:', error);
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as DashboardData;
        this.notifyListeners(data);
      } catch (e) {
        console.error('[ws] Failed to parse message:', e);
      }
    };
  }

  /**
   * Disconnect from the WebSocket server
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Subscribe to data updates
   */
  onData(callback: (data: DashboardData) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Subscribe to connection status changes
   */
  onStatusChange(callback: (connected: boolean) => void): () => void {
    this.statusListeners.add(callback);
    return () => this.statusListeners.delete(callback);
  }

  /**
   * Check if connected
   */
  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private getDefaultUrl(): string {
    // This utility is designed for browser use. In Node.js, always pass a URL to constructor.
    // The browser check uses globalThis to avoid TypeScript errors in Node.js compilation.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const g = globalThis as any;
      if (g.window?.location) {
        const loc = g.window.location;
        const protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${protocol}//${loc.host}/ws`;
      }
    } catch {
      // Ignore - not in browser
    }
    return 'ws://localhost:3888/ws';
  }

  private notifyListeners(data: DashboardData): void {
    for (const listener of this.listeners) {
      try {
        listener(data);
      } catch (e) {
        console.error('[ws] Listener error:', e);
      }
    }
  }

  private notifyStatus(connected: boolean): void {
    for (const listener of this.statusListeners) {
      try {
        listener(connected);
      } catch (e) {
        console.error('[ws] Status listener error:', e);
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[ws] Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 30000);

    setTimeout(() => {
      console.log(`[ws] Reconnecting (attempt ${this.reconnectAttempts})...`);
      this.connect();
    }, delay);
  }
}

/**
 * REST API methods
 */
export const api = {
  /**
   * Send a message via the relay
   */
  async sendMessage(request: SendMessageRequest): Promise<ApiResponse<void>> {
    try {
      const response = await fetch(getApiUrl('/api/send'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });

      const result = await response.json() as { success?: boolean; error?: string };

      if (response.ok && result.success) {
        return { success: true };
      }

      return { success: false, error: result.error || 'Failed to send message' };
    } catch (_error) {
      return { success: false, error: 'Network error' };
    }
  },

  /**
   * Upload an attachment (image/screenshot)
   * @param file - File object or { filename, mimeType, data } for base64 uploads
   */
  async uploadAttachment(
    file: File | { filename: string; mimeType: string; data: string }
  ): Promise<ApiResponse<{ attachment: Omit<Attachment, 'data'> }>> {
    try {
      let filename: string;
      let mimeType: string;
      let data: string;

      if (file instanceof File) {
        // Convert File to base64
        filename = file.name;
        mimeType = file.type;
        data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
      } else {
        filename = file.filename;
        mimeType = file.mimeType;
        data = file.data;
      }

      const response = await fetch(getApiUrl('/api/upload'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, mimeType, data }),
      });

      const result = await response.json() as {
        success?: boolean;
        attachment?: Omit<Attachment, 'data'>;
        error?: string;
      };

      if (response.ok && result.success && result.attachment) {
        return { success: true, data: { attachment: result.attachment } };
      }

      return { success: false, error: result.error || 'Failed to upload attachment' };
    } catch (_error) {
      return { success: false, error: 'Network error' };
    }
  },

  /**
   * Spawn a new agent
   */
  async spawnAgent(request: SpawnAgentRequest): Promise<SpawnAgentResponse> {
    try {
      const response = await fetch(getApiUrl('/api/spawn'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });

      return await response.json() as SpawnAgentResponse;
    } catch (_error) {
      return { success: false, name: request.name, error: 'Network error' };
    }
  },

  /**
   * Get list of spawned agents
   */
  async getSpawnedAgents(): Promise<ApiResponse<{ agents: Array<{ name: string; cli: string; startedAt: string }> }>> {
    try {
      const response = await fetch(getApiUrl('/api/spawned'));
      const result = await response.json() as { success?: boolean; agents?: Array<{ name: string; cli: string; startedAt: string }>; error?: string };

      if (response.ok && result.success) {
        return { success: true, data: { agents: result.agents || [] } };
      }

      return { success: false, error: result.error };
    } catch (_error) {
      return { success: false, error: 'Network error' };
    }
  },

  /**
   * Release a spawned agent
   */
  async releaseAgent(name: string): Promise<ApiResponse<void>> {
    try {
      const response = await fetch(getApiUrl(`/api/spawned/${encodeURIComponent(name)}`), {
        method: 'DELETE',
      });

      const result = await response.json() as { success?: boolean; error?: string };

      if (response.ok && result.success) {
        return { success: true };
      }

      return { success: false, error: result.error };
    } catch (_error) {
      return { success: false, error: 'Network error' };
    }
  },

  /**
   * Get dashboard data (fallback for REST polling)
   */
  async getData(): Promise<ApiResponse<DashboardData>> {
    try {
      const response = await fetch(getApiUrl('/api/data'));
      const data = await response.json() as DashboardData;

      if (response.ok) {
        return { success: true, data };
      }

      return { success: false, error: 'Failed to fetch data' };
    } catch (_error) {
      return { success: false, error: 'Network error' };
    }
  },

  /**
   * Get bridge data for multi-project view
   */
  async getBridgeData(): Promise<ApiResponse<FleetData>> {
    try {
      const response = await fetch(getApiUrl('/api/bridge'));
      const data = await response.json() as FleetData;

      if (response.ok) {
        return { success: true, data };
      }

      return { success: false, error: 'Failed to fetch bridge data' };
    } catch (_error) {
      return { success: false, error: 'Network error' };
    }
  },

  /**
   * Get system metrics
   */
  async getMetrics(): Promise<ApiResponse<unknown>> {
    try {
      const response = await fetch(getApiUrl('/api/metrics'));
      const data = await response.json();

      if (response.ok) {
        return { success: true, data };
      }

      return { success: false, error: 'Failed to fetch metrics' };
    } catch (_error) {
      return { success: false, error: 'Network error' };
    }
  },

  // ===== Conversation History API =====

  /**
   * Get historical sessions
   */
  async getHistorySessions(params?: {
    agent?: string;
    since?: number;
    limit?: number;
  }): Promise<ApiResponse<{ sessions: HistorySession[] }>> {
    try {
      const query = new URLSearchParams();
      if (params?.agent) query.set('agent', params.agent);
      if (params?.since) query.set('since', String(params.since));
      if (params?.limit) query.set('limit', String(params.limit));

      const response = await fetch(getApiUrl(`/api/history/sessions?${query}`));
      const data = await response.json();

      if (response.ok) {
        return { success: true, data };
      }

      return { success: false, error: 'Failed to fetch sessions' };
    } catch (_error) {
      return { success: false, error: 'Network error' };
    }
  },

  /**
   * Get historical messages
   */
  async getHistoryMessages(params?: {
    from?: string;
    to?: string;
    thread?: string;
    since?: number;
    limit?: number;
    order?: 'asc' | 'desc';
    search?: string;
  }): Promise<ApiResponse<{ messages: HistoryMessage[] }>> {
    try {
      const query = new URLSearchParams();
      if (params?.from) query.set('from', params.from);
      if (params?.to) query.set('to', params.to);
      if (params?.thread) query.set('thread', params.thread);
      if (params?.since) query.set('since', String(params.since));
      if (params?.limit) query.set('limit', String(params.limit));
      if (params?.order) query.set('order', params.order);
      if (params?.search) query.set('search', params.search);

      const response = await fetch(getApiUrl(`/api/history/messages?${query}`));
      const data = await response.json();

      if (response.ok) {
        return { success: true, data };
      }

      return { success: false, error: 'Failed to fetch messages' };
    } catch (_error) {
      return { success: false, error: 'Network error' };
    }
  },

  /**
   * Get unique conversations (agent pairs)
   */
  async getHistoryConversations(): Promise<ApiResponse<{ conversations: Conversation[] }>> {
    try {
      const response = await fetch(getApiUrl('/api/history/conversations'));
      const data = await response.json();

      if (response.ok) {
        return { success: true, data };
      }

      return { success: false, error: 'Failed to fetch conversations' };
    } catch (_error) {
      return { success: false, error: 'Network error' };
    }
  },

  /**
   * Get a single message by ID
   */
  async getHistoryMessage(id: string): Promise<ApiResponse<HistoryMessage>> {
    try {
      const response = await fetch(getApiUrl(`/api/history/message/${encodeURIComponent(id)}`));
      const data = await response.json();

      if (response.ok) {
        return { success: true, data };
      }

      return { success: false, error: data.error || 'Failed to fetch message' };
    } catch (_error) {
      return { success: false, error: 'Network error' };
    }
  },

  /**
   * Get storage statistics
   */
  async getHistoryStats(): Promise<ApiResponse<HistoryStats>> {
    try {
      const response = await fetch(getApiUrl('/api/history/stats'));
      const data = await response.json();

      if (response.ok) {
        return { success: true, data };
      }

      return { success: false, error: 'Failed to fetch stats' };
    } catch (_error) {
      return { success: false, error: 'Network error' };
    }
  },

  // ===== File Search API =====

  /**
   * Search for files in the repository
   */
  async searchFiles(params?: {
    query?: string;
    limit?: number;
  }): Promise<ApiResponse<FileSearchResponse>> {
    try {
      const queryParams = new URLSearchParams();
      if (params?.query) queryParams.set('q', params.query);
      if (params?.limit) queryParams.set('limit', String(params.limit));

      const response = await fetch(getApiUrl(`/api/files?${queryParams}`));
      const data = await response.json();

      if (response.ok) {
        return { success: true, data };
      }

      return { success: false, error: 'Failed to search files' };
    } catch (_error) {
      return { success: false, error: 'Network error' };
    }
  },

  // ===== Decision Queue API =====

  /**
   * Get all pending decisions
   */
  async getDecisions(): Promise<ApiResponse<{ decisions: ApiDecision[] }>> {
    try {
      const response = await fetch(getApiUrl('/api/decisions'));
      const data = await response.json();

      if (response.ok && data.success) {
        return { success: true, data: { decisions: data.decisions || [] } };
      }

      return { success: false, error: data.error || 'Failed to fetch decisions' };
    } catch (_error) {
      return { success: false, error: 'Network error' };
    }
  },

  /**
   * Approve a decision
   */
  async approveDecision(id: string, optionId?: string, response?: string): Promise<ApiResponse<void>> {
    try {
      const res = await fetch(getApiUrl(`/api/decisions/${encodeURIComponent(id)}/approve`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ optionId, response }),
      });

      const data = await res.json();

      if (res.ok && data.success) {
        return { success: true };
      }

      return { success: false, error: data.error || 'Failed to approve decision' };
    } catch (_error) {
      return { success: false, error: 'Network error' };
    }
  },

  /**
   * Reject a decision
   */
  async rejectDecision(id: string, reason?: string): Promise<ApiResponse<void>> {
    try {
      const res = await fetch(getApiUrl(`/api/decisions/${encodeURIComponent(id)}/reject`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });

      const data = await res.json();

      if (res.ok && data.success) {
        return { success: true };
      }

      return { success: false, error: data.error || 'Failed to reject decision' };
    } catch (_error) {
      return { success: false, error: 'Network error' };
    }
  },

  /**
   * Dismiss a decision
   */
  async dismissDecision(id: string): Promise<ApiResponse<void>> {
    try {
      const res = await fetch(getApiUrl(`/api/decisions/${encodeURIComponent(id)}`), {
        method: 'DELETE',
      });

      const data = await res.json();

      if (res.ok && data.success) {
        return { success: true };
      }

      return { success: false, error: data.error || 'Failed to dismiss decision' };
    } catch (_error) {
      return { success: false, error: 'Network error' };
    }
  },

  // ===== Fleet Overview API =====

  /**
   * Get fleet servers
   */
  async getFleetServers(): Promise<ApiResponse<{ servers: FleetServer[] }>> {
    try {
      const response = await fetch(getApiUrl('/api/fleet/servers'));
      const data = await response.json();

      if (response.ok && data.success) {
        return { success: true, data: { servers: data.servers || [] } };
      }

      return { success: false, error: data.error || 'Failed to fetch fleet servers' };
    } catch (_error) {
      return { success: false, error: 'Network error' };
    }
  },

  /**
   * Get fleet statistics
   */
  async getFleetStats(): Promise<ApiResponse<{ stats: FleetStats }>> {
    try {
      const response = await fetch(getApiUrl('/api/fleet/stats'));
      const data = await response.json();

      if (response.ok && data.success) {
        return { success: true, data: { stats: data.stats } };
      }

      return { success: false, error: data.error || 'Failed to fetch fleet stats' };
    } catch (_error) {
      return { success: false, error: 'Network error' };
    }
  },

  // ===== Task Assignment API =====

  /**
   * Get all tasks
   */
  async getTasks(params?: {
    status?: string;
    agent?: string;
  }): Promise<ApiResponse<{ tasks: TaskAssignment[] }>> {
    try {
      const queryParams = new URLSearchParams();
      if (params?.status) queryParams.set('status', params.status);
      if (params?.agent) queryParams.set('agent', params.agent);

      const response = await fetch(getApiUrl(`/api/tasks?${queryParams}`));
      const data = await response.json();

      if (response.ok && data.success) {
        return { success: true, data: { tasks: data.tasks || [] } };
      }

      return { success: false, error: data.error || 'Failed to fetch tasks' };
    } catch (_error) {
      return { success: false, error: 'Network error' };
    }
  },

  /**
   * Create and assign a task
   */
  async createTask(request: {
    agentName: string;
    title: string;
    description?: string;
    priority: 'low' | 'medium' | 'high' | 'critical';
  }): Promise<ApiResponse<{ task: TaskAssignment }>> {
    try {
      const response = await fetch(getApiUrl('/api/tasks'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        return { success: true, data: { task: data.task } };
      }

      return { success: false, error: data.error || 'Failed to create task' };
    } catch (_error) {
      return { success: false, error: 'Network error' };
    }
  },

  /**
   * Update task status
   */
  async updateTask(id: string, updates: {
    status?: TaskAssignment['status'];
    result?: string;
  }): Promise<ApiResponse<{ task: TaskAssignment }>> {
    try {
      const response = await fetch(getApiUrl(`/api/tasks/${encodeURIComponent(id)}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        return { success: true, data: { task: data.task } };
      }

      return { success: false, error: data.error || 'Failed to update task' };
    } catch (_error) {
      return { success: false, error: 'Network error' };
    }
  },

  /**
   * Cancel a task
   */
  async cancelTask(id: string): Promise<ApiResponse<void>> {
    try {
      const response = await fetch(getApiUrl(`/api/tasks/${encodeURIComponent(id)}`), {
        method: 'DELETE',
      });

      const data = await response.json();

      if (response.ok && data.success) {
        return { success: true };
      }

      return { success: false, error: data.error || 'Failed to cancel task' };
    } catch (_error) {
      return { success: false, error: 'Network error' };
    }
  },

  // ===== Beads Integration API =====

  /**
   * Create a bead (task/issue) via the beads CLI
   */
  async createBead(request: {
    title: string;
    assignee?: string;
    priority?: number;
    type?: 'task' | 'bug' | 'feature';
    description?: string;
  }): Promise<ApiResponse<{ bead: { id: string; title: string } }>> {
    try {
      const response = await fetch(getApiUrl('/api/beads'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        return { success: true, data: { bead: data.bead } };
      }

      return { success: false, error: data.error || 'Failed to create bead' };
    } catch (_error) {
      return { success: false, error: 'Network error' };
    }
  },

  /**
   * Send a relay message to an agent (non-interrupting notification)
   */
  async sendRelayMessage(request: {
    to: string;
    content: string;
    thread?: string;
  }): Promise<ApiResponse<{ messageId: string }>> {
    try {
      const response = await fetch(getApiUrl('/api/relay/send'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        return { success: true, data: { messageId: data.messageId } };
      }

      return { success: false, error: data.error || 'Failed to send message' };
    } catch (_error) {
      return { success: false, error: 'Network error' };
    }
  },
};

// History API types
export interface HistorySession {
  id: string;
  agentName: string;
  cli?: string;
  startedAt: string;
  endedAt?: string;
  duration: string;
  messageCount: number;
  summary?: string;
  isActive: boolean;
  closedBy?: 'agent' | 'disconnect' | 'error';
}

export interface HistoryMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: string;
  thread?: string;
  isBroadcast?: boolean;
  isUrgent?: boolean;
  status?: string;
  data?: Record<string, unknown>;
}

export interface Conversation {
  participants: string[];
  lastMessage: string;
  lastTimestamp: string;
  messageCount: number;
}

export interface HistoryStats {
  messageCount: number | string;
  sessionCount: number | string;
  activeSessions: number | string;
  uniqueAgents: number | string;
  oldestMessageDate?: string | null;
}

// File search types
export interface FileSearchResult {
  path: string;
  name: string;
  isDirectory: boolean;
}

export interface FileSearchResponse {
  files: FileSearchResult[];
  query: string;
  searchRoot: string;
}

// Decision Queue types (API response format)
export interface ApiDecision {
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

// Decision type (component format)
export interface Decision {
  id: string;
  agentName: string;
  timestamp: string | number;
  type: 'approval' | 'choice' | 'confirmation' | 'input';
  title: string;
  description: string;
  options?: { id: string; label: string; description?: string }[];
  priority: 'low' | 'medium' | 'high' | 'critical';
  context?: Record<string, unknown>;
  expiresAt?: string | number;
}

// Convert API decision to component format
export function convertApiDecision(apiDecision: ApiDecision): Decision {
  return {
    id: apiDecision.id,
    agentName: apiDecision.agentName,
    timestamp: apiDecision.createdAt,
    type: apiDecision.category,
    title: apiDecision.title,
    description: apiDecision.description,
    options: apiDecision.options,
    priority: apiDecision.urgency,
    context: apiDecision.context,
    expiresAt: apiDecision.expiresAt,
  };
}

// Fleet types
export interface FleetServer {
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

export interface FleetStats {
  totalAgents: number;
  onlineAgents: number;
  busyAgents: number;
  pendingDecisions: number;
  activeTasks: number;
}

// Task Assignment types
export interface TaskAssignment {
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

/**
 * Create a singleton WebSocket connection
 */
let wsInstance: DashboardWebSocket | null = null;

export function getWebSocket(): DashboardWebSocket {
  if (!wsInstance) {
    wsInstance = new DashboardWebSocket();
  }
  return wsInstance;
}
