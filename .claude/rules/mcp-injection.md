---
paths:
  - 'crates/broker/src/spawner.rs'
  - 'crates/broker/src/snippets.rs'
  - 'crates/broker/src/inject.rs'
  - 'crates/broker/src/broker/injection_format.rs'
---

# MCP Configuration Injection

When agents are spawned, the broker dynamically injects the Agent Relay MCP server configuration so the agent can communicate via MCP tools. **Not all CLI providers support this the same way.**

## Injection Flow

```
spawn_wrap_with_token() (spawner.rs)
  → configure_agent_relay_mcp() (snippets.rs)   ← pass original CLI name, NOT resolved_cli
    → merge_agent_relay_with_project_mcp()       ← merges user MCP servers + agent-relay
    → inject_api_key_into_mcp_json()             ← Claude-only: embeds RELAY_API_KEY
    → CLI-specific injection mechanism
      → Agent spawns with MCP tools available
```

## MCP Config Merge Order (Claude)

`merge_agent_relay_with_project_mcp_inner()` loads MCP servers in precedence order (lowest first, later overrides earlier):

1. `~/.claude/settings.json` — user-global
2. `~/.claude/settings.local.json` — user-global local
3. `<cwd>/.mcp.json` — project legacy
4. `<cwd>/.claude/settings.json` — project
5. `<cwd>/.claude/settings.local.json` — project local
6. `agent-relay` server entry — always added last (highest precedence)

## MCP Executable Resolution

Spawned MCP servers must use an already-installed Relay executable. Never add
`npx -y agent-relay mcp` back as a default: a cold package resolution can exceed
the client connection timeout and leave a live worker with no Relay tools.

The broker resolves the command in this order:

1. An explicit `AGENT_RELAY_MCP_COMMAND` whose executable is usable
2. `$AGENT_RELAY_INSTALL_DIR/bin/agent-relay`
3. `~/.agentworkforce/relay/bin/agent-relay`
4. `agent-relay` resolved on `PATH`
5. `$AGENT_RELAY_BIN_DIR/agent-relay`, or `~/.local/bin/agent-relay`

The standalone Bun CLI re-enters its own installed executable as
`agent-relay mcp`; npm/Node installs continue to use their adjacent bundled MCP
script. If no usable command can be resolved, MCP configuration returns an
actionable error before the worker is spawned, so the dispatcher cannot mistake
process liveness for Relay readiness.

## Important: CLI Name in Spawner

In `spawner.rs`, always pass the **original CLI name** (e.g. `"claude"`, `"cursor"`) to `configure_agent_relay_mcp_with_token()`, not `resolved_cli`. `parse_cli_command()` resolves aliases (e.g. `"cursor"` → `"agent"`), which would bypass CLI-specific config logic.

## CLI Provider Support Matrix

| CLI                   | MCP Support | Mechanism                                      | Key Function                   |
| --------------------- | ----------- | ---------------------------------------------- | ------------------------------ |
| **Claude**            | Full        | `--mcp-config '{json}'` flag                   | `configure_agent_relay_mcp()`  |
| **Codex**             | Full        | Multiple `--config key=value` flags            | `configure_agent_relay_mcp()`  |
| **Cursor**            | Full        | Writes `.cursor/mcp.json`                      | `ensure_cursor_mcp_config()`   |
| **Opencode**          | Full        | Writes `opencode.json` + `--agent agent-relay` | `ensure_opencode_config()`     |
| **Gemini**            | Conditional | Pre-spawn `gemini mcp add` command             | `configure_gemini_droid_mcp()` |
| **Droid**             | Conditional | Pre-spawn `droid mcp add` command              | `configure_gemini_droid_mcp()` |
| **Goose/Aider/Other** | None        | No injection — agent has no MCP tools          | —                              |

## Adding a New CLI Provider

When adding MCP injection for a new CLI:

