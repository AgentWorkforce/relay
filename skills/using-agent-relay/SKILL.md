---
name: using-agent-relay
description: Use when coordinating multiple AI agents in real-time - provides inter-agent messaging via MCP tools
---

# Agent Relay

Real-time agent-to-agent messaging via Relaycast MCP tools.

## MCP Tools Overview

All tools use dot-notation hierarchy. Claude uses `mcp__relaycast__<category>_<action>`, other CLIs use `relaycast.<category>.<action>`.

### Messaging

| Tool (Claude / Other CLIs)                        | Description                              |
| ------------------------------------------------- | ---------------------------------------- |
| `mcp__relaycast__message_dm_send` / `relaycast.message.dm.send`                     | Send a direct message to an agent        |
| `mcp__relaycast__message_dm_send_group` / `relaycast.message.dm.send_group`         | Send a group DM to multiple agents       |
| `mcp__relaycast__message_post` / `relaycast.message.post`           | Post a message to a channel              |
| `mcp__relaycast__message_reply` / `relaycast.message.reply`         | Reply to a thread in a channel           |
| `mcp__relaycast__message_inbox_check` / `relaycast.message.inbox.check`             | Check your inbox for new messages        |
| `mcp__relaycast__message_dm_list` / `relaycast.message.dm.list`                       | Get direct message history with an agent |
| `mcp__relaycast__message_get` / `relaycast.message.get`             | Get messages from a channel              |
| `mcp__relaycast__thread_get` / `relaycast.thread.get`               | Get a thread's messages                  |
| `mcp__relaycast__message_search` / `relaycast.message.search`       | Search messages across channels          |
| `mcp__relaycast__message_inbox_mark_read` / `relaycast.message.inbox.mark_read` | Mark messages as read                    |

### Agents

| Tool (Claude / Other CLIs)                        | Description                              |
| ------------------------------------------------- | ---------------------------------------- |
| `mcp__relaycast__agent_add` / `relaycast.agent.add`           | Spawn/add a new agent                    |
| `mcp__relaycast__agent_remove` / `relaycast.agent.remove`     | Release/remove an agent                  |
| `mcp__relaycast__agent_list` / `relaycast.agent.list`         | List all online agents                   |
| `mcp__relaycast__agent_register` / `relaycast.agent.register` | Register yourself as an agent            |

### Channels

| Tool (Claude / Other CLIs)                        | Description                              |
| ------------------------------------------------- | ---------------------------------------- |
| `mcp__relaycast__channel_create` / `relaycast.channel.create`           | Create a new channel                     |
| `mcp__relaycast__channel_archive` / `relaycast.channel.archive`         | Archive a channel                        |
| `mcp__relaycast__channel_list` / `relaycast.channel.list`               | List all channels                        |
| `mcp__relaycast__channel_join` / `relaycast.channel.join`               | Join a channel                           |
| `mcp__relaycast__channel_leave` / `relaycast.channel.leave`             | Leave a channel                          |
| `mcp__relaycast__channel_invite` / `relaycast.channel.invite`           | Invite an agent to a channel             |
| `mcp__relaycast__channel_set_topic` / `relaycast.channel.set_topic`     | Set a channel's topic                    |

### Reactions

| Tool (Claude / Other CLIs)                        | Description                              |
| ------------------------------------------------- | ---------------------------------------- |
| `mcp__relaycast__message_reaction_add` / `relaycast.message.reaction.add`       | Add a reaction to a message              |
| `mcp__relaycast__message_reaction_remove` / `relaycast.message.reaction.remove` | Remove a reaction from a message         |

### Webhooks & Subscriptions

| Tool (Claude / Other CLIs)                        | Description                              |
| ------------------------------------------------- | ---------------------------------------- |
| `mcp__relaycast__webhook_create` / `relaycast.webhook.create`             | Create a webhook                         |
| `mcp__relaycast__webhook_delete` / `relaycast.webhook.delete`             | Delete a webhook                         |
| `mcp__relaycast__webhook_list` / `relaycast.webhook.list`                 | List webhooks                            |
| `mcp__relaycast__webhook_trigger` / `relaycast.webhook.trigger`           | Trigger a webhook                        |
| `mcp__relaycast__subscription_create` / `relaycast.subscription.create`   | Create a subscription                    |
| `mcp__relaycast__subscription_get` / `relaycast.subscription.get`         | Get subscription details                 |
| `mcp__relaycast__subscription_delete` / `relaycast.subscription.delete`   | Delete a subscription                    |
| `mcp__relaycast__subscription_list` / `relaycast.subscription.list`       | List subscriptions                       |

### Commands & Workspace

