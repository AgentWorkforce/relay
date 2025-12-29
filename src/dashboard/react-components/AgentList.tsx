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
      <div className="agent-list-empty">
        <EmptyIcon />
        <p>No agents connected</p>
      </div>
    );
  }

  if (filteredAgents.length === 0) {
    return (
      <div className="agent-list-empty">
        <SearchIcon />
        <p>No agents match "{searchQuery}"</p>
      </div>
    );
  }

  return (
    <div className="agent-list">
      {groups.length > 1 && (
        <div className="agent-list-header">
          <span className="agent-count">{filteredAgents.length} agents</span>
          <button className="toggle-all-btn" onClick={toggleAll}>
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
}: AgentGroupComponentProps) {
  const stats = showStats ? getGroupStats(group.agents) : null;

  return (
    <div className="agent-group">
      <button
        className="agent-group-header"
        onClick={onToggle}
        style={{
          '--group-color': group.color.primary,
          '--group-light': group.color.light,
        } as React.CSSProperties}
      >
        <div className="group-color-bar" />
        <ChevronIcon expanded={isExpanded} />
        <span className="group-name">{group.displayName}</span>
        <span className="group-count">({group.agents.length})</span>

        {showStats && stats && (
          <div className="group-stats">
            {stats.online > 0 && (
              <span className="stat online">
                <span className="stat-dot" style={{ backgroundColor: STATUS_COLORS.online }} />
                {stats.online}
              </span>
            )}
            {stats.needsAttention > 0 && (
              <span className="stat attention">
                <span className="stat-dot" style={{ backgroundColor: STATUS_COLORS.attention }} />
                {stats.needsAttention}
              </span>
            )}
          </div>
        )}
      </button>

      {isExpanded && (
        <div className="agent-group-content">
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
      className={`chevron-icon ${expanded ? 'expanded' : ''}`}
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

/**
 * CSS styles for the component
 */
export const agentListStyles = `
.agent-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.agent-list-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  font-size: 12px;
  color: #666;
}

.toggle-all-btn {
  background: none;
  border: none;
  color: #1264a3;
  cursor: pointer;
  font-size: 12px;
}

.toggle-all-btn:hover {
  text-decoration: underline;
}

.agent-list-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  color: #888;
  text-align: center;
}

.agent-list-empty svg {
  margin-bottom: 12px;
  opacity: 0.5;
}

.agent-group {
  margin-bottom: 4px;
}

.agent-group-header {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 13px;
  text-align: left;
  border-radius: 4px;
  transition: background 0.2s;
  position: relative;
}

.agent-group-header:hover {
  background: var(--group-light);
}

.group-color-bar {
  position: absolute;
  left: 0;
  top: 4px;
  bottom: 4px;
  width: 3px;
  background: var(--group-color);
  border-radius: 2px;
}

.chevron-icon {
  transition: transform 0.2s;
  color: #888;
}

.chevron-icon.expanded {
  transform: rotate(90deg);
}

.group-name {
  font-weight: 600;
  color: #e8e8e8;
}

.group-count {
  color: #888;
  font-weight: normal;
}

.group-stats {
  margin-left: auto;
  display: flex;
  gap: 8px;
}

.stat {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: #666;
}

.stat-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.agent-group-content {
  padding: 4px 0 4px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
`;
