/**
 * Dashboard V2 - Metrics Page
 *
 * System metrics view showing agent health, throughput, and session lifecycle.
 */

'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';

interface AgentMetric {
  name: string;
  messagesSent: number;
  messagesReceived: number;
  firstSeen: string;
  lastSeen: string;
  uptimeSeconds: number;
  isOnline: boolean;
}

interface SessionMetric {
  agentName: string;
  startedAt: string;
  endedAt?: string;
  messageCount: number;
  closedBy?: 'agent' | 'disconnect' | 'error';
}

interface Metrics {
  timestamp: string;
  totalAgents: number;
  onlineAgents: number;
  offlineAgents: number;
  totalMessages: number;
  throughput: {
    messagesLastMinute: number;
    messagesLastHour: number;
    messagesLast24Hours: number;
    avgMessagesPerMinute: number;
  };
  agents: AgentMetric[];
  sessions?: {
    totalSessions: number;
    activeSessions: number;
    closedByAgent: number;
    closedByDisconnect: number;
    closedByError: number;
    errorRate: number;
    recentSessions: SessionMetric[];
  };
}

const COLORS = ['#4a9eff', '#b388ff', '#ff9e40', '#00e676', '#ff5c5c', '#00ffc8'];

function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return COLORS[Math.abs(hash) % COLORS.length];
}

function getInitials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

