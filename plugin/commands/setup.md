---
description: Install and configure agent-relay for multi-agent coordination in the current project
---

# Agent Relay Setup

Set up agent-relay in this project so Claude Code agents can communicate with each other in real-time.

## Steps

1. **Check if agent-relay is installed** by running `which agent-relay || npx agent-relay --version`. If not installed, install it with `npm install -g agent-relay`.

2. **Start the relay daemon** with `agent-relay up`. Verify it's running with `agent-relay status`.

3. **Confirm MCP integration** is active - the plugin provides an MCP server (`@agent-relay/mcp`) that gives you tools like `relay_send`, `relay_spawn`, `relay_inbox`, and `relay_who`.

4. **Report status** to the user: show daemon status, connected agents, and available MCP tools.

If $ARGUMENTS contains specific instructions (like "with dashboard"), adapt accordingly:
- "with dashboard": Start with `agent-relay up --dashboard`
- "cloud": Set up cloud sync with `agent-relay cloud link`

After setup, briefly explain that the user can now:
- Use `/agent-relay:spawn` to create worker agents
- Use `/agent-relay:team` to start a coordinated team
- Use `/agent-relay:status` to check on running agents
