/**
 * Dashboard V2 React Components
 *
 * This module requires React to be installed.
 * Components now use Tailwind CSS for styling.
 * Install with: npm install react react-dom
 */

// Core Components
export { AgentCard, type AgentCardProps } from './AgentCard';
export { AgentList, type AgentListProps } from './AgentList';
export { ThinkingIndicator, ThinkingDot, type ThinkingIndicatorProps } from './ThinkingIndicator';
export { MessageStatusIndicator, type MessageStatusIndicatorProps } from './MessageStatusIndicator';
export { MessageList, type MessageListProps } from './MessageList';
export { ThreadPanel, type ThreadPanelProps } from './ThreadPanel';
export { CommandPalette, type CommandPaletteProps, type Command } from './CommandPalette';
export { SpawnModal, type SpawnModalProps, type SpawnConfig, type SpeakOnTrigger } from './SpawnModal';
export { NewConversationModal, type NewConversationModalProps } from './NewConversationModal';
export { TrajectoryViewer, type TrajectoryViewerProps, type TrajectoryStep } from './TrajectoryViewer';
export { DecisionQueue, type DecisionQueueProps, type Decision } from './DecisionQueue';
export { ServerCard, type ServerCardProps, type ServerInfo } from './ServerCard';
export { FleetOverview, type FleetOverviewProps } from './FleetOverview';
export { BroadcastComposer, type BroadcastComposerProps, type BroadcastTarget } from './BroadcastComposer';
export { defaultSettings, type Settings } from './settings';
export { NotificationToast, useToasts, type NotificationToastProps, type Toast } from './NotificationToast';
export { ThemeProvider, ThemeToggle, useTheme, type ThemeProviderProps, type Theme, type ResolvedTheme } from './ThemeProvider';
export { App, appStyles, type AppProps } from './App';
export { MentionAutocomplete, useMentionAutocomplete, getMentionQuery, completeMentionInValue, type MentionAutocompleteProps } from './MentionAutocomplete';
export { ProjectList, type ProjectListProps } from './ProjectList';
export { WorkspaceSelector, type WorkspaceSelectorProps, type Workspace } from './WorkspaceSelector';
export { WorkspaceSettingsPanel, type WorkspaceSettingsPanelProps } from './settings/WorkspaceSettingsPanel';
export { AddWorkspaceModal, type AddWorkspaceModalProps } from './AddWorkspaceModal';
export { PricingPlans, type PricingPlansProps, type Plan } from './PricingPlans';
export { BillingPanel, type BillingPanelProps, type Subscription, type Invoice, type PaymentMethod } from './BillingPanel';
export { SessionExpiredModal, type SessionExpiredModalProps } from './SessionExpiredModal';
export { ProvisioningProgress, type ProvisioningProgressProps } from './ProvisioningProgress';
export {
  CloudSessionProvider,
  useCloudSession,
  useCloudSessionOptional,
  type CloudSessionProviderProps,
} from './CloudSessionProvider';
export {
  WorkspaceProvider,
  useWorkspace,
  useWorkspaceWsUrl,
  type WorkspaceProviderProps,
} from './WorkspaceContext';

// Terminal Components
export { XTermLogViewer, type XTermLogViewerProps } from './XTermLogViewer';
export { XTermInteractive, type XTermInteractiveProps } from './XTermInteractive';

// Layout Components
export { Sidebar, type SidebarProps } from './layout/Sidebar';
export { Header, type HeaderProps } from './layout/Header';

// Hooks
export {
  useWebSocket,
  useAgents,
  useMessages,
  useOrchestrator,
  useSession,
  type UseWebSocketOptions,
  type UseWebSocketReturn,
  type UseAgentsOptions,
  type UseAgentsReturn,
  type UseMessagesOptions,
  type UseMessagesReturn,
  type UseOrchestratorOptions,
  type UseOrchestratorResult,
  type UseSessionOptions,
  type UseSessionReturn,
  type DashboardData,
  type AgentWithColor,
  type OrchestratorAgent,
  type OrchestratorEvent,
  type SessionError,
  type CloudUser,
} from './hooks';
