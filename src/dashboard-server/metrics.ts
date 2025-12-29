/**
 * Metrics collection and computation for the Agent Relay dashboard.
 * Provides real-time metrics for monitoring: throughput, agent health, error rates.
 */

// Storage types imported for documentation, not currently used in computation
// import type { StorageAdapter, StoredMessage } from '../storage/adapter.js';

export interface AgentMetrics {
  name: string;
  messagesSent: number;
  messagesReceived: number;
  firstSeen: string;
  lastSeen: string;
  isOnline: boolean;
  uptimeSeconds: number;
}

export interface ThroughputMetrics {
  messagesLastMinute: number;
  messagesLastHour: number;
  messagesLast24Hours: number;
  avgMessagesPerMinute: number;
}

export interface SessionMetrics {
  totalSessions: number;
  activeSessions: number;
  closedByAgent: number;
  closedByDisconnect: number;
  closedByError: number;
  errorRate: number; // Percentage of sessions closed by error
  recentSessions: Array<{
    id: string;
    agentName: string;
    startedAt: string;
    endedAt?: string;
    closedBy?: 'agent' | 'disconnect' | 'error';
    messageCount: number;
  }>;
}

export interface SystemMetrics {
  totalAgents: number;
  onlineAgents: number;
  offlineAgents: number;
  totalMessages: number;
  throughput: ThroughputMetrics;
  sessions: SessionMetrics;
  agents: AgentMetrics[];
  timestamp: string;
}

export interface PrometheusMetric {
  name: string;
  help: string;
  type: 'counter' | 'gauge' | 'histogram';
  values: Array<{ labels: Record<string, string>; value: number }>;
}

// Consider agents offline after 5 minutes of inactivity
const OFFLINE_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Compute agent-level metrics from registry data
 */
export function computeAgentMetrics(
  agents: Array<{
    name: string;
    messagesSent: number;
    messagesReceived: number;
    firstSeen: string;
    lastSeen: string;
  }>
): AgentMetrics[] {
  const now = Date.now();

  return agents.map((agent) => {
    const lastSeenTime = new Date(agent.lastSeen).getTime();
    const firstSeenTime = new Date(agent.firstSeen).getTime();
    const isOnline = now - lastSeenTime < OFFLINE_THRESHOLD_MS;
    const uptimeSeconds = Math.floor((now - firstSeenTime) / 1000);

    return {
      name: agent.name,
      messagesSent: agent.messagesSent,
      messagesReceived: agent.messagesReceived,
      firstSeen: agent.firstSeen,
      lastSeen: agent.lastSeen,
      isOnline,
      uptimeSeconds,
    };
  });
}

/**
 * Compute throughput metrics from message history
 */
export function computeThroughputMetrics(messages: Array<{ timestamp: string }>): ThroughputMetrics {
  const now = Date.now();
  const oneMinuteAgo = now - 60 * 1000;
  const oneHourAgo = now - 60 * 60 * 1000;
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  let lastMinute = 0;
  let lastHour = 0;
  let last24Hours = 0;

  for (const msg of messages) {
    const ts = new Date(msg.timestamp).getTime();
    if (ts >= oneMinuteAgo) lastMinute++;
    if (ts >= oneHourAgo) lastHour++;
    if (ts >= oneDayAgo) last24Hours++;
  }

  // Calculate average messages per minute over the last hour
  const avgMessagesPerMinute = lastHour / 60;

  return {
    messagesLastMinute: lastMinute,
    messagesLastHour: lastHour,
    messagesLast24Hours: last24Hours,
    avgMessagesPerMinute: Math.round(avgMessagesPerMinute * 100) / 100,
  };
}

/**
 * Compute session lifecycle metrics from session history
 */
export function computeSessionMetrics(
  sessions: Array<{
    id: string;
    agentName: string;
    startedAt: number;
    endedAt?: number;
    closedBy?: 'agent' | 'disconnect' | 'error';
    messageCount: number;
  }>
): SessionMetrics {
  let activeSessions = 0;
  let closedByAgent = 0;
  let closedByDisconnect = 0;
  let closedByError = 0;

  for (const session of sessions) {
    if (!session.endedAt) {
      activeSessions++;
    } else {
      switch (session.closedBy) {
        case 'agent':
          closedByAgent++;
          break;
        case 'disconnect':
          closedByDisconnect++;
          break;
        case 'error':
          closedByError++;
          break;
        default:
          // Ended but no closedBy - treat as disconnect
          closedByDisconnect++;
      }
    }
  }

  const closedSessions = closedByAgent + closedByDisconnect + closedByError;
  const errorRate = closedSessions > 0 ? (closedByError / closedSessions) * 100 : 0;

  // Format recent sessions for display (most recent 10)
  const recentSessions = sessions
    .slice(0, 10)
    .map((s) => ({
      id: s.id,
      agentName: s.agentName,
      startedAt: new Date(s.startedAt).toISOString(),
      endedAt: s.endedAt ? new Date(s.endedAt).toISOString() : undefined,
      closedBy: s.closedBy,
      messageCount: s.messageCount,
    }));

  return {
    totalSessions: sessions.length,
    activeSessions,
    closedByAgent,
    closedByDisconnect,
    closedByError,
    errorRate: Math.round(errorRate * 100) / 100,
    recentSessions,
  };
}

/**
 * Compute full system metrics
 */
