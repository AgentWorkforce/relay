import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { getProjectPaths } from '@agent-relay/config';
import { generateAgentName } from '@agent-relay/utils';

import { createAgentRelayClient, formatTableRow, spawnAgentWithClient } from '../lib/index.js';
import type { HealthPayload } from '../lib/monitoring-health.js';

type ExitFn = (code: number) => never;

interface MetricsAgentInfo {
  name: string;
  pid?: number;
  memory_bytes?: number;
  uptime_secs?: number;
}

interface MetricsResponse {
  agents: MetricsAgentInfo[];
}

export interface MonitoringMetricsClient {
  getMetrics(agentName?: string): Promise<MetricsResponse>;
  shutdown(): Promise<unknown>;
}

interface MonitoringProfilerAgent {
  name: string;
}

export interface MonitoringProfilerRelay {
  spawn(options: { name: string; cli: string; args: string[]; channels: string[] }): Promise<unknown>;
  listAgents(): Promise<MonitoringProfilerAgent[]>;
  release(name: string, reason: string): Promise<unknown>;
  shutdown(): Promise<unknown>;
}

interface ProfileRelayOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface MonitoringDependencies {
  getProjectRoot: () => string;
  createMetricsClient: (cwd: string) => MonitoringMetricsClient;
  createProfilerRelay: (options: ProfileRelayOptions) => MonitoringProfilerRelay;
  generateAgentName: () => string;
  fetch: (url: string) => Promise<Response>;
  pathExists: (target: string) => boolean;
  mkdir: (target: string, options: { recursive: true }) => void;
  appendFile: (target: string, content: string) => void;
  memoryUsage: () => NodeJS.MemoryUsage;
  nowIso: () => string;
  onSignal: (signal: NodeJS.Signals, listener: () => void | Promise<void>) => void;
  setRepeatingTimer: (listener: () => void, intervalMs: number) => NodeJS.Timeout;
  clearRepeatingTimer: (timer: NodeJS.Timeout) => void;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  clear: () => void;
  exit: ExitFn;
}

const DEFAULT_DASHBOARD_PORT = process.env.AGENT_RELAY_DASHBOARD_PORT || '3888';

function defaultExit(code: number): never {
  process.exit(code);
}

function createDefaultMetricsClient(cwd: string): MonitoringMetricsClient {
  return createAgentRelayClient({ cwd }) as unknown as MonitoringMetricsClient;
}

function createDefaultProfilerRelay(options: ProfileRelayOptions): MonitoringProfilerRelay {
  const client = createAgentRelayClient({
    cwd: options.cwd,
    env: options.env,
  });

  return {
    spawn: (spawnOptions) =>
      spawnAgentWithClient(client, {
        ...spawnOptions,
      }),
    listAgents: () => client.listAgents(),
    release: (name: string, reason: string) => client.release(name, reason),
    shutdown: () => client.shutdown(),
  };
}

function withDefaults(overrides: Partial<MonitoringDependencies> = {}): MonitoringDependencies {
  return {
    getProjectRoot: () => getProjectPaths().projectRoot,
    createMetricsClient: createDefaultMetricsClient,
    createProfilerRelay: createDefaultProfilerRelay,
    generateAgentName,
    fetch: (url: string) => fetch(url),
    pathExists: (target: string) => fs.existsSync(target),
    mkdir: (target: string, options: { recursive: true }) => fs.mkdirSync(target, options),
    appendFile: (target: string, content: string) => fs.appendFileSync(target, content),
    memoryUsage: () => process.memoryUsage(),
    nowIso: () => new Date().toISOString(),
    onSignal: (signal, listener) => {
      process.on(signal, listener);
    },
    setRepeatingTimer: (listener: () => void, intervalMs: number) => setInterval(listener, intervalMs),
    clearRepeatingTimer: (timer: NodeJS.Timeout) => clearInterval(timer),
    log: (...args: unknown[]) => console.log(...args),
    error: (...args: unknown[]) => console.error(...args),
    clear: () => console.clear(),
    exit: defaultExit,
    ...overrides,
  };
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const index = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
  return `${(bytes / Math.pow(k, index)).toFixed(1)} ${sizes[index]}`;
}

