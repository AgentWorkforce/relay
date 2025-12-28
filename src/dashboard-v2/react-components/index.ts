/**
 * Dashboard V2 React Components
 *
 * This module requires React to be installed.
 * Install with: npm install react react-dom
 */

// Core Components
export { AgentCard, agentCardStyles, type AgentCardProps } from './AgentCard';
export { AgentList, agentListStyles, type AgentListProps } from './AgentList';
export { ThinkingIndicator, ThinkingDot, thinkingIndicatorStyles, type ThinkingIndicatorProps } from './ThinkingIndicator';
export { MessageList, messageListStyles, type MessageListProps } from './MessageList';
export { CommandPalette, commandPaletteStyles, type CommandPaletteProps, type Command } from './CommandPalette';
export { SpawnModal, spawnModalStyles, type SpawnModalProps, type SpawnConfig } from './SpawnModal';
export { TrajectoryViewer, trajectoryViewerStyles, type TrajectoryViewerProps, type TrajectoryStep } from './TrajectoryViewer';
export { DecisionQueue, decisionQueueStyles, type DecisionQueueProps, type Decision } from './DecisionQueue';
export { ServerCard, serverCardStyles, type ServerCardProps, type ServerInfo } from './ServerCard';
export { FleetOverview, fleetOverviewStyles, type FleetOverviewProps } from './FleetOverview';
export { BroadcastComposer, broadcastComposerStyles, type BroadcastComposerProps, type BroadcastTarget } from './BroadcastComposer';
export { SettingsPanel, settingsPanelStyles, defaultSettings, type SettingsPanelProps, type Settings } from './SettingsPanel';
export { NotificationToast, notificationToastStyles, useToasts, type NotificationToastProps, type Toast } from './NotificationToast';
export { ThemeProvider, ThemeToggle, themeStyles, themeToggleStyles, useTheme, type ThemeProviderProps, type Theme, type ResolvedTheme } from './ThemeProvider';
export { App, appStyles, type AppProps } from './App';
export { MentionAutocomplete, mentionAutocompleteStyles, useMentionAutocomplete, getMentionQuery, completeMentionInValue, type MentionAutocompleteProps } from './MentionAutocomplete';

// Layout Components
export { Sidebar, sidebarStyles, type SidebarProps } from './layout/Sidebar';
export { Header, headerStyles, type HeaderProps } from './layout/Header';

// Hooks
export {
  useWebSocket,
  useAgents,
  useMessages,
  type UseWebSocketOptions,
  type UseWebSocketReturn,
  type UseAgentsOptions,
  type UseAgentsReturn,
  type UseMessagesOptions,
  type UseMessagesReturn,
  type DashboardData,
  type AgentWithColor,
} from './hooks';

// Combined styles for easy import
export const allStyles = `
/* Agent Card Styles */
${/* agentCardStyles - imported dynamically */ ''}

/* Agent List Styles */
${/* agentListStyles - imported dynamically */ ''}

/* Sidebar Styles */
${/* sidebarStyles - imported dynamically */ ''}

/* Header Styles */
${/* headerStyles - imported dynamically */ ''}
`;
