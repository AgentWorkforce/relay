# Claude Relay Plugin

Relaycast MCP plus Claude Code hooks for brokerless multi-agent coordination.

## Included files

- `plugin.json` wires Relaycast MCP plus the `Stop`, `PostToolUse`, `SubagentStart`, and `PreCompact` hooks.
- `hooks/stop-inbox.ts` is the TypeScript source for the stop guard. `hooks/stop-inbox.js` is a checked-in runtime copy so the manifest works without a build step.
- `hooks/post-tool-inbox.sh` polls the relay inbox after each tool call and emits plain-text context when unread messages exist.
- `hooks/subagent-bootstrap.sh` injects Relaycast bootstrap instructions into spawned Claude subagents.
- `hooks/pre-compact.sh` emits a relay state summary with agent identity, workspace, and worker list before compaction.

## Environment

- `RELAY_API_KEY`: Relaycast workspace key for the MCP server. This is the current Relaycast/MCP env name for the workspace key.
- `RELAY_TOKEN`: Per-agent bearer token used by the hook scripts to poll `/v1/inbox/check`.
- `RELAY_BASE_URL`: Optional API base URL. Defaults to `https://api.relaycast.dev`.
- `RELAY_AGENT_NAME`: Optional fixed agent identity for the MCP server and bootstrap hook.
- `RELAY_WORKERS_JSON`: Optional JSON array or `{ "workers": [...] }` object consumed by `pre-compact.sh`.
- `RELAY_WORKERS_FILE`: Optional override for the workers file path. Defaults to `.agent-relay/team/workers.json` under the current working directory.

If you are reading older spec text that refers to `RELAY_WORKSPACE`, treat that as the workspace-key concept now represented by `RELAY_API_KEY` in the MCP server configuration. The inbox hooks still need `RELAY_TOKEN` separately because they poll Relaycast over HTTP outside the MCP session.

## Hook behavior

`Stop`

- Reads the Claude hook payload from stdin.
- Returns `{"decision":"approve"}` immediately when `stop_hook_active` is `true`.
- Otherwise checks the Relaycast inbox and blocks only when unread messages exist.

`PostToolUse`

- Uses `curl` plus `jq` to poll Relaycast after each tool call.
- Prints plain text to stdout so Claude appends the relay messages as additional context.

`SubagentStart`

- Injects the bootstrap sequence every new Claude subagent should follow: authenticate if needed, register, check inbox, ACK, then send DONE before exit.

`PreCompact`

- Emits a relay-state preservation string that includes the current agent, workspace, and known workers.
- Claude's current `PreCompact` hook is side-effect oriented, so this hook is best-effort state preservation rather than a guaranteed context mutation.

## Runtime notes

- Claude Code currently discovers plugin manifests at `.claude-plugin/plugin.json`. This package keeps the source manifest at the root for spec parity and can mirror it into `.claude-plugin/plugin.json`.
- Shell hooks require `bash`, `curl`, and `jq`.
