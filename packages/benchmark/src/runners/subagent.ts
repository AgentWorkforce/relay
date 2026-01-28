/**
 * Sub-Agent Runner
 *
 * Runs tasks using a lead agent that spawns and coordinates workers hierarchically.
 */

import type { Task, RunResult, ConfigurationType } from '../types.js';
import { ConfigurationRunner } from './base.js';

/**
 * Runner for sub-agent (hierarchical) configuration
 */
export class SubAgentRunner extends ConfigurationRunner {
  private workerCount = 0;

  get configurationType(): ConfigurationType {
    return 'subagent';
  }

  async run(task: Task): Promise<RunResult> {
    const startTime = Date.now();
    let firstActionTime = 0;
    let success = false;

    this.resetMetrics();
    this.workerCount = 0;
    this.log(`Starting task: ${task.id}`);

    try {
      // Set up message monitoring before spawning
      this.setupMessageMonitoring();

      // Spawn lead agent that will delegate to workers
      const leadResult = await this.orchestrator.spawn({
        name: 'Lead',
        cli: this.config.cli,
        task: this.buildLeadPrompt(task),
        cwd: this.config.cwd,
      });

      if (!leadResult.success) {
        this.metrics.errors.push(leadResult.error || 'Lead spawn failed');
        return this.buildFailedResult(task, startTime, this.metrics.errors);
      }

      this.metrics.spawnedAgents.push('Lead');
      firstActionTime = Date.now() - startTime;
      this.log(`Lead agent spawned in ${firstActionTime}ms`);

      // Wait for lead to complete (including all worker coordination)
      success = await this.waitForLeadCompletion(task);

      if (success) {
        this.log(`Task completed with ${this.workerCount} workers`);
      } else {
        this.log('Task failed or timed out');
      }
    } catch (err) {
      this.metrics.errors.push((err as Error).message);
    }

    // Collect final metrics
    let totalTokens = 0;
    let peakMemory = 0;
    try {
      const metrics = await this.orchestrator.getMetrics();
      totalTokens = this.extractTokens(metrics);
      peakMemory = this.extractMemory(metrics);
    } catch {
      // Metrics collection failed
    }

    const completedAt = Date.now();
    const agentCount = 1 + this.workerCount;

    return {
      taskId: task.id,
      configuration: 'subagent',
      totalTimeMs: completedAt - startTime,
      timeToFirstActionMs: firstActionTime,
      messageCount: this.metrics.messages,
      avgLatencyMs:
        this.metrics.latencies.length > 0
          ? this.metrics.latencies.reduce((a, b) => a + b, 0) /
            this.metrics.latencies.length
          : 0,
      latencyP50Ms: this.percentile(this.metrics.latencies, 50),
      latencyP99Ms: this.percentile(this.metrics.latencies, 99),
      coordinationRounds: Math.ceil(
        this.metrics.messages / Math.max(1, this.workerCount)
      ),
      agentCount,
      totalTokensUsed: totalTokens,
      peakMemoryMb: peakMemory,
      success,
      completionRate: success ? 1.0 : this.workerCount > 0 ? 0.5 : 0.0,
      errors: this.metrics.errors,
      startedAt: startTime,
      completedAt,
    };
  }

  /**
   * Set up message monitoring to track worker spawns and coordination
   */
  private setupMessageMonitoring(): void {
    this.orchestrator.onMessage = (from, payload, id, meta) => {
      this.metrics.messages++;

      // Track when lead spawns workers
      if (from === 'Lead') {
        // Check for spawn patterns in messages
        if (
          payload.body.includes('->relay-file:spawn') ||
          typeof payload.data?.name === 'string'
        ) {
          this.workerCount++;
          const workerName =
            (payload.data?.name as string) || `Worker${this.workerCount}`;
          this.metrics.spawnedAgents.push(workerName);
          this.log(`Worker spawned: ${workerName}`);
        }
      }

      // Track latencies if we have sync metadata
      if (meta?.sync?.correlationId) {
        // This would require tracking send times, simplified here
      }
    };
  }

  /**
   * Wait for the lead agent to signal completion
   */
  private waitForLeadCompletion(task: Task): Promise<boolean> {
    const timeoutMs = task.timeoutMs || 300000;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.metrics.errors.push('Timeout waiting for Lead completion');
        resolve(false);
      }, timeoutMs);

      const originalHandler = this.orchestrator.onMessage;
      this.orchestrator.onMessage = (from, payload, id, meta, originalTo) => {
        // Call existing handler for tracking
        if (originalHandler) {
          originalHandler(from, payload, id, meta, originalTo);
        }

        // Check for completion from Lead
        if (from === 'Lead' && payload.body.startsWith('DONE:')) {
          clearTimeout(timeout);
          resolve(true);
        }

        // Check for fatal errors
        if (from === 'Lead' && payload.body.startsWith('ERROR:')) {
          this.metrics.errors.push(payload.body);
          clearTimeout(timeout);
          resolve(false);
        }
      };
    });
  }

  /**
   * Build the task prompt for the lead agent
   */
  private buildLeadPrompt(task: Task): string {
    const suggestedWorkers = this.suggestWorkerCount(task);

    return `You are the Lead agent. Your job is to delegate subtasks to workers and coordinate their efforts.

## Task
${task.description}

## Files to Work On
${task.files.map((f) => `- ${f}`).join('\n')}

## Success Criteria
${task.expectedOutcome}

## Your Responsibilities

1. **Analyze the task** and break it into subtasks
2. **Spawn workers** for each subtask (suggested: ${suggestedWorkers} workers)
3. **Coordinate** their work and handle dependencies
4. **Aggregate results** and verify success criteria are met

## Spawning Workers

Use the relay protocol to spawn workers:

\`\`\`bash
cat > $AGENT_RELAY_OUTBOX/spawn << 'EOF'
KIND: spawn
NAME: Worker1
CLI: ${this.config.cli}

<Task description for this worker>
EOF
\`\`\`
Then output: ->relay-file:spawn

## Communication Protocol

- Workers will send you status updates
- Monitor for "DONE:" messages from workers
- Handle "BLOCKED:" or "ERROR:" messages by reassigning or helping

## Completion

When ALL subtasks are complete and verified:
\`\`\`
DONE: <summary of what was accomplished, including worker contributions>
\`\`\`

If you encounter an unrecoverable error:
\`\`\`
ERROR: <description of the problem>
\`\`\``;
  }

  /**
   * Suggest number of workers based on task complexity
   */
  private suggestWorkerCount(task: Task): number {
    switch (task.complexity) {
      case 'low':
        return Math.min(2, task.files.length);
      case 'medium':
        return Math.min(3, task.files.length);
      case 'high':
        return Math.min(5, task.files.length, this.config.maxSwarmSize);
      default:
        return 2;
    }
  }
}
