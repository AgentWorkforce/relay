# Claude Relay Plugin

Multi-agent coordination for Claude Code via Relaycast MCP and lifecycle hooks.

## What it does

This plugin connects Claude Code agents to [Agent Relay](https://agent-relay.com) so they can communicate, coordinate, and work as a team. It adds:

- **Relaycast MCP server** — gives Claude tools for messaging, channels, webhooks, and more
- **Inbox polling** — automatically checks for new messages after each tool call
- **Stop guard** — prevents an agent from exiting while it has unread messages
- **Subagent bootstrap** — spawned subagents automatically register with the relay
- **Compaction preservation** — relay state (agent identity, workspace, workers) survives context compaction

## Installation

### 1. Install the plugin

Copy or symlink the plugin into your project:

```bash
cp -r plugins/claude-relay-plugin /path/to/your/project/.claude-plugin
```

Or if you're working within the relay repo, the plugin is already at `plugins/claude-relay-plugin`.

Claude Code discovers plugins at `.claude-plugin/plugin.json` in your project root.

### 2. (Optional) Set environment variables

No environment variables are required to get started. The skills will call `create_workspace` automatically to generate a workspace key on the fly.

If you have an existing workspace key, you can set it for automatic authentication:

```bash
export RELAY_API_KEY="rk_live_your_key_here"
```

Other optional variables:

```bash
export RELAY_TOKEN="your-agent-token"              # Per-agent bearer token for inbox polling hooks
export RELAY_BASE_URL="https://api.relaycast.dev"  # API base URL (this is the default)
export RELAY_AGENT_NAME="my-agent"                 # Fixed agent identity
```

### 3. Allow relay tools for background workers

Background workers can't prompt for tool approval interactively — MCP calls silently fail without this. Run the setup script from your project root:

```bash
bash .claude-plugin/setup.sh
```

This adds `mcp__plugin_agent-relay_relaycast` to your `.claude/settings.json` permissions, allowing background workers to use relay tools (register, send messages, check inbox) without being blocked.

If you prefer to do it manually, add this to `.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_agent-relay_relaycast"
    ]
  }
}
```

### 4. Verify

Start Claude Code in your project. You should see the Relaycast MCP tools available (e.g., `post_message`, `check_inbox`, `create_channel`). Run `/tools` to confirm.

## Usage

Once the plugin is installed and your env vars are set, you can start coordinating agents.

### Quick start: send a message

Ask Claude to use the Relaycast MCP tools directly:

```
> Post a message to the #general channel saying "hello from my agent"
```

### Coordinate a team

Use the built-in skills to orchestrate multi-agent work:

```
> /relay-team Refactor the auth module — split the middleware, update tests, and update docs

> /relay-fanout Run linting fixes across all packages in the monorepo

> /relay-pipeline Analyze the API logs, then generate a summary report, then draft an email
```

- **`/relay-team`** — Best for multi-part tasks where workers need some coordination. Spawns 1-5 workers with explicit scopes and monitors their progress.
- **`/relay-fanout`** — Best for embarrassingly parallel work (same task across different targets). Workers run independently with no inter-dependencies.
- **`/relay-pipeline`** — Best for sequential work where each stage depends on the previous one's output. Stages run one at a time with explicit handoffs.

These slash commands are prompt templates — they load orchestration instructions into Claude's context as a convenience. They are not the only way to trigger relay coordination. You can also describe what you want in plain language and Claude will set up the workspace, spawn relay-workers, and coordinate them. The plugin's hooks and agent definitions handle the infrastructure automatically regardless of how the request is phrased.

### Natural language usage

You don't need slash commands to coordinate agents. Any prompt that describes multi-agent work will trigger the same coordination machinery:

```
> Use relay fan-out to lint all packages in parallel

> Split the migration into three relay workers — one for the database schema,
  one for the API routes, and one for the frontend types

> Set up a relay pipeline: first gather all TODO comments in the codebase,
  then categorize them by priority, then open GitHub issues for the top 10
```

Claude recognizes these requests because the plugin's skills, hooks, and agent definitions are already loaded. The slash commands are simply a shortcut for loading the same instructions.

### How agent spawning works

The plugin uses two separate mechanisms — **Claude Code's Agent tool** for spawning processes, and **Relay** for communication between them:

1. **Spawning**: When a skill like `/relay-team` runs, Claude uses its built-in Agent tool to spawn child Claude processes (subagents). Each worker is created with `subagent_type: "relay-worker"`, which gives it the Relaycast MCP server, inbox-polling hooks, and the worker protocol prompt.

2. **Bootstrap**: The `SubagentStart` hook automatically fires when a worker is spawned, injecting relay bootstrap instructions — register with the workspace, check inbox, ACK the lead, send DONE when finished.

3. **Communication**: Workers and the lead communicate through Relay MCP tools (`send_dm`, `post_message`, `check_inbox`). The `PostToolUse` hook polls the inbox after every tool call, so messages are picked up automatically.

4. **Concurrency**: Workers can run in the background (parallel) or foreground (sequential). The `/relay-team` and `/relay-fanout` skills use background mode; `/relay-pipeline` uses foreground mode to enforce stage ordering.

5. **Peer messaging**: Workers can message each other directly through Relay, not just the lead. Each worker has its own MCP server connection and inbox-polling hooks.

```
┌─────────────────────────────────────────────────┐
│  Claude Code Session (Lead)                     │
│                                                 │
│  Agent Tool ──spawn──► Worker 1 (relay-worker)  │
│  Agent Tool ──spawn──► Worker 2 (relay-worker)  │
│  Agent Tool ──spawn──► Worker 3 (relay-worker)  │
│                                                 │
│  ┌───────────────────────────────────────────┐  │
│  │  Relay (message bus)                      │  │
│  │                                           │  │
│  │  Lead ◄──DM──► Worker 1                   │  │
│  │  Lead ◄──DM──► Worker 2                   │  │
│  │  Worker 1 ◄──DM──► Worker 2               │  │
│  │  All ◄──channel──► #task-updates          │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

### What happens automatically

Once installed, the plugin runs in the background without any extra commands:

1. **After every tool call**, Claude checks the relay inbox for new messages from other agents
2. **When Claude tries to exit**, the stop guard checks for unread messages and blocks exit until they're handled
3. **When Claude spawns a subagent**, the `SubagentStart` hook injects relay bootstrap instructions (register, check inbox, ACK, send DONE)
4. **Before context compaction**, relay state is preserved so Claude remembers its identity and team

### Running multiple agents

You can also run agents across separate terminals instead of using subagents:

```bash
# Terminal 1 — lead agent
RELAY_AGENT_NAME="lead" claude

# Terminal 2 — worker agent
RELAY_AGENT_NAME="worker-1" claude

# Terminal 3 — another worker
RELAY_AGENT_NAME="worker-2" claude
```

Each agent registers with the relay and can message the others through channels or direct messages. This is useful when you want agents with separate context windows, different working directories, or manual control over each agent.

## Prerequisites

- Claude Code CLI
- `bash`, `curl`, and `jq` (for shell hooks)
- Node.js (for the stop guard hook and MCP server)

## Environment variables

| Variable | Required | Default | Used by |
|----------|----------|---------|---------|
| `RELAY_API_KEY` | No | auto-created via `create_workspace` | MCP server (workspace auth) |
| `RELAY_TOKEN` | No | — | Hook scripts (inbox polling) |
| `RELAY_BASE_URL` | No | `https://api.relaycast.dev` | MCP server + hooks |
| `RELAY_AGENT_NAME` | No | `"unknown"` | MCP server + hooks (agent identity) |
| `RELAY_WORKERS_JSON` | No | — | `pre-compact.sh` (inline worker list) |
| `RELAY_WORKERS_FILE` | No | `.agent-relay/team/workers.json` | `pre-compact.sh` (worker file path) |

## Plugin structure

```
claude-relay-plugin/
  .claude-plugin/plugin.json   # Plugin manifest (Claude discovers this)
  .mcp.json                    # Relaycast MCP server configuration
  hooks/
    hooks.json                 # Hook definitions
    stop-inbox.js              # Stop guard (blocks exit if unread messages)
    post-tool-inbox.sh         # Polls inbox after each tool call
    subagent-bootstrap.sh      # Injects relay bootstrap into subagents
    pre-compact.sh             # Preserves relay state before compaction
  agents/
    relay-worker/              # Worker agent template
  skills/
    relay-fanout/              # Fan-out coordination skill
    relay-pipeline/            # Pipeline coordination skill
    relay-team/                # Team coordination skill
```

## Hook behavior

### Stop

Reads the Claude hook payload from stdin. Returns `{"decision":"approve"}` immediately when `stop_hook_active` is `true`. Otherwise checks the Relaycast inbox and blocks the agent from exiting while unread messages exist.

### PostToolUse

Polls the Relaycast inbox after each tool call using `curl` and `jq`. Prints any new messages to stdout so Claude sees them as additional context.

### SubagentStart

Injects bootstrap instructions into every spawned subagent: authenticate, register with the relay, check inbox, ACK messages, and send DONE before exit.

### PreCompact

Emits a relay-state summary (agent identity, workspace, known workers) before Claude compacts context. This is best-effort — Claude's `PreCompact` hook is side-effect oriented, not a guaranteed context mutation.

## Skills

The plugin includes three coordination skills:

- **`/relay-team`** — Set up a team of coordinated agents
- **`/relay-fanout`** — Fan out work across multiple agents in parallel
- **`/relay-pipeline`** — Chain agents in a sequential pipeline

## Troubleshooting

### "Workspace key not configured. Call create_workspace or set_workspace_key first."

The MCP server doesn't have a workspace key yet. This is normal if you haven't set `RELAY_API_KEY` in your environment. The skills handle this automatically by calling `create_workspace`, but if you're using relay tools directly:

1. Call `create_workspace` to generate a workspace key on the fly, or
2. Set `RELAY_API_KEY` in your shell before launching Claude:

   ```bash
   export RELAY_API_KEY="rk_live_your_key_here"
   claude
   ```

### "Not registered. Call the register tool first."

This happens when you try to use relay tools before the agent has registered. Normally the agent registers automatically, but if the workspace key is missing (see above), registration fails silently and all subsequent tool calls fail with this error. Fix the workspace key first.

### Workers can't post messages / "permission issues"

Background subagents can't get interactive approval for tool calls. You need to allowlist Relaycast MCP tools in `.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["mcp__plugin_agent-relay_relaycast"]
  }
}
```

Without this, workers will spawn and do their work but silently fail on every relay MCP call.

### Workers all register as the lead's name

If workers are being forced to register as the lead's identity instead of their own names, check that `RELAY_STRICT_AGENT_NAME` is not set in your environment or `.mcp.json`. This setting (used by the broker) locks registration to a single name and should not be used in the plugin context.

### Hooks aren't firing

- Confirm the plugin is installed at `.claude-plugin/plugin.json` in your project root
- Run `/tools` in Claude Code to check that Relaycast MCP tools appear
- Verify `bash`, `curl`, and `jq` are available on your PATH

### Subagents don't connect to relay

Subagents inherit env vars from the parent process. If the parent has `RELAY_API_KEY` set, subagents should connect automatically via the `SubagentStart` hook. If they don't:

- Check that `RELAY_API_KEY` is exported (not just set): `export RELAY_API_KEY=...`
- Verify the `SubagentStart` hook is listed in `/hooks`

## Legacy note

If you encounter references to `RELAY_WORKSPACE`, this is the older name for the workspace key concept now represented by `RELAY_API_KEY`.
