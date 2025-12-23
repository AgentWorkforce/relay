/**
 * Dashboard Frontend Module
 *
 * A Slack-like real-time dashboard for Agent Relay communications.
 */

// Re-export all types
export type {
  Agent,
  Message,
  DashboardData,
  SessionInfo,
  AgentSummary,
  ChannelType,
  AppState,
  DOMElements,
} from './types.js';

// Re-export state management
export {
  state,
  subscribe,
  setAgents,
  setMessages,
  setCurrentChannel,
  setConnectionStatus,
  getFilteredMessages,
} from './state.js';

// Re-export utilities
export {
  STALE_THRESHOLD_MS,
  isAgentOnline,
  escapeHtml,
  formatTime,
  formatDate,
  getAvatarColor,
  getInitials,
  formatMessageBody,
} from './utils.js';

// Re-export WebSocket functionality
export { connect, sendMessage, onData } from './websocket.js';

// Re-export UI components
export {
  initElements,
  getElements,
  updateConnectionStatus,
  renderAgents,
  renderMessages,
  selectChannel,
  updateOnlineCount,
  openCommandPalette,
  closeCommandPalette,
  filterPaletteResults,
} from './components.js';

// Re-export app initialization
export { initApp } from './app.js';
