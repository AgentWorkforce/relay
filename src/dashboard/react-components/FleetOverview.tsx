/**
 * FleetOverview Component
 *
 * Displays a grid of fleet servers with aggregate stats,
 * health monitoring, and quick server selection.
 */

import React, { useMemo, useState } from 'react';
import { ServerCard, type ServerInfo } from './ServerCard';
import type { Agent } from '../types';
import { getAgentColor, getAgentInitials } from '../lib/colors';

export interface FleetOverviewProps {
  servers: ServerInfo[];
  agents: Agent[];
  selectedServerId?: string;
  onServerSelect?: (serverId: string) => void;
  onServerReconnect?: (serverId: string) => void;
  isLoading?: boolean;
}

export function FleetOverview({
  servers,
  agents,
  selectedServerId,
  onServerSelect,
  onServerReconnect,
  isLoading = false,
}: FleetOverviewProps) {
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

  // Aggregate stats
  const stats = useMemo(() => {
    const online = servers.filter((s) => s.status === 'online').length;
    const totalAgents = servers.reduce((sum, s) => sum + s.agentCount, 0);
    const avgLatency =
      servers.filter((s) => s.latency !== undefined).length > 0
        ? Math.round(
            servers.reduce((sum, s) => sum + (s.latency || 0), 0) /
              servers.filter((s) => s.latency !== undefined).length
          )
        : null;
    const totalMessages = servers.reduce((sum, s) => sum + (s.messageRate || 0), 0);

    return { online, total: servers.length, totalAgents, avgLatency, totalMessages };
  }, [servers]);

  // Group agents by server (using region as proxy for now)
  const agentsByServer = useMemo(() => {
    const groups: Record<string, Agent[]> = {};
    servers.forEach((s) => {
      groups[s.id] = [];
    });
    // In a real implementation, agents would have a serverId
    // For now, distribute agents across servers
    agents.forEach((agent, i) => {
      const serverIndex = i % servers.length;
      if (servers[serverIndex]) {
        groups[servers[serverIndex].id].push(agent);
      }
    });
    return groups;
  }, [servers, agents]);

  if (isLoading) {
    return (
      <div className="fleet-overview fleet-overview-loading">
        <Spinner />
        <span>Loading fleet data...</span>
      </div>
    );
  }

  if (servers.length === 0) {
    return (
      <div className="fleet-overview fleet-overview-empty">
        <EmptyIcon />
        <h3>No Fleet Servers</h3>
        <p>Connect to peer servers to enable fleet view</p>
      </div>
    );
  }

  return (
    <div className="fleet-overview">
      {/* Header with stats */}
      <div className="fleet-overview-header">
        <div className="fleet-overview-title">
          <FleetIcon />
          <span>Fleet Overview</span>
        </div>

        <div className="fleet-overview-stats">
          <div className="fleet-stat">
            <span className="fleet-stat-value">
              {stats.online}/{stats.total}
            </span>
            <span className="fleet-stat-label">Servers</span>
          </div>
          <div className="fleet-stat">
            <span className="fleet-stat-value">{stats.totalAgents}</span>
            <span className="fleet-stat-label">Agents</span>
          </div>
          {stats.avgLatency !== null && (
            <div className="fleet-stat">
              <span className="fleet-stat-value">{stats.avgLatency}ms</span>
              <span className="fleet-stat-label">Avg Latency</span>
            </div>
          )}
          <div className="fleet-stat">
            <span className="fleet-stat-value">{stats.totalMessages}/s</span>
            <span className="fleet-stat-label">Messages</span>
          </div>
        </div>

        <div className="fleet-overview-controls">
          <button
            className={`fleet-view-btn ${viewMode === 'grid' ? 'active' : ''}`}
            onClick={() => setViewMode('grid')}
            title="Grid view"
          >
            <GridIcon />
          </button>
          <button
            className={`fleet-view-btn ${viewMode === 'list' ? 'active' : ''}`}
            onClick={() => setViewMode('list')}
            title="List view"
          >
            <ListIcon />
          </button>
        </div>
      </div>

      {/* Health bar */}
      <div className="fleet-health-bar">
        {servers.map((server) => (
          <div
            key={server.id}
            className={`fleet-health-segment ${server.status}`}
            style={{ flex: server.agentCount || 1 }}
            title={`${server.name}: ${server.agentCount} agents`}
          />
        ))}
      </div>

      {/* Server grid/list */}
      <div className={`fleet-servers fleet-servers-${viewMode}`}>
        {servers.map((server) => (
          <div key={server.id} className="fleet-server-wrapper">
            <ServerCard
              server={server}
              isSelected={server.id === selectedServerId}
              onClick={() => onServerSelect?.(server.id)}
              onReconnect={() => onServerReconnect?.(server.id)}
              compact={viewMode === 'list'}
            />

            {/* Agent preview for grid view */}
            {viewMode === 'grid' && agentsByServer[server.id]?.length > 0 && (
              <div className="fleet-server-agents">
                {agentsByServer[server.id].slice(0, 5).map((agent) => {
                  const colors = getAgentColor(agent.name);
                  return (
                    <div
                      key={agent.name}
                      className="fleet-agent-avatar"
                      style={{ backgroundColor: colors.primary, color: colors.text }}
                      title={agent.name}
                    >
                      {getAgentInitials(agent.name)}
                    </div>
                  );
                })}
                {agentsByServer[server.id].length > 5 && (
                  <div className="fleet-agent-more">
                    +{agentsByServer[server.id].length - 5}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// Icon components
function FleetIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  );
}

function EmptyIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
      <line x1="6" y1="6" x2="6.01" y2="6" />
      <line x1="6" y1="18" x2="6.01" y2="18" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="fleet-spinner" width="24" height="24" viewBox="0 0 24 24">
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="2"
        fill="none"
        strokeDasharray="32"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * CSS styles for the fleet overview
 */
export const fleetOverviewStyles = `
.fleet-overview {
  background: #ffffff;
  border-radius: 8px;
  border: 1px solid #e8e8e8;
  overflow: hidden;
}

.fleet-overview-loading,
.fleet-overview-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px;
  color: #888;
  text-align: center;
}

.fleet-overview-empty h3 {
  margin: 16px 0 8px;
  font-size: 16px;
  color: #333;
}

.fleet-overview-empty p {
  margin: 0;
  font-size: 13px;
}

.fleet-spinner {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.fleet-overview-header {
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 16px;
  border-bottom: 1px solid #e8e8e8;
  background: #fafafa;
}

.fleet-overview-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 14px;
  color: #333;
}

.fleet-overview-title svg {
  color: #666;
}

.fleet-overview-stats {
  display: flex;
  gap: 24px;
  flex: 1;
}

.fleet-stat {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.fleet-stat-value {
  font-size: 16px;
  font-weight: 600;
  color: #1a1a1a;
}

.fleet-stat-label {
  font-size: 11px;
  color: #888;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.fleet-overview-controls {
  display: flex;
  gap: 4px;
  background: #f0f0f0;
  border-radius: 6px;
  padding: 2px;
}

.fleet-view-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: #888;
  cursor: pointer;
  transition: all 0.15s;
}

.fleet-view-btn:hover {
  color: #333;
}

.fleet-view-btn.active {
  background: #ffffff;
  color: #333;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
}

.fleet-health-bar {
  display: flex;
  height: 4px;
  background: #f0f0f0;
}

.fleet-health-segment {
  transition: flex 0.3s;
}

.fleet-health-segment.online {
  background: #10b981;
}

.fleet-health-segment.offline {
  background: #ef4444;
}

.fleet-health-segment.degraded {
  background: #f59e0b;
}

.fleet-health-segment.connecting {
  background: #6366f1;
}

.fleet-servers {
  padding: 16px;
}

.fleet-servers-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
}

.fleet-servers-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.fleet-server-wrapper {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.fleet-server-agents {
  display: flex;
  gap: 4px;
  padding: 0 8px;
}

.fleet-agent-avatar {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  font-weight: 600;
  border: 2px solid #ffffff;
  margin-left: -4px;
}

.fleet-agent-avatar:first-child {
  margin-left: 0;
}

.fleet-agent-more {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  background: #f0f0f0;
  font-size: 9px;
  font-weight: 600;
  color: #666;
  border: 2px solid #ffffff;
  margin-left: -4px;
}
`;
