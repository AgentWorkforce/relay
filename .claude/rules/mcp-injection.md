---
paths:
  - 'src/spawner.rs'
  - 'src/snippets.rs'
  - 'relay-pty/src/inject.rs'
  - 'relay-pty/src/protocol.rs'
---

# MCP Configuration Injection

When agents are spawned, the broker dynamically injects Relaycast MCP server configuration so the agent can communicate via MCP tools. **Not all CLI providers support this the same way.**

## Injection Flow

```
spawn_wrap() (spawner.rs)
  → configure_relaycast_mcp() (snippets.rs)
    → CLI-specific injection mechanism
      → Agent spawns with MCP tools available
```

## CLI Provider Support Matrix

| CLI                   | MCP Support | Mechanism                                    | Key Function                   |
| --------------------- | ----------- | -------------------------------------------- | ------------------------------ |
| **Claude**            | Full        | `--mcp-config '{json}'` flag                 | `configure_relaycast_mcp()`    |
| **Codex**             | Full        | Multiple `--config key=value` flags          | `configure_relaycast_mcp()`    |
| **Opencode**          | Full        | Writes `opencode.json` + `--agent relaycast` | `ensure_opencode_config()`     |
| **Gemini**            | Conditional | Pre-spawn `gemini mcp add` command           | `configure_gemini_droid_mcp()` |
| **Droid**             | Conditional | Pre-spawn `droid mcp add` command            | `configure_gemini_droid_mcp()` |
| **Goose/Aider/Other** | None        | No injection — agent has no MCP tools        | —                              |

## Adding a New CLI Provider

When adding MCP injection for a new CLI:

1. Add detection logic in `configure_relaycast_mcp()` (snippets.rs)
2. Check if the user already provided their own MCP config (opt-out pattern)
3. Use the CLI's native config mechanism (prefer flags > files > pre-spawn commands)
4. Include these env vars in the MCP server config:
   - `RELAY_BASE_URL` — API endpoint
   - `RELAY_AGENT_NAME` — agent identity
   - `RELAY_AGENT_TYPE` — always `"agent"`
   - `RELAY_STRICT_AGENT_NAME` — always `"1"`
   - `RELAY_AGENT_TOKEN` — if available (pre-registered agents)
5. **Do NOT include `RELAY_API_KEY`** in Claude's `--mcp-config` — the MCP server reads credentials from `~/.agent-relay/relaycast.json` at startup. Other CLIs (Codex, Opencode) do include it since they don't share that credential file mechanism.

## Opt-Out Detection

Always check if the user already provided MCP config before injecting:

```rust
// Claude: skip if user passed --mcp-config
if !existing_args.iter().any(|a| a.contains("mcp-config")) { ... }

// Codex: skip if user configured mcp_servers.relaycast
if !existing_args.iter().any(|a| a.contains("mcp_servers.relaycast")) { ... }

// Opencode: skip if user passed --agent
if !existing_args.iter().any(|a| a == "--agent") { ... }
```

## Message Injection (Post-Spawn)

After an agent is running, incoming relay messages are injected into the PTY with `<system-reminder>` wrappers that guide the agent to reply using MCP tools:

- DMs → hint to use `mcp__relaycast__send_dm`
- Channel messages → hint to use `mcp__relaycast__post_message`
- Includes channel context `[#channel-name]` when applicable
- Prevents double-wrapping of system-reminder tags

## CLIs Without MCP Support

For CLIs that don't support MCP (goose, aider, etc.):

- The agent spawns without MCP tools
- Message injection still happens via PTY
- The agent can only respond through its PTY output, not via MCP tool calls
- Consider adding support if the CLI adds MCP configuration capabilities
