/**
 * Base Configuration Runner
 *
 * Abstract base class for benchmark configuration runners.
 */

import {
  createRelay,
  RelayClient,
  type MetricsResponsePayload,
  type Relay,
} from '@agent-relay/sdk';
import type {
  ConfigurationType,
  Task,
  RunResult,
  RunMetrics,
  BenchmarkConfig,
} from '../types.js';
import { DEFAULT_BENCHMARK_CONFIG } from '../types.js';

type AgentMetrics = MetricsResponsePayload['agents'][number] & {
  tokens?: number;
  memoryMb?: number;
};

/**
 * Abstract base class for configuration runners
 */
export abstract class ConfigurationRunner {
  protected relay!: Relay;
  protected orchestrator!: RelayClient;
  protected config: BenchmarkConfig;
  protected metrics: RunMetrics = {
    messages: 0,
    latencies: [],
    startTime: 0,
    spawnedAgents: [],
    errors: [],
  };

  constructor(config: Partial<BenchmarkConfig> = {}) {
    this.config = { ...DEFAULT_BENCHMARK_CONFIG, ...config };
  }

  /**
   * Get the configuration type this runner handles
   */
  abstract get configurationType(): ConfigurationType;

  /**
   * Set up the relay and orchestrator client
   */
  async setup(): Promise<void> {
    this.relay = await createRelay({
      socketPath: this.config.socketPath,
      quiet: this.config.quiet,
    });
    this.orchestrator = await this.relay.client('Orchestrator', {
      quiet: this.config.quiet,
    });
    this.resetMetrics();
  }

  /**
   * Run a task and return the result
   */
  abstract run(task: Task): Promise<RunResult>;

  /**
   * Clean up resources
   */
  async teardown(): Promise<void> {
    // Release any remaining agents
    for (const agent of this.metrics.spawnedAgents) {
      try {
        await this.orchestrator.release(agent);
      } catch {
        // Ignore release errors during cleanup
      }
    }

    await this.relay.stop();
  }

  /**
   * Reset metrics for a new run
   */
  protected resetMetrics(): void {
    this.metrics = {
      messages: 0,
      latencies: [],
      startTime: Date.now(),
      spawnedAgents: [],
      errors: [],
    };
  }

  /**
   * Calculate percentile from an array of values
   */
  protected percentile(arr: number[], p: number): number {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  /**
   * Extract total tokens from metrics response
   */
  protected extractTokens(metrics: MetricsResponsePayload): number {
    const agents = metrics.agents as AgentMetrics[] | undefined;
    return (
      agents?.reduce((sum, agent) => sum + (agent.tokens || 0), 0) || 0
    );
  }

  /**
   * Extract peak memory from metrics response
   */
  protected extractMemory(metrics: MetricsResponsePayload): number {
    const agents = metrics.agents as AgentMetrics[] | undefined;
    const memoryValues = agents?.map((agent) => {
      if (agent.memoryMb != null) return agent.memoryMb;
      if (agent.rssBytes != null) return agent.rssBytes / 1024 / 1024;
      return 0;
    });
    return Math.max(...(memoryValues || [0]));
  }

  /**
   * Build a failed result when setup fails
   */
  protected buildFailedResult(
    task: Task,
    startTime: number,
    errors: string[]
  ): RunResult {
    const now = Date.now();
    return {
      taskId: task.id,
      configuration: this.configurationType,
      totalTimeMs: now - startTime,
      timeToFirstActionMs: 0,
      messageCount: 0,
      avgLatencyMs: 0,
      latencyP50Ms: 0,
      latencyP99Ms: 0,
      coordinationRounds: 0,
      agentCount: 0,
      totalTokensUsed: 0,
      peakMemoryMb: 0,
      success: false,
      completionRate: 0,
      errors,
      startedAt: startTime,
      completedAt: now,
    };
  }

  /**
   * Wait for an agent to complete their task
   */
  protected waitForCompletion(
    agentName: string,
    task: Task,
    donePrefix = 'DONE:'
  ): Promise<boolean> {
    const timeoutMs = task.timeoutMs || 300000;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.metrics.errors.push(`Timeout waiting for ${agentName}`);
        resolve(false);
      }, timeoutMs);

      const originalHandler = this.orchestrator.onMessage;
      this.orchestrator.onMessage = (from, payload, id, meta, originalTo) => {
        // Call original handler if exists
        if (originalHandler) {
          originalHandler(from, payload, id, meta, originalTo);
        }

        if (from === agentName && payload.body.startsWith(donePrefix)) {
          clearTimeout(timeout);
          resolve(true);
        }
      };
    });
  }

  /**
   * Log a message if not in quiet mode
   */
  protected log(message: string): void {
    if (!this.config.quiet) {
      console.log(`[${this.configurationType}] ${message}`);
    }
  }
}

// Re-export the DEFAULT_BENCHMARK_CONFIG
export { DEFAULT_BENCHMARK_CONFIG } from '../types.js';
