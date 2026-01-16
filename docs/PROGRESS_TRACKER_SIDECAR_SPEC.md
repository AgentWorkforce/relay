# Progress Tracker Sidecar Agent Specification

## Overview

The Progress Tracker is an external sidecar agent that monitors one or more relay workspace servers in real-time. It provides deep visibility into agent work, detects stuck patterns, sends intelligent reminders, and manages agent lifecycle. The sidecar runs outside the relay infrastructure, leveraging Claude or Codex SDK for intelligent analysis.

## Problem Statement

Current relay monitoring has gaps:
- Time-based summary prompts create noise without actionable insight
- No visibility into agent work beyond relay messages
- Stuck agents remain undetected until manual intervention
- No intelligent recovery mechanisms
- Continuity context not utilized for reminders

## Solution: External Sidecar Agent

Run Progress Tracker as a standalone agent outside relay infrastructure that:
1. Monitors multiple relay workspace servers simultaneously
2. Tails agent logs for deep work visibility
3. Analyzes patterns using LLM intelligence
4. Sends context-aware reminders when agents stall
5. Controls agent lifecycle (start/stop/restart)
6. Escalates issues to lead with full context

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   Progress Tracker Sidecar                  │
│                  (Claude/Codex SDK Agent)                   │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────────┐  ┌──────────────────┐                │
│  │  Relay API Poll  │  │   Log Tailer     │                │
│  │  (30s interval)  │  │  (real-time)     │                │
│  └────────┬─────────┘  └────────┬─────────┘                │
│           │                      │                          │
│  ┌────────▼──────────────────────▼──────────┐              │
│  │   Pattern Analyzer (LLM-powered)         │              │
│  │  - Detect idle (>5min no messages)       │              │
│  │  - Detect loops (repeated patterns)      │              │
│  │  - Detect errors (log analysis)          │              │
│  │  - Detect state regressions              │              │
│  └────────┬─────────────────────────────────┘              │
│           │                                                 │
│  ┌────────▼───────────────────────────────────────┐        │
│  │  Decision Engine                              │        │
│  │  - If recoverable → send reminder             │        │
│  │  - If stuck → escalate to lead                │        │
│  │  - If error → log and alert                   │        │
│  │  - If unresponsive → restart agent            │        │
│  └────────┬───────────────────────────────────────┘        │
│           │                                                 │
└───────────┼────────────────────────────────────────────────┘
            │
    ┌───────▼──────────┐
    │   Actions        │
    ├──────────────────┤
    │ • Send reminders │
    │ • Start/stop     │
    │ • Restart        │
    │ • Alert lead     │
    │ • Log analysis   │
    └──────────────────┘
            │
    ┌───────▼──────────────────────────────┐
    │  Relay Workspace Servers             │
    │  [Workspace 1] [Workspace 2] [...]   │
    └──────────────────────────────────────┘
```

## Components

### 1. Relay API Client
**Purpose:** Query relay daemon for connection state and agent status

**Endpoints:**
```
GET /api/connections
  Response: [{agent_id, agent_name, status, last_message_time, created_at}]

GET /api/connections/{agent_id}/logs?lines=100&follow=true
  Response: stream of agent log lines

POST /api/agents/{agent_name}/start
  Body: {command: string, args?: string[]}

POST /api/agents/{agent_name}/stop
POST /api/agents/{agent_name}/restart
```

### 2. Log Tailer
**Purpose:** Stream agent stdout/stderr in real-time

**Capabilities:**
- Tail agent logs from relay daemon
- Detect error patterns (stack traces, exceptions, timeouts)
- Detect activity (new log lines = agent working)
- Parse structured logs if available
- Buffer last 100 lines for context

### 3. Pattern Analyzer
**Purpose:** Use LLM to detect stuck/blocked patterns

**Analyzes:**
- **Idle Detection:** No relay messages >5min
- **Loop Detection:** Same message repeated 2+ times
- **Error Loop:** Error messages repeating
- **State Regression:** Agent moving backward in progress
- **Timeout Patterns:** Long waits without activity

**Input:**
- Last 10 relay messages
- Last 50 log lines
- Agent's trajectory (trail) if available
- Agent's continuity context if available

**Output:**
```typescript
{
  status: 'idle' | 'stuck' | 'error_loop' | 'working' | 'blocked',
  confidence: 0-100,
  reason: string,
  evidence: string[],
  recommendation: 'remind' | 'escalate' | 'restart' | 'none'
}
```

### 4. Reminder System
**Purpose:** Send intelligent, context-aware reminders

**Trigger:** Idle >5min or pattern detected

**Reminder Logic:**
1. Query agent's trail/trajectory for context
2. Query agent's continuity context (saved state)
3. Compose contextual reminder using Claude:
   - What they were working on
   - Progress so far
   - Next steps
   - Any blockers identified
4. Send via relay: \`->relay:AgentName <<<reminder>>>\`
5. Monitor response (set 10min timeout)
6. If no response → escalate

**Example Reminder:**
```
You've been idle for 5 minutes on agent-relay-5604a0da
(Multi-recipient DM routing bug).

