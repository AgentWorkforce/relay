# Scheduled Jobs Feature Proposal

## Executive Summary

Add scheduled and trigger-based job execution to agent-relay, enabling automatic agent spawning for recurring tasks (e.g., weekly changelog generation) and event-driven workflows (e.g., PR merge reviews).

## Problem Statement

Currently, agents must be manually spawned via CLI or API. There's no way to:
- Automatically run recurring tasks (e.g., weekly reports)
- Trigger agents based on events (e.g., PR merges, file changes)
- Schedule maintenance tasks (e.g., dependency audits)

## Proposed Solution

### Core Features

1. **Scheduled Jobs**: Cron-based scheduling for recurring tasks
2. **Trigger-based Jobs**: Event-driven spawning (webhooks, file watches)
3. **Automatic Lifecycle**: Agents auto-release upon completion
4. **Multi-agent Support**: Jobs can spawn multiple agents in parallel
5. **Job History**: Track job runs with status, timing, and logs

### Configuration

Jobs are defined in `relay.yaml` at project root:

```yaml
jobs:
  - name: weekly-changelog
    schedule: "0 9 * * 5"  # Friday 9am
    agent:
      name: ChangelogWriter
      task: "Generate changelog for the past week"
    autoRelease: true
    enabled: true
```

### Architecture

**Daemon Component**: Scheduler implemented as daemon module (`packages/daemon/src/scheduler.ts`)

**Rationale**:
- Single process simplifies deployment
- Shares daemon infrastructure (logging, health checks)
- Direct access to `AgentSpawner` instance
- Natural integration with project scoping

### Completion Detection

1. **Primary**: DONE message from agent
2. **Fallback**: Idle detection (process state + output silence)
3. **Timeout**: Max duration enforcement

### CLI Auto-Detection

When `cli` is not specified, detect first available authenticated CLI:
- `claude` → `cursor` → `codex` → `gemini`

## Implementation Plan

### Phase 1: Core Scheduler (MVP)
- [ ] JobScheduler class with cron support
- [ ] relay.yaml parsing
- [ ] Agent spawning/releasing
- [ ] DONE message handling
- [ ] Basic error handling

### Phase 2: Completion Detection
- [ ] Idle detection fallback
- [ ] Timeout handling
- [ ] Multi-agent completion tracking

### Phase 3: Database & History
- [ ] Database schema (job_runs, job_configs)
- [ ] Storage adapter methods
- [ ] Job history CLI commands

### Phase 4: Triggers
- [ ] Webhook trigger support
- [ ] File-watch trigger support
- [ ] Manual trigger CLI

### Phase 5: Polish
- [ ] Multi-agent job support
- [ ] Comprehensive tests
- [ ] Documentation

## Benefits

1. **Automation**: Reduce manual intervention for recurring tasks
2. **Consistency**: Ensure regular tasks run on schedule
3. **Event-driven**: React to code changes, PR merges, etc.
4. **Scalability**: Multi-agent jobs for parallel processing
5. **Observability**: Job history and logs for debugging

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Agent doesn't send DONE | Idle detection fallback |
| Job exceeds resources | MAX_AGENTS limit enforcement |
| Daemon restart mid-job | Job state persistence in DB |
| Overlapping runs | Allow by default, add config option if needed |

## Success Metrics

- Jobs execute on schedule
- Agents auto-release upon completion
- Job history is queryable
- Multi-agent jobs work correctly
- Error handling is robust

## Related Work

- Existing `AgentSpawner` infrastructure
- `UniversalIdleDetector` for completion detection
- Database schema patterns from cloud package
- CLI command patterns from existing commands

## Next Steps

1. Review and approve proposal
2. Create detailed spec (see `docs/specs/scheduled-jobs-spec.md`)
3. Implement Phase 1 (core scheduler)
4. Iterate based on feedback

## References

- [Detailed Specification](./specs/scheduled-jobs-spec.md)
- [Trajectory](./.trajectories/active/traj_*.md)
- [Beads](./.beads/issues.jsonl) (search for "scheduled jobs")