function formatTime(isoString: string): string {
  return new Date(isoString).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

export default function MetricsPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchMetrics = async () => {
      try {
        const response = await fetch('/api/metrics');
        if (!response.ok) throw new Error('Failed to fetch metrics');
        const data = await response.json();
        setMetrics(data);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load metrics');
      } finally {
        setLoading(false);
      }
    };

    fetchMetrics();
    const interval = setInterval(fetchMetrics, 5000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="metrics-page">
        <style>{styles}</style>
        <div className="loading">
          <div className="spinner" />
          <p>Loading metrics...</p>
        </div>
      </div>
    );
  }

  if (error || !metrics) {
    return (
      <div className="metrics-page">
        <style>{styles}</style>
        <div className="error-state">
          <p>{error || 'No metrics available'}</p>
          <button onClick={() => window.location.reload()}>Retry</button>
        </div>
      </div>
    );
  }

  const errorRateClass = (metrics.sessions?.errorRate ?? 0) <= 1 ? 'healthy' :
                         (metrics.sessions?.errorRate ?? 0) <= 5 ? 'warning' : 'critical';

  return (
    <div className="metrics-page">
      <style>{styles}</style>

      {/* Header */}
      <header className="header">
        <div className="header-content">
          <div className="header-left">
            <Link href="/" className="back-link">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M19 12H5M12 19l-7-7 7-7"/>
              </svg>
              Dashboard
            </Link>
            <div className="logo">
              <div className="logo-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                  <path d="M3 3v18h18"/>
                  <path d="M18 17V9"/>
                  <path d="M13 17V5"/>
                  <path d="M8 17v-3"/>
                </svg>
              </div>
              <div className="logo-text">Agent <span>Metrics</span></div>
            </div>
          </div>
          <div className="live-indicator">
            <span className="live-dot" />
            LIVE
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="main">
        {/* Stats Overview */}
        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-label">Total Agents</div>
            <div className="stat-value accent-cyan">{metrics.totalAgents}</div>
            <div className="stat-subtext">{metrics.onlineAgents} online / {metrics.offlineAgents} offline</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Online Now</div>
            <div className="stat-value accent-green">{metrics.onlineAgents}</div>
            <div className="stat-subtext">
              {metrics.totalAgents > 0 ? Math.round((metrics.onlineAgents / metrics.totalAgents) * 100) : 0}% availability
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Total Messages</div>
            <div className="stat-value accent-blue">{metrics.totalMessages.toLocaleString()}</div>
            <div className="stat-subtext">all time</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Avg. Throughput</div>
            <div className="stat-value accent-orange">{metrics.throughput.avgMessagesPerMinute}</div>
            <div className="stat-subtext">messages / minute</div>
          </div>
        </div>

        {/* Throughput Section */}
        <section className="section">
          <div className="section-header">
            <h2 className="section-title">Message Throughput</h2>
          </div>
          <div className="throughput-panel">
            <div className="throughput-grid">
              <ThroughputItem value={metrics.throughput.messagesLastMinute} label="Last Minute" max={10} />
              <ThroughputItem value={metrics.throughput.messagesLastHour} label="Last Hour" max={100} />
              <ThroughputItem value={metrics.throughput.messagesLast24Hours} label="Last 24 Hours" max={1000} />
              <ThroughputItem value={metrics.throughput.avgMessagesPerMinute} label="Avg / Min" max={5} />
            </div>
          </div>
        </section>

        {/* Session Lifecycle Section */}
        {metrics.sessions && (
          <section className="section">
            <div className="section-header">
              <h2 className="section-title">Session Lifecycle</h2>
              <span className={`error-rate-indicator ${errorRateClass}`}>
                {(metrics.sessions.errorRate || 0).toFixed(1)}% error rate
              </span>
            </div>
            <div className="lifecycle-panel">
              <div className="lifecycle-grid">
                <div className="lifecycle-item">
                  <div className="lifecycle-value accent-purple">{metrics.sessions.totalSessions}</div>
                  <div className="lifecycle-label">Total Sessions</div>
                </div>
                <div className="lifecycle-item">
                  <div className="lifecycle-value accent-blue">{metrics.sessions.activeSessions}</div>
                  <div className="lifecycle-label">Active</div>
                </div>
                <div className="lifecycle-item">
                  <div className="lifecycle-value accent-green">{metrics.sessions.closedByAgent}</div>
                  <div className="lifecycle-label">Clean Close</div>
                </div>
                <div className="lifecycle-item">
                  <div className="lifecycle-value accent-orange">{metrics.sessions.closedByDisconnect}</div>
                  <div className="lifecycle-label">Disconnect</div>
                </div>
                <div className="lifecycle-item">
                  <div className="lifecycle-value accent-red">{metrics.sessions.closedByError}</div>
                  <div className="lifecycle-label">Error</div>
                </div>
              </div>

              {metrics.sessions.recentSessions && metrics.sessions.recentSessions.length > 0 && (
                <table className="sessions-table">
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th>Status</th>
                      <th>Messages</th>
                      <th>Started</th>
                      <th>Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.sessions.recentSessions.slice(0, 5).map((session, i) => {
                      const started = new Date(session.startedAt);
                      const ended = session.endedAt ? new Date(session.endedAt) : new Date();
                      const durationSec = Math.floor((ended.getTime() - started.getTime()) / 1000);
                      const closedClass = session.closedBy || 'active';
                      const closedLabel = !session.closedBy ? 'Active' :
                                         session.closedBy === 'agent' ? 'Clean' :
                                         session.closedBy === 'disconnect' ? 'Disconnect' : 'Error';

                      return (
                        <tr key={i}>
                          <td>
                            <div className="agent-name">
                              <div
                                className="agent-avatar"
                                style={{ background: getAvatarColor(session.agentName) }}
                              >
                                {getInitials(session.agentName)}
                              </div>
                              <span className="agent-name-text">{session.agentName}</span>
                            </div>
                          </td>
                          <td>
                            <span className={`closed-badge ${closedClass}`}>{closedLabel}</span>
                          </td>
                          <td className="metric-cell">{session.messageCount}</td>
                          <td className="uptime-cell">{formatTime(session.startedAt)}</td>
                          <td className="uptime-cell">{formatDuration(durationSec)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        )}

        {/* Agent Health Section */}
        <section className="section">
          <div className="section-header">
            <h2 className="section-title">Agent Health</h2>
          </div>
          <div className="agents-table-container">
            {metrics.agents.length === 0 ? (
              <div className="empty-state">
                <svg className="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                  <circle cx="12" cy="7" r="4"/>
                </svg>
                <p className="empty-state-text">No agents registered yet</p>
              </div>
            ) : (
              <table className="agents-table">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Status</th>
                    <th>Messages Sent</th>
                    <th>Messages Received</th>
                    <th>Uptime</th>
                    <th>Last Seen</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.agents.map((agent) => (
                    <tr key={agent.name}>
                      <td>
                        <div className="agent-name">
                          <div
                            className="agent-avatar"
                            style={{ background: getAvatarColor(agent.name) }}
                          >
                            {getInitials(agent.name)}
                          </div>
                          <span className="agent-name-text">{agent.name}</span>
                        </div>
                      </td>
                      <td>
                        <span className={`status-badge ${agent.isOnline ? 'online' : 'offline'}`}>
                          {agent.isOnline ? 'Online' : 'Offline'}
                        </span>
                      </td>
                      <td className="metric-cell sent">{agent.messagesSent.toLocaleString()}</td>
                      <td className="metric-cell received">{agent.messagesReceived.toLocaleString()}</td>
                      <td className="uptime-cell">{formatDuration(agent.uptimeSeconds)}</td>
                      <td className="uptime-cell">{formatTime(agent.lastSeen)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <div className="last-updated">
          Last updated: {formatTime(metrics.timestamp)}
        </div>
      </main>
    </div>
  );
}

function ThroughputItem({ value, label, max }: { value: number; label: string; max: number }) {
  const percentage = Math.min((value / max) * 100, 100);
  return (
    <div className="throughput-item">
      <div className="throughput-value">{value}</div>
      <div className="throughput-label">{label}</div>
      <div className="throughput-bar">
        <div className="throughput-bar-fill" style={{ width: `${percentage}%` }} />
      </div>
    </div>
  );
}

const styles = `
  .metrics-page {
    min-height: 100vh;
    background: #1a1d21;
    color: #e8e8e8;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }

  .header {
    position: sticky;
    top: 0;
    z-index: 100;
    background: #1a1a2e;
    border-bottom: 1px solid #2a2a3e;
    padding: 16px 32px;
  }

  .header-content {
    max-width: 1400px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .back-link {
    display: flex;
    align-items: center;
    gap: 8px;
    color: #888;
    text-decoration: none;
    font-size: 14px;
    font-weight: 500;
    padding: 8px 12px;
    border-radius: 6px;
    transition: all 0.2s;
  }

  .back-link:hover {
    color: #4a9eff;
    background: rgba(74, 158, 255, 0.1);
  }

  .logo {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .logo-icon {
    width: 32px;
    height: 32px;
    background: linear-gradient(135deg, #1e3a5f 0%, #2a4a6e 100%);
    border: 1px solid #3a5a7e;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .logo-text {
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.3px;
  }

  .logo-text span {
    color: #4a9eff;
  }

  .live-indicator {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: rgba(34, 197, 94, 0.1);
    border: 1px solid rgba(34, 197, 94, 0.3);
    border-radius: 20px;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 12px;
    font-weight: 500;
    color: #22c55e;
  }

  .live-dot {
    width: 8px;
    height: 8px;
    background: #22c55e;
    border-radius: 50%;
    animation: pulse 2s ease-in-out infinite;
    box-shadow: 0 0 10px rgba(34, 197, 94, 0.4);
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.5; transform: scale(0.9); }
  }

  .main {
    position: relative;
    z-index: 1;
    max-width: 1400px;
    margin: 0 auto;
    padding: 24px 32px 48px;
  }

  .loading, .error-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100vh;
    gap: 16px;
  }

  .spinner {
    width: 32px;
    height: 32px;
    border: 2px solid rgba(255, 255, 255, 0.1);
    border-top-color: #4a9eff;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .error-state button {
    padding: 10px 20px;
    background: #1264a3;
    color: white;
    border: none;
    border-radius: 6px;
    cursor: pointer;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 16px;
    margin-bottom: 24px;
  }

  .stat-card {
    background: #222529;
    border: 1px solid #2a2a3e;
    border-radius: 8px;
    padding: 20px;
    transition: all 0.2s ease;
  }

  .stat-card:hover {
    border-color: #3a3a4e;
    background: #282c30;
  }

  .stat-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #888;
    margin-bottom: 8px;
  }

  .stat-value {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 32px;
    font-weight: 700;
    line-height: 1;
  }

  .stat-value.accent-cyan { color: #4a9eff; }
  .stat-value.accent-green { color: #22c55e; }
  .stat-value.accent-orange { color: #f59e0b; }
  .stat-value.accent-blue { color: #6366f1; }

  .stat-subtext {
    font-size: 12px;
    color: #666;
    margin-top: 8px;
    font-family: 'IBM Plex Mono', monospace;
  }

  .section {
    margin-bottom: 24px;
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }

  .section-title {
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: #888;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .section-title::before {
    content: '';
    width: 3px;
    height: 14px;
    background: #4a9eff;
    border-radius: 2px;
  }

  .throughput-panel, .lifecycle-panel {
    background: #222529;
    border: 1px solid #2a2a3e;
    border-radius: 8px;
    padding: 24px;
  }

  .throughput-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 24px;
  }

  .throughput-item {
    text-align: center;
  }

  .throughput-value {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 40px;
    font-weight: 700;
    color: #4a9eff;
    line-height: 1;
  }

  .throughput-label {
    font-size: 12px;
    color: #888;
    margin-top: 8px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .throughput-bar {
    height: 4px;
    background: #2a2a3e;
    border-radius: 2px;
    margin-top: 12px;
    overflow: hidden;
  }

  .throughput-bar-fill {
    height: 100%;
    background: linear-gradient(90deg, #4a9eff, #6366f1);
    border-radius: 2px;
    transition: width 0.5s ease;
  }

  .lifecycle-grid {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 20px;
  }

  .lifecycle-item {
    text-align: center;
  }

  .lifecycle-value {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 32px;
    font-weight: 700;
    line-height: 1;
  }

  .lifecycle-value.accent-purple { color: #a78bfa; }
  .lifecycle-value.accent-red { color: #ef4444; }

  .lifecycle-label {
    font-size: 11px;
    color: #888;
    margin-top: 8px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .error-rate-indicator {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 600;
    font-family: 'IBM Plex Mono', monospace;
  }

  .error-rate-indicator.healthy {
    background: rgba(34, 197, 94, 0.15);
    color: #22c55e;
  }

  .error-rate-indicator.warning {
    background: rgba(245, 158, 11, 0.15);
    color: #f59e0b;
  }

  .error-rate-indicator.critical {
    background: rgba(239, 68, 68, 0.15);
    color: #ef4444;
  }

  .sessions-table, .agents-table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 16px;
  }

  .sessions-table th, .sessions-table td,
  .agents-table th, .agents-table td {
    padding: 12px 16px;
    text-align: left;
  }

  .sessions-table th, .agents-table th {
    background: #1a1a2e;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #888;
    border-bottom: 1px solid #2a2a3e;
  }

  .sessions-table tr, .agents-table tr {
    border-bottom: 1px solid #2a2a3e;
  }

  .sessions-table tr:last-child, .agents-table tr:last-child {
    border-bottom: none;
  }

  .agents-table tr:hover {
    background: rgba(74, 158, 255, 0.03);
  }

  .agents-table-container {
    background: #222529;
    border: 1px solid #2a2a3e;
    border-radius: 8px;
    overflow: hidden;
  }

  .agent-name {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .agent-avatar {
    width: 32px;
    height: 32px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    font-size: 12px;
    color: white;
  }

  .agent-name-text {
    font-weight: 600;
    font-family: 'IBM Plex Mono', monospace;
  }

  .status-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 500;
  }

  .status-badge.online {
    background: rgba(34, 197, 94, 0.15);
    color: #22c55e;
  }

  .status-badge.offline {
    background: rgba(107, 114, 128, 0.15);
    color: #6b7280;
  }

  .status-badge::before {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
  }

  .closed-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 500;
  }

  .closed-badge.agent {
    background: rgba(34, 197, 94, 0.15);
    color: #22c55e;
  }

  .closed-badge.disconnect {
    background: rgba(245, 158, 11, 0.15);
    color: #f59e0b;
  }

  .closed-badge.error {
    background: rgba(239, 68, 68, 0.15);
    color: #ef4444;
  }

  .closed-badge.active {
    background: rgba(74, 158, 255, 0.15);
    color: #4a9eff;
  }

  .metric-cell {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 14px;
  }

  .metric-cell.sent { color: #4a9eff; }
  .metric-cell.received { color: #a78bfa; }

  .uptime-cell {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 13px;
    color: #888;
  }

  .empty-state {
    padding: 48px 32px;
    text-align: center;
  }

  .empty-state-icon {
    width: 48px;
    height: 48px;
    margin: 0 auto 16px;
    color: #666;
    opacity: 0.5;
  }

  .empty-state-text {
    color: #666;
    font-size: 14px;
  }

  .last-updated {
    text-align: center;
    padding: 20px;
    font-size: 12px;
    color: #666;
    font-family: 'IBM Plex Mono', monospace;
  }

  @media (max-width: 1200px) {
    .stats-grid {
      grid-template-columns: repeat(2, 1fr);
    }
    .throughput-grid {
      grid-template-columns: repeat(2, 1fr);
    }
    .lifecycle-grid {
      grid-template-columns: repeat(3, 1fr);
    }
  }

  @media (max-width: 768px) {
    .header {
      padding: 12px 16px;
    }
    .main {
      padding: 16px;
    }
    .stats-grid {
      grid-template-columns: 1fr;
    }
    .throughput-grid {
      grid-template-columns: 1fr;
    }
    .lifecycle-grid {
      grid-template-columns: repeat(2, 1fr);
    }
  }
`;
