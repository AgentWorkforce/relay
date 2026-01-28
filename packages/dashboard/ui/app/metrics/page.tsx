/**
 * Dashboard V2 - Metrics Page
 *
 * System metrics view showing agent health, throughput, and session lifecycle.
 * Refined "mission control" aesthetic with Tailwind CSS.
 */

'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { getApiUrl, initializeWorkspaceId } from '../../lib/api';

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

interface AgentMemoryMetric {
  name: string;
  pid?: number;
  status: string;
  rssBytes?: number;
  heapUsedBytes?: number;
  cpuPercent?: number;
  trend?: 'growing' | 'stable' | 'shrinking' | 'unknown';
  trendRatePerMinute?: number;
  alertLevel?: 'normal' | 'warning' | 'critical' | 'oom_imminent';
  highWatermark?: number;
  averageRss?: number;
  uptimeMs?: number;
  startedAt?: string;
}

interface MemoryMetrics {
  agents: AgentMemoryMetric[];
  system: {
    totalMemory: number;
    freeMemory: number;
    heapUsed: number;
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
  const [memoryMetrics, setMemoryMetrics] = useState<MemoryMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [_isCloudMode, setIsCloudMode] = useState(false);

  useEffect(() => {
    // Initialize workspace ID from localStorage for cloud mode
    const workspaceId = initializeWorkspaceId();

    // Check if we're in cloud mode by checking for session endpoint
    const checkCloudMode = async () => {
      try {
        const res = await fetch('/api/auth/session', { credentials: 'include' });
        if (res.status !== 404) {
          setIsCloudMode(true);
          // In cloud mode without workspace, redirect to app to select one
          if (!workspaceId) {
            window.location.href = '/app';
            return false;
          }
        }
        return true;
      } catch {
        return true; // Network error = local mode
      }
    };

    const fetchMetrics = async () => {
      try {
        // Check cloud mode first
        const shouldContinue = await checkCloudMode();
        if (!shouldContinue) return;

        const [metricsRes, memoryRes] = await Promise.all([
          fetch(getApiUrl('/api/metrics'), { credentials: 'include' }),
          fetch(getApiUrl('/api/metrics/agents'), { credentials: 'include' }),
        ]);

        if (!metricsRes.ok) throw new Error('Failed to fetch metrics');
        const data = await metricsRes.json();
        setMetrics(data);

        if (memoryRes.ok) {
          const memData = await memoryRes.json();
          setMemoryMetrics(memData);
        }

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
      <div className="min-h-screen bg-bg-primary text-text-primary font-sans">
        <div className="flex flex-col items-center justify-center h-screen gap-4">
          <div className="w-8 h-8 border-2 border-border border-t-accent rounded-full animate-spin" />
          <p className="text-text-muted text-sm">Loading metrics...</p>
        </div>
      </div>
    );
  }

  if (error || !metrics) {
    return (
      <div className="min-h-screen bg-bg-primary text-text-primary font-sans">
        <div className="flex flex-col items-center justify-center h-screen gap-4">
          <div className="w-12 h-12 rounded-full bg-error/10 flex items-center justify-center">
            <svg className="w-6 h-6 text-error" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <p className="text-text-secondary">{error || 'No metrics available'}</p>
          <button
            onClick={() => window.location.reload()}
            className="px-5 py-2.5 bg-accent text-white rounded-lg text-sm font-medium transition-colors hover:bg-accent-hover"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const errorRateClass = (metrics.sessions?.errorRate ?? 0) <= 1 ? 'healthy' :
                         (metrics.sessions?.errorRate ?? 0) <= 5 ? 'warning' : 'critical';

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary font-sans">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-sidebar-bg border-b border-sidebar-border px-4 md:px-8 py-4">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link
              href="/app"
              className="flex items-center gap-2 text-text-muted text-sm font-medium px-3 py-2 rounded-md transition-all hover:text-accent hover:bg-accent/10"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M19 12H5M12 19l-7-7 7-7"/>
              </svg>
              <span className="hidden sm:inline">Dashboard</span>
            </Link>
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-gradient-to-br from-accent/80 to-accent rounded-lg flex items-center justify-center border border-accent/30">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                  <path d="M3 3v18h18"/>
                  <path d="M18 17V9"/>
                  <path d="M13 17V5"/>
                  <path d="M8 17v-3"/>
                </svg>
              </div>
              <div className="text-lg font-semibold tracking-tight">
                Agent <span className="text-accent">Metrics</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 px-3 py-1.5 bg-success/10 border border-success/30 rounded-full">
            <span className="w-2 h-2 bg-success rounded-full animate-pulse shadow-[0_0_8px_rgba(43,172,118,0.5)]" />
            <span className="text-success text-xs font-semibold font-mono tracking-wide">LIVE</span>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-[1400px] mx-auto px-4 md:px-8 py-6">
        {/* Stats Overview */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard
            label="Total Agents"
            value={metrics.totalAgents}
            subtext={`${metrics.onlineAgents} online / ${metrics.offlineAgents} offline`}
            accent="cyan"
          />
          <StatCard
            label="Online Now"
            value={metrics.onlineAgents}
            subtext={`${metrics.totalAgents > 0 ? Math.round((metrics.onlineAgents / metrics.totalAgents) * 100) : 0}% availability`}
            accent="green"
          />
          <StatCard
            label="Total Messages"
            value={metrics.totalMessages.toLocaleString()}
            subtext="all time"
            accent="purple"
          />
          <StatCard
            label="Avg. Throughput"
            value={metrics.throughput.avgMessagesPerMinute}
            subtext="messages / minute"
            accent="orange"
          />
        </div>

        {/* Throughput Section */}
        <section className="mb-6">
          <SectionHeader title="Message Throughput" />
          <div className="bg-bg-secondary border border-border rounded-lg p-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
              <ThroughputItem value={metrics.throughput.messagesLastMinute} label="Last Minute" max={10} />
              <ThroughputItem value={metrics.throughput.messagesLastHour} label="Last Hour" max={100} />
              <ThroughputItem value={metrics.throughput.messagesLast24Hours} label="Last 24 Hours" max={1000} />
              <ThroughputItem value={metrics.throughput.avgMessagesPerMinute} label="Avg / Min" max={5} />
            </div>
          </div>
        </section>

        {/* Session Lifecycle Section */}
        {metrics.sessions && (
          <section className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <SectionHeader title="Session Lifecycle" />
              <ErrorRateIndicator rate={metrics.sessions.errorRate || 0} status={errorRateClass} />
            </div>
            <div className="bg-bg-secondary border border-border rounded-lg p-6">
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-5 mb-6">
                <LifecycleItem value={metrics.sessions.totalSessions} label="Total Sessions" accent="purple" />
                <LifecycleItem value={metrics.sessions.activeSessions} label="Active" accent="blue" />
                <LifecycleItem value={metrics.sessions.closedByAgent} label="Clean Close" accent="green" />
                <LifecycleItem value={metrics.sessions.closedByDisconnect} label="Disconnect" accent="orange" />
                <LifecycleItem value={metrics.sessions.closedByError} label="Error" accent="red" />
              </div>

              {metrics.sessions.recentSessions && metrics.sessions.recentSessions.length > 0 && (
                <div className="overflow-x-auto -mx-6 px-6">
                  <table className="w-full min-w-[500px]">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left py-3 px-4 text-xs font-semibold uppercase tracking-wider text-text-muted">Agent</th>
                        <th className="text-left py-3 px-4 text-xs font-semibold uppercase tracking-wider text-text-muted">Status</th>
                        <th className="text-left py-3 px-4 text-xs font-semibold uppercase tracking-wider text-text-muted">Messages</th>
                        <th className="text-left py-3 px-4 text-xs font-semibold uppercase tracking-wider text-text-muted">Started</th>
                        <th className="text-left py-3 px-4 text-xs font-semibold uppercase tracking-wider text-text-muted">Duration</th>
                      </tr>
                    </thead>
                    <tbody>
                      {metrics.sessions.recentSessions.slice(0, 5).map((session, i) => {
                        const started = new Date(session.startedAt);
                        const ended = session.endedAt ? new Date(session.endedAt) : new Date();
                        const durationSec = Math.floor((ended.getTime() - started.getTime()) / 1000);

                        return (
                          <tr key={i} className="border-b border-border/50 last:border-0">
                            <td className="py-3 px-4">
                              <AgentCell name={session.agentName} />
                            </td>
                            <td className="py-3 px-4">
                              <SessionStatusBadge closedBy={session.closedBy} />
                            </td>
                            <td className="py-3 px-4 font-mono text-sm text-accent">{session.messageCount}</td>
                            <td className="py-3 px-4 font-mono text-sm text-text-muted">{formatTime(session.startedAt)}</td>
                            <td className="py-3 px-4 font-mono text-sm text-text-muted">{formatDuration(durationSec)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        )}

        {/* Agent Health Section */}
        <section className="mb-6">
          <SectionHeader title="Agent Health" />
          <div className="bg-bg-secondary border border-border rounded-lg overflow-hidden">
            {metrics.agents.length === 0 ? (
              <div className="py-12 text-center">
                <svg className="w-12 h-12 mx-auto mb-4 text-text-muted opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                  <circle cx="12" cy="7" r="4"/>
                </svg>
                <p className="text-text-muted text-sm">No agents registered yet</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[700px]">
                  <thead>
                    <tr className="bg-bg-tertiary border-b border-border">
                      <th className="text-left py-3 px-4 text-xs font-semibold uppercase tracking-wider text-text-muted">Agent</th>
                      <th className="text-left py-3 px-4 text-xs font-semibold uppercase tracking-wider text-text-muted">Status</th>
                      <th className="text-left py-3 px-4 text-xs font-semibold uppercase tracking-wider text-text-muted">Sent</th>
                      <th className="text-left py-3 px-4 text-xs font-semibold uppercase tracking-wider text-text-muted">Received</th>
                      <th className="text-left py-3 px-4 text-xs font-semibold uppercase tracking-wider text-text-muted">Uptime</th>
                      <th className="text-left py-3 px-4 text-xs font-semibold uppercase tracking-wider text-text-muted">Last Seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.agents.map((agent) => (
                      <tr key={agent.name} className="border-b border-border/50 last:border-0 transition-colors hover:bg-bg-hover">
                        <td className="py-3 px-4">
                          <AgentCell name={agent.name} />
                        </td>
                        <td className="py-3 px-4">
                          <OnlineStatusBadge isOnline={agent.isOnline} />
                        </td>
                        <td className="py-3 px-4 font-mono text-sm text-accent">{agent.messagesSent.toLocaleString()}</td>
                        <td className="py-3 px-4 font-mono text-sm text-[#a78bfa]">{agent.messagesReceived.toLocaleString()}</td>
                        <td className="py-3 px-4 font-mono text-sm text-text-muted">{formatDuration(agent.uptimeSeconds)}</td>
                        <td className="py-3 px-4 font-mono text-sm text-text-muted">{formatTime(agent.lastSeen)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        {/* Agent Memory Section */}
        {memoryMetrics && memoryMetrics.agents.length > 0 && (
          <section className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <SectionHeader title="Agent Memory & Resources" />
              <SystemMemoryIndicator system={memoryMetrics.system} />
            </div>
            <div className="bg-bg-secondary border border-border rounded-lg p-6">
              {/* Memory Overview Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                <MemoryStatCard
                  label="Total Agents"
                  value={memoryMetrics.agents.length}
                  subtext="being monitored"
                  accent="cyan"
                />
                <MemoryStatCard
                  label="Healthy"
                  value={memoryMetrics.agents.filter(a => a.alertLevel === 'normal').length}
                  subtext="normal memory"
                  accent="green"
                />
                <MemoryStatCard
                  label="Warning"
                  value={memoryMetrics.agents.filter(a => a.alertLevel === 'warning').length}
                  subtext="elevated usage"
                  accent="orange"
                />
                <MemoryStatCard
                  label="Critical"
                  value={memoryMetrics.agents.filter(a => a.alertLevel === 'critical' || a.alertLevel === 'oom_imminent').length}
                  subtext="needs attention"
                  accent="red"
                />
              </div>

              {/* Agent Memory Cards */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {memoryMetrics.agents.map((agent) => (
                  <AgentMemoryCard key={agent.name} agent={agent} />
                ))}
              </div>
            </div>
          </section>
        )}

        {/* Footer */}
        <div className="text-center py-4 text-text-muted text-xs font-mono">
          Last updated: {formatTime(metrics.timestamp)}
        </div>
      </main>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Sub-components
───────────────────────────────────────────────────────────── */

function StatCard({ label, value, subtext, accent }: {
  label: string;
  value: string | number;
  subtext: string;
  accent: 'cyan' | 'green' | 'purple' | 'orange';
}) {
  const accentColors = {
    cyan: 'text-accent',
    green: 'text-success',
    purple: 'text-[#a78bfa]',
    orange: 'text-warning',
  };

  return (
    <div className="bg-bg-secondary border border-border rounded-lg p-5 transition-all hover:border-border-dark hover:bg-bg-tertiary group">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-2">{label}</div>
      <div className={`font-mono text-3xl font-bold ${accentColors[accent]} transition-transform group-hover:scale-105 origin-left`}>
        {value}
      </div>
      <div className="text-xs text-text-muted font-mono mt-2">{subtext}</div>
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <h2 className="flex items-center gap-2.5 text-xs font-semibold uppercase tracking-wider text-text-muted mb-3">
      <span className="w-[3px] h-3.5 bg-accent rounded-sm" />
      {title}
    </h2>
  );
}

function ThroughputItem({ value, label, max }: { value: number; label: string; max: number }) {
  const percentage = Math.min((value / max) * 100, 100);

  return (
    <div className="text-center">
      <div className="font-mono text-4xl font-bold text-accent leading-none">{value}</div>
      <div className="text-xs text-text-muted uppercase tracking-wide mt-2">{label}</div>
      <div className="h-1 bg-border rounded-full mt-3 overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-accent to-[#6366f1] rounded-full transition-all duration-500"
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}

function LifecycleItem({ value, label, accent }: {
  value: number;
  label: string;
  accent: 'purple' | 'blue' | 'green' | 'orange' | 'red';
}) {
  const accentColors = {
    purple: 'text-[#a78bfa]',
    blue: 'text-accent',
    green: 'text-success',
    orange: 'text-warning',
    red: 'text-error',
  };

  return (
    <div className="text-center">
      <div className={`font-mono text-3xl font-bold ${accentColors[accent]} leading-none`}>{value}</div>
      <div className="text-[11px] text-text-muted uppercase tracking-wide mt-2">{label}</div>
    </div>
  );
}

function ErrorRateIndicator({ rate, status }: { rate: number; status: string }) {
  const statusStyles = {
    healthy: 'bg-success/15 text-success border-success/30',
    warning: 'bg-warning/15 text-warning border-warning/30',
    critical: 'bg-error/15 text-error border-error/30',
  };

  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold font-mono border ${statusStyles[status as keyof typeof statusStyles]}`}>
      {rate.toFixed(1)}% error rate
    </span>
  );
}

function AgentCell({ name }: { name: string }) {
  return (
    <div className="flex items-center gap-3">
      <div
        className="w-8 h-8 rounded-md flex items-center justify-center text-white text-xs font-semibold"
        style={{ backgroundColor: getAvatarColor(name) }}
      >
        {getInitials(name)}
      </div>
      <span className="font-semibold font-mono text-sm">{name}</span>
    </div>
  );
}

function OnlineStatusBadge({ isOnline }: { isOnline: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
      isOnline
        ? 'bg-success/15 text-success'
        : 'bg-bg-hover text-text-muted'
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-success' : 'bg-text-muted'}`} />
      {isOnline ? 'Online' : 'Offline'}
    </span>
  );
}

function SessionStatusBadge({ closedBy }: { closedBy?: 'agent' | 'disconnect' | 'error' }) {
  const statusConfig = {
    agent: { label: 'Clean', className: 'bg-success/15 text-success' },
    disconnect: { label: 'Disconnect', className: 'bg-warning/15 text-warning' },
    error: { label: 'Error', className: 'bg-error/15 text-error' },
    active: { label: 'Active', className: 'bg-accent/15 text-accent' },
  };

  const config = statusConfig[closedBy || 'active'];

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-lg text-[11px] font-medium ${config.className}`}>
      {config.label}
    </span>
  );
}

/* ─────────────────────────────────────────────────────────────
   Memory Monitoring Components
───────────────────────────────────────────────────────────── */

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function SystemMemoryIndicator({ system }: { system: { totalMemory: number; freeMemory: number; heapUsed: number } }) {
  const usedPercent = Math.round(((system.totalMemory - system.freeMemory) / system.totalMemory) * 100);

  return (
    <div className="flex items-center gap-3 px-3 py-1.5 bg-bg-tertiary border border-border rounded-lg">
      <div className="flex items-center gap-2">
        <svg className="w-4 h-4 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <rect x="8" y="8" width="8" height="8" rx="1" fill="currentColor" opacity="0.3" />
        </svg>
        <span className="text-xs text-text-muted">System:</span>
      </div>
      <div className="flex items-center gap-2">
        <div className="w-24 h-2 bg-border rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${
              usedPercent > 90 ? 'bg-error' : usedPercent > 70 ? 'bg-warning' : 'bg-accent'
            }`}
            style={{ width: `${usedPercent}%` }}
          />
        </div>
        <span className="text-xs font-mono text-text-muted">{usedPercent}%</span>
      </div>
      <span className="text-xs font-mono text-text-muted">
        {formatBytes(system.freeMemory)} free
      </span>
    </div>
  );
}

function MemoryStatCard({ label, value, subtext, accent }: {
  label: string;
  value: number;
  subtext: string;
  accent: 'cyan' | 'green' | 'orange' | 'red';
}) {
  const accentColors = {
    cyan: 'text-accent',
    green: 'text-success',
    orange: 'text-warning',
    red: 'text-error',
  };

  return (
    <div className="bg-bg-tertiary border border-border/50 rounded-lg p-4 text-center">
      <div className={`font-mono text-3xl font-bold ${accentColors[accent]} leading-none`}>
        {value}
      </div>
      <div className="text-[11px] text-text-muted uppercase tracking-wide mt-2">{label}</div>
      <div className="text-xs text-text-muted mt-1">{subtext}</div>
    </div>
  );
}

function AgentMemoryCard({ agent }: { agent: AgentMemoryMetric }) {
  const memoryMB = agent.rssBytes ? agent.rssBytes / (1024 * 1024) : 0;
  const maxMemoryMB = 2048; // 2GB max for visualization
  const memoryPercent = Math.min((memoryMB / maxMemoryMB) * 100, 100);

  const alertStyles = {
    normal: { bg: 'bg-success/10', border: 'border-success/30', text: 'text-success', label: 'Healthy' },
    warning: { bg: 'bg-warning/10', border: 'border-warning/30', text: 'text-warning', label: 'Warning' },
    critical: { bg: 'bg-error/10', border: 'border-error/30', text: 'text-error', label: 'Critical' },
    oom_imminent: { bg: 'bg-error/20', border: 'border-error/50', text: 'text-error', label: 'OOM Risk' },
  };

  const trendIcons = {
    growing: { icon: '↑', color: 'text-warning', label: 'Growing' },
    stable: { icon: '→', color: 'text-success', label: 'Stable' },
    shrinking: { icon: '↓', color: 'text-accent', label: 'Shrinking' },
    unknown: { icon: '?', color: 'text-text-muted', label: 'Unknown' },
  };

  const style = alertStyles[agent.alertLevel || 'normal'];
  const trend = trendIcons[agent.trend || 'unknown'];

  return (
    <div className={`${style.bg} border ${style.border} rounded-lg p-4 transition-all hover:scale-[1.01]`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-lg flex items-center justify-center text-white text-sm font-semibold"
            style={{ backgroundColor: getAvatarColor(agent.name) }}
          >
            {getInitials(agent.name)}
          </div>
          <div>
            <div className="font-semibold font-mono text-sm text-text-primary">{agent.name}</div>
            <div className="text-xs text-text-muted">
              PID: {agent.pid || 'N/A'} • {agent.status}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${style.bg} ${style.text}`}>
            {style.label}
          </span>
        </div>
      </div>

      {/* Memory Bar */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs text-text-muted">Memory Usage</span>
          <span className="text-sm font-mono font-semibold text-text-primary">
            {formatBytes(agent.rssBytes || 0)}
          </span>
        </div>
        <div className="h-3 bg-bg-primary rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              (agent.alertLevel === 'critical' || agent.alertLevel === 'oom_imminent')
                ? 'bg-gradient-to-r from-error to-error/70'
                : agent.alertLevel === 'warning'
                ? 'bg-gradient-to-r from-warning to-warning/70'
                : 'bg-gradient-to-r from-accent to-[#6366f1]'
            }`}
            style={{ width: `${memoryPercent}%` }}
          />
        </div>
        <div className="flex items-center justify-between mt-1">
          <span className="text-[10px] text-text-muted">0</span>
          <span className="text-[10px] text-text-muted">2 GB</span>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-3 gap-3">
        <div className="text-center">
          <div className="text-lg font-mono font-bold text-accent">
            {agent.cpuPercent?.toFixed(1) || '0'}%
          </div>
          <div className="text-[10px] text-text-muted uppercase">CPU</div>
        </div>
        <div className="text-center">
          <div className={`text-lg font-mono font-bold ${trend.color} flex items-center justify-center gap-1`}>
            <span>{trend.icon}</span>
            <span className="text-xs">{trend.label}</span>
          </div>
          <div className="text-[10px] text-text-muted uppercase">Trend</div>
        </div>
        <div className="text-center">
          <div className="text-lg font-mono font-bold text-[#a78bfa]">
            {formatBytes(agent.highWatermark || 0)}
          </div>
          <div className="text-[10px] text-text-muted uppercase">Peak</div>
        </div>
      </div>

      {/* Uptime */}
      {agent.uptimeMs && (
        <div className="mt-3 pt-3 border-t border-border/30 flex items-center justify-between">
          <span className="text-xs text-text-muted">Uptime</span>
          <span className="text-xs font-mono text-text-muted">
            {formatDuration(Math.floor(agent.uptimeMs / 1000))}
          </span>
        </div>
      )}
    </div>
  );
}
