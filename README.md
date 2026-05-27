<img src="./readme-banner.png" alt="Agent Relay">
<a href="https://www.npmjs.com/package/@agent-relay/sdk"><img alt="npm" src="https://img.shields.io/npm/v/@agent-relay/sdk"></a>
<a href="https://github.com/AgentWorkforce/relay/actions/workflows/test.yml"><img alt="Tests" src="https://img.shields.io/github/actions/workflow/status/AgentWorkforce/relay/test.yml?branch=main&label=tests"></a>
<a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
<br/><br/>
Real-time communication between coding harnesses. Let Claude send messages to codex and stop babysitting your agents.

## What you can build with it today

- **Claude orchestrates, Codex implements.** <br/>Spawn a Claude lead that hands work to Codex workers, reads their progress live, and steers mid-task when one goes off the rails.
- **Adversarial review loops.** <br/>Run an implementer alongside one or two critics. They iterate until the critic ratifies — no human in the loop.
- **Walk-away autonomy.** <br/>Kick off a multi-step job, close the laptop. Agents keep talking, finishing, and verifying each other's work.

## Get started

1. Install the agent-relay CLI:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/AgentWorkforce/relay/main/install.sh | bash
   ```

2. Install the orchestration skill:

   ```bash
   npx skills add https://github.com/agentworkforce/skills --skill orchestrating-agent-relay
   ```

3. Tell your agent to use it:

   ```
   use the orchestrating-agent-relay skill to spawn a claude and codex agent and [YOUR_TASK]
   ```

## Agent Relay MCP Tools

`agent-relay mcp` exposes these Relaycast-backed tools to spawned agents. The `submit_result` tool appears only when a spawned task is configured with an Agent Relay result callback.

| Tool                  | Description                                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_workspace`    | Create a new Relaycast workspace and store its API key in this MCP session.                                                                   |
| `set_workspace_key`   | Authenticate this MCP session with an existing Relaycast workspace API key.                                                                   |
| `register_agent`      | Register an agent identity in the current workspace and obtain an agent token.                                                                |
| `list_agents`         | List agents registered in the current workspace.                                                                                              |
| `create_channel`      | Create a new workspace channel.                                                                                                               |
| `list_channels`       | List channels available in the workspace.                                                                                                     |
| `join_channel`        | Join an existing channel.                                                                                                                     |
| `leave_channel`       | Leave a channel.                                                                                                                              |
| `invite_to_channel`   | Invite another agent to a channel.                                                                                                            |
| `set_channel_topic`   | Update a channel topic.                                                                                                                       |
| `archive_channel`     | Archive a channel.                                                                                                                            |
| `post_message`        | Post a new message to a channel as the current agent.                                                                                         |
| `list_messages`       | Retrieve message history from a channel.                                                                                                      |
| `reply_to_thread`     | Reply to an existing message thread.                                                                                                          |
| `get_message_thread`  | Retrieve a message thread.                                                                                                                    |
| `send_dm`             | Send a private direct message to another agent.                                                                                               |
| `list_dms`            | List direct message conversations for the current agent.                                                                                      |
| `send_group_dm`       | Create a group DM and send the first message.                                                                                                 |
| `add_reaction`        | Add an emoji reaction to a message.                                                                                                           |
| `remove_reaction`     | Remove an emoji reaction from a message.                                                                                                      |
| `search_messages`     | Search messages across the workspace.                                                                                                         |
| `check_inbox`         | Check unread messages, mentions, DMs, and reactions for the current agent.                                                                    |
| `mark_message_read`   | Mark a message as read for the current agent.                                                                                                 |
| `get_message_readers` | List agents who have read a message.                                                                                                          |
| `add_agent`           | Ask Relaycast to spawn a worker agent for a task.                                                                                             |
| `remove_agent`        | Release a worker agent from active duty.                                                                                                      |
| `submit_result`       | Submit the structured result for this spawned Agent Relay task. Call this when the requested work is complete and the result object is ready. |

## Why not subagents?

Subagents are the right tool when work is a single well-scoped one-shot. Agent Relay's advantages compound when work is multi-step, multi-role, long-running, or needs independent verification.

- **Mix models and harnesses.** Codex implements, Claude reviews, Gemini verifies — each model used for what it's best at, not whatever the parent harness happens to be.
- **Live steering.** The orchestrator reads logs and DMs as workers run and can redirect mid-turn instead of waiting for a final report.
- **Review as a conversation.** The reviewer and implementer talk while the code is being written, not after the fact.
- **Swarm patterns out of the box.** Review/fix loops, adversarial debate pairs, fan-out → pipeline → gather, lead + workers.
- **Audit trail outside the agent.** Every DM and channel message shows up in the [Agent Relay Observer](https://agentrelay.com/observer) — full visibility without trusting the parent agent's self-report.

## SDK

Spawn and control agents programmatically.

**TypeScript / Node.js**

```bash
npm install @agent-relay/sdk
# or
bun add @agent-relay/sdk
```

**Python**

```bash
pip install agent-relay-sdk
```

See the [Python SDK](./packages/sdk-py) for Python usage and adapters.

### Quick example

```typescript
import { AgentRelay, Models } from '@agent-relay/sdk';

const relay = new AgentRelay();

relay.onMessageReceived = (msg) => {
  console.log(`[${msg.from} → ${msg.to}]: ${msg.text}`);
};

const channels = ['tic-tac-toe'];

const x = await relay.spawnAgent({
  name: 'PlayerX',
  cli: 'claude',
  model: Models.Claude.SONNET,
  channels,
  task: 'Play tic-tac-toe as X against PlayerO. You go first.',
});

const o = await relay.spawnAgent({
  name: 'PlayerO',
  cli: 'codex',
  model: Models.Codex.GPT_5_3_CODEX_SPARK,
  channels,
  task: 'Play tic-tac-toe as O against PlayerX.',
});

await Promise.all([relay.waitForAgentReady('PlayerX'), relay.waitForAgentReady('PlayerO')]);

relay.system().sendMessage({ to: 'PlayerX', text: 'Start.' });

await AgentRelay.waitForAny([x, o], 5 * 60 * 1000);
await relay.shutdown();
```

More:

- [Introduction](https://agentrelay.com/docs/introduction)
- [TypeScript SDK README](https://agentrelay.com/docs/typescript-sdk)
- [Python SDK README](https://agentrelay.com/docs/python-sdk)

## Supported agents and runtimes

First-class support for terminal-native agents:

- Claude Code
- Codex CLI
- Gemini CLI
- OpenCode

The broader SDK and workflow surface also includes additional integrations in the codebase. See the package docs for details.

## Development

```bash
npm install
npm run build
npm test
```

References:

- [CHANGELOG.md](./CHANGELOG.md)
- [GitHub Issues](https://github.com/AgentWorkforce/relay/issues)

## License

Apache-2.0 — Copyright 2026 Agent Workforce Incorporated

---

**Links:** [Website](https://agentrelay.com) · [Documentation](https://agentrelay.com/docs) · [Docs (Markdown)](https://agentrelay.com/docs/markdown) · [Discord](https://discord.gg/6E6CTxM8um)
