# Scheduled Jobs Specification

## Overview

Scheduled jobs enable automatic agent spawning based on time-based schedules (cron) or event triggers. Jobs are project-scoped and defined in a `relay.yaml` configuration file. Agents spawned by jobs automatically release themselves upon completion.

## Goals

- **Automation**: Enable recurring tasks (e.g., weekly changelog generation)
- **Event-driven**: Support trigger-based spawning (webhooks, file changes)
- **Lifecycle Management**: Automatic agent release when jobs complete
- **Multi-agent Support**: Jobs can spawn multiple agents in parallel
- **Resource Management**: Respect MAX_AGENTS limits

## Architecture

### Component: Daemon Scheduler Module

The scheduler is implemented as a daemon component (`packages/daemon/src/scheduler.ts`) rather than a separate service. This provides:

- **Single Process**: Simpler deployment and management
- **Shared Infrastructure**: Leverages daemon logging, health checks, and lifecycle
- **Direct Access**: Direct integration with `AgentSpawner` instance
- **Natural Scoping**: Works seamlessly with project/workspace scoping

### Integration Points

- **Daemon**: Hosts the scheduler service
- **AgentSpawner**: Used for spawning/releasing agents
- **Database**: Stores job run history and state
- **IdleDetector**: Used for completion detection fallback

## Configuration Schema

### File Location

Jobs are defined in `relay.yaml` at the project root:

```yaml
# relay.yaml
jobs:
  - name: weekly-changelog
    schedule: "0 9 * * 5"  # Cron: Friday 9am
    agent:
      name: ChangelogWriter
      cli: claude  # Optional - auto-detected if omitted
      task: "Generate changelog for the past week. Review git commits since last Friday and create a markdown changelog."
    autoRelease: true
    maxDuration: 3600  # Max job duration in seconds (optional, default: 3600)
    enabled: true
    
  - name: on-pr-merge
    trigger:
      type: webhook
      event: pull_request.merged
    agent:
      name: PostMergeReviewer
      task: "Review merged PR for follow-up tasks and technical debt"
    autoRelease: true
    enabled: true
    
  - name: dependency-audit
    trigger:
      type: file-watch
      paths:
        - package.json
        - package-lock.json
    agent:
      name: DependencyAuditor
      task: "Audit dependencies for security vulnerabilities"
    autoRelease: true
    enabled: false  # Disabled by default
    
  - name: parallel-analysis
    schedule: "0 0 * * 0"  # Weekly on Sunday
    agents:  # Multi-agent job
      - name: CodeAnalyzer
        task: "Analyze code quality metrics"
      - name: TestCoverageAnalyzer
        task: "Analyze test coverage gaps"
      - name: PerformanceProfiler
        task: "Profile application performance"
    autoRelease: true
    enabled: true
```

### Schema Definition

```typescript
interface JobConfig {
  name: string;
  schedule?: string;  // Cron expression (required if no trigger)
  trigger?: {
    type: 'webhook' | 'file-watch' | 'manual';
    event?: string;  // For webhook: 'pull_request.merged', 'push', etc.
    paths?: string[];  // For file-watch: array of file paths
  };
  agent?: {
    name: string;
    cli?: string;  // Optional - auto-detected if omitted
    task: string;
  };
  agents?: Array<{  // Multi-agent support
    name: string;
    cli?: string;
    task: string;
  }>;
  autoRelease: boolean;
  maxDuration?: number;  // Max duration in seconds (default: 3600)
  enabled: boolean;
}
```

## Implementation Details

### 1. CLI Auto-Detection

When `cli` is not specified, the scheduler detects the first available authenticated CLI:

**Detection Order:**
1. `claude` (Claude CLI)
2. `cursor` / `agent` (Cursor CLI)
3. `codex` (Codex CLI)
4. `gemini` (Gemini CLI)

**Detection Method:**
- Check environment variables: `GH_TOKEN`, `GITHUB_TOKEN`
- Parse `~/.config/gh/hosts.yml` for authenticated providers
- Execute `gh auth token` command if available
- Query cloud API as fallback (if workspace token available)

**Implementation:**
```typescript
// packages/utils/src/cli-detector.ts
export async function findAvailableCli(): Promise<string | null> {
  const candidates = ['claude', 'cursor', 'agent', 'codex', 'gemini'];
  for (const cli of candidates) {
    if (await isCliAuthenticated(cli)) {
      return cli;
    }
  }
  return null;
}
```

### 2. Job Scheduler Class

