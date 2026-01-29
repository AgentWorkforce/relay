/**
 * useAgents Hook
 *
 * React hook for managing agent state with hierarchical grouping,
 * filtering, and selection.
 */

import { useState, useMemo, useCallback } from 'react';
import type { Agent } from '../../types';
import {
  groupAgents,
  filterAgents,
  sortAgentsByHierarchy,
  getGroupStats,
  type AgentGroup,
} from '../../lib/hierarchy';
import { getAgentColor, type ColorScheme } from '../../lib/colors';

export interface UseAgentsOptions {
  agents: Agent[];
  initialSelected?: string;
  initialSearchQuery?: string;
}

export interface AgentWithColor extends Agent {
  color: ColorScheme;
}

export interface UseAgentsReturn {
  // Filtered and grouped agents
  agents: Agent[];
  groups: AgentGroup[];
  sortedAgents: Agent[];

  // Selection
  selectedAgent: Agent | null;
  selectAgent: (name: string | null) => void;

  // Search/filter
  searchQuery: string;
  setSearchQuery: (query: string) => void;

  // Stats
  totalCount: number;
  onlineCount: number;
  needsAttentionCount: number;

  // Utilities
  getAgentByName: (name: string) => Agent | undefined;
  getAgentWithColor: (agent: Agent) => AgentWithColor;
}

export function useAgents({
  agents,
  initialSelected,
  initialSearchQuery = '',
}: UseAgentsOptions): UseAgentsReturn {
  const [selectedName, setSelectedName] = useState<string | null>(initialSelected ?? null);
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery);

  // Filter agents by search query
  const filteredAgents = useMemo(
    () => filterAgents(agents, searchQuery),
    [agents, searchQuery]
  );

  // Group agents by prefix
  const groups = useMemo(
    () => groupAgents(filteredAgents),
    [filteredAgents]
  );

  // Sort agents for flat list display
  const sortedAgents = useMemo(
    () => sortAgentsByHierarchy(filteredAgents),
    [filteredAgents]
  );

  // Get selected agent object
  const selectedAgent = useMemo(
    () => agents.find((a) => a.name === selectedName) ?? null,
    [agents, selectedName]
  );

  // Calculate stats
  const stats = useMemo(() => {
    const allStats = getGroupStats(agents);
    return {
      totalCount: allStats.total,
      onlineCount: allStats.online,
      needsAttentionCount: allStats.needsAttention,
    };
  }, [agents]);

  // Selection handler
  const selectAgent = useCallback((name: string | null) => {
    setSelectedName(name);
  }, []);

  // Get agent by name
  const getAgentByName = useCallback(
    (name: string) => agents.find((a) => a.name === name),
    [agents]
  );

  // Get agent with color scheme attached
  const getAgentWithColor = useCallback(
    (agent: Agent): AgentWithColor => ({
      ...agent,
      color: getAgentColor(agent.name),
    }),
    []
  );

  return {
    agents: filteredAgents,
    groups,
    sortedAgents,
    selectedAgent,
    selectAgent,
    searchQuery,
    setSearchQuery,
    ...stats,
    getAgentByName,
    getAgentWithColor,
  };
}
