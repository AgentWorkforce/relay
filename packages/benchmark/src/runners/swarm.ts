/**
 * Swarm Runner
 *
 * Runs tasks using peer agents that coordinate as equals via messaging.
 */

import type { Task, RunResult, ConfigurationType } from '../types.js';
import { ConfigurationRunner } from './base.js';

/**
 * Runner for swarm (peer-to-peer) configuration
 */
export class SwarmRunner extends ConfigurationRunner {
  private completedPeers = new Set<string>();

  get configurationType(): ConfigurationType {
    return 'swarm';
  }

  async run(task: Task): Promise<RunResult> {
    const startTime = Date.now();
    let firstActionTime = 0;
    let success = false;

    this.resetMetrics();
    this.completedPeers.clear();
    this.log(`Starting task: ${task.id}`);

    // Determine swarm size based on task complexity
    const agentCount = this.determineSwarmSize(task);
    const peerNames: string[] = [];

    try {
      // Set up channel monitoring
      this.setupChannelMonitoring();

      // Partition task among peers
      const subtasks = this.partitionTask(task, agentCount);

      // Spawn peer agents simultaneously
      this.log(`Spawning ${agentCount} peer agents...`);
      const spawnPromises = subtasks.map((subtask, i) =>
        this.orchestrator.spawn({
          name: `Peer${i}`,
          cli: this.config.cli,
          task: this.buildPeerPrompt(subtask, i, agentCount, task),
          cwd: this.config.cwd,
          team: 'swarm',
        })
      );

      const results = await Promise.all(spawnPromises);
      firstActionTime = Date.now() - startTime;
      this.log(`Peers spawned in ${firstActionTime}ms`);

      // Track successful spawns
      for (let i = 0; i < results.length; i++) {
        if (results[i].success) {
          peerNames.push(`Peer${i}`);
          this.metrics.spawnedAgents.push(`Peer${i}`);
        } else {
          this.metrics.errors.push(
            `Peer${i} spawn failed: ${results[i].error}`
          );
        }
      }

      if (peerNames.length === 0) {
        return this.buildFailedResult(task, startTime, this.metrics.errors);
      }

      // Have orchestrator join #swarm channel to monitor
      this.orchestrator.joinChannel('#swarm');

      // Wait for swarm consensus on completion
      success = await this.waitForSwarmCompletion(peerNames, task);

      if (success) {
        this.log(
          `Task completed by swarm of ${peerNames.length} peers`
        );
      } else {
        this.log(
          `Swarm completed ${this.completedPeers.size}/${peerNames.length} subtasks`
        );
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

    return {
      taskId: task.id,
      configuration: 'swarm',
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
        this.metrics.messages / Math.max(1, peerNames.length)
      ),
      agentCount: peerNames.length,
      totalTokensUsed: totalTokens,
      peakMemoryMb: peakMemory,
      success,
      completionRate: this.completedPeers.size / Math.max(1, peerNames.length),
      errors: this.metrics.errors,
      startedAt: startTime,
      completedAt,
    };
  }

  /**
   * Set up channel message monitoring
   */
  private setupChannelMonitoring(): void {
    this.orchestrator.onChannelMessage = (from, channel, body, envelope) => {
      this.metrics.messages++;

      // Track completion announcements
      if (channel === '#swarm' && body.startsWith('DONE:')) {
        this.completedPeers.add(from);
        this.log(`${from} completed: ${body.substring(5).trim()}`);
      }

      // Track errors
      if (body.startsWith('ERROR:') || body.startsWith('BLOCKED:')) {
        this.metrics.errors.push(`${from}: ${body}`);
      }
    };

    this.orchestrator.onMessage = (from, payload, id, meta, originalTo) => {
      this.metrics.messages++;
    };
  }

  /**
   * Determine swarm size based on task complexity and files
   */
  private determineSwarmSize(task: Task): number {
    let baseSize: number;
    switch (task.complexity) {
      case 'low':
        baseSize = 2;
        break;
      case 'medium':
        baseSize = 3;
        break;
      case 'high':
        baseSize = 5;
        break;
      default:
        baseSize = 3;
    }

    // Don't have more agents than files
    const fileCount = task.files.length;
    const size = Math.min(baseSize, fileCount, this.config.maxSwarmSize);

    return Math.max(2, size); // At least 2 for swarm
  }

  /**
   * Partition task files among agents
   */
  private partitionTask(task: Task, count: number): Task[] {
    const filesPerAgent = Math.ceil(task.files.length / count);
    const subtasks: Task[] = [];

    for (let i = 0; i < count; i++) {
      const start = i * filesPerAgent;
      const files = task.files.slice(start, start + filesPerAgent);

      // Handle case where we have more agents than files
      if (files.length === 0) continue;

      subtasks.push({
        ...task,
        id: `${task.id}-part${i}`,
        files,
      });
    }

    return subtasks;
  }

  /**
   * Build prompt for a peer agent
   */
  private buildPeerPrompt(
    subtask: Task,
    index: number,
    totalPeers: number,
    fullTask: Task
  ): string {
    const otherPeers = Array.from({ length: totalPeers }, (_, i) => `Peer${i}`)
      .filter((_, i) => i !== index)
      .join(', ');

    return `You are Peer${index} in a swarm of ${totalPeers} peer agents working together.

## Your Subtask
Work on these files: ${subtask.files.map((f) => `\`${f}\``).join(', ')}

## Full Task Context
${fullTask.description}

## Success Criteria (for full task)
${fullTask.expectedOutcome}

## Peer Coordination

You are working alongside: ${otherPeers}

**Communication via #swarm channel:**

Share your progress:
\`\`\`bash
cat > $AGENT_RELAY_OUTBOX/msg << 'EOF'
TO: #swarm

STATUS: Working on <what you're doing>
EOF
\`\`\`
Then: ->relay-file:msg

Ask questions to the swarm:
\`\`\`bash
cat > $AGENT_RELAY_OUTBOX/msg << 'EOF'
TO: #swarm

QUESTION: <your question>
EOF
\`\`\`
Then: ->relay-file:msg

Report blockers:
\`\`\`bash
cat > $AGENT_RELAY_OUTBOX/msg << 'EOF'
TO: #swarm

BLOCKED: <what's blocking you>
EOF
\`\`\`
Then: ->relay-file:msg

## Completion

When YOUR part is complete:
\`\`\`bash
cat > $AGENT_RELAY_OUTBOX/msg << 'EOF'
TO: #swarm

DONE: Peer${index} completed <brief summary>
EOF
\`\`\`
Then: ->relay-file:msg

## Guidelines

1. Focus on your assigned files
2. Coordinate with peers on shared interfaces/dependencies
3. Don't duplicate work - check the channel for updates
4. Help peers if they're blocked and you can assist`;
  }

  /**
   * Wait for all peers to complete
   */
  private waitForSwarmCompletion(
    peers: string[],
    task: Task
  ): Promise<boolean> {
    const timeoutMs = task.timeoutMs || 300000;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.metrics.errors.push(
          `Swarm timeout: ${this.completedPeers.size}/${peers.length} completed`
        );
        resolve(false);
      }, timeoutMs);

      // Check periodically if all peers are done
      const checkInterval = setInterval(() => {
        if (this.completedPeers.size >= peers.length) {
          clearInterval(checkInterval);
          clearTimeout(timeout);
          resolve(true);
        }
      }, 1000);

      // Also check on each channel message
      const originalHandler = this.orchestrator.onChannelMessage;
      this.orchestrator.onChannelMessage = (from, channel, body, envelope) => {
        if (originalHandler) {
          originalHandler(from, channel, body, envelope);
        }

        if (this.completedPeers.size >= peers.length) {
          clearInterval(checkInterval);
          clearTimeout(timeout);
          resolve(true);
        }
      };
    });
  }
}