```typescript
// packages/daemon/src/scheduler.ts
export class JobScheduler {
  private cronJobs: Map<string, CronJob>;
  private activeJobs: Map<string, JobRun>;
  private spawner: AgentSpawner;
  private storage: StorageAdapter;
  private projectRoot: string;
  
  constructor(config: {
    spawner: AgentSpawner;
    storage: StorageAdapter;
    projectRoot: string;
  }) {
    this.spawner = config.spawner;
    this.storage = config.storage;
    this.projectRoot = config.projectRoot;
    this.cronJobs = new Map();
    this.activeJobs = new Map();
  }
  
  /**
   * Load jobs from relay.yaml
   */
  async loadJobs(): Promise<void> {
    const yamlPath = path.join(this.projectRoot, 'relay.yaml');
    if (!fs.existsSync(yamlPath)) {
      return;
    }
    
    const config = await parseYaml(yamlPath);
    const jobs = config.jobs || [];
    
    for (const jobConfig of jobs) {
      if (!jobConfig.enabled) continue;
      
      if (jobConfig.schedule) {
        await this.scheduleCronJob(jobConfig);
      } else if (jobConfig.trigger?.type === 'webhook') {
        await this.registerWebhookTrigger(jobConfig);
      } else if (jobConfig.trigger?.type === 'file-watch') {
        await this.registerFileWatchTrigger(jobConfig);
      }
    }
  }
  
  /**
   * Trigger a job manually
   */
  async triggerJob(jobName: string): Promise<JobRunResult> {
    const jobConfig = await this.getJobConfig(jobName);
    if (!jobConfig) {
      throw new Error(`Job not found: ${jobName}`);
    }
    
    return await this.executeJob(jobConfig);
  }
  
  /**
   * Execute a job (spawn agents, track completion)
   */
  private async executeJob(jobConfig: JobConfig): Promise<JobRunResult> {
    const runId = generateId();
    const agentNames: string[] = [];
    
    // Check MAX_AGENTS limit
    const maxAgents = parseInt(process.env.MAX_AGENTS || '10', 10);
    const currentAgents = this.spawner.getActiveWorkers().length;
    const agentsToSpawn = jobConfig.agents || [jobConfig.agent!];
    
    if (currentAgents + agentsToSpawn.length > maxAgents) {
      throw new Error(`Job would exceed MAX_AGENTS limit (${currentAgents}/${maxAgents})`);
    }
    
    // Determine CLI for each agent
    const spawnRequests = await Promise.all(
      agentsToSpawn.map(async (agentConfig) => {
        const cli = agentConfig.cli || await findAvailableCli();
        if (!cli) {
          throw new Error('No authenticated CLI found');
        }
        return {
          name: agentConfig.name,
          cli,
          task: agentConfig.task,
          isScheduledJob: true,  // Flag for instruction injection
        };
      })
    );
    
    // Spawn all agents
    const spawnResults = await Promise.all(
      spawnRequests.map(req => this.spawner.spawn(req))
    );
    
    // Track failed spawns
    const failed = spawnResults.filter(r => !r.success);
    if (failed.length > 0) {
      // Release successfully spawned agents
      for (const result of spawnResults) {
        if (result.success) {
          await this.spawner.release(result.name);
        }
      }
      throw new Error(`Failed to spawn ${failed.length} agent(s)`);
    }
    
    // Record agent names
    spawnResults.forEach(r => agentNames.push(r.name!));
    
    // Create job run record
    const jobRun: JobRun = {
      id: runId,
      jobName: jobConfig.name,
      projectRoot: this.projectRoot,
      startedAt: Date.now(),
      status: 'running',
      agentNames,
    };
    this.activeJobs.set(runId, jobRun);
    
    // Wait for completion
    const completionResult = await this.waitForJobCompletion(
      runId,
      jobConfig,
      agentNames,
      jobConfig.maxDuration || 3600
    );
    
    // Update job run status
    jobRun.status = completionResult.status;
    jobRun.completedAt = Date.now();
    jobRun.error = completionResult.error;
    
    // Save to database
    await this.saveJobRun(jobRun);
    
    // Clean up
    this.activeJobs.delete(runId);
    
    return {
      runId,
      status: completionResult.status,
      agentNames,
      duration: jobRun.completedAt! - jobRun.startedAt,
    };
  }
  
  /**
   * Wait for job completion (DONE message or idle timeout)
   */
  private async waitForJobCompletion(
    runId: string,
    jobConfig: JobConfig,
    agentNames: string[],
    maxDurationSeconds: number
  ): Promise<{ status: 'completed' | 'failed' | 'timeout'; error?: string }> {
    const startTime = Date.now();
    const maxDurationMs = maxDurationSeconds * 1000;
    const doneMessages = new Set<string>();
    
    // Set up message listener for DONE messages
    const messageListener = (envelope: Envelope) => {
      if (envelope.to === 'scheduler' && envelope.kind === 'message') {
        const content = envelope.payload as string;
        if (content.includes('DONE:')) {
          // Extract agent name from message
          const match = content.match(/from\s+(\w+)/i);
          if (match && agentNames.includes(match[1])) {
            doneMessages.add(match[1]);
          }
        }
      }
    };
    
    // TODO: Register message listener with daemon router
    
    // Poll for completion
    while (Date.now() - startTime < maxDurationMs) {
      // Check if all agents sent DONE
      if (doneMessages.size === agentNames.length) {
        return { status: 'completed' };
      }
      
      // Check for idle agents (fallback)
      const idleAgents = await Promise.all(
        agentNames.map(async (name) => {
          const worker = this.spawner.getWorker(name);
          if (!worker) return false;
          
          // Use idle detector if available
          // TODO: Integrate with IdleDetector
          return false;  // Placeholder
        })
      );
      
      // If all agents are idle for sufficient time, consider done
      if (idleAgents.every(idle => idle)) {
        await sleep(5000);  // Wait 5s to confirm idle
        const stillIdle = await Promise.all(
          agentNames.map(async (name) => {
            // Re-check idle status
            return false;  // Placeholder
          })
        );
        if (stillIdle.every(idle => idle)) {
          return { status: 'completed' };
        }
      }
      
      // Check if any agents crashed
      const activeAgents = agentNames.filter(name => 
        this.spawner.hasWorker(name)
      );
      if (activeAgents.length < agentNames.length) {
        return {
          status: 'failed',
          error: `Agent(s) crashed: ${agentNames.filter(n => !activeAgents.includes(n)).join(', ')}`,
        };
      }
      
      await sleep(1000);  // Poll every second
    }
    
    // Timeout
    return {
      status: 'timeout',
      error: `Job exceeded max duration (${maxDurationSeconds}s)`,
    };
  }
  
  /**
   * Schedule a cron job
   */
  private async scheduleCronJob(jobConfig: JobConfig): Promise<void> {
    const cronJob = new CronJob(jobConfig.schedule!, async () => {
      try {
        await this.executeJob(jobConfig);
      } catch (err) {
        log.error(`Job ${jobConfig.name} failed:`, err);
      }
    });
    
    this.cronJobs.set(jobConfig.name, cronJob);
    cronJob.start();
  }
  
  /**
   * Save job run to database
   */
  private async saveJobRun(jobRun: JobRun): Promise<void> {
    // TODO: Implement database save
    // Use storage adapter to save job run
  }
}
```

