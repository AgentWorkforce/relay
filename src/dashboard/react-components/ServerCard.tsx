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
        className={`server-card server-card-compact ${isSelected ? 'selected' : ''} ${server.status}`}
        onClick={onClick}
      >
        <div className="server-card-status-dot" style={{ backgroundColor: statusColor }} />
        <span className="server-card-name">{server.name}</span>
        <span className="server-card-agents">{server.agentCount}</span>
      </button>
    );
  }

  return (
    <div
      className={`server-card ${isSelected ? 'selected' : ''} ${server.status}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      <div className="server-card-header">
        <div className="server-card-identity">
          <ServerIcon />
          <div className="server-card-info">
            <span className="server-card-name">{server.name}</span>
            {server.region && (
              <span className="server-card-region">{server.region}</span>
            )}
          </div>
        </div>
        <div className="server-card-status" style={{ color: statusColor }}>
          <span className="server-card-status-dot" style={{ backgroundColor: statusColor }} />
          <span>{statusLabel}</span>
        </div>
      </div>

      <div className="server-card-metrics">
        <div className="server-card-metric">
          <span className="server-card-metric-value">{server.agentCount}</span>
          <span className="server-card-metric-label">Agents</span>
        </div>
        {server.messageRate !== undefined && (
          <div className="server-card-metric">
            <span className="server-card-metric-value">{server.messageRate}/s</span>
            <span className="server-card-metric-label">Messages</span>
          </div>
        )}
        {server.latency !== undefined && (
          <div className="server-card-metric">
            <span className="server-card-metric-value">{server.latency}ms</span>
            <span className="server-card-metric-label">Latency</span>
          </div>
        )}
        {server.uptime !== undefined && (
          <div className="server-card-metric">
            <span className="server-card-metric-value">{formatUptime(server.uptime)}</span>
            <span className="server-card-metric-label">Uptime</span>
          </div>
        )}
      </div>

      <div className="server-card-footer">
        <span className="server-card-url">{server.url}</span>
        {server.version && (
          <span className="server-card-version">v{server.version}</span>
        )}
      </div>

      {server.status === 'offline' && onReconnect && (
        <button
          className="server-card-reconnect"
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

/**
 * CSS styles for the server card
 */
export const serverCardStyles = `
.server-card {
  background: #ffffff;
  border: 1px solid #e8e8e8;
  border-radius: 8px;
  padding: 16px;
  cursor: pointer;
  transition: all 0.15s;
}

.server-card:hover {
  border-color: #d0d0d0;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
}

.server-card.selected {
  border-color: #1264a3;
  background: #f8fafc;
}

.server-card.offline {
  opacity: 0.7;
}

.server-card.degraded {
  border-left: 3px solid #f59e0b;
}

.server-card-compact {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: #fafafa;
  border: 1px solid #e8e8e8;
  border-radius: 6px;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}

.server-card-compact:hover {
  background: #f0f0f0;
}

.server-card-compact.selected {
  background: #e8f4fd;
  border-color: #1264a3;
}

.server-card-compact .server-card-name {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  color: #333;
  text-align: left;
}

.server-card-compact .server-card-agents {
  font-size: 12px;
  color: #888;
  background: #f0f0f0;
  padding: 2px 6px;
  border-radius: 10px;
}

.server-card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 16px;
}

.server-card-identity {
  display: flex;
  align-items: center;
  gap: 12px;
}

.server-card-identity svg {
  color: #666;
}

.server-card-info {
  display: flex;
  flex-direction: column;
}

.server-card-name {
  font-weight: 600;
  font-size: 14px;
  color: #1a1a1a;
}

.server-card-region {
  font-size: 12px;
  color: #888;
}

.server-card-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
}

.server-card-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.server-card.connecting .server-card-status-dot {
  animation: pulse 1.5s ease-in-out infinite;
}

.server-card-metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(60px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.server-card-metric {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.server-card-metric-value {
  font-size: 18px;
  font-weight: 600;
  color: #1a1a1a;
}

.server-card-metric-label {
  font-size: 11px;
  color: #888;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.server-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 12px;
  border-top: 1px solid #f0f0f0;
}

.server-card-url {
  font-size: 11px;
  color: #888;
  font-family: 'SF Mono', monospace;
}

.server-card-version {
  font-size: 11px;
  color: #888;
  background: #f5f5f5;
  padding: 2px 6px;
  border-radius: 3px;
}

.server-card-reconnect {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  margin-top: 12px;
  padding: 8px;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 6px;
  color: #dc2626;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}

.server-card-reconnect:hover {
  background: #fee2e2;
  border-color: #f87171;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
`;
