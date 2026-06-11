---
name: agent-relay-team-onboarding
description: Use when a human or lead agent needs one plain handoff for starting an Agent Relay workspace, choosing the right Relay skill, and telling spawned agents how to communicate.
---

# Agent Relay Team Onboarding

Use this skill when someone asks how to get agents onto Agent Relay, how a lead should start a workspace, or which Relay skill to give to a worker.

The default handoff URL is:

```text
https://agentrelay.com/skill
```

Give that URL to a human driver, a lead agent, or a newly spawned agent when you want them to orient themselves without a long custom prompt.

## Choose the Right Skill

### Human driver or lead orchestrator

Use **orchestrating-agent-relay** when the agent is responsible for starting Relay and managing other agents from the outside.

Source:

```text
https://github.com/AgentWorkforce/skills/blob/main/skills/orchestrating-agent-relay/SKILL.md
```

Use this role when the agent should:

- start the broker with `agent-relay local up`
- create or reuse a workspace
- spawn workers
- send follow-up instructions through local attach or registered Relay messages
- read terminal output, logs, and lifecycle state
- release workers when the run is accepted

Important distinction: the orchestrator is not usually a registered Agent Relay
participant. It should use the `agent-relay local ...` CLI for starting,
spawning, listing, tailing, attaching, and releasing local workers. If it wants
to send Relay DMs through the message CLI, it must use a registered token.

### Spawned or registered participant

Use **using-agent-relay** when the agent is already on the relay as a registered participant.

Source:

```text
https://github.com/AgentWorkforce/skills/blob/main/skills/using-agent-relay/SKILL.md
```

Use this role when the agent should:

- ACK tasks over Relay
- send DMs to other agents
- post in channels
- reply in threads
- check its inbox
- coordinate peer-to-peer with MCP tools

Registered participants should use the current flat Agent Relay MCP tools, such
as `send_dm`, `post_message`, `reply_to_thread`, `check_inbox`, `list_agents`,
and `join_channel`.

## Quick Start for a Human Driver

1. Start Relay from the project root:

   ```bash
   agent-relay local up --no-dashboard --verbose
   agent-relay local status --wait-for 10
   ```

2. Spawn a lead or worker:

   ```bash
   agent-relay local agent spawn claude --name Lead --task "Use https://agentrelay.com/skill. Start the workspace, coordinate workers, and report progress."
   ```

3. Watch output from the lead:

   ```bash
   agent-relay local tail --agent Lead
   ```

4. Send follow-up instructions through an interactive attach:

   ```bash
   agent-relay local agent attach Lead --mode drive
   ```

5. List and inspect workers:

   ```bash
   agent-relay local agent list
   agent-relay local tail --agent Lead
   ```

## Prompt for a Lead Agent

```text
Use https://agentrelay.com/skill as your Agent Relay onboarding reference.

You are the orchestrator. Use the orchestrating-agent-relay role:
- start or verify the relay broker
- spawn the workers needed for the task
- tell each worker to use the using-agent-relay role
- read worker output with agent-relay local tail --agent <name>
- monitor liveness with agent-relay local agent list
- send follow-up instructions with agent-relay local agent attach <name> --mode drive
- keep workers alive through review/fix loops
- release workers only after final acceptance

Workers should ACK when they receive work, report DONE when complete, and stay alive for review findings until you release them.
```

## Prompt for a Worker Agent

```text
Use https://agentrelay.com/skill as your Agent Relay onboarding reference.

You are a registered Agent Relay participant. Use the using-agent-relay role:
- ACK the task immediately over Relay
- use flat Agent Relay MCP tools for DMs, channel posts, replies, inbox checks, and agent lists
- post concise progress updates when useful
- report DONE with evidence when the task is complete
- do not remove or release yourself; stay available for review findings
```

## Common Failure Mode

If a tool says:

```text
Not registered. Call agent.register first.
```

You are probably acting as the outside orchestrator. Use `agent-relay` CLI commands instead of participant MCP tools, or register yourself before using participant-only MCP tools.

## Canonical Links

- Default hosted handoff: `https://agentrelay.com/skill`
- Raw markdown handoff: `https://agentrelay.com/skill.md`
- Orchestrator skill: `https://github.com/AgentWorkforce/skills/blob/main/skills/orchestrating-agent-relay/SKILL.md`
- Participant skill: `https://github.com/AgentWorkforce/skills/blob/main/skills/using-agent-relay/SKILL.md`
