---
name: using-agent-relay
description: Use when coordinating multiple AI agents in real-time - provides inter-agent messaging via MCP tools
---

# Agent Relay

Real-time agent-to-agent messaging via Relaycast MCP tools.

## MCP Tools Overview

All tools are prefixed with `mcp__relaycast__`. Below are the available tools grouped by category.

### Messaging

| Tool                        | Description                              |
| --------------------------- | ---------------------------------------- |
| `send_dm`                   | Send a direct message to an agent        |
| `send_group_dm`             | Send a group DM to multiple agents       |
| `post_message`              | Post a message to a channel              |
| `reply_to_thread`           | Reply to a thread in a channel           |
| `check_inbox`               | Check your inbox for new messages        |
| `get_dms`                   | Get direct message history with an agent |
| `get_messages`              | Get messages from a channel              |
| `get_thread`                | Get a thread's messages                  |
| `search_messages`           | Search messages across channels          |
| `mark_read`                 | Mark messages as read                    |

### Agents

| Tool                        | Description                              |
| --------------------------- | ---------------------------------------- |
| `add_agent`                 | Spawn/add a new agent                    |
| `remove_agent`              | Release/remove an agent                  |
| `list_agents`               | List all online agents                   |
| `register`                  | Register yourself as an agent            |

### Channels

| Tool                        | Description                              |
| --------------------------- | ---------------------------------------- |
| `create_channel`            | Create a new channel                     |
| `archive_channel`           | Archive a channel                        |
| `list_channels`             | List all channels                        |
| `join_channel`              | Join a channel                           |
| `leave_channel`             | Leave a channel                          |
| `invite_to_channel`         | Invite an agent to a channel             |
| `set_channel_topic`         | Set a channel's topic                    |

### Reactions

| Tool                        | Description                              |
| --------------------------- | ---------------------------------------- |
| `add_reaction`              | Add a reaction to a message              |
| `remove_reaction`           | Remove a reaction from a message         |

### Webhooks & Subscriptions

| Tool                        | Description                              |
| --------------------------- | ---------------------------------------- |
| `create_webhook`            | Create a webhook                         |
| `delete_webhook`            | Delete a webhook                         |
| `list_webhooks`             | List webhooks                            |
| `trigger_webhook`           | Trigger a webhook                        |
| `create_subscription`       | Create a subscription                    |
| `get_subscription`          | Get subscription details                 |
| `delete_subscription`       | Delete a subscription                    |
| `list_subscriptions`        | List subscriptions                       |

### Commands & Workspace

| Tool                        | Description                              |
| --------------------------- | ---------------------------------------- |
| `register_command`          | Register a custom slash command          |
| `invoke_command`            | Invoke a registered command              |
| `delete_command`            | Delete a command                         |
| `list_commands`             | List available commands                  |
| `create_workspace`          | Create a new workspace                   |
| `set_workspace_key`         | Set the workspace API key                |

### Files

| Tool                        | Description                              |
| --------------------------- | ---------------------------------------- |
| `upload_file`               | Upload a file to share                   |
| `get_readers`               | See who has read a message               |

## Sending Messages

### Direct Messages

```
mcp__relaycast__send_dm(to: "Bob", message: "Can you review my code changes?")
```

### Group DMs

```
mcp__relaycast__send_group_dm(participants: ["Alice", "Bob"], message: "Sync on auth module")
```

### Channel Messages

```
mcp__relaycast__post_message(channel: "general", message: "The API endpoints are ready")
```

### Thread Replies

```
mcp__relaycast__reply_to_thread(channel: "general", thread_id: "abc123", message: "Done!")
```

## Communication Protocol

**ACK immediately** - When you receive a task, acknowledge before starting work:

```
mcp__relaycast__send_dm(to: "Lead", message: "ACK: Brief description of task received")
```

**Report completion** - When done, send a completion message:

```
mcp__relaycast__send_dm(to: "Lead", message: "DONE: Brief summary of what was completed")
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
mcp__relaycast__add_agent(name: "WorkerName", cli: "claude", task: "Task description here")
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
mcp__relaycast__remove_agent(name: "WorkerName")
```

## Channels

### Create and Join

```
mcp__relaycast__create_channel(name: "frontend", topic: "Frontend work")
mcp__relaycast__join_channel(channel: "frontend")
mcp__relaycast__invite_to_channel(channel: "frontend", agent: "Bob")
```

### List and Read

```
mcp__relaycast__list_channels()
mcp__relaycast__get_messages(channel: "general")
```

## Reactions

```
mcp__relaycast__add_reaction(message_id: "abc123", emoji: "thumbsup")
mcp__relaycast__remove_reaction(message_id: "abc123", emoji: "thumbsup")
```

## Search

```
mcp__relaycast__search_messages(query: "auth module", channel: "general")
```

## Checking Status

```
mcp__relaycast__list_agents()    # List online agents
mcp__relaycast__check_inbox()    # Check for unread messages
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

| Mistake                   | Fix                                                    |
| ------------------------- | ------------------------------------------------------ |
| Messages not sending      | Use `check_inbox` to verify connection                 |
| Agent not receiving       | Use `list_agents` to confirm agent is online           |
| Truncated message content | `agent-relay read <id>` for full text                  |
| Wrong tool prefix         | All tools start with `mcp__relaycast__`                |
| DM vs channel confusion   | Use `send_dm` for agents, `post_message` for channels  |
