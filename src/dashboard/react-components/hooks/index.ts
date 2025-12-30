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
