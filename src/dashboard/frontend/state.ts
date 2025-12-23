/**
 * Dashboard State Management
 */

import type { Agent, Message, AppState, ChannelType } from './types.js';

/**
 * Global application state
 */
export const state: AppState = {
  agents: [],
  messages: [],
  currentChannel: 'general',
  currentThread: null,
  isConnected: false,
  ws: null,
  reconnectAttempts: 0,
};

/**
 * State update callbacks
 */
type StateListener = () => void;
const listeners: StateListener[] = [];

/**
 * Subscribe to state changes
 */
export function subscribe(listener: StateListener): () => void {
  listeners.push(listener);
  return () => {
    const index = listeners.indexOf(listener);
    if (index > -1) {
      listeners.splice(index, 1);
    }
  };
}

/**
 * Notify all listeners of state change
 */
function notifyListeners(): void {
  listeners.forEach((listener) => listener());
}

/**
 * Update agents in state
 */
export function setAgents(agents: Agent[]): void {
  state.agents = agents;
  notifyListeners();
}

/**
 * Update messages in state
 */
export function setMessages(messages: Message[]): void {
  state.messages = messages;
  notifyListeners();
}

/**
 * Set current channel/conversation
 */
export function setCurrentChannel(channel: ChannelType): void {
  state.currentChannel = channel;
  notifyListeners();
}

/**
 * Update connection status
 */
export function setConnectionStatus(connected: boolean): void {
  state.isConnected = connected;
  if (connected) {
    state.reconnectAttempts = 0;
  }
  notifyListeners();
}

/**
 * Increment reconnect attempts
 */
export function incrementReconnectAttempts(): void {
  state.reconnectAttempts++;
}

/**
 * Set WebSocket instance
 */
export function setWebSocket(ws: WebSocket | null): void {
  state.ws = ws;
}

/**
 * Filter messages based on current channel
 */
export function getFilteredMessages(): Message[] {
  const { messages, currentChannel } = state;

  if (currentChannel === 'general') {
    return messages;
  }

  // Filter for specific agent - show messages to/from that agent
  return messages.filter(
    (m) => m.from === currentChannel || m.to === currentChannel
  );
}

/**
 * Set current thread for thread panel
 */
export function setCurrentThread(thread: string | null): void {
  state.currentThread = thread;
}

/**
 * Get messages for a specific thread
 */
export function getThreadMessages(threadId: string): Message[] {
  return state.messages.filter((m) => m.thread === threadId);
}

/**
 * Get reply count for a thread
 */
export function getThreadReplyCount(threadId: string): number {
  return state.messages.filter((m) => m.thread === threadId).length;
}
