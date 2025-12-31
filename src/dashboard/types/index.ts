/**
 * Dashboard V2 Type Definitions
 */

import type { AgentStatus } from '../lib/colors';

// Agent Types
export interface Agent {
  name: string;
  role?: string;
  cli?: string;
  status: AgentStatus;
  lastSeen?: string;
  lastActive?: string;
  messageCount?: number;
  needsAttention?: boolean;
  currentTask?: string;
  server?: string; // For fleet view - which server the agent is on
  isProcessing?: boolean; // True when agent is thinking/processing a message
  processingStartedAt?: number; // Timestamp when processing started
  isSpawned?: boolean; // True if agent was spawned via dashboard (can be killed)
  team?: string; // Optional user-defined team grouping (e.g., "frontend-team", "backend-team")
}

export interface AgentSummary {
  agentName: string;
  lastUpdated: string;
  currentTask?: string;
  completedTasks?: string[];
  context?: string;
  files?: string[];
}

// Message Status
export type MessageStatus = 'unread' | 'read' | 'acked' | 'sending';

// Attachment Types
export interface Attachment {
  /** Unique identifier for the attachment */
  id: string;
  /** Original filename */
  filename: string;
  /** MIME type (e.g., 'image/png', 'image/jpeg') */
  mimeType: string;
  /** Size in bytes */
  size: number;
  /** URL to access the attachment */
  url: string;
  /** Width for images */
  width?: number;
  /** Height for images */
  height?: number;
  /** Base64-encoded data (for inline display, optional) */
  data?: string;
}

// Message Types
export interface Message {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: string;
  thread?: string;
  isBroadcast?: boolean;
  isRead?: boolean;
  replyCount?: number;
  /** Message delivery status: sending → acked (received by agent) */
  status?: MessageStatus;
  /** Attachments (images, files) */
  attachments?: Attachment[];
}

export interface Thread {
  id: string;
  messages: Message[];
  participants: string[];
  lastActivity: string;
}

// Fleet Types
export interface PeerServer {
  id: string;
  url: string;
  name?: string;
  status: 'connected' | 'disconnected' | 'error';
  agentCount: number;
  latency?: number;
}

export interface FleetData {
  servers: PeerServer[];
  agents: Agent[];
  totalMessages: number;
}

export interface Project {
  id: string;
  path: string;
  name?: string;
  agents: Agent[];
  lead?: {
    name: string;
    connected: boolean;
  };
}

// Session Types
export interface Session {
  id: string;
  agentName: string;
  cli?: string;
  startedAt: string;
  endedAt?: string;
  duration?: string;
  messageCount: number;
  summary?: string;
  isActive: boolean;
  closedBy?: 'agent' | 'disconnect' | 'error';
}

// Task Types (Beads Integration)
export interface Task {
  id: string;
  title: string;
  description?: string;
  status: 'open' | 'in_progress' | 'completed' | 'blocked';
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  type: 'task' | 'bug' | 'feature' | 'epic';
  assignee?: string;
  blockedBy?: string[];
  blocking?: string[];
  created: string;
  updated: string;
}

// Trajectory Types
export interface Decision {
  id: string;
  timestamp: string;
  agent: string;
  type: 'tool_call' | 'message' | 'file_edit' | 'command' | 'question';
  summary: string;
  details?: string;
  context?: string;
  outcome?: 'success' | 'error' | 'pending';
  children?: Decision[];
}

export interface Trajectory {
  agentName: string;
  sessionId: string;
  decisions: Decision[];
  startTime: string;
  endTime?: string;
}

// Decision Queue Types
export interface PendingDecision {
  id: string;
  agent: string;
  question: string;
  options?: string[];
  context?: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  createdAt: string;
  expiresAt?: string;
}

// Dashboard State
export interface DashboardState {
  agents: Agent[];
  messages: Message[];
  currentChannel: string;
  currentThread: string | null;
  isConnected: boolean;
  viewMode: 'local' | 'fleet';
  fleetData: FleetData | null;
  sessions: Session[];
  summaries: AgentSummary[];
}

// WebSocket Message Types
export interface WSMessage {
  type: 'data' | 'agents' | 'messages' | 'fleet' | 'error';
  payload: unknown;
}

// API Response Types
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface SendMessageRequest {
  to: string;
  message: string;
  thread?: string;
  /** Attachment IDs to include with the message */
  attachments?: string[];
}

export type SpeakOnTrigger = 'SESSION_END' | 'CODE_WRITTEN' | 'REVIEW_REQUEST' | 'EXPLICIT_ASK' | 'ALL_MESSAGES';

export interface SpawnAgentRequest {
  name: string;
  cli?: string;
  task?: string;
  team?: string;
  /** Shadow execution mode (subagent for Claude/OpenCode, process otherwise) */
  shadowMode?: 'subagent' | 'process';
  /** Primary agent to shadow (if this agent is a shadow) */
  shadowOf?: string;
  /** Shadow agent profile to use (for subagent mode) */
  shadowAgent?: string;
  /** When the shadow should be invoked (for subagent mode) */
  shadowTriggers?: SpeakOnTrigger[];
  /** When the shadow should speak */
  shadowSpeakOn?: SpeakOnTrigger[];
}

export interface SpawnAgentResponse {
  success: boolean;
  name: string;
  error?: string;
}