1. Add detection logic in `configure_agent_relay_mcp()` (snippets.rs)
2. Check if the user already provided their own MCP config (opt-out pattern)
3. Use the CLI's native config mechanism (prefer flags > files > pre-spawn commands)
4. Include these env vars in the MCP server config:
   - `RELAY_BASE_URL` — API endpoint
   - `RELAY_AGENT_NAME` — agent identity
   - `RELAY_AGENT_TYPE` — always `"agent"`
   - `RELAY_STRICT_AGENT_NAME` — always `"1"`
   - `RELAY_AGENT_TOKEN` — if available (pre-registered agents)
   - `RELAY_WORKSPACES_JSON` — multi-workspace context (if provided)
   - `RELAY_DEFAULT_WORKSPACE` — default workspace selection (if provided)
5. **Include `RELAY_API_KEY`** in Claude's `--mcp-config` — Claude Code does not reliably inherit parent process env vars into MCP server subprocesses when using `--mcp-config` + `--strict-mcp-config`, so the key must be embedded directly in the JSON config. The `inject_api_key_into_mcp_json()` helper handles this after the merge step. Other CLIs (Codex, Cursor, Opencode) also include it via their own mechanisms.

## Workspace Variable Forwarding

Multi-workspace vars (`RELAY_WORKSPACES_JSON`, `RELAY_DEFAULT_WORKSPACE`) must be threaded through **function parameters**, never read from `std::env::var()`. The broker's `up` mode sets these in `worker_env`, not in the broker's own process environment.

All CLI paths accept `workspaces_json: Option<&str>` and `default_workspace: Option<&str>`:

| Function                                   | Role                                                               |
| ------------------------------------------ | ------------------------------------------------------------------ |
| `configure_agent_relay_mcp_with_token()`   | Top-level entry; receives params, passes to each CLI path          |
| `merge_agent_relay_with_project_mcp()`     | Claude path; threads to `agent_relay_mcp_server_config()`          |
| `ensure_opencode_config()`                 | OpenCode; inserts into `environment` block                         |
| `ensure_cursor_mcp_config()`               | Cursor; chains through `agent_relay_mcp_config_json_with_token()`  |
| `gemini_droid_mcp_add_args()`              | Gemini/Droid; appends as `--env`/`-e` flags                        |
| `agent_relay_mcp_config_json_with_token()` | Shared JSON builder; forwards to `agent_relay_mcp_server_config()` |

**Rule:** When adding a new CLI path, always accept and forward these two params. Never fall back to `std::env::var()`.

## Opt-Out Detection

Always check if the user already provided MCP config before injecting:

```rust
// Claude: skip if user passed --mcp-config
if !existing_args.iter().any(|a| a.contains("mcp-config")) { ... }

// Codex: skip if user configured mcp_servers.agent-relay (or legacy mcp_servers.relaycast)
if !existing_args.iter().any(|a| a.contains("mcp_servers.agent-relay") || a.contains("mcp_servers.relaycast")) { ... }

// Opencode: skip if user passed --agent
if !existing_args.iter().any(|a| a == "--agent") { ... }
```

## Message Injection (Post-Spawn)

After an agent is running, incoming relay messages are injected into the PTY with `<system-reminder>` wrappers that guide the agent to reply using MCP tools:

- DMs → hint to use `mcp__agent-relay__send_dm`
- Channel messages → hint to use `mcp__agent-relay__post_message`
- Includes channel context `[#channel-name]` when applicable
- Prevents double-wrapping of system-reminder tags

Claude decorates the canonical `agent-relay` server key literally, including
the hyphen: `mcp__agent-relay__send_dm`, `mcp__agent-relay__post_message`, and
`mcp__agent-relay__check_inbox`. The `relaycast` server key is a legacy alias
used only to detect and migrate older configuration; do not use
`mcp__relaycast__*` in new allowlists or guidance.

## CLIs Without MCP Support

For CLIs that don't support MCP (goose, aider, etc.):

- The agent spawns without MCP tools
- Message injection still happens via PTY
- The agent can only respond through its PTY output, not via MCP tool calls
- Consider adding support if the CLI adds MCP configuration capabilities
