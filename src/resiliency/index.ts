/**
 * Agent Resiliency Module
 *
 * Provides comprehensive health monitoring, auto-restart, logging,
 * metrics, and context persistence for agent-relay agents.
 *
 * Features:
 * - Health monitoring with process liveness checks
 * - Auto-restart on crash with configurable limits
 * - Prometheus-compatible metrics export
 * - Structured JSON logging with rotation
 * - Context persistence across restarts (inspired by Continuous-Claude-v2)
 * - Provider-specific context injection (Claude hooks, Codex config, Gemini instructions)
 *
 * Usage:
 *
 * ```ts
 * import { getSupervisor, metrics, createLogger } from './resiliency';
 *
 * // Start the supervisor with context persistence
 * const supervisor = getSupervisor({
 *   autoRestart: true,
 *   maxRestarts: 5,
 *   contextPersistence: {
 *     enabled: true,
 *     autoInjectOnRestart: true,
 *   },
 * });
 * supervisor.start();
 *
 * // Add an agent to supervision
 * supervisor.supervise(
 *   {
 *     name: 'worker-1',
 *     cli: 'claude',
 *     pid: 12345,
 *     spawnedAt: new Date(),
 *     workingDir: '/path/to/repo',
 *     provider: 'claude', // or 'codex', 'gemini'
 *   },
 *   {
 *     isAlive: () => process.kill(12345, 0),
 *     kill: (sig) => process.kill(12345, sig),
 *     restart: async () => { ... },
 *   }
 * );
 *
 * // Get metrics
 * console.log(metrics.toPrometheus());
 * ```
 *
 * Context persistence works differently per provider:
 * - Claude: Uses hooks to inject context into CLAUDE.md
 * - Codex: Uses config for periodic context refresh via system prompt
 * - Gemini: Updates system instruction file
 */

export {
  AgentHealthMonitor,
  getHealthMonitor,
  type AgentHealth,
  type AgentProcess,
  type HealthMonitorConfig,
} from './health-monitor.js';

export {
  Logger,
  createLogger,
  configure as configureLogging,
  loggers,
  type LogLevel,
  type LogEntry,
  type LoggerConfig,
} from './logger.js';

export { metrics, type AgentMetrics, type SystemMetrics, type MetricPoint } from './metrics.js';

export {
  AgentSupervisor,
  getSupervisor,
  type SupervisedAgent,
  type SupervisorConfig,
} from './supervisor.js';

export {
  ContextPersistence,
  getContextPersistence,
  type AgentState,
  type Decision,
  type Artifact,
  type Handoff,
  type LedgerEntry,
} from './context-persistence.js';

export {
  createContextHandler,
  detectProvider,
  ClaudeContextHandler,
  CodexContextHandler,
  GeminiContextHandler,
  type ProviderType,
  type ProviderContextConfig,
  type ClaudeHooksConfig,
  type CodexContextConfig,
} from './provider-context.js';

export {
  StatelessLeadCoordinator,
  createStatelessLead,
  type BeadsTask,
  type LeadHeartbeat,
  type StatelessLeadConfig,
} from './stateless-lead.js';

export {
  LeaderWatchdog,
  createLeaderWatchdog,
  type LeaderWatchdogConfig,
  type ElectionResult,
} from './leader-watchdog.js';

export {
  GossipHealthMonitor,
  createGossipHealth,
  type GossipHeartbeat,
  type PeerHealth,
  type GossipHealthConfig,
} from './gossip-health.js';
