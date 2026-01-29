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
      <div className="bg-bg-card rounded-lg border border-border-subtle overflow-hidden flex flex-col items-center justify-center p-12 text-text-muted text-center">
        <Spinner />
        <span className="mt-3 text-sm">Loading fleet data...</span>
      </div>
    );
  }

  if (servers.length === 0) {
    return (
      <div className="bg-bg-card rounded-lg border border-border-subtle overflow-hidden flex flex-col items-center justify-center p-12 text-text-muted text-center">
        <EmptyIcon />
        <h3 className="mt-4 mb-2 text-base font-semibold text-text-primary">No Fleet Servers</h3>
        <p className="text-sm">Connect to peer servers to enable fleet view</p>
      </div>
    );
  }

  return (
    <div className="bg-bg-card rounded-lg border border-border-subtle overflow-hidden">
      {/* Header with stats */}
      <div className="flex items-center gap-6 p-4 border-b border-border-subtle bg-bg-secondary">
        <div className="flex items-center gap-2 font-semibold text-sm text-text-primary">
          <FleetIcon />
          <span>Fleet Overview</span>
        </div>

        <div className="flex gap-6 flex-1">
          <div className="flex flex-col items-center">
            <span className="text-base font-semibold text-text-primary">
              {stats.online}/{stats.total}
            </span>
            <span className="text-xs text-text-muted uppercase tracking-wide">Servers</span>
          </div>
          <div className="flex flex-col items-center">
            <span className="text-base font-semibold text-text-primary">{stats.totalAgents}</span>
            <span className="text-xs text-text-muted uppercase tracking-wide">Agents</span>
          </div>
          {stats.avgLatency !== null && (
            <div className="flex flex-col items-center">
              <span className="text-base font-semibold text-text-primary">{stats.avgLatency}ms</span>
              <span className="text-xs text-text-muted uppercase tracking-wide">Avg Latency</span>
            </div>
          )}
          <div className="flex flex-col items-center">
            <span className="text-base font-semibold text-text-primary">{stats.totalMessages}/s</span>
            <span className="text-xs text-text-muted uppercase tracking-wide">Messages</span>
          </div>
        </div>

        <div className="flex gap-1 bg-bg-tertiary rounded-md p-0.5">
          <button
            className={`flex items-center justify-center w-7 h-7 bg-transparent border-none rounded cursor-pointer transition-all duration-150 ${
              viewMode === 'grid'
                ? 'bg-bg-card text-text-primary shadow-sm'
                : 'text-text-muted hover:text-text-secondary'
            }`}
            onClick={() => setViewMode('grid')}
            title="Grid view"
          >
            <GridIcon />
          </button>
          <button
            className={`flex items-center justify-center w-7 h-7 bg-transparent border-none rounded cursor-pointer transition-all duration-150 ${
              viewMode === 'list'
                ? 'bg-bg-card text-text-primary shadow-sm'
                : 'text-text-muted hover:text-text-secondary'
            }`}
            onClick={() => setViewMode('list')}
            title="List view"
          >
            <ListIcon />
          </button>
        </div>
      </div>

      {/* Health bar */}
      <div className="flex h-1 bg-bg-tertiary">
        {servers.map((server) => {
          const statusColors: Record<string, string> = {
            online: 'bg-success',
            offline: 'bg-error',
            degraded: 'bg-warning',
            connecting: 'bg-accent-purple',
          };
          return (
            <div
              key={server.id}
              className={`transition-all duration-300 ${statusColors[server.status] || 'bg-text-dim'}`}
              style={{ flex: server.agentCount || 1 }}
              title={`${server.name}: ${server.agentCount} agents`}
            />
          );
        })}
      </div>

      {/* Server grid/list */}
      <div
        className={`p-4 ${
          viewMode === 'grid'
            ? 'grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4'
            : 'flex flex-col gap-2'
        }`}
      >
        {servers.map((server) => (
          <div key={server.id} className="flex flex-col gap-2">
            <ServerCard
              server={server}
              isSelected={server.id === selectedServerId}
              onClick={() => onServerSelect?.(server.id)}
              onReconnect={() => onServerReconnect?.(server.id)}
              compact={viewMode === 'list'}
            />

            {/* Agent preview for grid view */}
            {viewMode === 'grid' && agentsByServer[server.id]?.length > 0 && (
              <div className="flex gap-1 px-2">
                {agentsByServer[server.id].slice(0, 5).map((agent, idx) => {
                  const colors = getAgentColor(agent.name);
                  return (
                    <div
                      key={agent.name}
                      className="w-6 h-6 rounded-md flex items-center justify-center text-[9px] font-semibold border-2 border-bg-card"
                      style={{
                        backgroundColor: colors.primary,
                        color: colors.text,
                        marginLeft: idx > 0 ? '-4px' : 0,
                      }}
                      title={agent.name}
                    >
                      {getAgentInitials(agent.name)}
                    </div>
                  );
                })}
                {agentsByServer[server.id].length > 5 && (
                  <div
                    className="w-6 h-6 rounded-md flex items-center justify-center text-[9px] font-semibold bg-bg-tertiary text-text-muted border-2 border-bg-card"
                    style={{ marginLeft: '-4px' }}
                  >
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
    <svg className="animate-spin" width="24" height="24" viewBox="0 0 24 24">
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