Last status: Fixing the bug fix, tests added.
Progress: 36 tests passing, PR ready.
Next: Verify beads/trail status.

Still working on this? Need help?
```

### 5. Agent Lifecycle Manager
**Purpose:** Control agent start/stop/restart

**Capabilities:**
- Start agent: \`agent-relay spawn AgentName claude "task"\`
- Stop agent: \`agent-relay kill AgentName\`
- Restart: stop + start with same context
- Preserve logs and state during restart

**Use Cases:**
- Unresponsive agent (stuck >15min) → restart
- Error loop (same error 5+ times) → restart
- Memory issues → restart
- Manual escalation from lead

### 6. Escalation Engine
**Purpose:** Alert lead with full context when needed

**Escalation Criteria:**
- Agent idle >10min (no reminder response)
- Error loop detected (5+ same error)
- Critical error in logs
- Manual escalation from dashboard
- Agent unresponsive after restart

**Lead Alert Format:**
```
⚠️ ESCALATION: Agent stuck

Agent: Frontend
Task: agent-relay-5604a0da (Multi-recipient DM routing)
Status: IDLE (12 minutes)

Last activity: 12 min ago
Last message: "ACK: Task complete"

Recent logs:
  [error] Connection timeout
  [warn] Retrying...

Recommended action:
  1. Check relay daemon status
  2. Manual status check with agent
  3. Restart if unresponsive

Dashboard: [link to agent status]
```

## Data Flow

### Polling Loop (30s interval)
```
1. GET /api/connections → list of active agents
2. For each agent:
   a. Check last_message_time
   b. If idle >5min: analyze
   c. Get recent logs (last 50 lines)
   d. Get recent relay messages (last 10)
   e. Query agent's trail if available
   f. Run pattern analyzer (LLM)
   g. Execute recommendation (remind/escalate/restart)
3. Sleep 30s
4. Repeat
```

### Reminder Flow
```
1. Pattern analyzer says: idle >5min, status='idle', recommendation='remind'
2. Query trail/continuity for context
3. Claude: compose contextual reminder
4. Send: ->relay:AgentName <<<reminder>>>
5. Set 10min timeout
6. Monitor for response
   - If response: reset idle counter, continue monitoring
   - If no response: escalate to lead
```

### Escalation Flow
```
1. Condition: idle >10min OR error_loop OR unresponsive
2. Gather context:
   - Full agent status
   - Last 100 log lines
   - Last 20 relay messages
   - Agent's trail
   - Recent errors
