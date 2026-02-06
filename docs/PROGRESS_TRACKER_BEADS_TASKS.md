# Progress Tracker Sidecar - Beads Task Breakdown

## Overview
6 feature tasks to implement Progress Tracker sidecar agent as described in PROGRESS_TRACKER_SIDECAR_SPEC.md

## Phase 1: Core Framework

### Task 1: Core Sidecar Framework
**ID:** agent-relay-progress-tracker-1
**Type:** Feature
**Priority:** P2
**Phase:** 1

**Requirements:**
- [ ] Create Progress Tracker project structure
  - `src/progress-tracker/`
  - `src/progress-tracker/index.ts` - main entry point
  - `src/progress-tracker/config.ts` - configuration management
  - `src/progress-tracker/types.ts` - TypeScript interfaces
- [ ] Implement polling loop (30s interval)
- [ ] Connection state tracking (idle/active/error)
- [ ] Basic logging to file (`.relay/logs/progress-tracker.log`)
- [ ] Graceful shutdown handling
- [ ] Configuration file parsing (`.relay/progress-tracker.json`)

**Acceptance:**
- [ ] Sidecar starts and runs polling loop
- [ ] Can track 1+ relay workspace servers
- [ ] Logs all activity to file
- [ ] Handles graceful shutdown

**Estimated Effort:** 8 hours

---

## Phase 2: Relay API & Log Tailing

### Task 2: Relay API Integration
**ID:** agent-relay-progress-tracker-2
**Type:** Feature
**Priority:** P2
**Phase:** 2

**Requirements:**
- [ ] Create Relay API client module
  - Fetch active connections
  - Stream logs from relay daemon
  - Send start/stop/restart commands
- [ ] Implement connection polling (30s)
  - `GET /api/monitoring/connections`
  - Parse response into internal state
  - Track: agent_name, last_message_time, status
- [ ] Handle API errors gracefully
- [ ] Retry logic for failed requests
- [ ] API key authentication if needed

**Acceptance:**
- [ ] Can query relay daemon for active agents
- [ ] Gets real-time last_message_time
- [ ] Handles connection timeouts
- [ ] All API calls logged

**Estimated Effort:** 6 hours

---

### Task 3: Log Tailing & Pattern Detection
**ID:** agent-relay-progress-tracker-3
**Type:** Feature
**Priority:** P2
**Phase:** 2

**Requirements:**
- [ ] Stream agent logs from relay daemon
  - `GET /api/monitoring/connections/{id}/logs?follow=true`
  - Buffer last 100 lines
  - Parse error patterns (stack traces, timeouts, exceptions)
- [ ] Implement pattern analyzer
  - Idle detection: no messages >5min
  - Loop detection: repeated messages 2+x
  - Error loop: same error 5+ times
  - State regression detection
- [ ] LLM-powered analysis (Claude)
  - Send pattern data to Claude
  - Get: {status, confidence, reason, recommendation}
- [ ] Pattern scoring and confidence levels

**Acceptance:**
- [ ] Detects idle agents >5min with <2min latency
- [ ] Identifies repeated messages as loops
- [ ] Detects error patterns in logs
- [ ] LLM analysis returns valid recommendations
- [ ] >90% accuracy on known test cases

**Estimated Effort:** 12 hours

---

## Phase 3: Intelligent Reminders

### Task 4: Intelligent Reminder System
**ID:** agent-relay-progress-tracker-4
**Type:** Feature
**Priority:** P2
**Phase:** 3

**Requirements:**
- [ ] Integration with agent trail/trajectory
  - Query trail API for agent's context
  - Extract: task, progress, decisions
- [ ] Integration with continuity context
  - Query continuity for agent's last session
  - Extract: what was being done, next steps
- [ ] Reminder composition via Claude
  - Input: agent context, idle duration, logs
  - Output: contextual reminder message
  - Tone: helpful, specific, actionable