export function computeSystemMetrics(
  agents: Array<{
    name: string;
    messagesSent: number;
    messagesReceived: number;
    firstSeen: string;
    lastSeen: string;
  }>,
  messages: Array<{ timestamp: string }>,
  sessions: Array<{
    id: string;
    agentName: string;
    startedAt: number;
    endedAt?: number;
    closedBy?: 'agent' | 'disconnect' | 'error';
    messageCount: number;
  }> = []
): SystemMetrics {
  const agentMetrics = computeAgentMetrics(agents);
  const throughput = computeThroughputMetrics(messages);
  const sessionMetrics = computeSessionMetrics(sessions);

  const onlineAgents = agentMetrics.filter((a) => a.isOnline).length;
  const totalMessages = agents.reduce((sum, a) => sum + a.messagesSent + a.messagesReceived, 0) / 2; // Divide by 2 since each message is counted twice (sent + received)

  return {
    totalAgents: agents.length,
    onlineAgents,
    offlineAgents: agents.length - onlineAgents,
    totalMessages: Math.round(totalMessages),
    throughput,
    sessions: sessionMetrics,
    agents: agentMetrics,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Format metrics in Prometheus exposition format
 */
export function formatPrometheusMetrics(metrics: SystemMetrics): string {
  const lines: string[] = [];

  // Agent counts
  lines.push('# HELP agent_relay_agents_total Total number of registered agents');
  lines.push('# TYPE agent_relay_agents_total gauge');
  lines.push(`agent_relay_agents_total ${metrics.totalAgents}`);

  lines.push('# HELP agent_relay_agents_online Number of online agents');
  lines.push('# TYPE agent_relay_agents_online gauge');
  lines.push(`agent_relay_agents_online ${metrics.onlineAgents}`);

  // Message throughput
  lines.push('# HELP agent_relay_messages_total Total messages processed');
  lines.push('# TYPE agent_relay_messages_total counter');
  lines.push(`agent_relay_messages_total ${metrics.totalMessages}`);

  lines.push('# HELP agent_relay_messages_last_minute Messages in last minute');
  lines.push('# TYPE agent_relay_messages_last_minute gauge');
  lines.push(`agent_relay_messages_last_minute ${metrics.throughput.messagesLastMinute}`);

  lines.push('# HELP agent_relay_messages_last_hour Messages in last hour');
  lines.push('# TYPE agent_relay_messages_last_hour gauge');
  lines.push(`agent_relay_messages_last_hour ${metrics.throughput.messagesLastHour}`);

  lines.push('# HELP agent_relay_messages_avg_per_minute Average messages per minute');
  lines.push('# TYPE agent_relay_messages_avg_per_minute gauge');
  lines.push(`agent_relay_messages_avg_per_minute ${metrics.throughput.avgMessagesPerMinute}`);

  // Per-agent metrics
  lines.push('# HELP agent_relay_agent_messages_sent Messages sent by agent');
  lines.push('# TYPE agent_relay_agent_messages_sent counter');
  for (const agent of metrics.agents) {
    lines.push(`agent_relay_agent_messages_sent{agent="${agent.name}"} ${agent.messagesSent}`);
  }

  lines.push('# HELP agent_relay_agent_messages_received Messages received by agent');
  lines.push('# TYPE agent_relay_agent_messages_received counter');
  for (const agent of metrics.agents) {
    lines.push(`agent_relay_agent_messages_received{agent="${agent.name}"} ${agent.messagesReceived}`);
  }

  lines.push('# HELP agent_relay_agent_online Agent online status (1=online, 0=offline)');
  lines.push('# TYPE agent_relay_agent_online gauge');
  for (const agent of metrics.agents) {
    lines.push(`agent_relay_agent_online{agent="${agent.name}"} ${agent.isOnline ? 1 : 0}`);
  }

  lines.push('# HELP agent_relay_agent_uptime_seconds Agent uptime in seconds');
  lines.push('# TYPE agent_relay_agent_uptime_seconds gauge');
  for (const agent of metrics.agents) {
    lines.push(`agent_relay_agent_uptime_seconds{agent="${agent.name}"} ${agent.uptimeSeconds}`);
  }

  // Session lifecycle metrics
  lines.push('# HELP agent_relay_sessions_total Total number of sessions');
  lines.push('# TYPE agent_relay_sessions_total counter');
  lines.push(`agent_relay_sessions_total ${metrics.sessions.totalSessions}`);

  lines.push('# HELP agent_relay_sessions_active Number of active sessions');
  lines.push('# TYPE agent_relay_sessions_active gauge');
  lines.push(`agent_relay_sessions_active ${metrics.sessions.activeSessions}`);

  lines.push('# HELP agent_relay_sessions_closed_total Sessions closed by type');
  lines.push('# TYPE agent_relay_sessions_closed_total counter');
  lines.push(`agent_relay_sessions_closed_total{closed_by="agent"} ${metrics.sessions.closedByAgent}`);
  lines.push(`agent_relay_sessions_closed_total{closed_by="disconnect"} ${metrics.sessions.closedByDisconnect}`);
  lines.push(`agent_relay_sessions_closed_total{closed_by="error"} ${metrics.sessions.closedByError}`);

  lines.push('# HELP agent_relay_sessions_error_rate Percentage of sessions closed by error');
  lines.push('# TYPE agent_relay_sessions_error_rate gauge');
  lines.push(`agent_relay_sessions_error_rate ${metrics.sessions.errorRate}`);

  return lines.join('\n') + '\n';
}
