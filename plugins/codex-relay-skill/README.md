# Codex Relay Skill

Codex-native multi-agent coordination via Relaycast.

## What it does

This package gives Codex a reusable relay coordination layer so sub-agents can communicate through Relaycast instead of staying limited to parent-only result collection.

It includes:

- a Codex skill that teaches lead and worker messaging protocol
- an MCP dependency declaration for Relaycast
- a template Relaycast MCP config block for `.codex/config.toml`
- a `relay-worker` custom agent template for `.codex/agents/`

With these pieces installed, Codex can:

- coordinate teams through direct messages, channels, and threads
- require ACK/DONE signaling from workers
- let workers send peer-to-peer updates through Relaycast
- reuse the same relay workflow across project-scoped and user-scoped setups

## Installation

```bash
mkdir -p .agents/skills
cp -R plugins/codex-relay-skill .agents/skills/agent-relay
```

That's it. Everything else is automatic.

On first use, the skill self-installs by running `scripts/setup.sh`, which:

- adds the Relaycast MCP server to `.codex/config.toml`
- enables `features.codex_hooks = true`
- writes `.codex/hooks.json` with SessionStart, UserPromptSubmit, and Stop hooks
- installs `.codex/agents/relay-worker.toml`

All of this is idempotent — safe to run multiple times, and it merges with existing config rather than overwriting.

For user-wide availability, install to `$HOME/.agents/skills/agent-relay` instead.

### Optional: join an existing workspace

Set `RELAY_API_KEY` before launching Codex to join a specific Relaycast workspace:

```bash
export RELAY_API_KEY="rk_live_your_key_here"
```

If unset, a new workspace is auto-created on the first session.

<details>
<summary>Manual setup (advanced)</summary>

If you prefer to configure everything manually instead of using the auto-installer:

1. Add to `.codex/config.toml`:
```toml
features.codex_hooks = true

[mcp_servers.relaycast]
command = "npx"
args = ["-y", "@relaycast/mcp"]
env = { RELAY_API_KEY = "", RELAY_BASE_URL = "https://api.relaycast.dev", RELAY_AGENT_TYPE = "agent" }
```

2. Copy hooks config:
```bash
cp .agents/skills/agent-relay/hooks/hooks.json .codex/hooks.json
```

3. Install the worker agent:
```bash
mkdir -p .codex/agents
cp .agents/skills/agent-relay/codex-config/relay-worker.toml .codex/agents/relay-worker.toml
```

</details>

## Usage

### Use the skill directly

Invoke the skill explicitly:

```text
$agent-relay Coordinate this refactor with two workers and keep all status updates in Relaycast.
```

Or describe the task naturally and let Codex match the skill from its description.

### Spawn relay workers

Once `relay-worker.toml` is installed, delegate bounded tasks to the `relay-worker` custom agent and include:

- the worker relay name
- the lead relay name
- the workspace-key source
- exact task scope
- completion criteria

Example:

```text
Spawn a relay-worker named api-worker.
Have it check Relaycast, ACK me, update the API route tests only, send STATUS after the first green test run, and send DONE with evidence before exit.
```

### Coordinate a team

Use Relaycast when workers need to message each other directly, not only the lead. Good fits:

- parallel implementation across separate subsystems
- lead/worker review loops
- shared channel updates for longer-running tasks
- cross-terminal or cross-machine collaboration

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RELAY_API_KEY` | No | `""` in the template config | Relaycast workspace key |
| `RELAY_BASE_URL` | No | `https://api.relaycast.dev` | Relaycast API base URL |
| `RELAY_AGENT_TYPE` | No | `agent` | Default Relaycast agent type |
| `RELAY_AGENT_NAME` | No | unset | Optional stable relay identity when your workflow wants a fixed name |

## Plugin structure

```text
codex-relay-skill/
  SKILL.md                    # Codex skill manifest and workflow instructions
  README.md                   # Installation and usage docs
  agents/
    openai.yaml              # Relaycast MCP dependency metadata
  codex-config/
    config.toml              # Template MCP server config for .codex/config.toml
    relay-worker.toml        # Template custom worker agent for .codex/agents/
  scripts/
    setup.sh                 # Auto-installer (runs on first skill activation)
  hooks/
    hooks.json               # Hook definitions (SessionStart, Stop, UserPromptSubmit)
    session-start.sh         # Auto-connect and state persistence
    stop-inbox.sh            # Block exit while unread messages exist
    prompt-inbox.sh          # Rate-limited inbox polling and context injection
```

Installed layout in a project typically looks like:

```text
.agents/skills/agent-relay/   # Skill directory Codex scans
.codex/config.toml            # Runtime Relaycast MCP server + features.codex_hooks
.codex/hooks.json             # Hook wiring (copied from skill)
.codex/agents/relay-worker.toml
```