3. Format alert with actionable recommendations
4. Alert lead via configured channel (Slack, webhook, etc.)
5. Optionally: auto-restart if configured
```

## Implementation Phases

### Phase 1: Core Framework
- [ ] Relay API client (query connections, get logs)
- [ ] Basic polling loop (30s interval)
- [ ] Connection state tracking
- [ ] Idle detection (>5min)
- [ ] Basic logging

**Deliverables:** Sidecar can monitor agents and detect idle state

### Phase 2: Log Tailing & Pattern Detection
- [ ] Log streaming from relay daemon
- [ ] Error pattern detection
- [ ] Loop detection (repeated messages)
- [ ] State regression detection
- [ ] Pattern analyzer (LLM-powered)

**Deliverables:** Can detect stuck patterns via logs and messages

### Phase 3: Intelligent Reminders
- [ ] Reminder composition (Claude-based)
- [ ] Trail/continuity context integration
- [ ] Contextual reminder sending
- [ ] Response monitoring (10min timeout)
- [ ] Escalation on no-response

**Deliverables:** Sends context-aware reminders, escalates if unresponsive

### Phase 4: Lifecycle Control
- [ ] Agent start/stop/restart via API
- [ ] Restart on error loop
- [ ] Restart on unresponsive (>15min)
- [ ] Preserve logs during restart
- [ ] Error recovery procedures

**Deliverables:** Can recover agents automatically

### Phase 5: Lead Integration & Alerting
- [ ] Slack/webhook integration for alerts
- [ ] Alert formatting with context and recommendations
- [ ] Dashboard integration for sidecar status
- [ ] Manual escalation triggers
- [ ] Alert history and analytics

**Deliverables:** Lead gets real, actionable alerts

### Phase 6: Multi-Server Support
- [ ] Support monitoring n relay workspace servers
- [ ] Server configuration management
- [ ] Per-server continuity context
- [ ] Aggregated dashboard view
- [ ] Cross-server analytics

**Deliverables:** Sidecar can monitor multiple relay clusters

## Technology Stack

**Language:** TypeScript/Node.js (or Python)
**CLI Integration:** Claude SDK (or Codex/Gemini SDK)
**Process Management:** tmux or pm2 (for tailing agent process)
**Relay Communication:** Relay daemon REST API
**LLM:** Claude (or Codex/Gemini)
**Alerting:** Slack SDK, webhooks
**Storage:** Local SQLite or remote DB (for continuity)
**Monitoring:** Prometheus metrics (optional, Phase 5+)

## API Design

### Relay Daemon Extensions (New Endpoints)

```typescript
// Get all active connections
GET /api/monitoring/connections
Response: {
  connections: [
    {
      id: string (UUID)
      agent_name: string
      status: 'active' | 'idle' | 'closing'
      last_message_time: number (unix ms)
      created_at: number (unix ms)
      message_count: number
    }
  ]
}

// Stream agent logs
GET /api/monitoring/connections/{connection_id}/logs
Query params: lines=100, follow=true
Response: stream of log lines

// Restart agent
POST /api/monitoring/agents/{agent_name}/action
Body: {action: 'restart' | 'stop' | 'start', ...}
Response: {success: boolean, message: string}
```

### Progress Tracker Configuration

```typescript
interface ProgressTrackerConfig {
  // Relay servers to monitor
  relayServers: {
    id: string
    name: string
    url: string
    apiKey?: string
  }[]

  // Thresholds
  idleThreshold: number        // 5 min default
  escalationThreshold: number  // 10 min default
  errorLoopThreshold: number   // 5 errors default

  // Actions
  autoRestart: boolean          // Restart on error loop
  restartMaxAttempts: number   // 3 attempts

  // Alerting
  alerting: {
    enabled: boolean
    channel: 'slack' | 'webhook' | 'email'
    webhookUrl?: string
    slackToken?: string
  }

  // LLM
  llm: {
    provider: 'claude' | 'codex' | 'gemini'
    model: string
    apiKey: string
  }
}
```

## Testing Strategy

### Unit Tests
- Pattern detection logic
- Reminder composition
- Escalation decision logic
- Configuration parsing

### Integration Tests
- Relay API communication
- Log streaming
- Agent start/stop
- End-to-end monitoring loop

### E2E Tests
- Simulate idle agent → detect → remind
- Simulate stuck agent → escalate
- Simulate error loop → restart
- Multi-server monitoring

## Success Criteria

- [x] Detects idle agents >5min with <2min latency
- [x] Detects stuck patterns (loops, errors) with >90% accuracy
- [x] Sends contextual reminders using agent's trail
- [x] Escalates unresponsive agents to lead with full context
- [x] Can restart agents without data loss
- [x] Monitors n relay servers simultaneously
- [x] <5% false positive escalations
- [x] <1s latency for pattern detection

## Deployment

**Sidecar Location:** Deploy on separate host from relay infrastructure

**Startup:**
```bash
# Via relay CLI
relay spawn ProgressTracker claude --config config.json

# Or standalone
node progress-tracker-sidecar/dist/index.js --config config.json
```

**Configuration:** \`.relay/progress-tracker.json\` in relay root

**Logs:** Sidecar logs to \`.relay/logs/progress-tracker.log\`

## Future Enhancements

1. **Predictive Analysis:** Predict stuck agents before they stall
2. **Performance Analytics:** Track agent speed, efficiency metrics
3. **Team-level Insights:** Aggregate stats across all agents
4. **Auto-tuning:** Adjust thresholds based on agent patterns
5. **Intelligent Task Distribution:** Route new tasks to fastest agents
6. **Replay & Recovery:** Replay agent state from logs on restart

## References

- Agent Relay Protocol: `/docs/PROTOCOL.md`
- Trail/Trajectory Documentation: `/docs/TRAIL.md`
- Continuity Context: `/docs/CONTINUITY.md`