### 3. Agent Instructions Injection

When spawning agents from scheduled jobs, inject additional instructions:

```typescript
// In spawner.ts, modify getRelayInstructions()
function getRelayInstructions(
  agentName: string,
  options: {
    hasMcp?: boolean;
    includeWorkflowConventions?: boolean;
    isScheduledJob?: boolean;  // New option
  } = {}
): string {
  // ... existing instructions ...
  
  if (options.isScheduledJob) {
    parts.push(
      '',
      '## Job Completion Protocol',
      '',
      'You are running as part of a scheduled job. When your task is complete:',
      '',
      '1. Send a DONE message to the scheduler:',
      '```bash',
      `cat > ${outboxBase}/done << 'EOF'`,
      'TO: scheduler',
      '',
      'DONE: Brief summary of what was completed',
      'EOF',
      '```',
      'Then: `->relay-file:done`',
      '',
      '2. Release yourself:',
      '```bash',
      `cat > ${outboxBase}/release << 'EOF'`,
      'KIND: release',
      'NAME: ' + agentName,
      'EOF',
      '```',
      'Then: `->relay-file:release`',
    );
  }
  
  return parts.join('\n');
}
```

### 4. Database Schema

```sql
-- Job runs table
CREATE TABLE job_runs (
  id TEXT PRIMARY KEY,
  job_name TEXT NOT NULL,
  project_root TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  status TEXT NOT NULL,  -- 'running', 'completed', 'failed', 'timeout'
  agent_names TEXT[] NOT NULL,  -- Array of spawned agent names
  error TEXT,
  logs_path TEXT,
  metadata JSONB,  -- Additional metadata (duration, etc.)
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_job_runs_job_name ON job_runs(job_name);
CREATE INDEX idx_job_runs_project_root ON job_runs(project_root);
CREATE INDEX idx_job_runs_status ON job_runs(status);
CREATE INDEX idx_job_runs_started_at ON job_runs(started_at DESC);

-- Job configurations (cached from relay.yaml)
CREATE TABLE job_configs (
  id TEXT PRIMARY KEY,
  job_name TEXT NOT NULL,
  project_root TEXT NOT NULL,
  config JSONB NOT NULL,  -- Full job config
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_loaded_at TIMESTAMP NOT NULL,
  UNIQUE(job_name, project_root)
);

CREATE INDEX idx_job_configs_project_root ON job_configs(project_root);
CREATE INDEX idx_job_configs_enabled ON job_configs(enabled);
```

### 5. Webhook Integration

For webhook triggers, the scheduler registers webhook handlers:

```typescript
// packages/daemon/src/scheduler.ts
private async registerWebhookTrigger(jobConfig: JobConfig): Promise<void> {
  // Register webhook endpoint with daemon HTTP server
  // Format: POST /webhooks/jobs/{jobName}
  // Payload: GitHub webhook payload
  
  // TODO: Implement webhook registration
  // This requires HTTP server integration in daemon
}
```

### 6. File Watch Integration

For file watch triggers:

```typescript
// packages/daemon/src/scheduler.ts
private async registerFileWatchTrigger(jobConfig: JobConfig): Promise<void> {
  const paths = jobConfig.trigger!.paths!;
  
  // Use chokidar or similar for file watching
  const watcher = chokidar.watch(paths, {
    cwd: this.projectRoot,
    ignoreInitial: true,
  });
  
  watcher.on('change', async (filePath) => {
    try {
      await this.executeJob(jobConfig);
    } catch (err) {
      log.error(`File-watch job ${jobConfig.name} failed:`, err);
    }
  });
  
  // Store watcher reference for cleanup
  this.fileWatchers.set(jobConfig.name, watcher);
}
```

## Completion Detection Strategy

### Primary: DONE Message

Agents send a DONE message when complete:
```
TO: scheduler

DONE: Completed changelog generation for week of Jan 18-25
```

The scheduler listens for DONE messages from spawned agents.

### Fallback: Idle Detection

If DONE message is not received within a reasonable time, use idle detection:

1. **Process State** (Linux): Check `/proc/{pid}/stat` for waiting state
2. **Output Silence**: Monitor for lack of output for threshold duration
3. **Natural Ending**: Check if output ended naturally (sentence completion, etc.)

Use `UniversalIdleDetector` from `@agent-relay/wrapper` for this.

### Timeout

If neither DONE message nor idle detection triggers, enforce `maxDuration` timeout.

## Error Handling

### Spawn Failures

- If any agent fails to spawn, release all successfully spawned agents
- Mark job run as `failed`
- Log error details

### Agent Crashes

- Detect when agent process exits unexpectedly
- Mark job run as `failed`
- Include crash details in error message

### Timeouts

- If job exceeds `maxDuration`, mark as `timeout`
- Force release all agents
- Log timeout event

## Job History & Logs

### History Storage

Job runs are stored in the database with:
- Run ID
- Job name
- Start/completion timestamps
- Status (running, completed, failed, timeout)
- Agent names
- Error messages (if any)
- Metadata (duration, etc.)

### Log Aggregation

Agent logs are stored separately in `worker-logs/` directory. Job runs reference agent names, allowing log lookup by agent name.

## API Endpoints

### Manual Trigger

```bash
# Trigger a job manually
relay job trigger weekly-changelog
```

### List Jobs

```bash
# List all configured jobs
relay job list
```

### Job History

```bash
# View job run history
relay job history weekly-changelog
```

### Job Status

```bash
# Check if a job is currently running
relay job status weekly-changelog
```

## Testing Strategy

### Unit Tests

- Job config parsing
- Cron expression validation
- CLI auto-detection
- Completion detection logic

### Integration Tests

- End-to-end job execution
- Multi-agent job spawning
- DONE message handling
- Idle detection fallback
- Timeout handling

### Manual Testing

- Create test `relay.yaml` with sample jobs
- Verify cron scheduling
- Test manual triggers
- Verify agent auto-release

## Migration Path

1. **Phase 1**: Core scheduler implementation (cron only)
2. **Phase 2**: DONE message handling
3. **Phase 3**: Idle detection fallback
4. **Phase 4**: Webhook triggers
5. **Phase 5**: File watch triggers
6. **Phase 6**: Multi-agent support
7. **Phase 7**: CLI commands and API

## Open Questions

1. **Job Overlap**: Should overlapping runs be allowed or queued?
   - **Decision**: Allow overlap by default, add `maxConcurrentRuns` option if needed

2. **Retry Logic**: Should failed jobs retry automatically?
   - **Decision**: Not in v1, add `retry` config option later

3. **Job Dependencies**: Should jobs be able to depend on other jobs?
   - **Decision**: Not in v1, consider for v2

4. **Notifications**: Should jobs send notifications on completion/failure?
   - **Decision**: Not in v1, add webhook/email notifications later

5. **Job Templates**: Should we support job templates for common patterns?
   - **Decision**: Not in v1, consider for v2

## Success Criteria

- [ ] Jobs can be defined in `relay.yaml`
- [ ] Cron jobs execute on schedule
- [ ] Agents spawn successfully from jobs
- [ ] Agents send DONE messages and auto-release
- [ ] Idle detection works as fallback
- [ ] Job history is stored in database
- [ ] MAX_AGENTS limit is respected
- [ ] Multi-agent jobs work correctly
- [ ] Manual triggers work via CLI
- [ ] Error handling is robust
