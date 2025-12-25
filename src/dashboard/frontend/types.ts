/**
 * Dashboard Frontend Types
 */

export interface Agent {
  name: string;
  role: string;
  cli: string;
  messageCount: number;
  status?: string;
  lastActive?: string;
  lastSeen?: string;
  needsAttention?: boolean;
}

export interface Message {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: string;
  thread?: string;
  project?: string;  // For cross-project messages
}

export interface DashboardData {
  agents: Agent[];
  messages: Message[];
  activity: Message[];
  sessions: SessionInfo[];
  summaries: AgentSummary[];
}

export interface SessionInfo {
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

export interface AgentSummary {
  agentName: string;
  lastUpdated: string;
  currentTask?: string;
  completedTasks?: string[];
  context?: string;
}

export type ChannelType = 'general' | string;

export interface AppState {
  agents: Agent[];
  messages: Message[];
  currentChannel: ChannelType;
  currentThread: string | null;
  isConnected: boolean;
  ws: WebSocket | null;
  reconnectAttempts: number;
}

export interface DOMElements {
  connectionDot: HTMLElement;
  channelsList: HTMLElement;
  agentsList: HTMLElement;
  messagesList: HTMLElement;
  currentChannelName: HTMLElement;
  channelTopic: HTMLElement;
  onlineCount: HTMLElement;
  messageInput: HTMLTextAreaElement;
  sendBtn: HTMLButtonElement;
  boldBtn: HTMLButtonElement;
  emojiBtn: HTMLButtonElement;
  searchTrigger: HTMLElement;
  commandPaletteOverlay: HTMLElement;
  paletteSearch: HTMLInputElement;
  paletteResults: HTMLElement;
  paletteChannelsSection: HTMLElement;
  paletteAgentsSection: HTMLElement;
  paletteMessagesSection: HTMLElement;
  typingIndicator: HTMLElement;
  threadPanelOverlay: HTMLElement;
  threadPanelId: HTMLElement;
  threadPanelClose: HTMLButtonElement;
  threadMessages: HTMLElement;
  threadMessageInput: HTMLTextAreaElement;
  threadSendBtn: HTMLButtonElement;
  mentionAutocomplete: HTMLElement;
  mentionAutocompleteList: HTMLElement;
  // Spawn modal elements
  spawnBtn: HTMLButtonElement;
  spawnModalOverlay: HTMLElement;
  spawnModalClose: HTMLButtonElement;
  spawnNameInput: HTMLInputElement;
  spawnCliInput: HTMLInputElement;
  spawnTaskInput: HTMLTextAreaElement;
  spawnSubmitBtn: HTMLButtonElement;
  spawnStatus: HTMLElement;
}

export interface SpawnedAgent {
  name: string;
  cli: string;
  task: string;
  spawnedBy: string;
  spawnedAt: number;
  window: string;
}