- [ ] Relay message sending
  - Send: \`->relay:AgentName <<<reminder>>>\`
  - Set 10min response timeout
  - Track: sent_time, response_time
- [ ] Response monitoring
  - Check for agent response within timeout
  - Reset idle counter on response
  - Log all reminder/response pairs

**Acceptance:**
- [ ] Reminders include context from trail
- [ ] Mentions task and progress
- [ ] Suggests next steps
- [ ] Monitors for response
- [ ] Escalates if no response >10min

**Estimated Effort:** 10 hours

---

## Phase 4: Agent Lifecycle Control

### Task 5: Agent Lifecycle Control
**ID:** agent-relay-progress-tracker-5
**Type:** Feature
**Priority:** P2
**Phase:** 4

**Requirements:**
- [ ] Agent start command
  - `POST /api/monitoring/agents/{name}/action` with action='start'
  - Pass: command, args, working_dir
  - Return: success/error
- [ ] Agent stop command
  - Graceful stop with timeout
  - Force kill if timeout
  - Preserve logs
- [ ] Agent restart command
  - Stop + start with same context
  - Preserve environment, logs, state
- [ ] Auto-restart logic
  - On error loop (5+ same error)
  - On timeout (>15min unresponsive)
  - Max 3 restart attempts
  - Cooldown between restarts (5min)
- [ ] State preservation during restart
  - Save logs before restart
  - Notify agent of restart context

**Acceptance:**
- [ ] Can start/stop/restart agents
- [ ] Auto-restarts on error loop
- [ ] Max 3 restart attempts
- [ ] Logs preserved during restart
- [ ] Cooldown prevents infinite loops

**Estimated Effort:** 8 hours

---

## Phase 5: Lead Integration & Alerting

### Task 6: Escalation & Alerting
**ID:** agent-relay-progress-tracker-6
**Type:** Feature
**Priority:** P2
**Phase:** 5

**Requirements:**
- [ ] Escalation triggers
  - Idle >10min (no reminder response)
  - Error loop (5+ same error)
  - Critical error (RuntimeError, AssertionError, etc.)
  - Manual escalation from dashboard
  - Unresponsive after restart
- [ ] Alert composition
  - Agent name and task
  - Duration idle/stuck
  - Last 10 relay messages
  - Last 50 log lines
  - Recent errors
  - Trail context if available
  - Recommended actions
- [ ] Slack integration
  - Format alert for Slack
  - Send via Slack API
  - Include action buttons (if possible)
- [ ] Webhook integration
  - POST alert JSON to configured webhook
  - Include all context
  - Retry on failure (3x with backoff)
- [ ] Alert history
  - Store alerts in local SQLite
  - Track: agent, time, reason, resolution
  - Enable lead to query past escalations

**Acceptance:**
- [ ] Escalations sent to configured channel
- [ ] Alerts include full context
- [ ] Lead can trace recent escalations
- [ ] <2min delay from detection to alert
- [ ] <5% false positive escalations

**Estimated Effort:** 10 hours

---

## Summary

| Phase | Task | Hours | Status |
|-------|------|-------|--------|
| 1 | Core Framework | 8 | Pending |
| 2 | API Integration | 6 | Pending |
| 2 | Log Tailing | 12 | Pending |
| 3 | Reminders | 10 | Pending |
| 4 | Lifecycle | 8 | Pending |
| 5 | Escalation | 10 | Pending |
| | **Total** | **54** | |

**Total Estimated Effort:** 54 hours
**Team Size Recommended:** 2 developers (27 hours each)
**Timeline:** 2-3 weeks at standard velocity

## Dependencies

- Relay daemon with monitoring endpoints (/api/monitoring/*)
- Claude API access (for pattern analysis and reminder composition)
- Trail/Trajectory API available
- Continuity context API available
- Slack API key (for alerting)

## Risks

1. **API Stability:** Relay daemon monitoring endpoints may be under development
2. **LLM Rate Limits:** Claude API may throttle during heavy analysis
3. **Log Volume:** High-traffic agents may produce too many logs
4. **Continuity Context:** Trail/continuity APIs might not be stable

## Mitigation

- Mock relay API for development/testing
- Batch LLM requests to reduce API calls
- Implement log buffering and rotation
- Handle missing continuity gracefully
