/**
 * Dashboard V2 React Hooks
 */

export { useWebSocket, type UseWebSocketOptions, type UseWebSocketReturn, type DashboardData } from './useWebSocket';
export { useAgents, type UseAgentsOptions, type UseAgentsReturn, type AgentWithColor } from './useAgents';
export { useMessages, type UseMessagesOptions, type UseMessagesReturn } from './useMessages';
export {
  useOrchestrator,
  type UseOrchestratorOptions,
  type UseOrchestratorResult,
  type OrchestratorAgent,
  type OrchestratorEvent,
} from './useOrchestrator';
export { useAgentLogs, type UseAgentLogsOptions, type UseAgentLogsReturn, type LogLine } from './useAgentLogs';
export {
  useSession,
  type UseSessionOptions,
  type UseSessionReturn,
  type SessionError,
  type CloudUser,
} from './useSession';
export { useTrajectory } from './useTrajectory';
export {
  useRecentRepos,
  type UseRecentReposOptions,
  type UseRecentReposReturn,
  type RecentRepo,
} from './useRecentRepos';
