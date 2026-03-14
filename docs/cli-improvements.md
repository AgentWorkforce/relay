# Agent Relay CLI & Broker Improvements

Findings from a full-day production session running 30+ agents across 7 POC apps, 13 e2e test suites, and 3-agent coordinated teams.

---

## P0 — Blocking Issues

### 1. `--cwd` breaks droid/opencode auto-accept
**PR #570** (open)

When spawning droid agents with `--cwd`, the broker fails to auto-accept opencode's permission prompt. Agents get stuck at:
```
> Yes, allow
  Yes, and always allow medium impact commands
  No, cancel
```
**Workaround:** Don't use `--cwd` with droid — put `cd /path` in the task prompt instead.

### 2. `--workspace-key` only on `agent-relay up`

Currently you must restart the entire broker to change workspace:
```bash
agent-relay up --workspace-key rk_live_KEY
```
This should be:
- Storable in config (`agent-relay config set workspace-key rk_live_KEY`)
- Passable per-spawn (`agent-relay spawn NAME cli --workspace-key rk_live_KEY "task"`)
- Readable from env (`RELAY_WORKSPACE_KEY`)

### 3. `agent-relay down` graceful shutdown times out

Every shutdown prints:
```
Graceful shutdown timed out after 5000ms. Use --force to kill.
```
Port 3888 stays bound, causing "port already in use" on next `up`. Needs longer timeout or better cleanup of child processes.

---

## P1 — High-Impact Ergonomics

### 4. No channel management in CLI

Creating/listing/joining channels requires mcporter:
```bash
mcporter call relaycast create_channel name=my-project topic="..."
```
Should be built into the CLI:
```bash
agent-relay channels                          # list
agent-relay channels:create my-project        # create
agent-relay channels:join my-project          # join
agent-relay channels:messages my-project      # read messages
```

### 5. No way to read channel messages from CLI

Agents are told to use `agent-relay send '#channel' 'msg'` but there's no `agent-relay messages '#channel'` to read. Forces mcporter dependency.

Proposal:
```bash
agent-relay messages '#channel' --limit 20
agent-relay messages --dm agent-name --limit 10
```

### 6. Agent logs are raw PTY escape codes

`agent-relay agents:logs NAME` dumps raw ANSI for droid/opencode agents:
```
[?2026h[?2026l[?2026h[11A[?2026l
```
Should strip escape codes by default:
```bash
agent-relay agents:logs NAME              # clean output
agent-relay agents:logs NAME --raw        # preserve ANSI
```

### 7. No batch spawn with rate limiting

Spawning 7 agents requires 7 commands with manual `sleep 15` gaps:
```bash
agent-relay spawn a1 claude "task1"
sleep 15
agent-relay spawn a2 claude "task2"
# ...repeat 5 more times
```
Proposal:
```bash
agent-relay spawn-team team.json --delay 15s
```
Where `team.json`:
```json
{
  "team": "my-project",
  "channel": "my-project",
  "agents": [
    {"name": "architect", "cli": "claude", "task": "Design the system"},
    {"name": "developer", "cli": "claude", "task": "Build it"},
    {"name": "tester", "cli": "claude", "task": "Test it"}
  ]
}
```

### 8. No agent status beyond ONLINE

`agent-relay agents` shows ONLINE for agents that are idle, stuck, or errored:
```
NAME          STATUS   CLI
agent-1       ONLINE   claude
agent-2       ONLINE   claude   ← actually stuck at permission prompt
agent-3       ONLINE   claude   ← finished and idle for 10 minutes
```
Proposal: SPAWNING → WORKING → IDLE → ERROR → EXITED states, with idle duration.

---

## P2 — Nice to Have

### 9. DMs don't work for spawned agents

`agent-relay send agent-name "message"` only works for Relaycast-registered agents. Spawned agents go through the broker, not Relaycast, so DMs to them fail. Only `#channel` broadcasts work.

**Options:**
- Auto-register spawned agents on Relaycast (with per-agent tokens)
- Document the limitation clearly
- Proxy DMs through broker

### 10. `--model` flag ignored for droid

`agent-relay spawn NAME droid --model opus "task"` — the model flag gets overridden by opencode's own model selection. Should pass through to opencode config.

### 11. Agent name restrictions

Google ADK requires underscores, not hyphens. Agent names like `my-agent` break ADK integrations. Options:
- Auto-convert hyphens to underscores
- Validate names against a portable charset
- Document naming constraints

### 12. No completion notifications

Agents finish and go idle but the orchestrator gets no notification. The workaround is putting `openclaw system event --text 'Done' --mode now` in every task prompt.

Proposal: Broker emits events on agent state changes:
```bash
agent-relay on idle --run "echo '{agent} finished'"
agent-relay on exit --run "echo '{agent} exited with {code}'"
```
Or via webhook/channel:
```bash
agent-relay up --lifecycle-channel '#ops'
# → Posts "agent-1 → IDLE" to #ops automatically
```

### 13. No `agent-relay observe` TUI

A live dashboard in the terminal showing all agents, their status, recent messages, and output. Like `htop` for agent teams.

```bash
agent-relay observe
```
```
┌─ Agents ──────────────────────────────┐
│ architect  IDLE   claude  2m ago      │
│ developer  WORK   claude  writing...  │
│ tester     WORK   claude  running...  │
├─ #my-project ─────────────────────────┤
│ [architect] Design doc complete       │
│ [developer] Starting implementation   │
│ [tester] Go tests: 5/5 PASS          │
└───────────────────────────────────────┘
```

### 14. Port collision on restart

`agent-relay down` followed by `agent-relay up` frequently hits "port 3888 already in use" because the old process hasn't fully released the port. Falls back to 3889, then 3890, etc.

Fix: `agent-relay down` should wait for port release, or `up` should kill the stale listener.

---

## Summary

| # | Issue | Priority | Status |
|---|-------|----------|--------|
| 1 | `--cwd` droid auto-accept | P0 | PR #570 open |
| 2 | `--workspace-key` config | P0 | Not started |
| 3 | Graceful shutdown timeout | P0 | Not started |
| 4 | Channel management CLI | P1 | Not started |
| 5 | Read channel messages | P1 | Not started |
| 6 | Clean agent logs | P1 | Not started |
| 7 | Batch spawn | P1 | Not started |
| 8 | Agent status states | P1 | Not started |
| 9 | Spawned agent DMs | P2 | Not started |
| 10 | `--model` for droid | P2 | Not started |
| 11 | Agent name validation | P2 | Not started |
| 12 | Completion notifications | P2 | Not started |
| 13 | Observe TUI | P2 | Not started |
| 14 | Port collision | P2 | Not started |
