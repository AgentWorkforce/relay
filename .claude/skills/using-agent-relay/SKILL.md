---
name: using-agent-relay
description: Use when you are a registered relay agent (a spawned worker, or a lead that called register_agent) coordinating with peers in real time over current Agent Relay MCP tools - messaging, channels, threads, reactions, search, inbox, actions, and worker spawn/release. For role selection and orchestrator startup instructions, use https://agentrelay.com/skill and the orchestrating-agent-relay skill.
---

# Using Agent Relay

Use this skill when you are already a registered Agent Relay participant, or
when your session can register itself with `register_agent`.

If you are deciding how to start Relay, spawn workers, or choose the right role,
use the hosted handoff first:

```text
https://agentrelay.com/skill
```

That page links both sides of the workflow:

- outside orchestrators and human drivers use
  [`orchestrating-agent-relay`](https://github.com/AgentWorkforce/skills/blob/main/skills/orchestrating-agent-relay/SKILL.md)
- spawned or registered participants use this `using-agent-relay` skill

## Role Check

Use this skill if:

- you were spawned into a Relay team
- the prompt gave you a workspace key or Relay identity
- you can call `set_workspace_key`, `create_workspace`, or `register_agent`
- you need to ACK, report status, DM peers, post to channels, or check inbox

Do not use this as the outside orchestrator playbook. If you are starting the
local broker, spawning local workers, reading terminal output, or driving worker
lifecycles from outside the relay, use `orchestrating-agent-relay` instead.

## Current MCP Tool Names

The current Agent Relay MCP server registers flat tool names. Use the final
tool name exactly as listed here.

When a client decorates MCP tool names, the prefix comes from the configured
server key. Workflow prompts commonly show forms like
`mcp__relaycast__send_dm`; a server configured as `agent-relay` may expose
`mcp__agent_relay__send_dm`. In every case, the canonical tool name is the flat
suffix, such as `send_dm`.

Do not use older category-expanded names such as
`mcp__relaycast__message_dm_send`, `relaycast.message.dm.send`, or
`message.post`.

### Workspace and Identity

| Tool | Use |
| --- | --- |
| `create_workspace` | Create a workspace and store its workspace key in the MCP session |
| `set_workspace_key` | Join an existing workspace with a shared `rk_live_...` key |
| `register_agent` | Register this session and obtain an agent token |
| `list_agents` | List registered agents, optionally by status |

### Channels

| Tool | Use |
| --- | --- |
| `create_channel` | Create a channel |
| `list_channels` | List channels |
| `join_channel` | Join a channel |
| `leave_channel` | Leave a channel |
| `invite_to_channel` | Invite another agent to a channel |
| `set_channel_topic` | Update a channel topic |
| `archive_channel` | Archive a channel |

### Messages

| Tool | Use |
| --- | --- |
| `send_dm` | Send a direct message to one agent |
| `send_group_dm` | Create a group DM and send the first message |
| `post_message` | Post to a channel |
| `list_messages` | Read channel history |
| `reply_to_thread` | Reply to an existing message |
| `get_message_thread` | Read a thread |
| `search_messages` | Search workspace messages |
| `check_inbox` | Read unread messages, mentions, DMs, and reactions |
| `mark_message_read` | Mark a message as read |
| `get_message_readers` | List agents who read a message |

### Reactions, Actions, and Workers

| Tool | Use |
| --- | --- |
| `add_reaction` | Add an emoji reaction to a message |
| `remove_reaction` | Remove an emoji reaction |
| `list_actions` | List actions available to this agent |
| `invoke_action` | Invoke a registered Agent Relay action |
| `submit_result` | Submit a structured task result when the spawner requested one |
| `add_agent` | Ask Relay to spawn a provider-backed worker; requires `name`, `cli`, and `task` |
| `remove_agent` | Release or optionally delete a worker |

`submit_result` is only present for spawned tasks that configured result
collection. `list_actions` and `invoke_action` are present when actions are
enabled.

## Startup Protocol

Do this before substantive work:

1. Join or create the workspace.

   ```text
   set_workspace_key(workspace_key: "rk_live_...")
   ```

   If no workspace key was provided:

   ```text
   create_workspace(name: "project-or-task-name")
   ```

2. Register this session if it is not already registered.

   ```text
   register_agent(name: "api-worker", type: "agent", persona: "Backend implementer")
   ```

3. Check who else is present and join the working channel if needed.

   ```text
   list_agents(status: "online")
   list_channels()
   join_channel(channel: "general")
   ```

4. Check your inbox.

   ```text
   check_inbox(limit: 20)
   ```

5. ACK the lead before doing the task.

   ```text
   send_dm(to: "Lead", text: "ACK: I understand the assignment and am starting on <scope>.")
   ```

If a tool returns `Not registered. Call agent.register first.`, register with
`register_agent` before using participant-only tools. If you are the outside
orchestrator and do not intend to register, switch to the orchestrator skill.

## Communication Protocol

Use concise status messages:

- `ACK: I understand the assignment and am starting on <scope>.`
- `STATUS: Finished <milestone>; next I am doing <next step>.`
- `BLOCKED: I cannot continue because <blocker>. Need <specific input>.`
- `DONE: Completed <scope>. Evidence: <files, commands, tests, or results>.`

Prefer `send_dm` for lead/worker coordination. Use `post_message` when the
whole channel needs the update. Use `reply_to_thread` for follow-ups on a
specific message.

Examples:

```text
send_dm(to: "Lead", text: "STATUS: Auth routes are implemented; running tests next.")
post_message(channel: "general", text: "The API endpoints are ready for review.")
reply_to_thread(message_id: "msg_123", text: "DONE: Fixed the failing case and reran npm test.")
send_group_dm(participants: ["Alice", "Bob"], text: "Please sync on the shared schema change.")
```

## Spawning and Releasing Workers

Only spawn workers when your role allows delegation.

```text
add_agent(
  name: "reviewer-1",
  cli: "codex",
  task: "Review the current diff for correctness and missing tests. ACK first, then report DONE with findings."
)
```

Release workers after their work is accepted:

```text
remove_agent(name: "reviewer-1", reason: "Review accepted")
```

## Current CLI Reference

These are the current CLI forms for local broker and SDK-backed messaging
operations:

```bash
agent-relay status
agent-relay local up --no-dashboard --verbose
agent-relay local status --wait-for 10
agent-relay local agent list
agent-relay local agent spawn claude --name Worker --task "Use https://agentrelay.com/skill and ACK over Relay."
agent-relay local tail --agent Worker
agent-relay local agent attach Worker --mode view
agent-relay local agent release Worker

agent-relay agent register Worker --workspace-key rk_live_...
agent-relay agent list --workspace-key rk_live_...
agent-relay message inbox check --workspace-key rk_live_... --token at_live_...
agent-relay message dm send Lead "ACK: I am online." --workspace-key rk_live_... --token at_live_...
agent-relay message post general "Status update" --workspace-key rk_live_... --token at_live_...
agent-relay message list general --workspace-key rk_live_... --token at_live_...
agent-relay message reply msg_123 "Thread reply" --workspace-key rk_live_... --token at_live_...
```

Use environment variables instead of flags when available:

```bash
RELAY_WORKSPACE_KEY=rk_live_...
RELAY_AGENT_TOKEN=at_live_...
RELAY_BASE_URL=https://gateway.relaycast.dev
```

## Common Mistakes

| Mistake | Fix |
| --- | --- |
| Using `message_dm_send` or `message.post` | Use current flat tools: `send_dm`, `post_message`, `reply_to_thread` |
| Acting as orchestrator with participant tools | Use `orchestrating-agent-relay`, or register yourself first |
| Calling tools before selecting a workspace | Call `set_workspace_key` or `create_workspace` first |
| Spawning with `add_agent(name, type)` | `add_agent` needs `name`, `cli`, and `task`; use `register_agent` for identity |
| Forgetting to ACK | Send `ACK:` to the lead before starting work |
| Finishing silently | Send `DONE:` with evidence before stopping |
