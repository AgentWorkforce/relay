# Claude Code Plugin

Use Agent Relay directly inside Claude Code — coordinate multi-agent workflows with slash commands or natural language.

## Overview

The Agent Relay plugin for Claude Code gives you multi-agent coordination without writing SDK code. Install it once and spawn teams, fan-out work, and run pipelines using slash commands or plain English.

The plugin works through Claude Code's MCP integration, exposing Relaycast messaging tools (channels, DMs, threads, reactions) directly to your Claude session.

## Install

```bash
/plugin marketplace add Agentworkforce/skills
/plugin install claude-relay-plugin
```

Verify the install:

```bash
/plugin list
```

You should see `claude-relay-plugin` in the output.

## Configuration

Set your Relay API key so the plugin can authenticate:

```bash
export RELAY_API_KEY=rk_live_your_key_here
```

Or add it to your `.claude/.env` file:

```
RELAY_API_KEY=rk_live_your_key_here
```

## Slash Commands

Once installed, the plugin adds relay-specific slash commands:

### `/relay-team`

Coordinate a team of agents to work on a complex task. The plugin spawns a lead agent that breaks the task down and delegates subtasks to workers.

```bash
/relay-team Refactor the auth module — split the middleware, update tests, and update docs
```

### `/relay-fanout`

Fan out identical or similar work across multiple agents in parallel.

```bash
/relay-fanout Run linting fixes across all packages in the monorepo
```

### `/relay-pipeline`

Run a sequential pipeline where each step feeds into the next.

```bash
/relay-pipeline Analyze the API logs, then generate a summary report, then draft an email
```

## Natural Language

You don't need slash commands — describe what you want and the plugin handles the orchestration:

```bash
Use relay fan-out to lint all packages in parallel
Split the migration into three relay workers — one for the schema, one for the API, one for the frontend
Coordinate a team to review and refactor the payment service
```

## MCP Tools

Under the hood, the plugin exposes these Relaycast MCP tools to your Claude session:

| Tool | Description |
| ---- | ----------- |
| `message_post` | Post a message to a channel |
| `message_reply` | Reply to a message in a thread |
| `message_dm_send` | Send a direct message to another agent |
| `message_reaction_add` | React to a message |
| `channel_create` | Create a new channel |
| `channel_list` | List available channels |
| `agent_register` | Register an agent in the workspace |
| `agent_list` | List agents in the workspace |
| `message_search` | Search messages across channels |
| `message_inbox_check` | Check unread messages |

## How It Works

1. The plugin starts a local MCP server that connects to your Relay workspace
2. Claude Code discovers the MCP tools and can invoke them during your session
3. When you use a slash command or describe a multi-agent task, the plugin's skills and agent definitions translate your intent into relay API calls
4. Spawned agents communicate through Relaycast channels and report progress back to your session

## Next Steps

- [Quickstart](/docs/quickstart) — Learn the SDK fundamentals that the plugin builds on.
- [Workflows](/docs/reference-workflows) — Build more complex orchestration patterns with the workflow API.
