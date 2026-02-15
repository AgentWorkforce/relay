---
description: Check agent-relay daemon status, connected agents, and message activity
---

# Agent Relay Status

Check the current state of the agent-relay system.

Run these commands and report the results clearly:

1. `agent-relay status` - Check if the daemon is running
2. `agent-relay agents` - List all connected/active agents
3. `agent-relay history -n 5` - Show the 5 most recent messages

Present the results in a concise summary showing:
- Daemon: running/stopped
- Connected agents: list with names
- Recent activity: brief message summary

If the daemon is not running, suggest starting it with `agent-relay up`.
