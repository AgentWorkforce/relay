---
description: Spawn a worker agent with a specific task using agent-relay
---

# Spawn Agent

Spawn a new worker agent via agent-relay to handle a task.

Parse $ARGUMENTS to determine:
- **Agent name**: A descriptive name for the worker (e.g., "AuthWorker", "TestRunner")
- **CLI**: Which AI CLI to use (default: `claude`). Options: `claude`, `codex`, `gemini`, `aider`, `goose`
- **Task**: The task description for the agent

## How to Spawn

Use the file-based relay protocol:

```bash
cat > $AGENT_RELAY_OUTBOX/spawn << 'EOF'
KIND: spawn
NAME: <agent-name>
CLI: <cli>

<task description>
EOF
```

Then output the trigger: `->relay-file:spawn`

If `$AGENT_RELAY_OUTBOX` is not set, fall back to:
```bash
agent-relay spawn <name> <cli> "<task>"
```

## Examples

- `/agent-relay:spawn AuthWorker implement JWT authentication` - Spawns a Claude agent named AuthWorker
- `/agent-relay:spawn TestRunner claude run all tests and fix failures` - Spawns a test runner
- `/agent-relay:spawn CodexHelper codex review the API endpoints` - Spawns a Codex agent

After spawning, monitor the agent with `agent-relay agents` and check messages with `agent-relay history`.
