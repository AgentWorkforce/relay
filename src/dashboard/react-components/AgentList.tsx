/**
 * AgentList Component
 *
 * Displays agents grouped by their hierarchical prefix with
 * collapsible groups and color coding.
 */

import React, { useState, useMemo } from 'react';
import type { Agent } from '../types';
import { AgentCard } from './AgentCard';
import { groupAgents, getGroupStats, filterAgents, getAgentDisplayName, type AgentGroup } from '../lib/hierarchy';
import { STATUS_COLORS } from '../lib/colors';

export interface AgentListProps {
  agents: Agent[];
  selectedAgent?: string;
  searchQuery?: string;
  onAgentSelect?: (agent: Agent) => void;
  onAgentMessage?: (agent: Agent) => void;
  onReleaseClick?: (agent: Agent) => void;
  onLogsClick?: (agent: Agent) => void;
  compact?: boolean;
  showGroupStats?: boolean;
}

export function AgentList({
  agents,
  selectedAgent,
  searchQuery = '',
  onAgentSelect,
  onAgentMessage,
  onReleaseClick,
  onLogsClick,
  compact = false,
  showGroupStats = true,
}: AgentListProps) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [allExpanded, setAllExpanded] = useState(true);

  // Filter and group agents
  const filteredAgents = useMemo(
    () => filterAgents(agents, searchQuery),
    [agents, searchQuery]
  );

  const groups = useMemo(
    () => groupAgents(filteredAgents),
    [filteredAgents]
  );

  // Initialize all groups as expanded
  useMemo(() => {
    if (expandedGroups.size === 0 && groups.length > 0) {
      setExpandedGroups(new Set(groups.map((g) => g.prefix)));
    }
  }, [groups]);

  const toggleGroup = (prefix: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(prefix)) {
        next.delete(prefix);
      } else {
        next.add(prefix);
      }
      return next;
    });
  };

  const toggleAll = () => {
    if (allExpanded) {
      setExpandedGroups(new Set());
    } else {
      setExpandedGroups(new Set(groups.map((g) => g.prefix)));
    }
    setAllExpanded(!allExpanded);
  };

  if (agents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 px-5 text-text-muted text-center">
        <EmptyIcon />
        <p>No agents connected</p>
      </div>
    );
  }

  if (filteredAgents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 px-5 text-text-muted text-center">
        <SearchIcon />
        <p>No agents match "{searchQuery}"</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {groups.length > 1 && (
        <div className="flex justify-between items-center py-2 px-3 text-xs text-text-muted">
          <span>{filteredAgents.length} agents</span>
          <button
            className="bg-transparent border-none text-accent cursor-pointer text-xs hover:underline"
            onClick={toggleAll}
          >
            {allExpanded ? 'Collapse all' : 'Expand all'}
          </button>
        </div>
      )}

      {groups.map((group) => (
        <AgentGroupComponent
          key={group.prefix}
          group={group}
          isExpanded={expandedGroups.has(group.prefix)}
          selectedAgent={selectedAgent}
          compact={compact}
          showStats={showGroupStats}
          onToggle={() => toggleGroup(group.prefix)}
          onAgentSelect={onAgentSelect}
          onAgentMessage={onAgentMessage}
          onReleaseClick={onReleaseClick}
          onLogsClick={onLogsClick}
        />
      ))}
    </div>
  );
}

interface AgentGroupComponentProps {
  group: AgentGroup;
  isExpanded: boolean;
  selectedAgent?: string;
  compact?: boolean;
  showStats?: boolean;
  onToggle: () => void;
  onAgentSelect?: (agent: Agent) => void;
  onAgentMessage?: (agent: Agent) => void;
  onReleaseClick?: (agent: Agent) => void;
  onLogsClick?: (agent: Agent) => void;
}

function AgentGroupComponent({
  group,
  isExpanded,
  selectedAgent,
  compact,
  showStats,
  onToggle,
  onAgentSelect,
  onAgentMessage,
  onReleaseClick,
  onLogsClick,
}: AgentGroupComponentProps) {
  const stats = showStats ? getGroupStats(group.agents) : null;

  // Check if this is a "solo" agent - single agent in group where name matches prefix
  // (e.g., "Lead" agent with no team set creates a "lead" group)
  const isSoloAgent =
    group.agents.length === 1 &&
    group.agents[0].name.toLowerCase() === group.prefix.toLowerCase();

  // For solo agents, render just the card without a group header
  if (isSoloAgent) {
    const agent = group.agents[0];
    return (
      <div className="mb-1 py-1 px-2">
        <AgentCard
          key={agent.name}
          agent={agent}
          isSelected={agent.name === selectedAgent}
          compact={compact}
          onClick={onAgentSelect}
          onMessageClick={onAgentMessage}
          onReleaseClick={onReleaseClick}
          onLogsClick={onLogsClick}
        />
      </div>
    );
  }

  return (
    <div className="mb-1">
      <button
        className="flex items-center gap-2 w-full py-2 px-3 bg-transparent border-none cursor-pointer text-sm text-left rounded transition-colors duration-200 relative hover:bg-[var(--group-light)]"
        onClick={onToggle}
        style={{
          '--group-color': group.color.primary,
          '--group-light': group.color.light,
        } as React.CSSProperties}
      >
        <div
          className="absolute left-0 top-1 bottom-1 w-[3px] rounded-sm"
          style={{ backgroundColor: group.color.primary }}
        />
        <ChevronIcon expanded={isExpanded} />
        <span className="font-semibold text-text-primary">{group.displayName}</span>
        <span className="text-text-muted font-normal">({group.agents.length})</span>

        {showStats && stats && (
          <div className="ml-auto flex gap-2">
            {stats.online > 0 && (
              <span className="flex items-center gap-1 text-xs text-text-muted" title={`${stats.online} agent${stats.online > 1 ? 's' : ''} online`}>
                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: STATUS_COLORS.online }} />
                {stats.online}
              </span>
            )}
            {stats.needsAttention > 0 && (
              <span className="flex items-center gap-1 text-xs text-text-muted" title={`${stats.needsAttention} agent${stats.needsAttention > 1 ? 's' : ''} need${stats.needsAttention === 1 ? 's' : ''} attention`}>
                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: STATUS_COLORS.attention }} />
                {stats.needsAttention}
              </span>
            )}
          </div>
        )}
      </button>

      {isExpanded && (
        <div className="py-1 pl-4 flex flex-col gap-1">
          {group.agents.map((agent) => (
            <AgentCard
              key={agent.name}
              agent={agent}
              isSelected={agent.name === selectedAgent}
              compact={compact}
              displayNameOverride={getAgentDisplayName(agent.name)}
              onClick={onAgentSelect}
              onMessageClick={onAgentMessage}
              onReleaseClick={onReleaseClick}
              onLogsClick={onLogsClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`text-text-muted transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function EmptyIcon() {
  return (
    <svg
      className="mb-3 opacity-50"
      width="48"
      height="48"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
    >
      <circle cx="12" cy="8" r="5" />
      <path d="M20 21a8 8 0 1 0-16 0" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      className="mb-3 opacity-50"
      width="48"
      height="48"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}