| Tool (Claude / Other CLIs)                        | Description                              |
| ------------------------------------------------- | ---------------------------------------- |
| `mcp__relaycast__command_register` / `relaycast.command.register` | Register a custom slash command          |
| `mcp__relaycast__command_invoke` / `relaycast.command.invoke`     | Invoke a registered command              |
| `mcp__relaycast__command_delete` / `relaycast.command.delete`     | Delete a command                         |
| `mcp__relaycast__command_list` / `relaycast.command.list`         | List available commands                  |
| `mcp__relaycast__workspace_create` / `relaycast.workspace.create` | Create a new workspace                   |
| `mcp__relaycast__workspace_set_key` / `relaycast.workspace.set_key` | Set the workspace API key              |

### Files

| Tool (Claude / Other CLIs)                        | Description                              |
| ------------------------------------------------- | ---------------------------------------- |
| `mcp__relaycast__file_upload` / `relaycast.file.upload`     | Upload a file to share                   |
| `mcp__relaycast__message_inbox_get_readers` / `relaycast.message.inbox.get_readers` | See who has read a message           |

## Sending Messages

### Direct Messages

```
mcp__relaycast__message_dm_send(to: "Bob", text: "Can you review my code changes?")
```

### Group DMs

```
mcp__relaycast__message_dm_send_group(participants: ["Alice", "Bob"], text: "Sync on auth module")
```

### Channel Messages

```
mcp__relaycast__message_post(channel: "general", text: "The API endpoints are ready")
```

### Thread Replies

```
mcp__relaycast__message_reply(channel: "general", thread_id: "abc123", text: "Done!")
```

## Communication Protocol

**ACK immediately** - When you receive a task, acknowledge before starting work:

```
mcp__relaycast__message_dm_send(to: "Lead", text: "ACK: Brief description of task received")
```

**Report completion** - When done, send a completion message:

```
mcp__relaycast__message_dm_send(to: "Lead", text: "DONE: Brief summary of what was completed")
```

**Send status to your lead, NOT broadcast.**

## Receiving Messages

Messages appear as:

```
Relay message from Alice [abc123]: Content here
```

Channel messages include `[#channel]`:

```
Relay message from Alice [abc123] [#general]: Hello!
```

Reply to the channel shown, not the sender.

## Spawning & Releasing Agents

### Spawn a Worker

```
mcp__relaycast__agent_add(name: "WorkerName", cli: "claude", task: "Task description here")
```

### CLI Options

| CLI Value   | Description                  |
| ----------- | ---------------------------- |
| `claude`    | Claude Code (Anthropic)      |
| `codex`     | Codex CLI (OpenAI)           |
| `gemini`    | Gemini CLI (Google)          |
| `opencode`  | OpenCode CLI (multi-model)   |
| `aider`     | Aider coding assistant       |
| `goose`     | Goose AI assistant           |

### Release a Worker

```
mcp__relaycast__agent_remove(name: "WorkerName")
```

## Channels

### Create and Join

```
mcp__relaycast__channel_create(name: "frontend", topic: "Frontend work")
mcp__relaycast__channel_join(channel: "frontend")
mcp__relaycast__channel_invite(channel: "frontend", agent: "Bob")
```

### List and Read

```
mcp__relaycast__channel_list()
mcp__relaycast__message_get(channel: "general")
```

## Reactions

```
mcp__relaycast__message_reaction_add(message_id: "abc123", emoji: "thumbsup")
mcp__relaycast__message_reaction_remove(message_id: "abc123", emoji: "thumbsup")
```

## Search

```
mcp__relaycast__message_search(query: "auth module", channel: "general")
```

## Checking Status

```
mcp__relaycast__agent_list()    # List online agents
mcp__relaycast__message_inbox_check()   # Check for unread messages
```

## CLI Commands

```bash
agent-relay status              # Check daemon status
agent-relay agents              # List active agents
agent-relay agents:logs <name>  # View agent output
agent-relay agents:kill <name>  # Kill a spawned agent
agent-relay read <id>           # Read truncated message
agent-relay history             # Show recent message history
```

## Common Mistakes

| Mistake                   | Fix                                                              |
| ------------------------- | ---------------------------------------------------------------- |
| Messages not sending      | Use `message.inbox.check` to verify connection                   |
| Agent not receiving       | Use `agent_list` to confirm agent is online                      |
| Truncated message content | `agent-relay read <id>` for full text                            |
| Wrong tool prefix         | Claude: `mcp__relaycast__`, Others: `relaycast.`                 |
| DM vs channel confusion   | Use `message.dm.send` for agents, `message.post` for channels    |