function formatUptime(secs: number): string {
  const ms = secs * 1000;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

export function registerMonitoringCommands(
  program: Command,
  overrides: Partial<MonitoringDependencies> = {}
): void {
  const deps = withDefaults(overrides);

  program
    .command('metrics', { hidden: true })
    .description('Show agent memory metrics and resource usage')
    .option('--agent <name>', 'Show metrics for specific agent')
    .option('--port <port>', 'Dashboard port', DEFAULT_DASHBOARD_PORT)
    .option('--json', 'Output as JSON')
    .option('--watch', 'Continuously update metrics')
    .option('--interval <ms>', 'Update interval for watch mode', '5000')
    .action(
      async (options: {
        agent?: string;
        port?: string;
        json?: boolean;
        watch?: boolean;
        interval?: string;
      }) => {
        const fetchMetrics = async (): Promise<MetricsResponse> => {
          const client = deps.createMetricsClient(deps.getProjectRoot());
          try {
            return await client.getMetrics(options.agent);
          } catch (err: any) {
            deps.error(`Failed to fetch metrics: ${err?.message || String(err)}`);
            deps.exit(1);
          } finally {
            await client.shutdown().catch(() => undefined);
          }

          return { agents: [] };
        };

        const displayMetrics = (data: MetricsResponse): void => {
          let agents = data.agents;

          if (options.agent) {
            agents = agents.filter((agent) => agent.name === options.agent);
            if (agents.length === 0) {
              deps.error(`Agent "${options.agent}" not found`);
              return;
            }
          }

          if (options.json) {
            deps.log(JSON.stringify({ agents }, null, 2));
            return;
          }

          if (options.watch) {
            deps.clear();
            deps.log(`Agent Metrics (updating every ${options.interval}ms)  [Ctrl+C to stop]`);
            deps.log('');
          }

          if (agents.length === 0) {
            deps.log('No agents with memory metrics.');
            deps.log('Ensure agents are running.');
            return;
          }

          deps.log('AGENT           PID      MEMORY      UPTIME');
          deps.log('─'.repeat(55));

          for (const agent of agents) {
            const uptime = formatUptime(agent.uptime_secs || 0);
            deps.log(
              formatTableRow([
                { value: agent.name, width: 15 },
                { value: agent.pid?.toString() || '-', width: 8 },
                { value: formatBytes(agent.memory_bytes || 0), width: 11 },
                { value: uptime },
              ])
            );
          }

          if (!options.watch) {
            deps.log('');
            deps.log(`Total: ${agents.length} agent(s)`);
          }
        };

        if (options.watch) {
          const intervalMs = parseInt(options.interval || '5000', 10);

          const update = async (): Promise<void> => {
            try {
              const data = await fetchMetrics();
              displayMetrics(data);
            } catch {
              // fetchMetrics logs and exits.
            }
          };

          deps.onSignal('SIGINT', () => {
            deps.log('\nStopped watching metrics.');
            deps.exit(0);
          });

          await update();
          deps.setRepeatingTimer(() => {
            void update();
          }, intervalMs);
          return;
        }

        const data = await fetchMetrics();
        displayMetrics(data);
      }
    );

  program
    .command('health')
    .description('Show system health, crash insights, and recommendations')
    .option('--port <port>', 'Dashboard port', DEFAULT_DASHBOARD_PORT)
    .option('--json', 'Output as JSON')
    .option('--crashes', 'Show recent crash history')
    .option('--alerts', 'Show unacknowledged alerts')
    .action(async (options: { port?: string; json?: boolean; crashes?: boolean; alerts?: boolean }) => {
      const port = options.port || DEFAULT_DASHBOARD_PORT;

      try {
        const response = await deps.fetch(`http://localhost:${port}/api/metrics/health`);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = (await response.json()) as HealthPayload;

        if (options.json) {
          deps.log(JSON.stringify(data, null, 2));
          return;
        }

        const scoreColor =
          data.healthScore >= 80 ? '\x1b[32m' : data.healthScore >= 50 ? '\x1b[33m' : '\x1b[31m';
        const resetColor = '\x1b[0m';

        deps.log('');
        deps.log('═══════════════════════════════════════════════════════════════');
        deps.log(`  SYSTEM HEALTH: ${scoreColor}${data.healthScore}/100${resetColor}`);
        deps.log('═══════════════════════════════════════════════════════════════');
        deps.log('');
        deps.log(`  ${data.summary}`);
        deps.log('');
        deps.log(`  Agents: ${data.stats.agentCount}`);
        deps.log(`  Crashes (24h): ${data.stats.totalCrashes24h}`);
        deps.log(`  Alerts (24h): ${data.stats.totalAlerts24h}`);
        deps.log('');

        if (data.issues.length > 0) {
          deps.log('  ISSUES:');
          for (const issue of data.issues) {
            const icon =
              issue.severity === 'critical'
                ? '🔴'
                : issue.severity === 'high'
                  ? '🟠'
                  : issue.severity === 'medium'
                    ? '🟡'
                    : '🔵';
            deps.log(`    ${icon} ${issue.message}`);
          }
          deps.log('');
        }

        if (data.recommendations.length > 0) {
          deps.log('  RECOMMENDATIONS:');
          for (const recommendation of data.recommendations) {
            deps.log(`    → ${recommendation}`);
          }
          deps.log('');
        }

        if (options.crashes && data.crashes.length > 0) {
          deps.log('  RECENT CRASHES:');
          deps.log('  ─────────────────────────────────────────────────────────────');
          for (const crash of data.crashes.slice(0, 10)) {
            const time = new Date(crash.crashedAt).toLocaleString();
            deps.log(`    ${crash.agentName} - ${time}`);
            deps.log(`      Cause: ${crash.likelyCause} | ${crash.summary.slice(0, 60)}...`);
          }
          deps.log('');
        }

        if (options.alerts && data.alerts.length > 0) {
          deps.log('  UNACKNOWLEDGED ALERTS:');
          deps.log('  ─────────────────────────────────────────────────────────────');
          for (const alert of data.alerts.slice(0, 10)) {
            const icon =
              alert.alertType === 'oom_imminent' ? '🔴' : alert.alertType === 'critical' ? '🟠' : '🟡';
            deps.log(`    ${icon} ${alert.agentName} - ${alert.alertType}`);
            deps.log(`      ${alert.message}`);
          }
          deps.log('');
        }

        deps.log('═══════════════════════════════════════════════════════════════');
        deps.log('');

        if (!options.crashes && data.stats.totalCrashes24h > 0) {
          deps.log('  Tip: Run `agent-relay health --crashes` to see crash details');
        }
        if (!options.alerts && data.stats.totalAlerts24h > 0) {
          deps.log('  Tip: Run `agent-relay health --alerts` to see alerts');
        }
        deps.log('');
      } catch (err: any) {
        if (err?.code === 'ECONNREFUSED') {
          deps.error(`Cannot connect to dashboard at port ${port}. Is the broker running?`);
          deps.log(`Run 'agent-relay up' to start the broker.`);
        } else {
          deps.error(`Failed to fetch health data: ${err?.message || String(err)}`);
        }
        deps.exit(1);
      }
    });

  program
    .command('profile', { hidden: true })
    .description('Run an agent with memory profiling enabled')
    .argument('<command...>', 'Command to profile')
    .option('-n, --name <name>', 'Agent name')
    .option('--heap-snapshot-interval <ms>', 'Take heap snapshots at interval (ms)', '60000')
    .option('--output-dir <dir>', 'Directory for profile output', './profiles')
    .option('--expose-gc', 'Expose garbage collector for manual GC')
    .action(
      async (
        commandParts: string[],
        options: {
          name?: string;
          heapSnapshotInterval?: string;
          outputDir?: string;
          exposeGc?: boolean;
        }
      ) => {
        if (!commandParts || commandParts.length === 0) {
          deps.error('No command specified');
          deps.exit(1);
        }

        const [cmd, ...args] = commandParts;
        const agentName = options.name ?? deps.generateAgentName();
        const outputDir = options.outputDir || './profiles';
        const snapshotInterval = parseInt(options.heapSnapshotInterval || '60000', 10);

        if (!deps.pathExists(outputDir)) {
          deps.mkdir(outputDir, { recursive: true });
        }

        deps.log('');
        deps.log('🔬 Agent Relay Profiler');
        deps.log('');
        deps.log(`  Agent: ${agentName}`);
        deps.log(`  Command: ${cmd} ${args.join(' ')}`);
        deps.log(`  Output: ${outputDir}`);
        deps.log(`  Heap snapshots: every ${snapshotInterval}ms`);
        deps.log('');

        const nodeFlags: string[] = ['--inspect', '--inspect-brk=0'];
        if (options.exposeGc) {
          nodeFlags.push('--expose-gc');
        }

        const profileEnv = {
          ...process.env,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} ${nodeFlags.join(' ')}`.trim(),
          AGENT_RELAY_PROFILE_ENABLED: '1',
          AGENT_RELAY_PROFILE_OUTPUT: outputDir,
          AGENT_RELAY_PROFILE_INTERVAL: snapshotInterval.toString(),
        };

        deps.log('Starting profiled agent...');
        deps.log('');

        const relay = deps.createProfilerRelay({
          cwd: deps.getProjectRoot(),
          env: profileEnv,
        });

        const sampleInterval = deps.setRepeatingTimer(() => {
          const memUsage = deps.memoryUsage();
          const sample = {
            timestamp: deps.nowIso(),
            heapUsed: memUsage.heapUsed,
            heapTotal: memUsage.heapTotal,
            external: memUsage.external,
            rss: memUsage.rss,
          };
          const samplesFile = path.join(outputDir, `${agentName}-memory.jsonl`);
          deps.appendFile(samplesFile, `${JSON.stringify(sample)}\n`);
        }, 5000);

        deps.onSignal('SIGINT', () => {
          void (async () => {
            deps.clearRepeatingTimer(sampleInterval);
            deps.log('\n');
            deps.log('Profiling stopped.');
            deps.log('');
            deps.log(`Profile data saved to: ${outputDir}/`);
            deps.log(`  - ${agentName}-memory.jsonl  (memory samples)`);
            deps.log('');
            deps.log('To analyze:');
            deps.log('  1. Open chrome://inspect in Chrome');
            deps.log(`  2. Load CPU/heap profiles from ${outputDir}/`);
            deps.log('');
            try {
              const agents = await relay.listAgents();
              const target = agents.find((agent) => agent.name === agentName);
              if (target) {
                await relay.release(target.name, 'profiling stopped');
              }
            } catch {
              // Best effort shutdown.
            }
            await relay.shutdown().catch(() => undefined);
            deps.exit(0);
          })();
        });

        try {
          await relay.spawn({
            name: agentName,
            cli: cmd,
            args,
            channels: ['general'],
          });
          deps.log(`Profiling ${agentName}... Press Ctrl+C to stop.`);
        } catch (err: any) {
          deps.clearRepeatingTimer(sampleInterval);
          deps.error(`Failed to start profiled agent: ${err?.message || String(err)}`);
          await relay.shutdown().catch(() => undefined);
          deps.exit(1);
        }
      }
    );
}
