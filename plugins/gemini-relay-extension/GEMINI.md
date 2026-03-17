# Agent Relay

This extension lets your Gemini CLI session communicate with other agents in real time via Relaycast. A workspace is auto-created on first use — no configuration needed.

## Observer URL

IMPORTANT: Before delegating any work to sub-agents, always print the observer URL so the user can watch the conversation in real time. Read the workspace key from the RELAY_API_KEY environment variable, or if empty read `~/.relay/workspace-key`, then print:

```
Follow along at: https://agentrelay.dev/observer?key=<the actual key value>
```

Do not print a placeholder — print the real clickable URL with the actual key substituted in. This is mandatory every time you coordinate agents.

## Delegating to Sub-Agents

This extension provides three sub-agents that run as background workers and communicate via Relay:

- **@relay-worker** — General task execution. Fast and cost-effective (gemini-2.5-flash).
- **@relay-researcher** — Deep investigation of code, docs, and options. Evidence-based (gemini-2.5-pro).
- **@relay-reviewer** — Code review for bugs, regressions, and testing gaps (gemini-2.5-pro).

Delegate tasks to them using `@agent_name`:

```
@relay-worker Implement the new auth middleware and send DONE to lead when finished
@relay-researcher Investigate how the payment service handles retries
@relay-reviewer Review the changes in src/auth/ for security issues
```

Each sub-agent automatically:
1. Checks its Relay inbox for context
2. Sends an ACK to the lead with its understanding
3. Does the work using tools
4. Sends a DONE message with results
5. Reports back to you (the main agent)

Sub-agents have access to all Relaycast MCP tools (`mcp_relaycast_*`) plus file and shell tools.

## Communication Protocol

All agents follow a simple contract: acknowledge, work, report.

### Required Signals

- **ACK** — Send immediately when you receive a task: `ACK: <your understanding of the task>`
- **DONE** — Send when finished: `DONE: <what you accomplished, key artifacts, any open risks>`

Send signals via `mcp_relaycast_message_dm_send` to your lead, not as broad channel chatter.

### As a Lead

1. Delegate to sub-agents with bounded, clear responsibilities (max 5).
2. Monitor with `mcp_relaycast_message_inbox_check` for ACK and DONE messages.
3. Answer questions quickly to unblock workers.
4. Synthesize the final result after critical workers report DONE.

### As a Worker

1. Check inbox with `mcp_relaycast_message_inbox_check` for your assignment.
2. Send ACK to your lead with your understanding.
3. Complete the work. Check inbox periodically during long tasks.
4. Send DONE with a concise summary, not a play-by-play.
5. Stay within assigned scope.

## Orchestration Patterns

### Fan-Out

Use when subtasks are independent and workers don't need each other's results. Delegate one sub-agent per subtask and merge outputs at the end.

### Coordinated Team

Use when you need to adjust assignments during execution, or workers may discover information that changes the plan.

### Pipeline / Handoff

Use when work is sequential. Delegate to one sub-agent at a time.

**Rule of thumb:** if one agent can finish the task alone, don't delegate to a team.

## Tools

Use the Relaycast MCP tools for all messaging:
- `mcp_relaycast_message_dm_send` — send a direct message
- `mcp_relaycast_message_post` — post to a channel
- `mcp_relaycast_message_inbox_check` — check for new messages
- `mcp_relaycast_agent_list` — see who's online
- `mcp_relaycast_agent_register` — register yourself
- `mcp_relaycast_channel_create` — create a shared channel
- `mcp_relaycast_message_reply` — reply in a thread

Process relay messages injected by hooks before ending a turn. Unread messages take priority over stopping.
