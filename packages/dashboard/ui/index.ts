/**
 * Dashboard V2 - Main Entry Point
 *
 * Exports all utilities, components, and types for the v2 dashboard.
 */

// Types
export * from './types/index.js';

// Color coding utilities
export {
  getAgentColor,
  getAgentPrefix,
  getAgentInitials,
  parseAgentHierarchy,
  groupAgentsByPrefix,
  sortAgentsByHierarchy,
  getAgentColorVars,
  STATUS_COLORS,
  type ColorScheme,
  type AgentStatus,
} from './lib/colors.js';

// Hierarchy utilities
export {
  buildAgentTree,
  flattenTree,
  groupAgents,
  getAgentDisplayName,
  getAgentBreadcrumb,
  matchesSearch,
  filterAgents,
  getGroupStats,
  type HierarchyNode,
  type AgentGroup,
} from './lib/hierarchy.js';

// API utilities
export {
  api,
  DashboardWebSocket,
  getWebSocket,
  type DashboardData,
} from './lib/api.js';

// React Components (when using React)
// Note: These require React to be installed
// export { AgentCard, agentCardStyles } from './components/AgentCard.js';
// export { AgentList, agentListStyles } from './components/AgentList.js';
