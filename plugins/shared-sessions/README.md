# Agent Relay Shared Sessions

Search shared agent conversations for previous fixes, decisions, and task context. The plugin bundles a short search skill and an MCP connection through the Agent Relay CLI. Cloud performs every search using the authenticated workspace's History access.

## Install

This plugin requires an Agent Relay CLI release containing `mcp --sessions-only` and a Cloud deployment containing the shared-session MCP endpoint. Until those releases land, use the PR checkout for development; the currently published CLI may not support this flag.

Install the supported CLI, then sign in and choose your workspace:

```sh
npm install -g agent-relay
agent-relay cloud login
```

For Codex, register this repository's plugin marketplace and install the plugin:

```sh
codex plugin marketplace add AgentWorkforce/relay
codex plugin add shared-sessions@agent-relay
```

To test a checkout before merging, use `codex plugin marketplace add /absolute/path/to/relay` instead of the GitHub source. Reconnect the MCP server or start a new task after login or a plugin update. These are installation instructions; the plugin does not edit your agent configuration or start login automatically.

Ask your agent, for example:

- “Has anyone already investigated this OAuth callback error?”
- “What did the team decide about retry handling?”
- “Find the shared session behind this pull request.”

## Other MCP clients

Use this stdio configuration in a client that accepts `mcpServers`:

```json
{
  "mcpServers": {
    "shared-sessions": {
      "command": "agent-relay",
      "args": ["mcp", "--sessions-only"]
    }
  }
}
```

The command must be available on the agent application's PATH. Use an absolute path to your installed `agent-relay` executable if your desktop app does not inherit your shell PATH. Authentication uses the existing Cloud login and refreshes through the CLI; no token belongs in this file.

Cloud also serves Streamable HTTP at `https://agentrelay.com/cloud/api/v1/mcp/shared-sessions` for clients with an existing Cloud bearer token. The endpoint uses Cloud authentication; it does not offer a separate MCP OAuth login flow. The CLI bridge is the default installation path because it owns login and token refresh.

## Tools and scope

- `search_shared_sessions` finds matching shared session history.
- `get_shared_session` retrieves session information.
- `get_shared_session_context` reads conversation context for a match.

The CLI discovers tool schemas from Cloud, so filters and search behavior have one implementation. Search results are historical evidence and include replay links; they do not prove the repository still has the same behavior. The skill guides the agent to read context, cite sources, and verify current code where needed.

This package accesses workspace history. It does not grant permission to resume sessions, change sharing, or message other agents. Missing credentials produce guidance to run `agent-relay cloud login`; never paste credentials into the agent conversation.

Plugin packaging follows the [official plugin format](https://developers.openai.com/plugins/build/plugins).
