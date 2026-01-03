/**
 * Daemon Types
 * Core types for the agent-relay daemon
 */

export type WorkspaceStatus = 'active' | 'inactive' | 'error';
export type AgentStatus = 'running' | 'idle' | 'crashed' | 'restarting' | 'stopped';
export type ProviderType = 'claude' | 'codex' | 'gemini' | 'generic';

/**
 * Workspace represents a connected repository/project
 */
export interface Workspace {
  id: string;
  name: string;
  path: string;
  status: WorkspaceStatus;
  provider: ProviderType;
  createdAt: Date;
  lastActiveAt: Date;
  /** Cloud workspace ID if provisioned via cloud */
  cloudId?: string;
  /** Custom domain if configured */
  customDomain?: string;
  /** Git remote URL */
  gitRemote?: string;
  /** Current branch */
  gitBranch?: string;
}

/**
 * Agent running within a workspace
 */
export interface Agent {
  id: string;
  name: string;
  workspaceId: string;
  provider: ProviderType;
  status: AgentStatus;
  pid?: number;
  task?: string;
  spawnedAt: Date;
  lastHealthCheck?: Date;
  restartCount: number;
  logFile?: string;
  /** Unique agent ID for session resume */
  agentId?: string;
}

/**
 * Message between agents or from dashboard
 */
export interface AgentMessage {
  id: string;
  from: string;
  to: string;
  workspaceId: string;
  body: string;
  timestamp: Date;
  delivered: boolean;
}

/**
 * Real-time event for WebSocket updates
 */
export interface DaemonEvent {
  type:
    | 'workspace:added'
    | 'workspace:removed'
    | 'workspace:updated'
    | 'workspace:switched'
    | 'agent:spawned'
    | 'agent:stopped'
    | 'agent:crashed'
    | 'agent:restarted'
    | 'agent:output'
    | 'agent:summary'
    | 'agent:session-end'
    | 'agent:injection-failed'
    | 'message:received'
    | 'message:sent';
  workspaceId?: string;
  agentId?: string;
  data: unknown;
  timestamp: Date;
}

/**
 * Dashboard user session
 */
export interface UserSession {
  userId: string;
  githubUsername: string;
  avatarUrl?: string;
  activeWorkspaceId?: string;
  connectedAt: Date;
}

/**
 * API daemon configuration (for HTTP/WebSocket API)
 */
export interface ApiDaemonConfig {
  /** Port for HTTP/WebSocket API */
  port: number;
  /** Host to bind to */
  host: string;
  /** Allowed CORS origins for HTTP API (empty = no cross-origin access) */
  allowedOrigins?: string[];
  /** Data directory for persistence */
  dataDir: string;
  /** Enable auto-restart for crashed agents */
  autoRestart: boolean;
  /** Max restart attempts */
  maxRestarts: number;
  /** Health check interval in ms */
  healthCheckInterval: number;
  /** Cloud API URL (if using cloud features) */
  cloudApiUrl?: string;
  /** User's authentication token for cloud */
  cloudToken?: string;
}

/**
 * API request to spawn an agent
 */
export interface SpawnAgentRequest {
  name: string;
  provider?: ProviderType;
  task?: string;
}

/**
 * API request to add a workspace
 */
export interface AddWorkspaceRequest {
  path: string;
  name?: string;
  provider?: ProviderType;
}

/**
 * API response for workspace list
 */
export interface WorkspacesResponse {
  workspaces: Workspace[];
  activeWorkspaceId?: string;
}

/**
 * API response for agents in a workspace
 */
export interface AgentsResponse {
  agents: Agent[];
  workspaceId: string;
}
