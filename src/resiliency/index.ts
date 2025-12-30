/**
 * Agent Resiliency Module
 *
 * Provides comprehensive health monitoring, auto-restart, logging,
 * and metrics for agent-relay agents.
 *
 * Usage:
 *
 * ```ts
 * import { getSupervisor, metrics, createLogger } from './resiliency';
 *
 * // Start the supervisor
 * const supervisor = getSupervisor({
 *   autoRestart: true,
 *   maxRestarts: 5,
 * });
 * supervisor.start();
 *
 * // Add an agent to supervision
 * supervisor.supervise(
 *   { name: 'worker-1', cli: 'claude', pid: 12345, spawnedAt: new Date() },
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
 */

export {
  AgentHealthMonitor,
  getHealthMonitor,
  type AgentHealth,
  type AgentProcess,
  type HealthMonitorConfig,
} from './health-monitor';

export {
  Logger,
  createLogger,
  configure as configureLogging,
  loggers,
  type LogLevel,
  type LogEntry,
  type LoggerConfig,
} from './logger';

export { metrics, type AgentMetrics, type SystemMetrics, type MetricPoint } from './metrics';

export {
  AgentSupervisor,
  getSupervisor,
  type SupervisedAgent,
  type SupervisorConfig,
} from './supervisor';
