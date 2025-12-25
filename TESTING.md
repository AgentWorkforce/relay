# Manual Testing Guide

Manual testing instructions for bridge, staffing, and multi-project orchestration features.

## Prerequisites

- Node.js installed
- `agent-relay` built and available (`npm run build`)
- tmux installed (`brew install tmux` on macOS)

---

## 1. Single Project - Lead + Spawning

Test the Lead role and worker spawning within a single project.

### Setup

```bash
# Terminal 1: Start daemon
cd /path/to/your/project
agent-relay up
```

```bash
# Terminal 2: Start as Lead
agent-relay lead Alice
```

### Test Spawning

Inside Alice's terminal, output these patterns:

```
->relay:spawn Dev1 claude "Write unit tests for the auth module"
```

**Expected:**
- New tmux window created in `relay-workers` session
- Dev1 agent starts with the task injected
- Message: `[spawner] Spawned Dev1 (claude) for Alice`

### Verify Spawn

```bash
# Check tmux windows
tmux list-windows -t relay-workers
```

### Test Release

```
->relay:release Dev1
```

**Expected:**
- Dev1 window closed
- Message: `[spawner] Released Dev1`

### Test Release All

First spawn multiple workers:
```
->relay:spawn Dev1 claude "Task 1"
->relay:spawn Dev2 claude "Task 2"
->relay:spawn QA1 claude "Task 3"
```

Then release all:
```
->relay:release *
```

**Expected:** All workers released.

---

## 2. Multi-Project Bridge

Test cross-project communication with the bridge command.

### Setup (3 terminals minimum)

```bash
# Terminal 1: Project A daemon
mkdir -p /tmp/project-a
cd /tmp/project-a
agent-relay up
```

```bash
# Terminal 2: Project B daemon
mkdir -p /tmp/project-b
cd /tmp/project-b
agent-relay up
```

```bash
# Terminal 3: Bridge (Architect mode)
agent-relay bridge /tmp/project-a /tmp/project-b
```

**Expected:**
- Bridge connects to both project sockets
- Dashboard shows both projects (if enabled)

### Start Leads in Each Project

```bash
# Terminal 4: Lead in Project A
cd /tmp/project-a
agent-relay lead Alice
```

```bash
# Terminal 5: Lead in Project B
cd /tmp/project-b
agent-relay lead Bob
```

### Test Cross-Project Messaging

From Alice (Project A):
```
->relay:project-b:Bob Hey Bob, can you review my changes?
```

**Expected:** Bob receives the message in Project B.

From Bob (Project B):
```
->relay:project-a:Alice Sure, sending review now.
```

**Expected:** Alice receives the message in Project A.

### Test Broadcast to All Leads

From the bridge/architect:
```
->relay:*:lead Standup time - report your status
```

**Expected:** Both Alice and Bob receive the message.

---

## 3. Dashboard Verification

### Main Dashboard

Open: http://localhost:4280

Check:
- [ ] Connected agents appear
- [ ] Online/Offline status badges show correctly
- [ ] Messages appear in activity log
- [ ] Last seen timestamps update

### Bridge Dashboard

Open: http://localhost:4280/bridge

Check:
- [ ] Connected projects appear
- [ ] Leads shown per project
- [ ] Workers shown under their lead
- [ ] Cross-project messages in message flow panel

---

## 4. Agent Role Auto-Detection

Test that agent names match role definitions.

### Setup

Create a role agent:
```bash
mkdir -p .claude/agents
cat > .claude/agents/lead.md << 'EOF'
---
name: lead
description: Coordinator agent
model: haiku
---

# Lead Agent

You are a Lead agent - coordinate and delegate.
EOF
```

### Test

```bash
agent-relay -n Lead claude
```

**Expected:** Agent assumes the Lead role from `lead.md` (case-insensitive match).

---

## 5. Cleanup

```bash
# Stop all daemons
agent-relay down

# Kill any orphaned tmux sessions
tmux kill-session -t relay-workers 2>/dev/null
tmux list-sessions | grep relay | cut -d: -f1 | xargs -I {} tmux kill-session -t {}

# Remove test directories
rm -rf /tmp/project-a /tmp/project-b
```

---

## Quick Smoke Test Script

Save as `test-bridge.sh` and run:

```bash
#!/bin/bash
set -e

echo "=== Bridge Smoke Test ==="

# Setup
mkdir -p /tmp/smoke-a /tmp/smoke-b
cd /tmp/smoke-a && agent-relay up &
PID_A=$!
sleep 1

cd /tmp/smoke-b && agent-relay up &
PID_B=$!
sleep 1

# Check daemons
echo "Checking daemons..."
agent-relay status

# Bridge
echo "Starting bridge..."
agent-relay bridge /tmp/smoke-a /tmp/smoke-b &
PID_BRIDGE=$!
sleep 2

# Cleanup
echo "Cleaning up..."
kill $PID_A $PID_B $PID_BRIDGE 2>/dev/null || true
rm -rf /tmp/smoke-a /tmp/smoke-b

echo "=== Smoke Test Complete ==="
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Socket not found" | Start daemon with `agent-relay up` |
| Spawn not working | Check tmux is installed, check `relay-workers` session |
| Cross-project messages not delivered | Verify bridge is running and connected to both daemons |
| Dashboard not loading | Check daemon started with dashboard enabled (default) |
| Agent role not applied | Check file exists at `.claude/agents/<name>.md` (case-insensitive) |
