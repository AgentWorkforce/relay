---
description: Start a coordinated multi-agent team with a lead and specialized workers
---

# Start Agent Team

Start a coordinated team of agents to work on a complex task. This spawns a Lead agent who coordinates specialized workers.

Parse $ARGUMENTS for the task description. The Lead agent will:
1. Analyze the task and break it into subtasks
2. Spawn specialized worker agents as needed
3. Coordinate work and track progress
4. Report results back

## How to Start a Team

Spawn a Lead agent with the team task:

```bash
cat > $AGENT_RELAY_OUTBOX/spawn << 'EOF'
KIND: spawn
NAME: Lead
CLI: claude

You are the Lead agent. Your task: $ARGUMENTS

Break this into subtasks and spawn specialized workers to handle each one.
Coordinate their work, track progress, and report when complete.
EOF
```

Then output: `->relay-file:spawn`

If `$AGENT_RELAY_OUTBOX` is not set, use:
```bash
agent-relay spawn Lead claude "You are the Lead agent. Your task: <task>. Break this into subtasks and spawn specialized workers."
```

## Tips

- The Lead agent will automatically spawn workers as needed
- Monitor progress with `/agent-relay:status`
- Check message flow with `agent-relay history`
- Workers report back to Lead, who coordinates the overall effort
