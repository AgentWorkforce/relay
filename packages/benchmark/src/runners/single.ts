/**
 * Single Agent Runner
 *
 * Runs tasks using a single agent with no delegation.
 */

import type { Task, RunResult, ConfigurationType } from '../types.js';
import { ConfigurationRunner } from './base.js';

/**
 * Runner for single-agent configuration
 */
export class SingleAgentRunner extends ConfigurationRunner {
  get configurationType(): ConfigurationType {
    return 'single';
  }

  async run(task: Task): Promise<RunResult> {
    const startTime = Date.now();
    let firstActionTime = 0;
    let success = false;

    this.resetMetrics();
    this.log(`Starting task: ${task.id}`);

    try {
      // Spawn single agent with full task
      const result = await this.orchestrator.spawn({
        name: 'SoloAgent',
        cli: this.config.cli,
        task: this.buildTaskPrompt(task),
        cwd: this.config.cwd,
      });

      if (!result.success) {
        this.metrics.errors.push(result.error || 'Spawn failed');
        return this.buildFailedResult(task, startTime, this.metrics.errors);
      }

      this.metrics.spawnedAgents.push('SoloAgent');
      firstActionTime = Date.now() - startTime;
      this.log(`Agent spawned in ${firstActionTime}ms`);

      // Wait for completion signal
      success = await this.waitForCompletion('SoloAgent', task);

      if (success) {
        this.log('Task completed successfully');
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
      // Metrics collection failed, use defaults
    }

    const completedAt = Date.now();

    return {
      taskId: task.id,
      configuration: 'single',
      totalTimeMs: completedAt - startTime,
      timeToFirstActionMs: firstActionTime,
      messageCount: 0, // No inter-agent communication
      avgLatencyMs: 0,
      latencyP50Ms: 0,
      latencyP99Ms: 0,
      coordinationRounds: 0,
      agentCount: 1,
      totalTokensUsed: totalTokens,
      peakMemoryMb: peakMemory,
      success,
      completionRate: success ? 1.0 : 0.0,
      errors: this.metrics.errors,
      startedAt: startTime,
      completedAt,
    };
  }

  /**
   * Build the task prompt for a single agent
   */
  private buildTaskPrompt(task: Task): string {
    return `Complete this task entirely on your own:

## Task
${task.description}

## Files to Work On
${task.files.map((f) => `- ${f}`).join('\n')}

## Success Criteria
${task.expectedOutcome}

## Instructions
1. Analyze the task requirements
2. Plan your approach
3. Implement the solution
4. Verify your work meets the success criteria

When complete, send a message to Orchestrator:
\`\`\`
DONE: <brief summary of what you accomplished>
\`\`\`

If you encounter an error you cannot resolve:
\`\`\`
ERROR: <description of the problem>
\`\`\``;
  }
}
