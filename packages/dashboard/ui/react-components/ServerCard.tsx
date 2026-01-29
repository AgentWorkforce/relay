/**
 * ServerCard Component
 *
 * Displays a fleet server's status, connected agents,
 * and health metrics in a compact card format.
 */

import React from 'react';

export interface ServerInfo {
  id: string;
  name: string;
  url: string;
  status: 'online' | 'offline' | 'degraded' | 'connecting';
  agentCount: number;
  messageRate?: number;
  latency?: number;
  uptime?: number;
  version?: string;
  region?: string;
  lastSeen?: string | number;
}

export interface ServerCardProps {
  server: ServerInfo;
  isSelected?: boolean;
  onClick?: () => void;
  onReconnect?: () => void;
  compact?: boolean;
}

export function ServerCard({
  server,
  isSelected = false,
  onClick,
  onReconnect,
  compact = false,
}: ServerCardProps) {
  const statusColor = getStatusColor(server.status);
  const statusLabel = getStatusLabel(server.status);

  if (compact) {
    return (
      <button
        className={`
          flex items-center gap-2 py-2 px-3 bg-bg-tertiary border border-border-subtle rounded-md cursor-pointer font-inherit transition-all duration-150
          hover:bg-bg-hover
          ${isSelected ? 'bg-bg-elevated border-accent-cyan' : ''}
          ${server.status === 'offline' ? 'opacity-70' : ''}
        `}
        onClick={onClick}
      >
        <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: statusColor }} />
        <span className="flex-1 text-sm font-medium text-text-primary text-left">{server.name}</span>
        <span className="text-xs text-text-muted bg-bg-tertiary px-1.5 py-0.5 rounded-full">{server.agentCount}</span>
      </button>
    );
  }

  return (
    <div
      className={`
        bg-bg-card border border-border-subtle rounded-lg p-4 cursor-pointer transition-all duration-150
        hover:border-border-hover hover:shadow-md
        ${isSelected ? 'border-accent-cyan bg-bg-elevated' : ''}
        ${server.status === 'offline' ? 'opacity-70' : ''}
        ${server.status === 'degraded' ? 'border-l-[3px] border-l-warning' : ''}
      `}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <ServerIcon />
          <div className="flex flex-col">
            <span className="font-semibold text-sm text-text-primary">{server.name}</span>
            {server.region && (
              <span className="text-xs text-text-muted">{server.region}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-xs font-medium" style={{ color: statusColor }}>
          <span
            className={`w-2 h-2 rounded-full flex-shrink-0 ${server.status === 'connecting' ? 'animate-pulse' : ''}`}
            style={{ backgroundColor: statusColor }}
          />
          <span>{statusLabel}</span>
        </div>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(60px,1fr))] gap-3 mb-4">
        <div className="flex flex-col items-center text-center">
          <span className="text-lg font-semibold text-text-primary">{server.agentCount}</span>
          <span className="text-[11px] text-text-muted uppercase tracking-wide">Agents</span>
        </div>
        {server.messageRate !== undefined && (
          <div className="flex flex-col items-center text-center">
            <span className="text-lg font-semibold text-text-primary">{server.messageRate}/s</span>
            <span className="text-[11px] text-text-muted uppercase tracking-wide">Messages</span>
          </div>
        )}
        {server.latency !== undefined && (
          <div className="flex flex-col items-center text-center">
            <span className="text-lg font-semibold text-text-primary">{server.latency}ms</span>
            <span className="text-[11px] text-text-muted uppercase tracking-wide">Latency</span>
          </div>
        )}
        {server.uptime !== undefined && (
          <div className="flex flex-col items-center text-center">
            <span className="text-lg font-semibold text-text-primary">{formatUptime(server.uptime)}</span>
            <span className="text-[11px] text-text-muted uppercase tracking-wide">Uptime</span>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between pt-3 border-t border-border-subtle">
        <span className="text-[11px] text-text-muted font-mono">{server.url}</span>
        {server.version && (
          <span className="text-[11px] text-text-muted bg-bg-tertiary px-1.5 py-0.5 rounded">v{server.version}</span>
        )}
      </div>

      {/* Reconnect button */}
      {server.status === 'offline' && onReconnect && (
        <button
          className="flex items-center justify-center gap-1.5 w-full mt-3 py-2 px-3 bg-error/10 border border-error/30 rounded-md text-error text-xs font-medium cursor-pointer font-inherit transition-all duration-150 hover:bg-error/20 hover:border-error/50"
          onClick={(e) => {
            e.stopPropagation();
            onReconnect();
          }}
        >
          <RefreshIcon />
          Reconnect
        </button>
      )}
    </div>
  );
}

// Helper functions
function getStatusColor(status: ServerInfo['status']): string {
  switch (status) {
    case 'online':
      return '#10b981';
    case 'offline':
      return '#ef4444';
    case 'degraded':
      return '#f59e0b';
    case 'connecting':
      return '#6366f1';
    default:
      return '#888888';
  }
}

function getStatusLabel(status: ServerInfo['status']): string {
  switch (status) {
    case 'online':
      return 'Online';
    case 'offline':
      return 'Offline';
    case 'degraded':
      return 'Degraded';
    case 'connecting':
      return 'Connecting...';
    default:
      return 'Unknown';
  }
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

// Icon components
function ServerIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
      <line x1="6" y1="6" x2="6.01" y2="6" />
      <line x1="6" y1="18" x2="6.01" y2="18" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}
